import crypto from "crypto";

// HMAC-signed OAuth `state` parameter.
//
// The Gmail callback receives the same query schema for both OAuth clients
// (Guri's project + Employee's project), so we need a tamper-resistant way
// to know which label initiated the flow. A plain `state=employee1` would be
// trivially forgeable — an attacker could trick the callback into saving
// a refresh_token under the wrong label and effectively hijack the parse
// pipeline for an account they control.
//
// Signing the label with HMAC-SHA256 (keyed by CRON_SECRET, which the app
// already requires for cron auth) makes the state un-forgeable without
// access to the server's env. A 10-minute TTL prevents replay-after-leak.

function getSecret(): string {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // CRON_SECRET is already required by the rest of the cron pipeline; if
    // it's missing we want to fail loudly here rather than silently emit
    // unsigned state values that the callback will reject anyway.
    throw new Error(
      "CRON_SECRET not set — required for OAuth state signing"
    );
  }
  return secret;
}

export function signState(label: string): string {
  const payload = `${label}.${Date.now()}`;
  const sig = crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("hex")
    .slice(0, 16);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

// Returns the decoded label iff the signature is valid and the state is
// fresh (default 10-minute TTL). Returns null on any failure — callers
// should treat null as an authentication failure and refuse the callback.
export function verifyState(
  state: string,
  maxAgeMs: number = 10 * 60 * 1000
): string | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf-8");
    const parts = decoded.split(".");
    if (parts.length !== 3) return null;
    const [label, tsStr, sig] = parts;
    const ts = Number(tsStr);
    if (!Number.isFinite(ts)) return null;
    if (Date.now() - ts > maxAgeMs) return null;

    const payload = `${label}.${tsStr}`;
    const expected = crypto
      .createHmac("sha256", getSecret())
      .update(payload)
      .digest("hex")
      .slice(0, 16);

    // Constant-time compare to defend against timing attacks on the sig.
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    return label;
  } catch {
    return null;
  }
}
