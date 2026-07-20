import { NextResponse } from "next/server";
import {
  getOAuth2Client,
  isSendAuthenticated,
  getSendAccountEmail,
  clearSendToken,
  SCOPES,
} from "@/lib/email/gmail";

// Auth flow for the SEND Gmail account (e.g. info@kodionsoftwares.com).
// Mirrors /api/gmail-auth but stores into settings.send_gmail_refresh_token
// via the `state=send` marker that the callback route checks.
//
// GET → returns either { authenticated: true, email: "info@..." }
//        when a sender is already connected, or { authUrl } when not.
// DELETE → clears the saved sender token so the user can reconnect a
//          different account.

export async function GET() {
  try {
    if (await isSendAuthenticated()) {
      const email = await getSendAccountEmail();
      return NextResponse.json({
        success: true,
        authenticated: true,
        email,
      });
    }
    // No sender connected — surface a fresh consent URL. `state=send`
    // tells /api/gmail-callback to route the resulting tokens into the
    // send_gmail_refresh_token column instead of the read token.
    const authUrl = getOAuth2Client().generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      // prompt=consent forces Google to re-issue a refresh_token even
      // if the user has authorised this client before — otherwise the
      // refresh_token field comes back empty and saveSendToken throws.
      prompt: "consent",
      state: "send",
    });
    return NextResponse.json({
      success: true,
      authenticated: false,
      authUrl,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    await clearSendToken();
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
