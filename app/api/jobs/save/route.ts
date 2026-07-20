import { NextRequest, NextResponse } from "next/server";
import { persistScrapedJobs } from "@/lib/db/jobs-persist";
import { getSupabaseAdmin, TABLES } from "@/lib/db/supabase";

// POST /api/jobs/save
//
// Explicit "save these jobs to the DB" endpoint, used by the dashboard's
// per-row Save button and the Save-All button on the Scrape Jobs page.
//
// The split exists because /api/parse-gmail and /api/scrape-remoteok now
// support `saveToDb: false`, so a manual Run Scrape Now returns rows
// WITHOUT writing them. This endpoint is the deliberate write path —
// only the rows the user picked land in jobs_v2 (and downstream cron
// drain picks them up for enrichment + outreach).
//
// Cron / Auto-Scrape paths do NOT need this endpoint; they keep using
// saveToDb=true on the source routes and persist in one shot.
//
// Body:
//   { jobs: ScrapedJob[] }   - 1+ jobs to persist
// Returns:
//   { success, savedCount }

interface SaveBody {
  jobs?: Array<{
    title?: string;
    jobId?: string;
    company?: string;
    email?: string;
    location?: string;
    jobType?: string;
    description?: string;
    url?: string;
    postedAt?: string;
    platform?: string;
  }>;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as SaveBody;
    const jobs = Array.isArray(body.jobs) ? body.jobs : [];

    if (jobs.length === 0) {
      return NextResponse.json(
        { success: false, error: "No jobs in body to save" },
        { status: 400 }
      );
    }

    // Defensive normalisation — persistScrapedJobs expects each row to have
    // a real jobId, title and company at minimum. Skip anything missing
    // those rather than letting the DB layer choke on it.
    type ScrapedJob = Parameters<typeof persistScrapedJobs>[0][number];
    const cleaned: ScrapedJob[] = jobs
      .filter(
        (j) =>
          j &&
          typeof j.jobId === "string" &&
          j.jobId.length > 0 &&
          typeof j.title === "string" &&
          typeof j.company === "string"
      )
      .map((j) => ({
        title: j.title ?? "",
        jobId: j.jobId ?? "",
        company: j.company ?? "",
        email: j.email ?? "N/A",
        location: j.location ?? "",
        jobType: j.jobType ?? "",
        description: j.description ?? "",
        url: j.url ?? "",
        postedAt: j.postedAt ?? "",
        platform: j.platform ?? "Manual Save",
      }));

    if (cleaned.length === 0) {
      return NextResponse.json(
        { success: false, error: "No valid jobs after normalisation" },
        { status: 400 }
      );
    }

    await persistScrapedJobs(cleaned);

    // Update last_scrape_at — the user saving a curated set is functionally
    // the end of a manual run, so the dashboard's "Last Run" stat should
    // tick over the same way it would for auto-save.
    try {
      const db = getSupabaseAdmin();
      await db
        .from(TABLES.settings)
        .update({ last_scrape_at: new Date().toISOString() })
        .eq("id", 1);
    } catch (e) {
      console.warn("[jobs-save] last_scrape_at update failed:", e);
    }

    return NextResponse.json({ success: true, savedCount: cleaned.length });
  } catch (err) {
    console.error("[jobs-save] error:", err);
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
