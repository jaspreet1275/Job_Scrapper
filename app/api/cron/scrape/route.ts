import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, TABLES } from "@/lib/db/supabase";
import { isAuthorizedCron, getInternalBaseUrl } from "@/lib/cron/auth";

// Daily scrape + Stage 1 send cron.
//
// Schedule: 11 AM IST (= 05:30 UTC) — configured in vercel.json.
//
// Pipeline:
//   1. Auth check.
//   2. Quota check: how many sends already today? compare to daily_send_limit
//      from settings. If at cap, exit early (no scraping wasted on
//      already-saturated days).
//   3. Source A: /api/parse-gmail to ingest LinkedIn alert emails.
//   4. Source B: /api/scrape-jobs once per role in DEFAULT_ROLES.
//      Both sources auto-upsert into the jobs table via persistScrapedJobs.
//   5. Pull candidate jobs from DB: status='new' with a non-null company.
//   6. For each, call /api/enrich-lead. Pick the best email.
//   7. Generate Stage 1 via /api/generate-email, send via /api/send-email
//      with jobId set so the follow-up cron can pick up Stage 2 later.
//   8. Stop when daily cap hit. Mark each processed job as 'enriched' or
//      'contacted' so subsequent runs skip them.
//   9. Log to auto_runs.

// Roles the cron searches for. Hardcoded for now — UI-configurable later.
const DEFAULT_ROLES = [
  "AI Engineer",
  "ML Engineer",
  "Data Analyst",
  "Backend Developer",
  "Full Stack Developer",
];
const DEFAULT_PLATFORM = "linkedin";
const DEFAULT_FILTERS = ["Remote"];

// How many DB jobs to enrich + send per cron run, regardless of daily cap.
// Keeps a single invocation under Vercel's serverless time budget.
const MAX_JOBS_PER_RUN = 25;

// Vercel function timeout. Hobby plan caps at 300s. The GitHub Actions
// orchestrator splits work across calls so one invocation rarely needs
// the full ceiling: typical paths are
//   ?skipIngest=true&max=5  → drain 5 candidate jobs (~30-60s)
//   default                  → full pipeline (only safe on Pro/lighter loads)
export const maxDuration = 300;

type EnrichCandidate = {
  email?: string;
  name?: string;
  title?: string;
  linkedin?: string;
};

type EnrichedLead = {
  candidates?: EnrichCandidate[];
  companyDomain?: string;
  companyCountry?: string;
  companyIndustry?: string;
  companySize?: string;
};

// Returns IST midnight as UTC ISO. Used to count today's sends in
// "operate from 11 AM IST" semantics: a day starts at IST 00:00.
function startOfTodayIST_ISO(): string {
  const now = new Date();
  // IST = UTC+5:30. Compute current IST instant, zero its time part, then
  // shift back to UTC for the timestamp filter.
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const istMidnight = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate())
  );
  // Convert IST midnight back to UTC by subtracting the offset.
  const utcEquivalent = new Date(istMidnight.getTime() - 5.5 * 60 * 60 * 1000);
  return utcEquivalent.toISOString();
}

async function todaysSendCount(
  db: ReturnType<typeof getSupabaseAdmin>
): Promise<number> {
  const since = startOfTodayIST_ISO();
  const { count, error } = await db
    .from(TABLES.emailSends)
    .select("id", { count: "exact", head: true })
    .gte("sent_at", since);
  if (error) return 0;
  return count ?? 0;
}

async function readSettings(db: ReturnType<typeof getSupabaseAdmin>) {
  const { data } = await db
    .from(TABLES.settings)
    .select(
      "auto_mode_enabled, daily_send_limit, send_window_start_hour, daily_schedule_times, max_emails_per_run, platform_filter"
    )
    .eq("id", 1)
    .maybeSingle();
  // daily_schedule_times is a JSON array of IST "HH:MM" strings (e.g.
  // ["09:30", "12:30", "16:00"]). Empty array → scheduler disabled
  // (manual / Auto-Scrape only).
  const rawTimes = data?.daily_schedule_times;
  const scheduleTimes = Array.isArray(rawTimes)
    ? (rawTimes as string[]).filter(
        (t) => typeof t === "string" && /^\d{2}:\d{2}$/.test(t)
      )
    : [];
  return {
    autoEnabled: (data?.auto_mode_enabled as boolean) ?? false,
    dailyLimit: (data?.daily_send_limit as number) ?? 50,
    windowStartHour: (data?.send_window_start_hour as number) ?? 11,
    scheduleTimes,
    maxEmailsPerRun: (data?.max_emails_per_run as number) ?? 25,
    platformFilter:
      (data?.platform_filter as string | null) ?? "linkedin",
  };
}

