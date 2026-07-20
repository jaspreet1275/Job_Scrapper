import type { NextRequest } from "next/server";

// Verifies that an incoming /api/cron/* request actually came from Vercel
// Cron (or a manual curl with the right secret). Vercel sends
// `Authorization: Bearer ${CRON_SECRET}` automatically when you add the
// route to vercel.json under the `crons` array.
//
// In dev (no CRON_SECRET set), the check is skipped so you can hit the
// endpoint from a browser to test.
export function isAuthorizedCron(req: NextRequest): boolean {
  // Dev mode: skip auth so you can hit the URL from a browser tab. Production
  // (Vercel) sets NODE_ENV=production, where the secret check IS enforced.
  if (process.env.NODE_ENV !== "production") {
    return true;
  }
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // No secret configured in production — refuse rather than silently allow,
    // since this means the route would be open to the internet.
    return false;
  }
  const header = req.headers.get("authorization") || "";
  return header === `Bearer ${expected}`;
}

// Resolves the timing thresholds for Stage 2 / Stage 3 follow-ups.
// In production: 3 days for Stage 2, 7 days total for Stage 3.
// In test mode (NEXT_PUBLIC_FOLLOWUP_TEST_MODE=true): both compressed to
// ~2 minutes so the full sequence can be exercised in a short demo run.
export function getFollowupThresholds(): {
  stage2MinAgeMs: number;
  stage3MinAgeMs: number;
} {
  const testMode = process.env.NEXT_PUBLIC_FOLLOWUP_TEST_MODE === "true";
  if (testMode) {
    return { stage2MinAgeMs: 2 * 60 * 1000, stage3MinAgeMs: 4 * 60 * 1000 };
  }
  // Stage 2: 3 days after Stage 1
  // Stage 3: 4 days after Stage 2 (7 total from Stage 1)
  // We measure from the IMMEDIATELY PRECEDING stage, not Stage 1, so:
  //  - "stage2MinAgeMs" = how old the Stage 1 row must be before Stage 2 fires.
  //  - "stage3MinAgeMs" = how old the Stage 2 row must be before Stage 3 fires.
  return {
    stage2MinAgeMs: 3 * 24 * 60 * 60 * 1000,
    stage3MinAgeMs: 4 * 24 * 60 * 60 * 1000,
  };
}

// Builds the absolute URL to call sibling /api routes from inside a cron
// handler. Resolution order matters: deployment-specific URLs (VERCEL_URL)
// sit behind Vercel Deployment Protection, so internal calls to them get
// the SSO login HTML instead of JSON. Prefer the public production alias.
//
//   1. NEXT_PUBLIC_BASE_URL          → manual override (e.g. ngrok in dev)
//   2. VERCEL_PROJECT_PRODUCTION_URL → public production alias, unprotected
//   3. VERCEL_URL                    → deployment-specific (LAST resort —
//                                       behind Deployment Protection)
//   4. http://localhost:3000         → `npm run dev`
export function getInternalBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}
