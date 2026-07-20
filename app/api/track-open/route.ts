import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/db/supabase";

// Records every email open into the new email_tracking row keyed by
// tracking_id. The same row carries sent / opened / replied state, so an
// open just bumps open_count, sets opened_at on the first hit, and flips
// status to 'opened' (unless the row already advanced to 'replied' — that's
// terminal and wins). Also propagates email_status='opened' to jobs_v2 so
// the dashboard badge updates.
//
// The endpoint must always return the 1×1 GIF — DB write failures are
// logged but never block the response, so a Supabase outage doesn't break
// tracking pixels embedded in already-sent emails.

const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

export async function GET(req: NextRequest) {
  const trackingId = req.nextUrl.searchParams.get("id") || "";

  if (trackingId) {
    try {
      const db = getSupabaseAdmin();
      // Read the current row so we can correctly increment open_count and
      // preserve a 'replied' status (replies are terminal — opens shouldn't
      // demote them back to 'opened').
      const { data: existing, error: readErr } = await db
        .from("email_tracking")
        .select("id, job_id, status, opened_at")
        .eq("tracking_id", trackingId)
        .maybeSingle();

      if (readErr || !existing) {
        console.warn(
          `[track-open] no email_tracking row for trackingId=${trackingId}`,
          readErr?.message
        );
      } else {
        const nowIso = new Date().toISOString();
        // Replied is terminal — never demote a 'replied' row to 'opened'.
        const nextStatus =
          existing.status === "replied" ? "replied" : "opened";
        const update: Record<string, unknown> = {
          status: nextStatus,
          updated_at: nowIso,
        };
        // Stamp opened_at only on the FIRST open. updated_at moves on every hit
        // so we still know when the most recent open occurred.
        if (!existing.opened_at) update.opened_at = nowIso;

        const { error: updErr } = await db
          .from("email_tracking")
          .update(update)
          .eq("id", existing.id);
        if (updErr) {
          console.warn("[track-open] email_tracking update failed:", updErr.message);
        } else {
          console.log(`[track-open] ✉️  open recorded · trackingId=${trackingId}`);
        }

        // Propagate to jobs_v2 — but never overwrite a 'replied' lifecycle.
        if (existing.job_id && nextStatus === "opened") {
          const { error: jobErr } = await db
            .from("jobs_v2")
            .update({ email_status: "opened", updated_at: nowIso })
            .eq("job_id", existing.job_id)
            .neq("email_status", "replied");
          if (jobErr) {
            console.warn("[track-open] jobs_v2 status update failed:", jobErr.message);
          }
        }
      }
    } catch (err) {
      // Never let DB issues break the pixel response — email clients re-fetch.
      console.warn("[track-open] persist error:", (err as Error).message);
    }
  }

  return new NextResponse(TRANSPARENT_GIF, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(TRANSPARENT_GIF.length),
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}
