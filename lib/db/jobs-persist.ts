import { getSupabaseAdmin } from "@/lib/db/supabase";

// Server-side helper that persists scraped jobs into Supabase. Called by
// every scrape route (parse-gmail, scrape-jobs, scrape-upwork, scrape-
// remoteok) so all writes go through one place.
//
// Phase 1 schema: writes land in `jobs_v2` (text job_id PK, JSONB enrichment,
// restricted email_status enum). The old `jobs` table is no longer touched.
//
// Behaviour:
//   - Filters out rows missing title/company/jobId — jobs_v2.job_id is PK,
//     so a NULL or 'N/A' would crash the upsert.
//   - Splits the free-form `platform` string into platform + method:
//       "LinkedIn (Apify)"        → platform=linkedin, method=search
//       "LinkedIn (Gmail Alert)"  → platform=linkedin, method=gmail-alert
//       "Upwork (Apify)"          → platform=upwork,   method=search
//   - Upserts on job_id so re-running a scrape is idempotent.
//   - Returns the input array unchanged but with `dbId` set to the same
//     text job_id (the new PK) on each successfully persisted row, so
//     downstream callers (send-email, etc.) can still reference it.

export interface ScrapedJob {
  title: string;
  jobId: string;
  company: string;
  email: string;
  location: string;
  jobType: string;
  description: string;
  url: string;
  postedAt: string;
  platform: string;
  // Populated by this helper after a successful upsert. Equals the row's
  // job_id (text PK) — kept under the legacy "dbId" name for backwards
  // compatibility with consumers that already destructure it.
  dbId?: string;
}

// Returns canonical `platform` + `method` for the new schema's CHECK
// constraints. Falls back to linkedin/search for anything we can't classify
// so the row still inserts rather than failing.
function classify(platform: string): { platform: string; method: string } {
  const lower = (platform || "").toLowerCase();
  let p = "linkedin";
  if (lower.includes("upwork")) p = "upwork";
  else if (lower.includes("indeed")) p = "indeed";
  else if (lower.includes("remoteok")) p = "remoteok";

  const m =
    lower.includes("gmail") || lower.includes("alert") ? "gmail-alert" : "search";
  return { platform: p, method: m };
}

export async function persistScrapedJobs(
  jobs: ScrapedJob[]
): Promise<ScrapedJob[]> {
  if (jobs.length === 0) return jobs;

  let db;
  try {
    db = getSupabaseAdmin();
  } catch (err) {
    console.warn("[jobs-persist] supabase init failed:", (err as Error).message);
    return jobs;
  }

  // Build the rows to upsert. Reject anything missing the three required
  // jobs_v2 fields so a single bad scrape doesn't 23502 the whole batch.
  //
  // scraped_at steps DOWN by 1ms per index so the caller's array order
  // survives the DB round-trip: /api/jobs sorts by `scraped_at desc`, so
  // jobs[0] (e.g. the newest LinkedIn alert's first card) lands on top,
  // jobs[1] next, and so on. 1ms steps keep the whole batch inside the same
  // second, so the displayed "scraped date" is unaffected.
  const scrapeBase = Date.now();
  const rows = jobs
    .filter(
      (j) =>
        j.title &&
        j.title !== "N/A" &&
        j.company &&
        j.company !== "N/A" &&
        j.jobId &&
        j.jobId !== "N/A"
    )
    .map((job, i) => {
      const { platform, method } = classify(job.platform);
      return {
        job_id: job.jobId,
        title: job.title,
        company: job.company,
        url: job.url || null,
        description: job.description || null,
        location: job.location && job.location !== "N/A" ? job.location : null,
        job_type: job.jobType && job.jobType !== "N/A" ? job.jobType : null,
        posted_at:
          job.postedAt && job.postedAt !== "N/A"
            ? toDateOrNull(job.postedAt)
            : null,
        platform,
        method,
        scraped_at: new Date(scrapeBase - i).toISOString(),
        // email_status starts NULL — flips to 'enriched' once enrich-lead
        // finds a contact, then 'sent'/'opened'/'replied' as the email
        // lifecycle progresses.
      };
    });

  if (rows.length === 0) return jobs;

  const { data, error } = await db
    .from("jobs_v2")
    .upsert(rows, { onConflict: "job_id", ignoreDuplicates: false })
    .select("job_id");

  if (error) {
    console.warn("[jobs-persist] upsert failed:", error.message);
    return jobs;
  }

  // job_id IS the PK now, so dbId = jobId. Loop just records which input
  // rows actually made it through the constraints.
  const persisted = new Set<string>();
  for (const row of data ?? []) {
    if (row.job_id) persisted.add(row.job_id as string);
  }
  for (const job of jobs) {
    if (job.jobId && persisted.has(job.jobId)) {
      job.dbId = job.jobId;
    }
  }

  console.log(
    `[jobs-persist] upserted ${data?.length ?? 0}/${rows.length} jobs to jobs_v2`
  );
  return jobs;
}

function toDateOrNull(s: string): string | null {
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}
