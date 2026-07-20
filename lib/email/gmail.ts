import { google } from "googleapis";
import type { OAuth2Client, Credentials } from "google-auth-library";
import fs from "fs";
import path from "path";
import { getSupabaseAdmin, TABLES } from "@/lib/db/supabase";
import { signState } from "./oauth-state";

// ─────────────────────────────────────────────────────────────────────────────
// Centralised Gmail OAuth helper — multi-account aware.
//
// The platform supports N Gmail "labels" (e.g. `employee1`, `employee`), each with
// its own Google Cloud project and OAuth client credentials. A label's
// credentials live in env vars:
//     GMAIL_<LABEL>_CLIENT_ID
//     GMAIL_<LABEL>_CLIENT_SECRET
//     GMAIL_<LABEL>_DISPLAY_NAME   (optional, human-readable for UI)
//
// Per-account refresh_tokens live in the `gmail_accounts` table (one row per
// label). The cron + manual parse paths call getReadClientsForSelection()
// which resolves the user's "Both / Guri / Employee" dropdown choice into
// a list of authenticated clients, ready to iterate.
//
// SEND side (cold outreach) is intentionally untouched here — it still uses
// settings.send_gmail_refresh_token via getSendClient(). Mixing send + read
// into the same multi-label table is a future refactor.
//
// Backward compat:
//   - settings.gmail_refresh_token (legacy single-token field) stays in place.
//   - getAuthenticatedClient() falls back to scanning configured labels for
//     the first connected one, OR the legacy field, so existing code paths
//     that aren't aware of labels keep working during migration.
// ─────────────────────────────────────────────────────────────────────────────

const CREDENTIALS_PATH = path.join(process.cwd(), "gmail-credentials.json");
const TOKEN_PATH = path.join(process.cwd(), "gmail-token.json");

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export type GmailLabel = string;

interface InstalledCredentials {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

interface LabeledCredentials extends InstalledCredentials {
  display_name: string;
}

// ─── Redirect URI resolution ────────────────────────────────────────────────

function getRedirectUri(): string {
  if (process.env.GMAIL_REDIRECT_URI) return process.env.GMAIL_REDIRECT_URI;
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/api/gmail-callback`;
  }
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return `${process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "")}/api/gmail-callback`;
  }
  return "http://localhost:3000/api/gmail-callback";
}

// ─── Label discovery + per-label credentials ────────────────────────────────

// Scans env for every GMAIL_<LABEL>_CLIENT_ID and returns the labels in
// lowercase, sorted for stable ordering. UI uses this to render the right
// number of account slots without hard-coding label names.
export function discoverConfiguredLabels(): GmailLabel[] {
  const labels = new Set<string>();
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^GMAIL_([A-Z][A-Z0-9_]+)_CLIENT_ID$/);
    if (m) labels.add(m[1].toLowerCase());
  }
  return Array.from(labels).sort();
}

function readCredentialsForLabel(label: GmailLabel): LabeledCredentials {
  const upper = label.toUpperCase();
  const id = process.env[`GMAIL_${upper}_CLIENT_ID`];
  const secret = process.env[`GMAIL_${upper}_CLIENT_SECRET`];
  const display = process.env[`GMAIL_${upper}_DISPLAY_NAME`] ?? label;
  if (!id || !secret) {
    throw new Error(
      `Gmail OAuth config missing for label "${label}". Set GMAIL_${upper}_CLIENT_ID and GMAIL_${upper}_CLIENT_SECRET.`
    );
  }
  return { client_id: id, client_secret: secret, display_name: display };
}

export function getOAuth2ClientForLabel(label: GmailLabel): OAuth2Client {
  const { client_id, client_secret } = readCredentialsForLabel(label);
  return new google.auth.OAuth2(client_id, client_secret, getRedirectUri());
}

// Builds the consent URL for a specific label, with a signed state so the
// callback can recover the originating label safely.
export function generateAuthUrlForLabel(label: GmailLabel): string {
  const client = getOAuth2ClientForLabel(label);
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state: signState(label),
  });
}

// ─── Per-label token I/O on gmail_accounts ──────────────────────────────────

async function readTokenForLabel(label: GmailLabel): Promise<string | null> {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from("gmail_accounts")
      .select("refresh_token, is_connected")
      .eq("label", label)
      .maybeSingle();
    if (error) {
      console.warn(`[gmail] account read failed (${label}):`, error.message);
      return null;
    }
    if (!data?.is_connected || !data.refresh_token) return null;
    return data.refresh_token as string;
  } catch (err) {
    console.warn(`[gmail] DB unreachable (${label}):`, (err as Error).message);
    return null;
  }
}

export async function saveAccountForLabel(
  label: GmailLabel,
  emailAddress: string,
  refreshToken: string
): Promise<void> {
  if (!refreshToken) {
    throw new Error(
      `Google did not return a refresh_token for '${label}'. The user must revoke prior consent at https://myaccount.google.com/permissions and re-authorise.`
    );
  }
  const db = getSupabaseAdmin();
  const { error } = await db.from("gmail_accounts").upsert(
    {
      label,
      email_address: emailAddress,
      refresh_token: refreshToken,
      is_connected: true,
    },
    { onConflict: "label" }
  );
  if (error) throw new Error(error.message);
  console.log(`[gmail] account saved: ${label} (${emailAddress})`);
}

