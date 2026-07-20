import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, TABLES } from "@/lib/db/supabase";
import { isAuthorizedCron } from "@/lib/cron/auth";

// Bearer-gated read of the singleton settings row, exposed under
// /api/cron/* (which is whitelisted in middleware so curl from GitHub
// Actions actually reaches it instead of getting 307'd to /login). The
// cron-scrape workflow's gate step reads daily_schedule_times from here
// to decide whether the current scheduled fire matches a user-picked
// slot. The dashboard's mutation surface is still POST /api/settings.
export async function GET(req: NextRequest) {
  if (!isAuthorizedCron(req)) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from(TABLES.settings)
      .select("daily_schedule_times")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