// Current IST minutes since midnight. The gate compares this against each
// scheduled time (also expressed as minutes) with a tolerance window —
// GitHub Actions can delay scheduled fires by up to ~15 min, so a strict
// HH:MM equality check would miss those legitimately-late firings.
function currentIstMinutes(): number {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  const d = new Date(istMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// Pretty-printed current IST HH:MM purely for log lines.
function currentIstHHMM(): string {
  const istMs = Date.now() + 5.5 * 60 * 60 * 1000;
  const d = new Date(istMs);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes()
  ).padStart(2, "0")}`;
}

// Allow the gate to match a scheduled time even when GitHub Actions delays
// the firing by up to this many minutes (their docs warn 0–15 min during
// peak load). 20 min keeps us safely above their worst-case while still
// short enough that our 30-min-apart slots (16:00 / 16:30 / 17:00) can't
// be ambiguously matched twice in one fire.
const SCHEDULE_TOLERANCE_MIN = 20;

function timeStringToMinutes(t: string): number | null {
  const m = t.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  return h * 60 + min;
}

function isWithinSchedule(scheduleTimes: string[]): boolean {
  const nowMin = currentIstMinutes();
  return scheduleTimes.some((t) => {
    const targetMin = timeStringToMinutes(t);
    if (targetMin === null) return false;
    return Math.abs(nowMin - targetMin) <= SCHEDULE_TOLERANCE_MIN;
  });
}

async function callJson<T>(
  url: string,
  body: Record<string, unknown> | null = null
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const init: RequestInit = body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
    const res = await fetch(url, init);
    const json = (await res.json()) as { success: boolean; data?: T; error?: string };
    if (!res.ok || !json.success) {
      return { ok: false, error: json.error || `http ${res.status}` };
    }
    return { ok: true, data: json.data };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function pickBestCandidate(lead: EnrichedLead): EnrichCandidate | null {
  if (!lead.candidates || lead.candidates.length === 0) return null;
  // The /api/enrich-lead route already returns candidates in priority order
  // (best email first). Just pick the first one with an email.
  return lead.candidates.find((c) => c.email && c.email.includes("@")) ?? null;
}

export async function GET(req: NextRequest) {
  const startedAt = new Date();
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  // Per-call knobs so external orchestrators (e.g. GitHub Actions on Vercel
  // Hobby's 60s function cap) can split work into smaller chunks:
  //   ?skipIngest=true → skip Source A (parse-gmail) + Source B (scrape-jobs),
  //                      only enrich+send for jobs already in the table.
  //   ?skipSend=true   → enrich the candidate jobs and mark them as
  //                      "enriched" but do NOT generate or send Stage 1.
  //                      Used during the manual-testing phase where the user
  //                      wants the daily cron to populate enrichments only,
  //                      then triggers Stage 1 / 2 / 3 sends manually from
  //                      the dashboard's Smart Send button.
  //   ?max=N           → process at most N candidate jobs this call instead
  //                      of MAX_JOBS_PER_RUN. Re-invoke until "jobsProcessed"
  //                      drops to 0 to drain the queue across calls.
  const skipIngest = req.nextUrl.searchParams.get("skipIngest") === "true";
  const skipSend = req.nextUrl.searchParams.get("skipSend") === "true";
  const maxParam = Number(req.nextUrl.searchParams.get("max"));
  const maxJobs = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : MAX_JOBS_PER_RUN;

  const db = getSupabaseAdmin();
  const baseUrl = getInternalBaseUrl();
  const { autoEnabled, dailyLimit, scheduleTimes, maxEmailsPerRun } =
    await readSettings(db);

  const summary = {
    autoEnabled,
    dailyLimit,
    scheduleTimes,
    sentBeforeRun: 0,
    sentThisRun: 0,
    jobsProcessed: 0,
    enrichmentsSaved: 0,
    sourceAJobs: 0,
    sourceBJobs: 0,
    skipped: 0,
    errors: [] as string[],
    durationMs: 0,
  };

  // Note: the separate `auto_mode_enabled` gate was removed — the
  // existence of a non-empty `daily_schedule_times` array is now the
  // single source of truth for "is auto-mode on?". Saving any time slot
  // in the dashboard effectively turns auto-mode on; clearing them all
  // turns it off. No more dual-toggle confusion.

  // Scheduler time-gate. The workflow fires at every supported IST slot
  // (09:30, 10:00, 10:30, 12:30, 13:30, 14:30, 16:00, 16:30, 17:00); this
  // route only proceeds when the current IST HH:MM is in the user-selected
  // `daily_schedule_times` array. Empty array = scheduler off — every
  // scheduled fire no-ops. The `force=true` query param bypasses the gate
  // so manual triggers (workflow_dispatch / Auto-Scrape) still run.
  const force = req.nextUrl.searchParams.get("force") === "true";
  if (!force) {
    if (scheduleTimes.length === 0) {
      summary.errors.push(
        "daily_schedule_times is empty — scheduler disabled. Pass force=true to override."
      );
      summary.durationMs = Date.now() - startedAt.getTime();
      await logRun(db, "scrape", startedAt, summary);
      return NextResponse.json({ success: true, ...summary });
    }
    const nowIst = currentIstHHMM();
    if (!isWithinSchedule(scheduleTimes)) {
      summary.errors.push(
        `IST ${nowIst} not within ±${SCHEDULE_TOLERANCE_MIN}m of any scheduled time [${scheduleTimes.join(", ")}]. Skipping.`
      );
      summary.durationMs = Date.now() - startedAt.getTime();
      await logRun(db, "scrape", startedAt, summary);
      return NextResponse.json({ success: true, ...summary });
    }
  }

  // ── Quota check ───────────────────────────────────────────────────────────
  const before = await todaysSendCount(db);
  summary.sentBeforeRun = before;
  if (before >= dailyLimit) {
    summary.errors.push(`daily cap already reached (${before}/${dailyLimit})`);
    summary.durationMs = Date.now() - startedAt.getTime();
    await logRun(db, "scrape", startedAt, summary);
    return NextResponse.json({ success: true, ...summary });
  }

  if (!skipIngest) {
    // ── SOURCE A: Gmail Parser ─────────────────────────────────────────────
    // maxEmails honours the user's "Max emails per run" setting (default
    // 25, hard-cap is Gmail's per-page 100). Backend searches "yesterday →
    // now" so this is an upper bound, not the exact fetch count.
    const gmailRes = await callJson<unknown[]>(`${baseUrl}/api/parse-gmail`, {
      maxEmails: maxEmailsPerRun,
    });
    if (gmailRes.ok && Array.isArray(gmailRes.data)) {
      summary.sourceAJobs = gmailRes.data.length;
    } else if (gmailRes.error) {
      summary.errors.push(`parse-gmail: ${gmailRes.error}`);
    }

    // ── SOURCE B: Apify (one call per role) ────────────────────────────────
    for (const role of DEFAULT_ROLES) {
      const apifyRes = await callJson<unknown[]>(`${baseUrl}/api/scrape-jobs`, {
        platform: DEFAULT_PLATFORM,
        roles: [role],
        filters: DEFAULT_FILTERS,
      });
      if (apifyRes.ok && Array.isArray(apifyRes.data)) {
        summary.sourceBJobs += apifyRes.data.length;
      } else if (apifyRes.error) {
        summary.errors.push(`scrape-jobs[${role}]: ${apifyRes.error}`);
      }
    }
  }

  // ── Pick candidate jobs from jobs_v2 ─────────────────────────────────────
  // Only rows that haven't been processed yet — email_status null (raw) or
  // 'enriched' (have a contact, never sent). Anything past 'sent' has its
  // own follow-up path.
  const { data: fresh, error: freshErr } = await db
    .from(TABLES.jobs)
    .select("job_id, title, company, description, url, location, email_status")
    .or("email_status.is.null,email_status.eq.enriched")
    .order("scraped_at", { ascending: false })
    .limit(maxJobs * 2); // overfetch — many won't enrich cleanly
  if (freshErr) {
    summary.errors.push(`jobs query: ${freshErr.message}`);
  }

  const jobs = (fresh ?? []) as Array<{
    job_id: string;
    title: string;
    company: string;
    description: string | null;
    url: string | null;
    location: string | null;
    email_status: string | null;
  }>;

  // Filter out jobs that already have a Stage 1 row in email_tracking — the
  // `or(...status='enriched')` filter above keeps them out, but a partial
  // run could leave a row in 'sent' that the OR predicate excludes anyway.
  // Defensive: also skip anything whose lifecycle is past 'enriched'.
  const jobIds = jobs.map((j) => j.job_id);
  const sentSet = new Set<string>();
  if (jobIds.length > 0) {
    const { data: existingSends } = await db
      .from(TABLES.emailTracking)
      .select("job_id")
      .in("job_id", jobIds)
      .eq("stage", 1);
    for (const r of existingSends ?? []) {
      if (r.job_id) sentSet.add(r.job_id as string);
    }
  }

  let remaining = dailyLimit - before;
  for (const job of jobs) {
    if (remaining <= 0 || summary.jobsProcessed >= maxJobs) break;
    summary.jobsProcessed++;
    if (sentSet.has(job.job_id)) {
      summary.skipped++;
      continue;
    }

    // Enrichment — pass jobId so /api/enrich-lead writes the JSONB +
    // flips email_status='enriched' on the jobs_v2 row directly.
    const enrichRes = await callJson<EnrichedLead>(`${baseUrl}/api/enrich-lead`, {
      companyName: job.company,
      source: "cron-scrape",
      jobId: job.job_id,
    });
    if (!enrichRes.ok || !enrichRes.data) {
      summary.errors.push(`enrich[${job.company}]: ${enrichRes.error}`);
      summary.skipped++;
      continue;
    }
    const lead = enrichRes.data;
    const best = pickBestCandidate(lead);
    if (!best?.email) {
      summary.skipped++;
      continue;
    }

    // /api/enrich-lead already wrote the enrichment JSONB and flipped
    // jobs_v2.email_status to 'enriched' (when an email was found). The old
    // separate enrichments-table insert is gone — that table isn't the
    // source of truth anymore.
    summary.enrichmentsSaved++;

    // Stage 1 auto-send is parked behind ?skipSend=true during the manual-
    // testing phase. The daily cron stops at "enriched"; the user fires the
    // Smart Send button on the dashboard to ship Stage 1 / 2 / 3 themselves.
    // Drop the flag once that loop is verified and you're ready to flip
    // automation back on. (When skipSend is true we don't need to do
    // anything here — enrich-lead already set email_status='enriched'.)
    if (skipSend) {
      continue;
    }

    // Generate Stage 1 email.
    const genRes = await callJson<{ subject: string; body: string }>(
      `${baseUrl}/api/generate-email`,
      {
        job: {
          title: job.title,
          company: job.company,
          description: job.description ?? "",
          url: job.url ?? "",
        },
        contactName: best.name,
        companyName: job.company,
        stage: 1,
      }
    );
    if (!genRes.ok || !genRes.data) {
      summary.errors.push(`generate[${job.company}]: ${genRes.error}`);
      continue;
    }

    // Send Stage 1 with jobId — /api/send-email writes the email_tracking
    // row + flips jobs_v2.email_status to 'sent', so we don't need a
    // separate status update here.
    const sendRes = await callJson(`${baseUrl}/api/send-email`, {
      to: best.email,
      subject: genRes.data.subject,
      body: genRes.data.body,
      stage: 1,
      jobId: job.job_id,
    });
    if (!sendRes.ok) {
      summary.errors.push(`send[${job.company}]: ${sendRes.error}`);
      continue;
    }

    summary.sentThisRun++;
    remaining--;
  }

  summary.durationMs = Date.now() - startedAt.getTime();
  await logRun(db, "scrape", startedAt, summary);
  console.log("[cron/scrape]", summary);
  return NextResponse.json({ success: true, ...summary });
}

async function logRun(
  db: ReturnType<typeof getSupabaseAdmin>,
  cronType: string,
  startedAt: Date,
  summary: {
    sourceAJobs: number;
    sourceBJobs: number;
    sentThisRun: number;
    errors: string[];
  }
) {
  try {
    await db.from(TABLES.autoRuns).insert({
      cron_type: cronType,
      started_at: startedAt.toISOString(),
      ended_at: new Date().toISOString(),
      jobs_found: summary.sourceAJobs + summary.sourceBJobs,
      emails_sent: summary.sentThisRun,
      errors: summary.errors.length,
      log: summary.errors.slice(0, 5).join(" | ").slice(0, 4000) || "ok",
    });
  } catch {
    /* ignore */
  }
}

export const POST = GET;
