import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getSupabaseAdmin } from "@/lib/db/supabase";
import { htmlToText } from "@/lib/utils/html-to-text";

// Resend Inbound webhook → reply detection.
//
// Flow (see project discussion):
//   1. We send cold outreach via Resend  →  From: info@kodionsoftwares.com
//   2. Recruiter replies  →  lands in the info@ Google Workspace inbox
//   3. A Gmail forwarding rule copies every inbound mail to
//      reply@inbound.kodionsoftwares.com  (a subdomain whose MX → Resend)
//   4. Resend parses that copy and POSTs it here
//   5. This route matches the reply to an email_tracking row and flips
//      status → 'replied' (which makes Smart Send stop Stage 2/3).
//
// Why a forward (and not Reply-To)? The team wants replies to stay
// human-readable in the info@ inbox. The forward gives the automation a
// copy without taking replies away from the inbox.
//
// Matching is by sender + subject (not Message-ID): Resend's send API
// returns its own UUID, not the RFC Message-ID header, so In-Reply-To
// can't be matched directly. For 1-recruiter-per-job cold outreach,
// from == to_email plus a normalised-subject check is reliable.

const LOOKBACK_DAYS = 30;

interface TrackingRow {
  id: string;
  job_id: string;
  to_email: string | null;
  subject: string | null;
  sent_at: string | null;
  stage: number | null;
  status: string;
}

// Normalised view of whatever shape Resend hands us in the webhook body.
interface InboundEmail {
  from: string; // bare, lower-cased sender address
  fromRaw: string; // original From header (kept for the audit field)
  to: string[]; // bare recipient addresses
  subject: string;
  text: string; // best-effort plain-text body
  date: string | null; // ISO timestamp of the reply, if present
  headers: Record<string, string>; // header name (lower-case) → value
  rawType: string; // webhook event type, for logging
}

// ─── Webhook signature verification (Svix scheme, used by Resend) ──────────
// Resend signs webhooks via Svix. The signed payload is
// `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the base64-decoded
// secret (the part after the `whsec_` prefix), compared base64.
function verifyResendSignature(
  rawBody: string,
  headers: Headers,
  secret: string
): { ok: boolean; reason?: string } {
  // Svix sends `svix-*`; the standardised webhooks spec uses `webhook-*`.
  const id = headers.get("svix-id") || headers.get("webhook-id");
  const timestamp =
    headers.get("svix-timestamp") || headers.get("webhook-timestamp");
  const signature =
    headers.get("svix-signature") || headers.get("webhook-signature");
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: "missing signature headers" };
  }

  // Replay guard — reject timestamps more than 5 minutes off.
  const ts = Number(timestamp);
  if (Number.isFinite(ts) && Math.abs(Date.now() / 1000 - ts) > 300) {
    return { ok: false, reason: "timestamp out of tolerance" };
  }

  const secretKey = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let keyBytes: Buffer;
  try {
    keyBytes = Buffer.from(secretKey, "base64");
  } catch {
    return { ok: false, reason: "bad secret encoding" };
  }

  const expected = crypto
    .createHmac("sha256", keyBytes)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest("base64");

  // The header is a space-separated list of `v1,<sig>` tokens.
  const provided = signature.split(" ").map((p) => {
    const comma = p.indexOf(",");
    return comma === -1 ? p : p.slice(comma + 1);
  });
  const matched = provided.some((sig) => {
    if (sig.length !== expected.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  });
  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

// ─── Payload parsing helpers ───────────────────────────────────────────────

// Resend's inbound payload field names aren't 100%-pinned here, so every
// extractor is defensive: it accepts strings, objects ({address|email|value})
// and arrays, and falls back to the raw headers when a top-level field is
// missing.
function extractEmail(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") {
    const angle = value.match(/<([^>]+)>/);
    const candidate = angle ? angle[1] : value;
    const m = candidate.match(/[^\s<>"]+@[^\s<>"]+/);
    return (m ? m[0] : "").toLowerCase().trim();
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    return extractEmail(o.address ?? o.email ?? o.value ?? "");
  }
  return "";
}

