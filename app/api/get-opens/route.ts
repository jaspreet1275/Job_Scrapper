import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/supabase";

// Returns aggregated open events from email_tracking so the dashboard
// can attribute opens to saved jobs. Reads from the unified email_tracking
// table where open_count and opened_at live on the same row as the send,
// so this is a single SELECT with no joins — much simpler than the old
// version that aggregated email_opens against email_sends.

interface Aggregate {
  trackingId: string;
  openedCount: number;
  firstOpenedAt: string;
  lastOpenedAt: string;
}

interface TrackingRow {
  tracking_id: string | null;
  opened_at: string | null;
  updated_at: string | null;
}

export async function GET() {
  try {
    const db = getSupabaseAdmin();
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();

    // Pull rows that have been opened in the last 30 days. open_count was
    // dropped from the schema — opened_at is enough to know "yes, opened",
    // and updated_at moves with every subsequent hit so it doubles as the
    // last-open timestamp.
    const { data, error } = await db
      .from("email_tracking")
      .select("tracking_id, opened_at, updated_at")
      .not("opened_at", "is", null)
      .gte("opened_at", thirtyDaysAgo);

    if (error) {
      console.warn("[get-opens] email_tracking fetch failed:", error.message);
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }

    const rows = (data ?? []) as TrackingRow[];
    const aggregates: Aggregate[] = [];
    for (const r of rows) {
      if (!r.tracking_id || !r.opened_at) continue;
      aggregates.push({
        trackingId: r.tracking_id,
        // Without open_count we report 1 per row that registered an open.
        // The dashboard's "openedCount" indicator becomes "opened?" boolean.
        openedCount: 1,
        firstOpenedAt: r.opened_at,
        lastOpenedAt: r.updated_at ?? r.opened_at,
      });
    }

    return NextResponse.json({
      success: true,
      total: aggregates.length,
      uniqueOpens: aggregates.length,
      aggregates,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
