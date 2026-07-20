import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import crypto from "crypto";
import { Resend } from "resend";
import { getSendClient } from "@/lib/email/gmail";
import { getSupabaseAdmin } from "@/lib/db/supabase";
import {
  LOGO_CID,
  LOGO_CONTENT_TYPE,
  LOGO_FILENAME,
  getLogoBuffer,
  referencesLogo,
  stripLogoImg,
  toBase64Lines,
} from "@/lib/email/logo";

// Builds the final HTML body that Resend / Gmail will ship. Two paths:
//   1. Body is already a full HTML document (Manatanu-style output from
//      /api/generate-email) — inject the tracking pixel before </body>
//      and return as-is.
//   2. Body is plain text (legacy) — wrap in a minimal HTML shell so
//      Gmail / Outlook render it as HTML and the tracking pixel still
//      attaches.
function buildHtmlBody(body: string, trackingPixelTag: string): string {
  if (looksLikeHtmlDocument(body)) {
    // Inject pixel right before </body>. Fallback to appending if the
    // closing tag is missing for any reason.
    return /(<\/body>)/i.test(body)
      ? body.replace(/<\/body>/i, (m) => `${trackingPixelTag}${m}`)
      : body + trackingPixelTag;
  }
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.5;">${plainTextToHtml(
    body
  )}${trackingPixelTag}</body></html>`;
}

// Escapes characters that would break HTML, then converts plain newlines into
// <br/> so the HTML version preserves the same paragraph layout as the text one.
function plainTextToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r?\n/g, "<br/>\n");
}

// Sniff whether a body is a full HTML document (Manatanu-style output from
// /api/generate-email) vs plain text. Looks for the document marker or
// the body tag — covers both "<!doctype html>" and "<html>"-only outputs.
function looksLikeHtmlDocument(body: string): boolean {
  const head = body.trimStart().slice(0, 200).toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    /<body\b/i.test(head)
  );
}

// Strip tags + collapse whitespace to produce a readable text/plain
// fallback for the multipart message. Only used when body is HTML; the
// plain-text part is what shows in clients that don't render HTML.
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Builds the MIME message:
//
//   multipart/related            ← only when the body references the CID logo
//     multipart/alternative
//       text/plain               → readable in any client
//       text/html                → carries the open-tracking pixel
//     image/jpeg (Content-ID)    → the inline signature logo
//
// Without a logo the outer multipart/related is skipped entirely and the
// message is a plain multipart/alternative, exactly as before.
//
// Gmail / most modern clients pick the HTML part by default; clients that
// don't (or block remote images) fall back gracefully to the text part.
function createMessage(
  to: string,
  subject: string,
  body: string,
  trackingPixelUrl: string | null
): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf-8").toString("base64")}?=`;
  const boundary = `boundary_${crypto.randomBytes(8).toString("hex")}`;
  const relBoundary = `related_${crypto.randomBytes(8).toString("hex")}`;
  const pixelTag = trackingPixelUrl
    ? `<img src="${trackingPixelUrl}" width="1" height="1" alt="" style="display:block;border:0;outline:none;text-decoration:none;height:1px;width:1px;" />`
    : "";

  // Two paths:
  //   1. Body is already a full HTML document (Manatanu-style output from
  //      /api/generate-email). Send it as-is in the text/html part with
  //      the tracking pixel injected before </body>; derive a stripped-
  //      down text/plain version for fallback clients.
  //   2. Body is plain text (legacy). Wrap it in a minimal HTML shell
  //      and use the original text as the text/plain part.
  const isHtml = looksLikeHtmlDocument(body);

  // Resolve the inline logo BEFORE deriving the parts: if the file can't be
  // read, the <img src="cid:…"> has to come out of the HTML, otherwise every
  // client renders a broken-image icon pointing at an attachment we never
  // shipped.
  const logo = referencesLogo(body) ? getLogoBuffer() : null;
  const htmlSource =
    referencesLogo(body) && !logo ? stripLogoImg(body) : body;

  const plainPart = isHtml ? htmlToPlainText(htmlSource) : htmlSource;
  const htmlPart = isHtml
    ? // Inject the tracking pixel right before </body>; if for some
      // reason there's no </body>, fall back to appending.
      htmlSource.replace(/<\/body>/i, (match) => `${pixelTag}${match}`) +
      (/(<\/body>)/i.test(htmlSource) ? "" : pixelTag)
    : `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.5;">${plainTextToHtml(htmlSource)}${pixelTag}</body></html>`;

  const alternativeParts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    plainPart,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    htmlPart,
    "",
    `--${boundary}--`,
    "",
  ];

  const headerLines = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
  ];

  // No logo → the message is exactly the multipart/alternative it always was.
  const messageParts = logo
    ? [
        ...headerLines,
        `Content-Type: multipart/related; boundary="${relBoundary}"`,
        "",
        `--${relBoundary}`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        ...alternativeParts,
        `--${relBoundary}`,
        `Content-Type: ${LOGO_CONTENT_TYPE}; name="${LOGO_FILENAME}"`,
        "Content-Transfer-Encoding: base64",
        // The angle brackets matter: the HTML says src="cid:manatanu-logo",
        // the header must say Content-ID: <manatanu-logo>.
        `Content-ID: <${LOGO_CID}>`,
        `Content-Disposition: inline; filename="${LOGO_FILENAME}"`,
        "",
        toBase64Lines(logo),
        "",
        `--${relBoundary}--`,
        "",
      ]
    : [
        ...headerLines,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        "",
        ...alternativeParts,
      ];
  const message = messageParts.join("\r\n");

  return Buffer.from(message, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function POST(req: NextRequest) {
  try {
    const {
      to,
      subject,
      body,
      // Optional metadata so the email_sends row carries useful context.
      // Frontend can omit these (legacy callers); defaults keep the row valid.
      stage = 1,                  // 1=Trigger, 2=Case Study, 3=Breakup
      templateVariant = "A",      // 'A' or 'B' for A/B testing
      jobId = null,               // FK to jobs.id once jobs are migrated to DB
      threadId = null,            // existing Gmail thread to reply into (Stage 2/3)
    } = await req.json();

    if (!to || !subject || !body) {
      return NextResponse.json({
        success: false,
        error: "Missing to, subject, or body",
      });
    }

    // TEST MODE: redirect the actual send to TEST_EMAIL_OVERRIDE, but the
    // DB row keeps the original `to` (the real recruiter email) so the
    // dashboard / analytics show who the email was intended for. `to`     = real recruiter (stored in email_tracking.to_email)
    // `actualRecipient` = where Resend / Gmail actually delivers
    
    const testOverride = process.env.TEST_EMAIL_OVERRIDE;
    const actualRecipient = testOverride || to;

    const finalSubject = subject;
    const finalBody = body;

    if (testOverride && testOverride !== to) {
      console.log(`[send-email] TEST MODE: redirecting from ${to} → ${testOverride}`);
    }

    // Generate a unique trackingId per send so /api/track-open can attribute
    // every later open event back to this exact email/job.
    const trackingId = `e_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    // Public base URL must be reachable by the recipient's email client.
    // Set EMAIL_TRACKING_BASE_URL=https://your-public-url.example  in .env.local
    // (e.g. ngrok / Vercel deploy). Falls back to localhost for dev self-tests.
    const baseUrl =
      process.env.EMAIL_TRACKING_BASE_URL ||
      process.env.NEXT_PUBLIC_BASE_URL ||
      "http://localhost:3000";
    const trackingPixelUrl = `${baseUrl.replace(/\/$/, "")}/api/track-open?id=${trackingId}`;

    // Primary path: Resend (if RESEND_API_KEY env var is set). Fallback to
    // Gmail OAuth if Resend isn't configured yet — keeps existing setups
    // working during the migration window.
    const useResend = Boolean(process.env.RESEND_API_KEY);

    let messageId: string | null = null;
    let returnedThreadId: string | null = null;

    if (useResend) {
      // ─── Resend path ────────────────────────────────────────────────
      // From header uses MANATANU_FROM_EMAIL (falls back to the legacy
      // KODION_FROM_EMAIL name so existing .env files keep working)
      // verified on the Resend domain. Reply-To is intentionally NOT
      // set — replies go straight to the info@ inbox where a human can
      // read them. Reply detection: the info@ inbox forwards a copy of
      // every reply to the Resend-inbound subdomain, which POSTs it to
      // /api/inbound/resend, where it's matched to an email_tracking row.
      const fromEmail =
        process.env.MANATANU_FROM_EMAIL ||
        process.env.KODION_FROM_EMAIL ||
        "info@manatanuinfotech.com";
      const fromHeader = `Manatanu Infotech <${fromEmail}>`;
      const pixelTag = `<img src="${trackingPixelUrl}" width="1" height="1" alt="" style="display:block;border:0;outline:none;text-decoration:none;height:1px;width:1px;" />`;
      // Same deal as the Gmail path: ship the logo as an inline attachment
      // keyed by Content-ID, or drop the <img> if the file can't be read so
      // no dangling cid: reference goes out.
      const resendLogo = referencesLogo(finalBody) ? getLogoBuffer() : null;
      const resendSource =
        referencesLogo(finalBody) && !resendLogo
          ? stripLogoImg(finalBody)
          : finalBody;
      const htmlBody = buildHtmlBody(resendSource, pixelTag);

      const resend = new Resend(process.env.RESEND_API_KEY!);
      try {
        const sendResult = await resend.emails.send({
          from: fromHeader,
          to: actualRecipient,
          subject: finalSubject,
          html: htmlBody,
          // content_id turns this from a downloadable attachment into an
          // inline one the HTML can reference via src="cid:manatanu-logo".
          attachments: resendLogo
            ? [
                {
                  filename: LOGO_FILENAME,
                  content: resendLogo.toString("base64"),
                  contentType: LOGO_CONTENT_TYPE,
                  contentId: LOGO_CID,
                },
              ]
            : undefined,
          // Stage 2/3 follow-up threading: if the caller supplied a
          // previous message-id, set In-Reply-To + References so the
          // recipient's client groups the new mail under the original
          // thread. (Gmail-API threading via threadId doesn't apply
          // here — Resend uses standard SMTP headers.)
          headers:
            threadId && typeof threadId === "string"
              ? {
                  "In-Reply-To": threadId,
                  References: threadId,
                }
              : undefined,
        });
        if (sendResult.error) {
          console.error("[send-email][resend] API error:", sendResult.error);
          return NextResponse.json(
            {
              success: false,
              error: `Resend error: ${sendResult.error.message ?? "unknown"}`,
            },
            { status: 500 }
          );
        }
        messageId = sendResult.data?.id ?? null;
        // Resend doesn't return a thread-id; store the message-id so
        // follow-ups can reference it via the In-Reply-To header.
        returnedThreadId = messageId;
        console.log(
          `[send-email][resend] Sent to ${actualRecipient} (real: ${to}) · msg=${messageId} · trackingId=${trackingId}`
        );
      } catch (err) {
        console.error("[send-email][resend] threw:", err);
        return NextResponse.json(
          { success: false, error: `Resend threw: ${String(err)}` },
          { status: 500 }
        );
      }
    } else {
      // ─── Legacy Gmail OAuth path (fallback) ─────────────────────────
      let auth;
      try {
        auth = await getSendClient();
      } catch (err) {
        return NextResponse.json({
          success: false,
          error:
            "No sender configured. Set RESEND_API_KEY env var (recommended) OR connect Gmail in the Scrape Settings panel.",
          detail: String(err),
        });
      }
      const gmail = google.gmail({ version: "v1", auth });
      const encoded = createMessage(
        actualRecipient,
        finalSubject,
        finalBody,
        trackingPixelUrl
      );
      const sendBody: { raw: string; threadId?: string } = { raw: encoded };
      if (threadId && typeof threadId === "string") {
        sendBody.threadId = threadId;
      }
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: sendBody,
      });
      messageId = res.data.id ?? null;
      returnedThreadId = res.data.threadId ?? null;
      console.log(
        `[send-email][gmail] Sent to ${actualRecipient} (real: ${to}) · msg=${messageId} · trackingId=${trackingId}`
      );
    }

    // Persist into the new email_tracking row + flip jobs_v2.email_status to
    // 'sent'. Both happen AFTER the Gmail call succeeded — if either DB write
    // fails the email is still out the door, we just log the issue and continue.
    try {
      const db = getSupabaseAdmin();
      // The email itself ships as HTML (styled, with the tracking pixel).
      // But email_tracking.body is a record/audit field — no UI renders it
      // as HTML — so store the readable plain-text version. Saves a human
      // browsing the table from wading through <!doctype html> markup.
      const bodyForRecord = looksLikeHtmlDocument(finalBody)
        ? htmlToPlainText(finalBody)
        : finalBody;
      const trackingPayload = {
        job_id: jobId,                       // jobs_v2.job_id (text)
        stage: Number(stage) || 1,
        // Store the ORIGINAL recruiter email (pre-redirect), not the
        // TEST_EMAIL_OVERRIDE target. The actual Resend/Gmail send went
        // to `actualRecipient`; the dashboard wants to see who it was
        // intended for.
        to_email: to,
        subject: finalSubject,
        body: bodyForRecord,
        thread_id: returnedThreadId,
        tracking_id: trackingId,
        status: "sent",
        sent_at: new Date().toISOString(),
      };
      console.log(
        `[send-email] inserting email_tracking row · jobId=${jobId} stage=${stage} trackingId=${trackingId}`
      );
      const { data: inserted, error: insertErr } = await db
        .from("email_tracking")
        .insert(trackingPayload)
        .select("id");
      if (insertErr) {
        console.warn(
          "[send-email] email_tracking insert FAILED:",
          insertErr.message,
          "code=",
          insertErr.code,
          "details=",
          insertErr.details,
          "hint=",
          insertErr.hint
        );
      } else {
        console.log(
          `[send-email] email_tracking row created id=${inserted?.[0]?.id ?? "?"}`
        );
      }
      // Flip jobs_v2.email_status to 'sent' so the dashboard badge / Smart
      // Send button / cron drain loop all see the lifecycle move forward.
      // Only when jobId is supplied — bare manual sends without a job link
      // skip this step.
      if (jobId && typeof jobId === "string") {
        const { error: updErr } = await db
          .from("jobs_v2")
          .update({ email_status: "sent", updated_at: new Date().toISOString() })
          .eq("job_id", jobId);
        if (updErr) {
          console.warn("[send-email] jobs_v2 status update failed:", updErr.message);
        }
      }
      console.log(`[send-email] persisted · stage=${stage} jobId=${jobId ?? "(none)"}`);
    } catch (dbErr) {
      console.warn("[send-email] DB unreachable:", (dbErr as Error).message);
    }
    // templateVariant is no longer persisted (column removed in v2 schema) —
    // reference it once so the linter doesn't flag the parameter as unused.
    void templateVariant;

    return NextResponse.json({
      success: true,
      data: {
        messageId,
        threadId: returnedThreadId,
        trackingId,
      },
    });
  } catch (error) {
    console.error("[send-email] Error:", error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
