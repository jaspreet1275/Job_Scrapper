import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/supabase";

// GET /api/jobs?platform=linkedin
//
// Source-of-truth read for the dashboard's job list.
// Reads from the Phase 1 schema (jobs_v2 + email_tracking) — NOT the old
// 7-table layout. Enrichment lives inside jobs_v2.enrichment (jsonb), and
// every email lifecycle event (sent / opened / replied) lives on a single
// row in email_tracking, so the join is dramatically simpler than before.
//
// Response shape matches the frontend `Job` interface unchanged.

interface JobV2Row {
  job_id: string;
  title: string;
  company: string;
  url: string | null;
  description: string | null;
  location: string | null;
  job_type: string | null;
  posted_at: string | null;
  platform: string;
  method: string;
  scraped_at: string;
  enrichment: {
    email?: string | null;
    name?: string | null;
    title?: string | null;
    linkedin?: string | null;
    company_country?: string | null;
    company_industry?: string | null;
    company_size?: string | null;
    source?: string | null;
    verified?: boolean | null;
  } | null;
  email_status: string | null;
}

interface EmailTrackingRow {
  job_id: string;
  stage: number;
  status: "sent" | "opened" | "replied";
  thread_id: string | null;
  sent_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
  reply_from: string | null;
  reply_snippet: string | null;
}

export async function GET(req: NextRequest) {
  try {
    const db = getSupabaseAdmin();
    const platform = req.nextUrl.searchParams.get("platform") ?? undefined;
    const method = req.nextUrl.searchParams.get("method") ?? undefined;

    // ── 1. Jobs (jobs_v2) ────────────────────────────────────────────────────
    let query = db
      .from("jobs_v2")
      .select(
        "job_id, title, company, url, description, location, job_type, posted_at, platform, method, scraped_at, enrichment, email_status"
      )
      .order("scraped_at", { ascending: false })
      .limit(1000);
    if (platform) query = query.eq("platform", platform);
    if (method) query = query.eq("method", method);

    const { data: jobsData, error: jobsErr } = await query;
    if (jobsErr) {
      return NextResponse.json(
        { success: false, error: jobsErr.message },
        { status: 500 }
      );
    }

    const jobs = ((jobsData ?? []) as JobV2Row[]).filter(
      (j) => j && j.job_id
    );
    if (jobs.length === 0) {
      return NextResponse.json({ success: true, jobs: [] });
    }
    const jobIdList = jobs.map((j) => j.job_id);

    // ── 2. Email tracking — aggregate per job ───────────────────────────────
    const { data: trackingData } = await db
      .from("email_tracking")
      .select(
        "job_id, stage, status, thread_id, sent_at, opened_at, replied_at, reply_from, reply_snippet"
      )
      .in("job_id", jobIdList)
      .order("sent_at", { ascending: false });

    interface TrackAgg {
      stagesSent: number[];
      lastThreadId?: string;
      lastEmailSentAt?: string;
      hasReplied: boolean;
      repliedAt?: string;
      openedCount: number;
      firstOpenedAt?: string;
      lastOpenedAt?: string;
    }
    const trackByJob = new Map<string, TrackAgg>();
    for (const t of (trackingData ?? []) as EmailTrackingRow[]) {
      let agg = trackByJob.get(t.job_id);
      if (!agg) {
        // First (most recent) row sets the latest-send markers.
        agg = {
          stagesSent: [],
          lastThreadId: t.thread_id ?? undefined,
          lastEmailSentAt: t.sent_at ?? undefined,
          hasReplied: false,
          openedCount: 0,
        };
        trackByJob.set(t.job_id, agg);
      }
      if (!agg.stagesSent.includes(t.stage)) agg.stagesSent.push(t.stage);
      if (t.status === "replied" || t.replied_at) {
        agg.hasReplied = true;
        if (!agg.repliedAt || (t.replied_at && t.replied_at > agg.repliedAt)) {
          agg.repliedAt = t.replied_at ?? agg.repliedAt;
        }
      }
      if (t.opened_at) agg.openedCount += 1;
      if (t.opened_at) {
        if (!agg.firstOpenedAt || t.opened_at < agg.firstOpenedAt) agg.firstOpenedAt = t.opened_at;
        if (!agg.lastOpenedAt || t.opened_at > agg.lastOpenedAt) agg.lastOpenedAt = t.opened_at;
      }
    }

    // ── 3. Compose to the frontend Job shape ────────────────────────────────
    const out = jobs.map((j) => {
      const enrich = j.enrichment ?? null;
      const track = trackByJob.get(j.job_id);
      const email = enrich?.email ?? "N/A";
      return {
        title: j.title,
        jobId: j.job_id,
        dbId: j.job_id, // job_id IS the primary key now — same value
        company: j.company,
        email,
        location: j.location || "Remote",
        jobType: j.job_type || "N/A",
        description: j.description || "",
        url: j.url ?? undefined,
        postedAt: j.posted_at ?? undefined,
        platform: j.platform,
        matchScore: 0,
        enriched: enrich
          ? {
              companyDomain: "",
              companyLinkedin: enrich.linkedin || "",
              companyPhone: "",
              companySize: enrich.company_size || "",
              companyCountry: enrich.company_country || "",
              companyIndustry: enrich.company_industry || "",
              candidates: [
                {
                  email: enrich.email || undefined,
                  name: enrich.name || undefined,
                  title: enrich.title || undefined,
                  linkedin: enrich.linkedin || undefined,
                },
              ],
              apolloSearchUrl: "",
              linkedinSearchUrl: "",
            }
          : undefined,
        status: j.email_status ?? "new",
        capturedDate: j.scraped_at,
        emailsSent: track?.stagesSent.length ?? 0,
        lastContactedAt: track?.lastEmailSentAt,
        stagesSent: track?.stagesSent.slice().sort((a, b) => a - b),
        lastThreadId: track?.lastThreadId,
        lastEmailSentAt: track?.lastEmailSentAt,
        hasReplied: track?.hasReplied ?? false,
        repliedAt: track?.repliedAt,
        openedCount: track?.openedCount ?? 0,
        firstOpenedAt: track?.firstOpenedAt,
        lastOpenedAt: track?.lastOpenedAt,
      };
    });

    return NextResponse.json({ success: true, jobs: out });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
