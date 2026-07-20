import { NextRequest, NextResponse } from "next/server";
import {
  disconnectAccount,
  discoverConfiguredLabels,
  listAccountSlots,
} from "@/lib/email/gmail";

// CRUD for the dashboard's "Gmails Connected" panel.
//
//   GET    /api/gmail-accounts         → list all configured slots + status
//   DELETE /api/gmail-accounts?label=X → disconnect that account (clear token)
//
// refresh_tokens are never returned by GET — only public-safe fields
// (label, display_name, email, connection state, last_parsed_at).

export async function GET() {
  try {
    const slots = await listAccountSlots();
    return NextResponse.json({
      success: true,
      data: slots,
      configured_labels: discoverConfiguredLabels(),
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const label = req.nextUrl.searchParams.get("label");
  if (!label) {
    return NextResponse.json(
      { success: false, error: "label query param required" },
      { status: 400 }
    );
  }
  const configured = discoverConfiguredLabels();
  if (!configured.includes(label)) {
    return NextResponse.json(
      { success: false, error: `Label '${label}' not configured` },
      { status: 400 }
    );
  }
  try {
    await disconnectAccount(label);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