// Headers may arrive as an object {name: value} or an array [{name,value}].
function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (const h of raw) {
      if (h && typeof h === "object") {
        const name = (h as Record<string, unknown>).name ??
          (h as Record<string, unknown>).key;
        const value = (h as Record<string, unknown>).value;
        if (typeof name === "string" && typeof value === "string") {
          out[name.toLowerCase()] = value;
        }
      }
    }
  } else if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k.toLowerCase()] = v;
      else if (Array.isArray(v) && typeof v[0] === "string") {
        out[k.toLowerCase()] = v[0] as string;
      }
    }
  }
  return out;
}

function parseInboundPayload(rawBody: string): InboundEmail | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  // Resend wraps the email under `data`; tolerate a flat shape too.
  const d = (
    json.data && typeof json.data === "object" ? json.data : json
  ) as Record<string, unknown>;
  if (!d || typeof d !== "object") return null;

  const headers = normalizeHeaders(d.headers ?? d.header);

  const fromRaw =
    typeof d.from === "string"
      ? d.from
      : extractEmail(d.from) || headers["from"] || "";
  const from =
    extractEmail(d.from) ||
    extractEmail(headers["from"]) ||
    extractEmail(fromRaw);

  const toField = d.to ?? headers["to"];
  const to = (Array.isArray(toField) ? toField : [toField])
    .map(extractEmail)
    .filter(Boolean);

  const subject =
    (typeof d.subject === "string" && d.subject) || headers["subject"] || "";

  // Body: prefer text/plain; fall back to HTML → text; then a raw `body`.
  let text = "";
  if (typeof d.text === "string" && d.text.trim()) text = d.text;
  else if (typeof d.html === "string" && d.html.trim()) {
    text = htmlToText(d.html);
  } else if (typeof d.body === "string") text = d.body;

  const date =
    (typeof d.date === "string" && d.date) ||
    headers["date"] ||
    (typeof json.created_at === "string" ? json.created_at : null);

  return {
    from,
    fromRaw: String(fromRaw),
    to,
    subject,
    text,
    date: date ?? null,
    headers,
    rawType: typeof json.type === "string" ? json.type : "",
  };
}

// Strips Re:/Fwd:/Fw:/AW: prefixes (repeatedly) so "Re: Re: X" == "X".
function normalizeSubject(subject: string | null | undefined): string {
  let out = (subject || "").trim();
  let prev: string;
  do {
    prev = out;
    out = out.replace(/^(re|fw|fwd|aw|antw)\s*(\[\d+\])?\s*:\s*/i, "");
  } while (out !== prev);
  return out.toLowerCase().replace(/\s+/g, " ").trim();
}

// True for out-of-office / vacation auto-replies, bounces and bulk mail —
// these must NOT flip a job to 'replied'.
function isAutomatedEmail(email: InboundEmail): boolean {
  const h = email.headers;
  const autoSubmitted = (h["auto-submitted"] || "").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (h["x-autoreply"] || h["x-autorespond"]) return true;
  const precedence = (h["precedence"] || "").toLowerCase();
  if (precedence === "auto_reply" || precedence === "bulk" || precedence === "junk") {
    return true;
  }
  if (
    /^\s*(automatic reply|auto[\s-]?reply|out of office|out-of-office|away from the office|on vacation|on annual leave|undeliverable|delivery status notification|mail delivery failed)\b/i.test(
      email.subject
    )
  ) {
    return true;
  }
  if (/(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(email.from)) {
    return true;
  }
  return false;
}

// Pulls just the recruiter's new text out of a reply, dropping the quoted
// original email and any trailing signature. Used for the reply_snippet
// preview column.
function cleanReplySnippet(text: string): string {
  if (!text) return "";
  let s = text.replace(/\r\n/g, "\n");

  // Cut at the earliest "quoted original" boundary.
  const boundaries: number[] = [];
  const patterns = [
    /^\s*On\s.+\swrote:/im, // Gmail / Apple Mail
    /^\s*-{2,}\s*Original Message\s*-{2,}/im, // generic
    /^\s*_{5,}\s*$/m, // Outlook divider line
    /^\s*From:\s.+[\r\n]+\s*Sent:\s/im, // Outlook quote header block
    /^\s*>{1,}/m, // first ">"-quoted line
    /^\s*El\s.+\sescribió:/im, // Spanish clients
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && typeof m.index === "number" && m.index > 0) {
      boundaries.push(m.index);
    }
  }
  if (boundaries.length) s = s.slice(0, Math.min(...boundaries));

  // Drop a trailing signature block ("-- " on its own line).
  const sig = s.match(/^\s*--\s*$/m);
  if (sig && typeof sig.index === "number" && sig.index > 0) {
    s = s.slice(0, sig.index);
  }

  s = s
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Never store an empty snippet — fall back to the raw text.
  if (!s) s = text.replace(/\s+/g, " ").trim();
  return s.slice(0, 280);
}

