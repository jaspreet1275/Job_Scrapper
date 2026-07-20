import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, TABLES } from "@/lib/db/supabase";

// Per-email drill-down behind the Analytics funnel's "Emails Sent" and
// "Opened" stat cards. The funnel route (/api/analytics/funnel) only returns
// COUNTS; this returns the actual email_tracking ROWS (joined to their job)
// for the same IST date window, so the dashboard can pop a modal listing each
// email + the job it belongs to.
//
//   GET /api/analytics/events?type=sent|opened&from=YYYY-MM-DD&to=YYYY-MM-DD
//
//   type=sent   → rows whose sent_at   falls in the window (ordered newest-first)
//   type=opened → rows whose opened_at falls in the window (ordered newest-first)
//
// Each row carries the linked job's title / url / platform (embedded from
// jobs_v2 via the email_tracking.job_id FK) so the UI can render a clickable
// job title that opens the original posting — exactly like the All Jobs page.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIST(): string {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

interface JobEmbed {
  title: string | null;
  url: string | null;
  platform: string | null;
}

interface TrackingRow {
  id: string;
  job_id: string | null;
  to_email: string | null;
  subject: string | null;
  stage: number | null;
  status: string | null;
  sent_at: string | null;
  opened_at: string | null;
  // PostgREST embeds a to-one FK as an object (or null when the FK is null).
  jobs_v2: JobEmbed | JobEmbed[] | null;
}

export async function GET(req: NextRequest) {
  try {
    const type = req.nextUrl.searchParams.get("type") === "opened" ? "opened" : "sent";

    const fromParam = req.nextUrl.searchParams.get("from");
    const toParam = req.nextUrl.searchParams.get("to");
    const fallback = todayIST();
    const from = fromParam && ISO_DATE_RE.test(fromParam) ? fromParam : fallback;
    let to = toParam && ISO_DATE_RE.test(toParam) ? toParam : fallback;
    if (to < from) to = from;

    const fromUtc = new Date(`${from}T00:00:00+05:30`).toISOString();
    const toUtc = new Date(`${to}T23:59:59.999+05:30`).toISOString();

    // Window the same column the funnel counts: sent_at for "sent", opened_at
    // for "opened". opened rows additionally require a non-null opened_at.
    const dateCol = type === "opened" ? "opened_at" : "sent_at";

    const db = getSupabaseAdmin();
    let query = db
      .from(TABLES.emailTracking)
      .select(
        "id, job_id, to_email, subject, stage, status, sent_at, opened_at, jobs_v2(title, url, platform)"
      )
      .gte(dateCol, fromUtc)
      .lte(dateCol, toUtc)
      .order(dateCol, { ascending: false })
      .limit(500);
    if (type === "opened") {
      query = query.not("opened_at", "is", null);
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    const rows = (data ?? []) as unknown as TrackingRow[];
    const events = rows.map((r) => {
      // Normalise the embed to a single object (PostgREST may hand back either
      // shape depending on how it infers the relationship).
      const job = Array.isArray(r.jobs_v2) ? r.jobs_v2[0] ?? null : r.jobs_v2;
      return {
        id: r.id,
        jobId: r.job_id,
        toEmail: r.to_email,
        subject: r.subject,
        stage: r.stage,
        status: r.status,
        sentAt: r.sent_at,
        openedAt: r.opened_at,
        jobTitle: job?.title ?? null,
        jobUrl: job?.url ?? null,
        platform: job?.platform ?? null,
      };
    });

    return NextResponse.json({
      success: true,
      type,
      from,
      to,
      total: events.length,
      events,
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
