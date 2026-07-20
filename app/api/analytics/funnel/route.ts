import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/supabase";

// Outreach-funnel counts for a configurable IST date window.
//
//   GET /api/analytics/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// `from` and `to` are inclusive IST calendar dates. Set them equal for a
// single-day view; pass different values for a range. Both default to
// today (IST) if omitted, matching the Analytics page's initial state.
//
// Each metric counts EVENTS in the window (not jobs):
//   sent     = COUNT(email_tracking.sent_at    in window)
//   opened   = COUNT(email_tracking.opened_at  in window)
//   replied  = COUNT(email_tracking.replied_at in window)
//   openRate  = opened  / sent * 100   (0 if sent === 0)
//   replyRate = replied / sent * 100   (0 if sent === 0)
//
// Note: the rates are intentionally based on events in the SAME window,
// not cohorts. If 8 emails were sent today and 2 of today's opens came
// from older sends, openRate = 25% — the page is showing daily activity,
// not per-cohort conversion.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIST(): string {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  try {
    const fromParam = req.nextUrl.searchParams.get("from");
    const toParam = req.nextUrl.searchParams.get("to");
    const fallback = todayIST();
    const from = fromParam && ISO_DATE_RE.test(fromParam) ? fromParam : fallback;
    let to = toParam && ISO_DATE_RE.test(toParam) ? toParam : fallback;

    // If `to` ended up before `from` we silently swap so the query still
    // returns useful data instead of an empty window — protects the UI
    // from a state where the user dragged the range backwards.
    if (to < from) {
      to = from;
    }

    const fromUtc = new Date(`${from}T00:00:00+05:30`).toISOString();
    const toUtc = new Date(`${to}T23:59:59.999+05:30`).toISOString();

    const db = getSupabaseAdmin();

    // Three head-only count queries — no rows shipped over the wire.
    const sentRes = await db
      .from("email_tracking")
      .select("id", { count: "exact", head: true })
      .gte("sent_at", fromUtc)
      .lte("sent_at", toUtc);
    if (sentRes.error) {
      return NextResponse.json(
        { success: false, error: sentRes.error.message },
        { status: 500 }
      );
    }

    const openedRes = await db
      .from("email_tracking")
      .select("id", { count: "exact", head: true })
      .not("opened_at", "is", null)
      .gte("opened_at", fromUtc)
      .lte("opened_at", toUtc);
    if (openedRes.error) {
      return NextResponse.json(
        { success: false, error: openedRes.error.message },
        { status: 500 }
      );
    }

    const repliedRes = await db
      .from("email_tracking")
      .select("id", { count: "exact", head: true })
      .not("replied_at", "is", null)
      .gte("replied_at", fromUtc)
      .lte("replied_at", toUtc);
    if (repliedRes.error) {
      return NextResponse.json(
        { success: false, error: repliedRes.error.message },
        { status: 500 }
      );
    }

    const sent = sentRes.count ?? 0;
    const opened = openedRes.count ?? 0;
    const replied = repliedRes.count ?? 0;
    const openRate = sent > 0 ? Number(((opened / sent) * 100).toFixed(1)) : 0;
    const replyRate = sent > 0 ? Number(((replied / sent) * 100).toFixed(1)) : 0;

    return NextResponse.json({
      success: true,
      data: { sent, opened, openRate, replied, replyRate, from, to },
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
