import fs from "fs";
import path from "path";

// Signature logo, shipped INSIDE the email as an inline (CID) attachment
// rather than fetched from a URL.
//
// Why not a hosted <img src="https://…">: the recipient's mail client is the
// one that fetches it, so the URL has to be publicly reachable forever. A
// dead deployment or an unpushed asset turns the signature into a broken
// image — which is exactly what happened with the old
// job-scraper-ai-dashboard.vercel.app/manatanu-logo.jpg link (404).
//
// An inline attachment travels with the message: no hosting, no URL, nothing
// to keep alive. Gmail and Outlook also render CID images without the
// "display images" prompt that blocks remote ones.
//
// The text rows in the signature still stand on their own — see the layout in
// lib/prompts/email-prompt.ts. The logo is a bonus, never the only carrier.

export const LOGO_CID = "manatanu-logo";
export const LOGO_FILENAME = "manatanu-logo.jpg";
export const LOGO_CONTENT_TYPE = "image/jpeg";

/** What the generated HTML references: <img src="cid:manatanu-logo"> */
export const LOGO_SRC = `cid:${LOGO_CID}`;

// `undefined` = not read yet, `null` = read and failed. Cached either way so
// a missing file costs one failed read per process, not one per email.
let cachedLogo: Buffer | null | undefined;

/**
 * The logo bytes from public/, or null if unreadable. Never throws — a
 * missing logo must not block a send.
 */
export function getLogoBuffer(): Buffer | null {
  if (cachedLogo !== undefined) return cachedLogo;
  try {
    cachedLogo = fs.readFileSync(
      path.join(process.cwd(), "public", LOGO_FILENAME)
    );
  } catch (err) {
    console.warn(
      `[email-logo] public/${LOGO_FILENAME} unreadable — sending without the logo:`,
      err instanceof Error ? err.message : err
    );
    cachedLogo = null;
  }
  return cachedLogo;
}

/** True when this HTML actually references the inline logo. */
export function referencesLogo(html: string): boolean {
  return html.includes(LOGO_SRC);
}

/**
 * Drop the logo <img> from the HTML. Used when the file can't be read: a
 * cid: reference with no matching attachment renders as a broken-image icon
 * in most clients, which looks worse than no logo at all.
 */
export function stripLogoImg(html: string): string {
  return html.replace(
    new RegExp(`<img[^>]*src=["']${LOGO_SRC}["'][^>]*>`, "gi"),
    ""
  );
}

/** Base64 body for a MIME part, wrapped at the RFC 2045 limit of 76 chars. */
export function toBase64Lines(buf: Buffer): string {
  return (buf.toString("base64").match(/.{1,76}/g) || []).join("\r\n");
}
