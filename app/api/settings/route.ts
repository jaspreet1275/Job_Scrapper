import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, TABLES } from "@/lib/db/supabase";

// Bridges the dashboard UI to the singleton settings row in Supabase. The
// cron jobs (scrape, followups) read auto_mode_enabled / daily_send_limit
// from this row, so the toggle in the UI must update DB — not just local
// state — for server-side automation to actually flip ON or OFF.
//
// GET  /api/settings        → current settings
// POST /api/settings { ... } → patch one or more allowed fields

interface SettingsRow {
  id: number;
  auto_mode_enabled: boolean;
  daily_send_limit: number;
  send_window_start_hour: number;
  // Scrape-page knobs added in 0005_scrape_settings.sql.
  max_emails_per_run: number | null;
  platform_filter: string | null;
  daily_schedule_hour: number | null;
  // Multi-time daily schedule (added in 0004_schedule_times.sql). Array of
  // IST "HH:MM" strings; empty array means the scheduler is off.
  daily_schedule_times: string[] | null;
  technologies: string[] | null;
  // Which Gmail account(s) parse-gmail should read from (added in
  // 0005_multi_gmail_accounts.sql). One of 'both' | 'employee1' | 'employee'.
  parse_gmail_selection: string | null;
  last_scrape_at: string | null;
  last_followup_check_at: string | null;
  last_reply_check_at: string | null;
  updated_at: string;
}

// Whitelist of fields that can be patched via POST. Other DB columns
// (gmail_refresh_token, last_*) are managed internally and must not be
// settable from the public API.
const ALLOWED_PATCH_FIELDS = new Set([
  "auto_mode_enabled",
  "daily_send_limit",
  "send_window_start_hour",
  // Scrape Settings panel fields.
  "max_emails_per_run",
  "platform_filter",
  "daily_schedule_hour",
  "daily_schedule_times",
  "technologies",
  // Multi-Gmail account selector.
  "parse_gmail_selection",
]);

export async function GET() {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from(TABLES.settings)
      .select(
        "id, auto_mode_enabled, daily_send_limit, send_window_start_hour, max_emails_per_run, platform_filter, daily_schedule_hour, daily_schedule_times, technologies, parse_gmail_selection, last_scrape_at, last_followup_check_at, last_reply_check_at, updated_at"
      )
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true, data: (data ?? null) as SettingsRow | null });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (ALLOWED_PATCH_FIELDS.has(k)) patch[k] = v;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { success: false, error: "No allowed fields in body" },
        { status: 400 }
      );
    }
    patch.updated_at = new Date().toISOString();

    const db = getSupabaseAdmin();
    // Upsert (not update) — the singleton settings row may not exist yet
    // (it is never seeded), and a plain UPDATE would silently match 0 rows
    // so nothing would persist.
    const { data, error } = await db
      .from(TABLES.settings)
      .upsert({ id: 1, ...patch }, { onConflict: "id" })
      .select()
      .maybeSingle();
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    console.log("[settings] patched:", Object.keys(patch).join(", "));
    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
