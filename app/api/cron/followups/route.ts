import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin, TABLES } from "@/lib/db/supabase";
import {
  isAuthorizedCron,
  getFollowupThresholds,
  getInternalBaseUrl,
} from "@/lib/cron/auth";

// Cron handler that fires Stage 2 (Case Study) and Stage 3 (Breakup)
// follow-ups based on the email_sends table.
//
// Schedule: every 30 min (configured in vercel.json).
//
// Pipeline:
//   1. Auth check (CRON_SECRET).
//   2. Find Stage 2 candidates: stage=1 sends old enough, no stage=2 row
//      yet for the same job, no reply detected on the thread, no bounce.
//   3. For each: fetch the linked job (description / company / title),
//      call /api/generate-email with stage=2, then /api/send-email with
//      stage=2 and the same threadId so it threads as a reply.
//   4. Repeat for Stage 3 (built off Stage 2 rows).
//   5. Log a row to auto_runs for visibility.

interface SendRow {
  id: string;
  job_id: string | null;
  stage: number;
  to_email: string;
  real_to_email: string | null;
  subject: string;
  thread_id: string | null;
  template_variant: string;
  sent_at: string;
}

interface JobRow {
  id: string;
  title: string;
  company: string;
  description: string | null;
  url: string | null;
}

// Lookup the job row referenced by a Stage 1/2 send. Returns null if the
// send has no job_id (legacy rows from before frontend started passing
// jobId) — those follow-ups must be skipped, since we have no job context
// for personalization.
async function fetchJobForSend(
  db: ReturnType<typeof getSupabaseAdmin>,
  send: SendRow
): Promise<JobRow | null> {
  if (!send.job_id) return null;
  const { data, error } = await db
    .from(TABLES.jobs)
    .select("id, title, company, description, url")
    .eq("id", send.job_id)
    .maybeSingle();
  if (error || !data) return null;
  return data as JobRow;
}

// Has anyone already sent a higher-stage follow-up for this job? Used to
// avoid double-sending Stage 2 if a previous cron run already did it.
async function alreadySentStage(
  db: ReturnType<typeof getSupabaseAdmin>,
  jobId: string,
  stage: number
): Promise<boolean> {
  const { count, error } = await db
    .from(TABLES.emailSends)
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId)
    .eq("stage", stage);
  if (error) return true; // be safe — assume sent on error to avoid duplicates
  return (count ?? 0) > 0;
}

// Has the recipient replied on this thread? Stage 2/3 must be suppressed
// the moment any reply lands, regardless of sentiment.
async function hasThreadReply(
  db: ReturnType<typeof getSupabaseAdmin>,
  threadId: string | null
): Promise<boolean> {
  if (!threadId) return false;
  const { count, error } = await db
    .from(TABLES.emailReplies)
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId);
  if (error) return false;
  return (count ?? 0) > 0;
}

async function generateAndSendStage(opts: {
  baseUrl: string;
  job: JobRow;
  toEmail: string;
  stage: 2 | 3;
  threadId: string | null;
  templateVariant: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { baseUrl, job, toEmail, stage, threadId, templateVariant } = opts;

  // Step A: Generate the email body (Gemini → Groq fallback inside).
  const genRes = await fetch(`${baseUrl}/api/generate-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      job: {
        title: job.title,
        company: job.company,
        description: job.description ?? "",
        url: job.url ?? "",
      },
      companyName: job.company,
      stage,
    }),
  });
  if (!genRes.ok) return { ok: false, error: `generate-email http ${genRes.status}` };
  const genJson = (await genRes.json()) as {
    success: boolean;
    data?: { subject: string; body: string };
    error?: string;
  };
  if (!genJson.success || !genJson.data) {
    return { ok: false, error: genJson.error || "generate-email returned no data" };
  }

  // Step B: Send via existing send-email pipeline. Pass jobId + stage so
  // the new email_sends row links correctly, plus threadId so Gmail threads
  // it as a reply to the Stage 1 conversation.
  const sendRes = await fetch(`${baseUrl}/api/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: toEmail,
      subject: genJson.data.subject,
      body: genJson.data.body,
      stage,
      templateVariant,
      jobId: job.id,
      threadId,
    }),
  });
  if (!sendRes.ok) return { ok: false, error: `send-email http ${sendRes.status}` };
  const sendJson = (await sendRes.json()) as { success: boolean; error?: string };
  if (!sendJson.success) {
    return { ok: false, error: sendJson.error || "send-email failed" };
  }
  return { ok: true };
}

