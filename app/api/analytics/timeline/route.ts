import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/supabase";

// Daily-count timeseries for the Analytics line chart.
//
//   GET /api/analytics/timeline?days=7
//
// Returns one bucket per IST calendar date in the trailing window
// (`days` defaults to 7, range 1-90). Three series per bucket:
//   - enriched : jobs_v2.enriched_at falls on this date
//   - sent     : email_tracking.sent_at  falls on this date
//   - opened   : email_tracking.opened_at falls on this date
//
// All bucketing is IST (UTC+5:30) because the rest of the dashboard
// (cron windows, parse-gmail arrival filter, today/week stat cards) is
// IST. Bucketing in UTC would shift the chart's "today" by 5.5h relative
// to the rest of the page.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_PER_DAY = 86400000;
const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;

interface Bucket {
  date: string; // YYYY-MM-DD (IST)
  enriched: number;
  sent: number;
  opened: number;
}

function toISTDateString(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

// Build the bucket array for a [fromIST, toIST] window (inclusive).
// Pre-seeded with zeros so days with no activity still appear on the X
// axis. `fromIST` must be <= `toIST` and both must be YYYY-MM-DD.
function buildBucketsForRange(
  fromIST: string,
  toIST: string
): { buckets: Bucket[]; index: Map<string, Bucket> } {
  const buckets: Bucket[] = [];
  const index = new Map<string, Bucket>();
  // Walk day-by-day starting at noon UTC of `fromIST` so DST boundaries
  // don't shift the count. Each iteration adds 24h and re-bucketizes.
  let cursor = new Date(`${fromIST}T12:00:00+05:30`).getTime();
  const end = new Date(`${toIST}T12:00:00+05:30`).getTime();
  while (cursor <= end) {
    const date = toISTDateString(new Date(cursor));
    const bucket: Bucket = { date, enriched: 0, sent: 0, opened: 0 };
    buckets.push(bucket);
    index.set(date, bucket);
    cursor += MS_PER_DAY;
  }
  return { buckets, index };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  try {
    // Two accepted query shapes:
    //   ?from=YYYY-MM-DD&to=YYYY-MM-DD   → explicit IST window (preferred)
    //   ?days=N                          → trailing N days ending today
    // Defaults to the last 7 days if nothing is passed.
    const fromParam = req.nextUrl.searchParams.get("from");
    const toParam = req.nextUrl.searchParams.get("to");
    let fromIST: string;
    let toIST: string;
    if (fromParam && toParam && ISO_DATE_RE.test(fromParam) && ISO_DATE_RE.test(toParam)) {
      fromIST = fromParam;
      toIST = toParam;
      if (toIST < fromIST) toIST = fromIST; // swap-protect
    } else {
      const requested = parseInt(
        req.nextUrl.searchParams.get("days") || String(DEFAULT_DAYS),
        10
      );
      const days = Math.min(
        MAX_DAYS,
        Math.max(1, isNaN(requested) ? DEFAULT_DAYS : requested)
      );
      const todayMs = Date.now();
      toIST = toISTDateString(new Date(todayMs));
      fromIST = toISTDateString(new Date(todayMs - (days - 1) * MS_PER_DAY));
    }

    const { buckets, index } = buildBucketsForRange(fromIST, toIST);

    // Lower bound: start-of-day UTC for the earliest IST date in the window,
    // upper bound: end-of-day UTC for the latest. Both queries clamp to
    // this window so the chart's totals reflect exactly the picked range.
    const earliestUtc = new Date(`${fromIST}T00:00:00+05:30`).toISOString();
    const latestUtc = new Date(`${toIST}T23:59:59.999+05:30`).toISOString();

    const db = getSupabaseAdmin();

    // 1. Enriched per day — jobs_v2.enriched_at, bucketed by IST date.
    const enrichedRes = await db
      .from("jobs_v2")
      .select("enriched_at")
      .not("enriched_at", "is", null)
      .gte("enriched_at", earliestUtc)
      .lte("enriched_at", latestUtc);
    if (enrichedRes.error) {
      return NextResponse.json(
        { success: false, error: enrichedRes.error.message },
        { status: 500 }
      );
    }
    for (const row of enrichedRes.data ?? []) {
      const ts = row.enriched_at as string | null;
      if (!ts) continue;
      const date = toISTDateString(new Date(ts));
      const b = index.get(date);
      if (b) b.enriched += 1;
    }

    // 2. Sent per day — email_tracking.sent_at.
    const sentRes = await db
      .from("email_tracking")
      .select("sent_at")
      .not("sent_at", "is", null)
      .gte("sent_at", earliestUtc)
      .lte("sent_at", latestUtc);
    if (sentRes.error) {
      return NextResponse.json(
        { success: false, error: sentRes.error.message },
        { status: 500 }
      );
    }
    for (const row of sentRes.data ?? []) {
      const ts = row.sent_at as string | null;
      if (!ts) continue;
      const date = toISTDateString(new Date(ts));
      const b = index.get(date);
      if (b) b.sent += 1;
    }

    // 3. Opened per day — email_tracking.opened_at. Only set on the first
    // open (single timestamp per send), so this counts unique opened
    // emails per day, not pixel hits.
    const openedRes = await db
      .from("email_tracking")
      .select("opened_at")
      .not("opened_at", "is", null)
      .gte("opened_at", earliestUtc)
      .lte("opened_at", latestUtc);
    if (openedRes.error) {
      return NextResponse.json(
        { success: false, error: openedRes.error.message },
        { status: 500 }
      );
    }
    for (const row of openedRes.data ?? []) {
      const ts = row.opened_at as string | null;
      if (!ts) continue;
      const date = toISTDateString(new Date(ts));
      const b = index.get(date);
      if (b) b.opened += 1;
    }

    return NextResponse.json({
      success: true,
      data: buckets,
      from: fromIST,
      to: toIST,
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