// ─── Webhook handler ───────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    // Raw body is required for signature verification — read it as text.
    let rawBody: string;
    try {
      rawBody = await req.text();
    } catch {
      return NextResponse.json(
        { success: false, error: "unreadable body" },
        { status: 400 }
      );
    }

    // ── 1. Verify signature ──────────────────────────────────────────────
    const secret = process.env.RESEND_INBOUND_SECRET;
    if (secret) {
      const v = verifyResendSignature(rawBody, req.headers, secret);
      if (!v.ok && v.reason === "signature mismatch") {
        console.warn("[inbound/resend] signature mismatch — rejecting");
        return NextResponse.json(
          { success: false, error: "invalid signature" },
          { status: 401 }
        );
      }
      if (!v.ok) {
        // Headers missing / odd timestamp — process but flag it loudly.
        console.warn(
          `[inbound/resend] signature not verified (${v.reason}) — processing anyway`
        );
      }
    } else {
      console.warn(
        "[inbound/resend] RESEND_INBOUND_SECRET not set — skipping signature check"
      );
    }

    // ── 2. Parse the payload ─────────────────────────────────────────────
    const email = parseInboundPayload(rawBody);
    if (!email) {
      console.warn("[inbound/resend] could not parse payload");
      return NextResponse.json({
        success: true,
        matched: false,
        reason: "unparseable",
      });
    }
    console.log(
      `[inbound/resend] received type=${email.rawType || "?"} from=${
        email.from || "?"
      } subject=${JSON.stringify(email.subject)}`
    );
    if (!email.from && !email.subject) {
      return NextResponse.json({
        success: true,
        matched: false,
        reason: "no from/subject",
      });
    }

    // ── 3. Skip automated mail (out-of-office, bounce, bulk) ─────────────
    if (isAutomatedEmail(email)) {
      console.log(`[inbound/resend] skipped automated mail from=${email.from}`);
      return NextResponse.json({
        success: true,
        matched: false,
        reason: "automated",
      });
    }

    // ── 4. Match the reply to an email_tracking row ──────────────────────
    let db;
    try {
      db = getSupabaseAdmin();
    } catch (e) {
      console.error("[inbound/resend] DB init failed:", (e as Error).message);
      return NextResponse.json(
        { success: false, error: "db unavailable" },
        { status: 500 }
      );
    }

    const cutoffISO = new Date(
      Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const { data: rows, error: qErr } = await db
      .from("email_tracking")
      .select("id, job_id, to_email, subject, sent_at, stage, status")
      .neq("status", "replied")
      .gte("sent_at", cutoffISO)
      .order("sent_at", { ascending: false })
      .limit(500);
    if (qErr) {
      console.error("[inbound/resend] email_tracking query failed:", qErr.message);
      return NextResponse.json(
        { success: false, error: qErr.message },
        { status: 500 }
      );
    }

    const candidates = (rows ?? []) as TrackingRow[];
    const replyDate = email.date ? new Date(email.date) : null;
    const replyDateValid = replyDate && !Number.isNaN(replyDate.getTime());
    // A real reply is sent AFTER our email — guard against matching mail
    // that predates the send (allow 5 min of clock skew).
    const sentBeforeReply = (sentAt: string | null): boolean => {
      if (!replyDateValid || !sentAt) return true;
      return (
        new Date(sentAt).getTime() <=
        (replyDate as Date).getTime() + 5 * 60 * 1000
      );
    };

    // Primary signal: reply sender == the address we emailed.
    let pool = candidates.filter(
      (r) =>
        extractEmail(r.to_email) === email.from && sentBeforeReply(r.sent_at)
    );
    let matchedBy = "from";

    // Fallback: subject match — covers a recruiter replying from a
    // different address than the one we targeted.
    const replySubjectNorm = normalizeSubject(email.subject);
    if (pool.length === 0 && replySubjectNorm) {
      pool = candidates.filter(
        (r) =>
          normalizeSubject(r.subject) === replySubjectNorm &&
          sentBeforeReply(r.sent_at)
      );
      matchedBy = "subject";
    }

    if (pool.length === 0) {
      // Unmatched — log enough to recognise it. (On first setup the Gmail
      // forwarding-address verification code also lands here.)
      console.warn(
        `[inbound/resend] UNMATCHED from=${email.from} subject=${JSON.stringify(
          email.subject
        )} body="${email.text.slice(0, 200).replace(/\s+/g, " ")}"`
      );
      return NextResponse.json({
        success: true,
        matched: false,
        reason: "no tracking row",
      });
    }

    // Disambiguate: prefer an exact subject match; otherwise the most
    // recent send (pool is already ordered sent_at desc).
    const match =
      pool.find((r) => normalizeSubject(r.subject) === replySubjectNorm) ??
      pool[0];

    // ── 5. Persist the reply ─────────────────────────────────────────────
    const repliedAt = (
      replyDateValid ? (replyDate as Date) : new Date()
    ).toISOString();
    const snippet = cleanReplySnippet(email.text);

    const { error: updErr } = await db
      .from("email_tracking")
      .update({
        status: "replied",
        replied_at: repliedAt,
        reply_from: email.from || email.fromRaw,
        reply_snippet: snippet,
        updated_at: new Date().toISOString(),
      })
      .eq("id", match.id);
    if (updErr) {
      console.error(
        "[inbound/resend] email_tracking update failed:",
        updErr.message
      );
      return NextResponse.json(
        { success: false, error: updErr.message },
        { status: 500 }
      );
    }

    // Propagate to jobs_v2 — terminal state. Non-fatal if it fails: the
    // tracking row is already flipped, so the dashboard still reflects it.
    const { error: jobErr } = await db
      .from("jobs_v2")
      .update({ email_status: "replied", updated_at: new Date().toISOString() })
      .eq("job_id", match.job_id);
    if (jobErr) {
      console.warn("[inbound/resend] jobs_v2 update failed:", jobErr.message);
    }

    console.log(
      `[inbound/resend] MATCHED by=${matchedBy} job=${match.job_id} stage=${
        match.stage ?? "?"
      } tracking=${match.id} (${Date.now() - startedAt}ms)`
    );
    return NextResponse.json({
      success: true,
      matched: true,
      matchedBy,
      jobId: match.job_id,
      trackingId: match.id,
    });
  } catch (error) {
    // Unexpected failure — return 500 so Resend retries (transient DB blips
    // recover on the next delivery).
    console.error("[inbound/resend] Error:", error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

// Health check — handy for confirming the route deployed and whether the
// signing secret is wired up. Resend itself only ever POSTs here.
export async function GET() {
  return NextResponse.json({
    success: true,
    endpoint: "resend-inbound-webhook",
    secretConfigured: Boolean(process.env.RESEND_INBOUND_SECRET),
    note: "POST only — configure this URL as a Resend inbound webhook target.",
  });
}