export async function GET(req: NextRequest) {
  const startedAt = new Date();
  if (!isAuthorizedCron(req)) {
    return NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 });
  }

  const db = getSupabaseAdmin();
  const baseUrl = getInternalBaseUrl();
  const { stage2MinAgeMs, stage3MinAgeMs } = getFollowupThresholds();

  let stage2Sent = 0;
  let stage3Sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  // ── STAGE 2 PASS ─────────────────────────────────────────────────────────
  const stage2Cutoff = new Date(Date.now() - stage2MinAgeMs).toISOString();
  const { data: s1Sends, error: s1Err } = await db
    .from(TABLES.emailSends)
    .select(
      "id, job_id, stage, to_email, real_to_email, subject, thread_id, template_variant, sent_at"
    )
    .eq("stage", 1)
    .lt("sent_at", stage2Cutoff)
    .not("job_id", "is", null)
    .order("sent_at", { ascending: true })
    .limit(50);

  if (s1Err) {
    errors.push(`stage2 query: ${s1Err.message}`);
  }

  for (const send of (s1Sends ?? []) as SendRow[]) {
    if (!send.job_id) {
      skipped++;
      continue;
    }
    if (await alreadySentStage(db, send.job_id, 2)) {
      skipped++;
      continue;
    }
    if (await hasThreadReply(db, send.thread_id)) {
      skipped++;
      continue;
    }
    const job = await fetchJobForSend(db, send);
    if (!job) {
      skipped++;
      continue;
    }
    const result = await generateAndSendStage({
      baseUrl,
      job,
      toEmail: send.real_to_email || send.to_email,
      stage: 2,
      threadId: send.thread_id,
      templateVariant: send.template_variant || "A",
    });
    if (result.ok) {
      stage2Sent++;
    } else {
      errors.push(`s2 job=${send.job_id}: ${result.error}`);
    }
  }

  // ── STAGE 3 PASS ─────────────────────────────────────────────────────────
  const stage3Cutoff = new Date(Date.now() - stage3MinAgeMs).toISOString();
  const { data: s2Sends, error: s2Err } = await db
    .from(TABLES.emailSends)
    .select(
      "id, job_id, stage, to_email, real_to_email, subject, thread_id, template_variant, sent_at"
    )
    .eq("stage", 2)
    .lt("sent_at", stage3Cutoff)
    .not("job_id", "is", null)
    .order("sent_at", { ascending: true })
    .limit(50);

  if (s2Err) {
    errors.push(`stage3 query: ${s2Err.message}`);
  }

  for (const send of (s2Sends ?? []) as SendRow[]) {
    if (!send.job_id) {
      skipped++;
      continue;
    }
    if (await alreadySentStage(db, send.job_id, 3)) {
      skipped++;
      continue;
    }
    if (await hasThreadReply(db, send.thread_id)) {
      skipped++;
      continue;
    }
    const job = await fetchJobForSend(db, send);
    if (!job) {
      skipped++;
      continue;
    }
    const result = await generateAndSendStage({
      baseUrl,
      job,
      toEmail: send.real_to_email || send.to_email,
      stage: 3,
      threadId: send.thread_id,
      templateVariant: send.template_variant || "A",
    });
    if (result.ok) {
      stage3Sent++;
    } else {
      errors.push(`s3 job=${send.job_id}: ${result.error}`);
    }
  }

  const summary = {
    stage2Sent,
    stage3Sent,
    skipped,
    errors: errors.length,
    durationMs: Date.now() - startedAt.getTime(),
  };

  // Persist the run for ops visibility — short truncated log keeps the column small.
  try {
    await db.from(TABLES.autoRuns).insert({
      cron_type: "followup",
      started_at: startedAt.toISOString(),
      ended_at: new Date().toISOString(),
      emails_sent: stage2Sent + stage3Sent,
      errors: errors.length,
      log: errors.slice(0, 5).join(" | ").slice(0, 4000) || "ok",
    });
  } catch {
    /* ignore log write failure */
  }

  console.log(`[cron/followups]`, summary);
  return NextResponse.json({ success: true, ...summary, errors });
}

// POST is allowed too so manual `curl -X POST` testing works the same.
export const POST = GET;
