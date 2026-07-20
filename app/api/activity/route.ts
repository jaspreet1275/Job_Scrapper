import { NextResponse } from "next/server";
import { getSupabaseAdmin, TABLES } from "@/lib/db/supabase";

// Recent Activity feed for the Scrape Jobs page. Derives entries from
// canonical DB tables instead of in-memory state so refreshing the page
// (or opening it on a different device) shows the same log.
//
// Two sources:
//   1. jobs_v2.scraped_at  → "Daily scrape complete — +N new jobs"
//      grouped by IST date.
//   2. email_tracking.sent_at  → "Outreach sent — N emails" grouped
//      by IST date (only days where at least one send happened).
//
// Returns the most recent ~5 entries, newest first. Each entry has:
//   { time: 'Today' | 'Yesterday' | '6 May', kind, label, count }

export const dynamic = "force-dynamic";

interface ActivityEntry {
  time: string;
  kind: "scrape" | "send";
  label: string;
  count: number;
}

// Convert UTC timestamp → IST date key (YYYY-MM-DD). DB stores UTC
// so we shift by +5:30 before slicing the date out.
function istDateKey(utc: string): string {
  const d = new Date(utc);
  const istMs = d.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().split("T")[0];
}

function relativeLabel(dateKey: string): string {
  const today = istDateKey(new Date().toISOString());
  const yesterdayKey = istDateKey(
    new Date(Date.now() - 86_400_000).toISOString()
  );
  if (dateKey === today) return "Today";
  if (dateKey === yesterdayKey) return "Yesterday";
  return new Date(dateKey).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
  });
}

export async function GET() {
  try {
    const db = getSupabaseAdmin();

    // Last 14 days is enough for "recent" — saves us pulling the whole
    // table on accounts that have months of history.
    const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();

    const [{ data: jobs, error: jobsErr }, { data: emails, error: emailsErr }] =
      await Promise.all([
        db
          .from(TABLES.jobs)
          .select("scraped_at")
          .gte("scraped_at", cutoff)
          .order("scraped_at", { ascending: false })
          .limit(2000),
        db
          .from(TABLES.emailTracking)
          .select("sent_at")
          .gte("sent_at", cutoff)
          .not("sent_at", "is", null)
          .order("sent_at", { ascending: false })
          .limit(2000),
      ]);

    if (jobsErr) {
      return NextResponse.json(
        { success: false, error: jobsErr.message },
        { status: 500 }
      );
    }
    if (emailsErr) {
      return NextResponse.json(
        { success: false, error: emailsErr.message },
        { status: 500 }
      );
    }

    // Group counts by IST date key.
    const scrapeByDay: Record<string, number> = {};
    for (const row of jobs ?? []) {
      if (!row.scraped_at) continue;
      const key = istDateKey(row.scraped_at);
      scrapeByDay[key] = (scrapeByDay[key] || 0) + 1;
    }
    const sendByDay: Record<string, number> = {};
    for (const row of emails ?? []) {
      if (!row.sent_at) continue;
      const key = istDateKey(row.sent_at);
      sendByDay[key] = (sendByDay[key] || 0) + 1;
    }

    // Build entries with their actual ISO date so we can sort properly. The
    // human-readable label is applied AFTER sorting — the old code only knew
    // "Today/Yesterday/other" and lumped every older day into one bucket,
    // which left May 22 / May 25 in arbitrary order on the panel.
    type Tmp = ActivityEntry & { date: string };
    const tmp: Tmp[] = [];
    for (const [date, count] of Object.entries(scrapeByDay)) {
      tmp.push({
        time: relativeLabel(date),
        kind: "scrape",
        label: "Daily scrape complete",
        count,
        date,
      });
    }
    for (const [date, count] of Object.entries(sendByDay)) {
      tmp.push({
        time: relativeLabel(date),
        kind: "send",
        label: "Outreach sent",
        count,
        date,
      });
    }

    // Sort: newest date first, and on the same day put scrape above send.
    tmp.sort((a, b) => {
      if (a.date !== b.date) return a.date > b.date ? -1 : 1;
      return a.kind === "scrape" ? -1 : 1;
    });

    const entries: ActivityEntry[] = tmp.map(({ date: _d, ...rest }) => {
      void _d;
      return rest;
    });

    return NextResponse.json({
      success: true,
      entries: entries.slice(0, 8),
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
