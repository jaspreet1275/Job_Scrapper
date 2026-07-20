import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Two clients are exported:
//
//  1. supabaseAdmin — uses the service_role key. Bypasses RLS, full DB access.
//     ONLY use from server routes / cron jobs / never ship to the browser.
//
//  2. supabaseAnon — uses the publishable (anon) key. Safe for the browser if
//     RLS policies are configured. We don't enable RLS for this app because
//     all access goes through our own API routes, but the client is exported
//     in case future client-side reads (e.g. realtime subscriptions) need it.
//
// Env vars come from .env.local — do NOT hardcode keys here.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL in .env.local");
}

// Lazy admin client — only instantiated when first accessed from a server
// route. This prevents the service_role key from being read into Next.js's
// client bundle (it can't be there because we check NODE env, but lazy is
// belt-and-braces).
let _admin: SupabaseClient | null = null;
export function getSupabaseAdmin(): SupabaseClient {
  if (_admin) return _admin;
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY in .env.local — cron jobs need full DB access"
    );
  }
  _admin = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}

// Anon client — exported for any future browser-side reads. Don't use this
// from server routes; use getSupabaseAdmin() instead.
export const supabaseAnon: SupabaseClient | null = SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// ── Typed table names — central place to rename if schema evolves ──────────
//
// Phase 1 schema is two operational tables + settings:
//   jobs           → renamed at cutover from jobs_v2 (new PK = text job_id,
//                    enrichment as JSONB, restricted email_status enum)
//   email_tracking → unified send / open / reply lifecycle, FK to jobs.job_id
//
// During the migration window we keep both pointers (jobs and emailTracking)
// referenced by route code. Once the cutover SQL renames jobs_v2 → jobs and
// drops the legacy 6 tables, the *_legacy entries can go.
export const TABLES = {
  settings: "settings",
  // Active schema (Phase 1)
  jobs: "jobs_v2",
  emailTracking: "email_tracking",
  // Legacy table names — only referenced by routes still being migrated.
  // Remove once every route under /api/cron/* + /api/parse-gmail etc. has
  // moved over to the new schema.
  enrichments: "enrichments",
  emailSends: "email_sends",
  emailOpens: "email_opens",
  emailReplies: "email_replies",
  autoRuns: "auto_runs",
} as const;
