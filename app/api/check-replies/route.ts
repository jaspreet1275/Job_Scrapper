import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { getAuthenticatedClient } from "@/lib/email/gmail";

// POST: Given a list of Gmail threadIds, return which have received a reply.
// A "reply" = the thread contains at least one message whose From address is NOT the authenticated user's own address.
export async function POST(req: NextRequest) {
  try {
    const { threadIds } = await req.json();
    if (!Array.isArray(threadIds) || threadIds.length === 0) {
      return NextResponse.json({ success: true, data: { repliedThreadIds: [], checked: 0 } });
    }

    let auth;
    try {
      auth = await getAuthenticatedClient();
    } catch (err) {
      return NextResponse.json({
        success: false,
        error: "Gmail not connected.",
        detail: String(err),
      });
    }
    const gmail = google.gmail({ version: "v1", auth });

    // Resolve authenticated user's own email address (to exclude self-sends from "replies")
    const profile = await gmail.users.getProfile({ userId: "me" });
    const selfEmail = (profile.data.emailAddress || "").toLowerCase();

    const repliedThreadIds: string[] = [];
    const errors: string[] = [];

    // Check each thread sequentially (Gmail has quota limits; we cap at the caller)
    for (const threadId of threadIds) {
      if (!threadId || typeof threadId !== "string") continue;
      try {
        const res = await gmail.users.threads.get({
          userId: "me",
          id: threadId,
          format: "metadata",
          metadataHeaders: ["From"],
        });
        const messages = res.data.messages || [];
        // A reply exists if any message's From header is NOT the self email
        const hasReply = messages.some((m) => {
          const fromHeader = m.payload?.headers?.find((h) => h.name === "From")?.value || "";
          // Extract email from "Name <email@x.com>" format, lower-case
          const match = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([^\s]+@[^\s]+)/);
          const addr = (match?.[1] || "").toLowerCase().trim();
          return addr && addr !== selfEmail;
        });
        if (hasReply) repliedThreadIds.push(threadId);
      } catch (err) {
        errors.push(`${threadId}: ${(err as Error).message}`);
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        repliedThreadIds,
        checked: threadIds.length,
        selfEmail,
        errors,
      },
    });
  } catch (error) {
    console.error("[check-replies] Error:", error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}