export async function disconnectAccount(label: GmailLabel): Promise<void> {
  const db = getSupabaseAdmin();
  await db
    .from("gmail_accounts")
    .update({
      refresh_token: null,
      is_connected: false,
      email_address: null,
    })
    .eq("label", label);
  console.log(`[gmail] account disconnected: ${label}`);
}

// ─── Authenticated client builders ──────────────────────────────────────────

export async function getAuthenticatedClientForLabel(
  label: GmailLabel
): Promise<OAuth2Client> {
  const token = await readTokenForLabel(label);
  if (!token) throw new Error(`Gmail '${label}' not connected`);
  const client = getOAuth2ClientForLabel(label);
  client.setCredentials({ refresh_token: token });
  return client;
}

export type ReadAccount = {
  client: OAuth2Client;
  label: GmailLabel;
  email: string;
};

// Resolves the dashboard's "Both / <label>" selection into a list of
// authenticated clients. Silently skips any account that is either
// (a) not yet env-configured or (b) not OAuth-connected — so the parse
// route never has to guard for partial setup.
export async function getReadClientsForSelection(
  selection: "both" | GmailLabel
): Promise<ReadAccount[]> {
  const configured = discoverConfiguredLabels();
  const targetLabels =
    selection === "both" ? configured : configured.filter((l) => l === selection);

  if (targetLabels.length === 0) return [];

  const db = getSupabaseAdmin();
  const { data: rows } = await db
    .from("gmail_accounts")
    .select("label, email_address, refresh_token, is_connected")
    .in("label", targetLabels);

  const results: ReadAccount[] = [];
  for (const row of rows ?? []) {
    if (!row.is_connected || !row.refresh_token) continue;
    try {
      const client = getOAuth2ClientForLabel(row.label as string);
      client.setCredentials({ refresh_token: row.refresh_token as string });
      results.push({
        client,
        label: row.label as string,
        email: (row.email_address as string) ?? `${row.label}@unknown`,
      });
    } catch (err) {
      console.warn(
        `[gmail] skipping label '${row.label}':`,
        (err as Error).message
      );
    }
  }
  return results;
}

// ─── UI listing ─────────────────────────────────────────────────────────────

export type AccountSlot = {
  label: GmailLabel;
  display_name: string;
  email: string | null;
  is_connected: boolean;
  last_parsed_at: string | null;
};

export async function listAccountSlots(): Promise<AccountSlot[]> {
  const configured = discoverConfiguredLabels();
  if (configured.length === 0) return [];

  const db = getSupabaseAdmin();
  const { data: rows } = await db
    .from("gmail_accounts")
    .select("label, email_address, is_connected, last_parsed_at")
    .in("label", configured);

  type SlotRow = {
    label: string;
    email_address: string | null;
    is_connected: boolean;
    last_parsed_at: string | null;
  };
  const byLabel = new Map<string, SlotRow>(
    ((rows ?? []) as SlotRow[]).map((r) => [r.label, r])
  );

  return configured.map((label) => {
    let display_name = label;
    try {
      display_name = readCredentialsForLabel(label).display_name;
    } catch {
      // Env vars half-configured — fall back to raw label.
    }
    const row = byLabel.get(label);
    return {
      label,
      display_name,
      email: (row?.email_address as string | null) ?? null,
      is_connected: (row?.is_connected as boolean) ?? false,
      last_parsed_at: (row?.last_parsed_at as string | null) ?? null,
    };
  });
}

