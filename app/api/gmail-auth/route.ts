import { NextRequest, NextResponse } from "next/server";
import {
  discoverConfiguredLabels,
  generateAuthUrlForLabel,
  getAuthenticatedClientForLabel,
} from "@/lib/email/gmail";
import { google } from "googleapis";

// Label-aware OAuth initiator.
//
//   GET /api/gmail-auth?label=employee1 → auth URL for the employee1 project
//   GET /api/gmail-auth?label=employee  → auth URL for Employee's project
//
// Each label uses its own GMAIL_<LABEL>_CLIENT_ID / _CLIENT_SECRET env pair,
// so two separate Google Cloud projects (one per Gmail) can be wired in
// without touching code. Returns either { authenticated: true } if that
// label already has a valid refresh_token, or { authUrl } to redirect the
// user to Google's consent screen.

export async function GET(req: NextRequest) {
  const label = req.nextUrl.searchParams.get("label");
  if (!label) {
    return NextResponse.json(
      { success: false, error: "label query param required (e.g. ?label=employee1)" },
      { status: 400 }
    );
  }

  const configured = discoverConfiguredLabels();
  if (!configured.includes(label)) {
    return NextResponse.json(
      {
        success: false,
        error: `Label '${label}' not configured in env`,
        configured,
        hint: `Set GMAIL_${label.toUpperCase()}_CLIENT_ID and GMAIL_${label.toUpperCase()}_CLIENT_SECRET`,
      },
      { status: 400 }
    );
  }

  // Cheap liveness check — if the label already has a working refresh_token
  // we can skip the consent screen entirely and report "already connected".
  try {
    const client = await getAuthenticatedClientForLabel(label);
    const gmail = google.gmail({ version: "v1", auth: client });
    await gmail.users.getProfile({ userId: "me" });
    return NextResponse.json({ success: true, authenticated: true, label });
  } catch {
    // Not authenticated yet — fall through to issuing an auth URL.
  }

  try {
    const authUrl = generateAuthUrlForLabel(label);
    return NextResponse.json({
      success: true,
      authenticated: false,
      authUrl,
      label,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
