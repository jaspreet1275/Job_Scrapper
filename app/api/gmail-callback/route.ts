import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import {
  getOAuth2Client,
  getOAuth2ClientForLabel,
  saveAccountForLabel,
  saveSendToken,
  saveToken,
} from "@/lib/email/gmail";
import { verifyState } from "@/lib/email/oauth-state";

// OAuth2 callback. Google sends the user here with `code` + `state` after
// consent. The state determines which slot the resulting tokens go into:
//
//   state="send"            → settings.send_gmail_refresh_token (legacy SEND)
//   state=signed("employee1")→ gmail_accounts[label='employee1'].refresh_token
//   state=signed("employee")→ gmail_accounts[label='employee'].refresh_token
//   anything else / missing → settings.gmail_refresh_token (legacy READ)
//
// The signed-state path uses HMAC-SHA256 (keyed by CRON_SECRET) so an
// attacker can't trick the callback into saving a refresh_token under a
// label they don't own.

function originFor(req: NextRequest): string {
  const fromReq = req.nextUrl.origin;
  if (fromReq) return fromReq;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.NEXT_PUBLIC_BASE_URL)
    return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  return "http://localhost:3000";
}

export async function GET(req: NextRequest) {
  const origin = originFor(req);
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    if (!code) {
      return NextResponse.redirect(`${origin}/?error=no_code`);
    }

    // SEND-account path (legacy, unchanged).
    if (state === "send") {
      const { tokens } = await getOAuth2Client().getToken(code);
      await saveSendToken(tokens);
      console.log("[gmail] SEND token saved");
      return NextResponse.redirect(`${origin}/?gmail=send-connected`);
    }

    // New label-aware path: state is HMAC-signed by signState().
    const verifiedLabel = state ? verifyState(state) : null;
    if (verifiedLabel) {
      const oauth2 = getOAuth2ClientForLabel(verifiedLabel);
      const { tokens } = await oauth2.getToken(code);

      if (!tokens.refresh_token) {
        // Google only returns refresh_token on FIRST consent or when the user
        // explicitly re-consented (prompt=consent). If we didn't get one, the
        // user has previously authorised this app and Google is reusing the
        // existing grant — they need to revoke at myaccount.google.com.
        return NextResponse.redirect(
          `${origin}/?gmail_error=no_refresh_token&label=${verifiedLabel}`
        );
      }

      oauth2.setCredentials(tokens);
      const gmail = google.gmail({ version: "v1", auth: oauth2 });
      const profile = await gmail.users.getProfile({ userId: "me" });
      const emailAddress = profile.data.emailAddress;
      if (!emailAddress) {
        return NextResponse.redirect(
          `${origin}/?gmail_error=no_email&label=${verifiedLabel}`
        );
      }

      await saveAccountForLabel(
        verifiedLabel,
        emailAddress,
        tokens.refresh_token
      );
      console.log(
        `[gmail] label='${verifiedLabel}' connected as ${emailAddress}`
      );
      return NextResponse.redirect(
        `${origin}/?gmail=connected&label=${verifiedLabel}&email=${encodeURIComponent(emailAddress)}`
      );
    }

    // Legacy unlabelled READ path (back-compat for older code that issued
    // auth URLs without state).
    const { tokens } = await getOAuth2Client().getToken(code);
    await saveToken(tokens);
    console.log("[gmail] READ token saved (legacy single-account path)");
    return NextResponse.redirect(`${origin}/?gmail=connected`);
  } catch (error) {
    console.error("[gmail] callback error:", error);
    return NextResponse.redirect(
      `${origin}/?error=${encodeURIComponent(String(error))}`
    );
  }
}