// Updates last_parsed_at + bumps the per-account total counter. Called by
// parse-gmail after each inbox is processed so the UI's "last parsed" stamp
// is per-account, not a single global timestamp.
export async function markParsed(
  label: GmailLabel,
  uniqueCount: number
): Promise<void> {
  if (uniqueCount <= 0) return;
  const db = getSupabaseAdmin();
  // Two-step: read current count, then update. Avoids needing an RPC for
  // an atomic increment on a non-hot field.
  const { data } = await db
    .from("gmail_accounts")
    .select("jobs_parsed_total")
    .eq("label", label)
    .maybeSingle();
  const prev = (data?.jobs_parsed_total as number) ?? 0;
  await db
    .from("gmail_accounts")
    .update({
      last_parsed_at: new Date().toISOString(),
      jobs_parsed_total: prev + uniqueCount,
    })
    .eq("label", label);
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY exports — kept so existing call sites that don't yet know about
// labels (and the SEND-account flow, which is still single-account) continue
// to work without modification.
// ─────────────────────────────────────────────────────────────────────────────

interface SettingsCredentials {
  client_id: string;
  client_secret: string;
}

// Resolves OAuth client credentials for the LEGACY single-account flow with
// precedence:
//   1. GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET env vars
//   2. gmail-credentials.json file (local dev)
// Used only by getOAuth2Client() (without label) and the SEND path.
function readClientCredentials(): SettingsCredentials {
  const envId = process.env.GMAIL_CLIENT_ID;
  const envSecret = process.env.GMAIL_CLIENT_SECRET;
  if (envId && envSecret) {
    return { client_id: envId, client_secret: envSecret };
  }
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      "Gmail OAuth client config missing. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET env vars (production) OR drop gmail-credentials.json next to the repo (local dev)."
    );
  }
  const raw = fs.readFileSync(CREDENTIALS_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  return parsed.installed ?? parsed.web ?? parsed;
}

// LEGACY: no-label OAuth client. Kept for the SEND flow and any caller that
// still uses the single-account path.
export function getOAuth2Client(): OAuth2Client {
  const { client_id, client_secret } = readClientCredentials();
  return new google.auth.OAuth2(client_id, client_secret, getRedirectUri());
}

