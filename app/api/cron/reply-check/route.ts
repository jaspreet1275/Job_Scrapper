import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { getSupabaseAdmin } from "@/lib/db/supabase";
import { isAuthorizedCron } from "@/lib/cron/auth";
import { getAuthenticatedClient } from "@/lib/email/gmail";

// Cron handler that polls Gmail threads we've already sent into and records
// any new replies onto the matching email_tracking row. The dashboard's
// Smart Send button suppresses Stage 2/3 the moment it sees status='replied'
// on an email_tracking row for that job.
//
// Pipeline:
//   1. Auth check (CRON_SECRET).
//   2. Pull active thread_ids from email_tracking (last 14 days, status not
//      already 'replied').
//   3. Resolve our own Gmail address once so we can ignore self-sends.
//   4. For each thread, check if any message has a From != us → that's a reply.
//   5. Update email_tracking row: status='replied', replied_at, reply_from,
//      reply_snippet. Also flip jobs_v2.email_status to 'replied'.

const LOOKBACK_DAYS = 14;
const MAX_PER_RUN = 30;

interface TrackingRow {
  id: string;
  thread_id: string | null;
  job_id: string;
  status: string;
}

export async function GET(req: NextRequest) {
  const startedAt = new Date();
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getSupabaseAdmin();

  // ── 1. Collect distinct active thread_ids from email_tracking ─────────────
  const cutoffISO = new Date(
    Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: trackRows, error: trackErr } = await db
    .from("email_tracking")
    .select("id, thread_id, job_id, status")
    .not("thread_id", "is", null)
    .neq("status", "replied")
    .gte("sent_at", cutoffISO)
    .limit(500);

  if (trackErr) {
    console.warn("[cron/reply-check] email_tracking query failed:", trackErr.message);
    return NextResponse.json(
      { success: false, error: trackErr.message },
      { status: 500 }
    );
  }

  // Dedupe — a single thread can have 1-3 sends (Stage 1 / 2 / 3) all sharing
  // the same thread_id. Keep the most recent stage's row id so the reply
  // update lands on the latest send for that thread.
  const threadMap = new Map<string, TrackingRow>();
  for (const row of (trackRows ?? []) as TrackingRow[]) {
    if (!row.thread_id) continue;
    if (!threadMap.has(row.thread_id)) {
      threadMap.set(row.thread_id, row);
    }
  }

  const threadIds = Array.from(threadMap.keys());
  if (threadIds.length === 0) {
    return NextResponse.json({
      success: true,
      threadsChecked: 0,
      newReplies: 0,
      durationMs: Date.now() - startedAt.getTime(),
    });
  }

  // ── 2. Auth Gmail + resolve self-email ────────────────────────────────────
  let auth;
  try {
    auth = await getAuthenticatedClient();
  } catch (err) {
    console.warn("[cron/reply-check] gmail auth failed:", (err as Error).message);
    return NextResponse.json(
      { success: false, error: "gmail not connected" },
      { status: 500 }
    );
  }
  const gmail = google.gmail({ version: "v1", auth });

  let selfEmail = "";
  try {
    const profile = await gmail.users.getProfile({ userId: "me" });
    selfEmail = (profile.data.emailAddress || "").toLowerCase();
  } catch {
    /* falling through means everything looks like a reply — over-eager
       but safe (worst case we stop sending) */
  }

  // ── 3. Walk threads, detect replies ───────────────────────────────────────
  const slice = threadIds.slice(0, MAX_PER_RUN);
  const errors: string[] = [];
  let newReplyCount = 0;

  for (const threadId of slice) {
    const trackingRow = threadMap.get(threadId);
    if (!trackingRow) continue;
    try {
      const tres = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["From", "Message-ID"],
      });
      const messages = tres.data.messages || [];
      let detectedReply: { from: string; messageId: string | null; snippet: string } | null = null;

      for (const m of messages) {
        const headers = m.payload?.headers || [];
        const fromHeader = headers.find((h) => h.name === "From")?.value || "";
        const fromMatch =
          fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([^\s]+@[^\s]+)/);
        const from = (fromMatch?.[1] || "").toLowerCase().trim();
        if (!from || from === selfEmail) continue;

        const messageId =
          headers.find((h) => h.name === "Message-ID")?.value || null;
        detectedReply = {
          from,
          messageId,
          snippet: (m.snippet || "").slice(0, 280),
        };
        break;
      }

      if (!detectedReply) continue;

      // Update email_tracking row → status='replied' (terminal).
      const repliedAt = new Date().toISOString();
      const { error: updErr } = await db
        .from("email_tracking")
        .update({
          status: "replied",
          replied_at: repliedAt,
          reply_from: detectedReply.from,
          reply_snippet: detectedReply.snippet,
          updated_at: repliedAt,
        })
        .eq("id", trackingRow.id);
      if (updErr) {
        errors.push(`tracking update ${threadId}: ${updErr.message}`);
        continue;
      }

      // Propagate to jobs_v2 — terminal state, always wins.
      const { error: jobErr } = await db
        .from("jobs_v2")
        .update({ email_status: "replied", updated_at: repliedAt })
        .eq("job_id", trackingRow.job_id);
      if (jobErr) {
        errors.push(`jobs_v2 update ${trackingRow.job_id}: ${jobErr.message}`);
      }

      newReplyCount += 1;
    } catch (err) {
      errors.push(`${threadId}: ${(err as Error).message}`);
    }
  }

  const summary = {
    threadsChecked: slice.length,
    newReplies: newReplyCount,
    skippedAlreadyReplied: 0, // pre-filtered via .neq("status", "replied")
    errors: errors.length,
    durationMs: Date.now() - startedAt.getTime(),
    debug: { selfEmail },
  };
  console.log("[cron/reply-check]", summary);
  return NextResponse.json({ success: true, ...summary, errors });
}

export const POST = GET;