async function readRefreshTokenFromDb(): Promise<string | null> {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from(TABLES.settings)
      .select("gmail_refresh_token")
      .eq("id", 1)
      .maybeSingle();
    if (error) return null;
    const token = (data?.gmail_refresh_token ?? "") as string;
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

async function readSendRefreshTokenFromDb(): Promise<string | null> {
  try {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from(TABLES.settings)
      .select("send_gmail_refresh_token")
      .eq("id", 1)
      .maybeSingle();
    if (error) return null;
    const token = (data?.send_gmail_refresh_token ?? "") as string;
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function readTokenFromFile(): Credentials | null {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8")) as Credentials;
  } catch {
    return null;
  }
}

// LEGACY: returns an authenticated client without caring about label. Tries
// the new multi-account table first (returns the first connected account
// found), then falls back to the legacy single-token field, then the file.
// Callers should migrate to getReadClientsForSelection() — this exists so
// pre-migration code keeps working during rollout.
export async function getAuthenticatedClient(): Promise<OAuth2Client> {
  // Pass 1: any connected account in the new table.
  const configured = discoverConfiguredLabels();
  for (const label of configured) {
    try {
      return await getAuthenticatedClientForLabel(label);
    } catch {
      // Try next label.
    }
  }

  // Pass 2: legacy refresh_token in settings.
  const client = getOAuth2Client();
  const dbRefresh = await readRefreshTokenFromDb();
  if (dbRefresh) {
    client.setCredentials({ refresh_token: dbRefresh });
    return client;
  }

  // Pass 3: legacy file fallback.
  const fileToken = readTokenFromFile();
  if (fileToken && (fileToken.refresh_token || fileToken.access_token)) {
    client.setCredentials(fileToken);
    if (fileToken.refresh_token) {
      void writeRefreshTokenToDb(fileToken.refresh_token).catch(() => {});
    }
    return client;
  }

  throw new Error(
    "Gmail not connected. Visit the dashboard's 'Gmails Connected' section to connect at least one account."
  );
}

async function writeRefreshTokenToDb(refreshToken: string): Promise<void> {
  const db = getSupabaseAdmin();
  const { error } = await db
    .from(TABLES.settings)
    .update({
      gmail_refresh_token: refreshToken,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) throw new Error(error.message);
}

async function writeSendRefreshTokenToDb(refreshToken: string): Promise<void> {
  const db = getSupabaseAdmin();
  const { error } = await db
    .from(TABLES.settings)
    .update({
      send_gmail_refresh_token: refreshToken,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) throw new Error(error.message);
}

// ─── SEND-side (untouched) ──────────────────────────────────────────────────

export async function getSendClient(): Promise<OAuth2Client> {
  const sendRefresh = await readSendRefreshTokenFromDb();
  if (sendRefresh) {
    const client = getOAuth2Client();
    client.setCredentials({ refresh_token: sendRefresh });
    return client;
  }
  return getAuthenticatedClient();
}

export async function saveSendToken(tokens: Credentials): Promise<void> {
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token for the sender account. Disconnect the app from the account at https://myaccount.google.com/permissions and re-authorise."
    );
  }
  await writeSendRefreshTokenToDb(tokens.refresh_token);
  console.log("[gmail] sender refresh_token persisted to Supabase");
}

export async function isSendAuthenticated(): Promise<boolean> {
  try {
    const refresh = await readSendRefreshTokenFromDb();
    if (!refresh) return false;
    const client = getOAuth2Client();
    client.setCredentials({ refresh_token: refresh });
    const gmail = google.gmail({ version: "v1", auth: client });
    await gmail.users.getProfile({ userId: "me" });
    return true;
  } catch {
    return false;
  }
}

export async function getSendAccountEmail(): Promise<string | null> {
  try {
    const refresh = await readSendRefreshTokenFromDb();
    if (!refresh) return null;
    const client = getOAuth2Client();
    client.setCredentials({ refresh_token: refresh });
    const gmail = google.gmail({ version: "v1", auth: client });
    const { data } = await gmail.users.getProfile({ userId: "me" });
    return data.emailAddress ?? null;
  } catch {
    return null;
  }
}

export async function clearSendToken(): Promise<void> {
  try {
    const db = getSupabaseAdmin();
    await db
      .from(TABLES.settings)
      .update({
        send_gmail_refresh_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
  } catch (err) {
    console.warn("[gmail] send token clear failed:", (err as Error).message);
  }
}

// ─── LEGACY token save / clear / status (single-account) ────────────────────

export async function saveToken(tokens: Credentials): Promise<void> {
  if (tokens.refresh_token) {
    try {
      await writeRefreshTokenToDb(tokens.refresh_token);
      console.log("[gmail] refresh_token persisted to Supabase (legacy field)");
    } catch (err) {
      console.warn("[gmail] DB write failed, file-only save:", (err as Error).message);
    }
  }
  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  } catch (err) {
    console.warn("[gmail] file write failed:", (err as Error).message);
  }
}

export async function isAuthenticated(): Promise<boolean> {
  try {
    const client = await getAuthenticatedClient();
    const gmail = google.gmail({ version: "v1", auth: client });
    await gmail.users.getProfile({ userId: "me" });
    return true;
  } catch (err) {
    console.warn("[gmail] isAuthenticated failed:", (err as Error).message);
    return false;
  }
}

export async function clearToken(): Promise<void> {
  try {
    const db = getSupabaseAdmin();
    await db
      .from(TABLES.settings)
      .update({ gmail_refresh_token: null, updated_at: new Date().toISOString() })
      .eq("id", 1);
  } catch (err) {
    console.warn("[gmail] DB clear failed:", (err as Error).message);
  }
  try {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
  } catch {
    /* ignore */
  }
}
