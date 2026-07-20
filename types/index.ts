// Centralised TypeScript types for the dashboard. Components and API
// routes used to redefine these in 6+ places — this file is now the
// single source of truth. When adding a field, update here only.

// ─── Enrichment ───────────────────────────────────────────────────────

/**
 * Slim contact view used by the detail page. Only the four fields the
 * UI actually surfaces (name / title / email / LinkedIn) — all nullable
 * because enrichment can fail partially.
 */
export interface DetailCandidate {
  email?: string | null;
  name?: string | null;
  title?: string | null;
  linkedin?: string | null;
}

/**
 * A decision-maker contact (CEO / Founder / Hiring Manager etc.) that
 * the enrichment pipeline pulled from the company website + RocketReach.
 */
export interface Candidate {
  id: number;
  name: string;
  title: string;
  linkedin: string;
  company: string;
  domain: string;
  location: string;
  email?: string;
  emailVerified?: string;
}

/**
 * Full enrichment payload attached to a Job. Company-level facts +
 * an ordered list of candidates (best-email-first).
 */
export interface EnrichedLead {
  companyDomain: string;
  companyLinkedin: string;
  companyPhone: string;
  companySize: string;
  companyCountry: string;
  companyIndustry: string;
  candidates: Candidate[];
  selectedCandidateIndex?: number;
  apolloSearchUrl: string;
  linkedinSearchUrl: string;
}

// ─── Jobs ─────────────────────────────────────────────────────────────

/**
 * The client-facing Job shape used by the dashboard. Mirrors a row in
 * `jobs_v2` plus the embedded enrichment JSONB and a few client-side
 * tracking fields written back from email_tracking aggregates.
 */
export interface Job {
  title: string;
  jobId?: string;
  /**
   * Supabase row UUID assigned by `lib/db/jobs-persist.ts` after upsert.
   * Passed back to /api/email/send so email_tracking.job_id links to
   * the row — the cron follow-up worker uses this to locate context.
   */
  dbId?: string;
  company: string;
  email?: string;
  location: string;
  jobType: string;
  description: string;
  url?: string;
  postedAt?: string;
  platform?: string;
  matchScore: number;
  enriched?: EnrichedLead;
  status?: string;
  capturedDate?: string;
  emailsSent?: number;
  lastContactedAt?: string;
  notes?: string;
  dealValue?: number;
  // ─── Multi-stage email tracking (Trigger → Case Study → Breakup) ───
  stagesSent?: number[];
  lastThreadId?: string;
  lastEmailSentAt?: string;
  hasReplied?: boolean;
  repliedAt?: string;
  repliedAfterStage?: number;
  // ─── Auto-fetched description tracking ───
  descriptionFetched?: boolean;
  // ─── Open tracking ───
  trackingId?: string;
  openedCount?: number;
  firstOpenedAt?: string;
  lastOpenedAt?: string;
}

/**
 * Raw row shape as returned by /api/jobs/[jobId] — closer to the DB
 * schema than the client `Job` type. Used by the detail page which
 * works with the unflattened JSONB enrichment column.
 */
export interface JobRow {
  job_id: string;
  title: string;
  company: string;
  description: string | null;
  url: string | null;
  location: string | null;
  platform: string;
  method: string;
  job_type: string | null;
  posted_at: string | null;
  scraped_at: string;
  enrichment: {
    email?: string | null;
    name?: string | null;
    title?: string | null;
    linkedin?: string | null;
    company_country?: string | null;
    company_industry?: string | null;
    company_size?: string | null;
  } | null;
  email_status: string | null;
}

// ─── Email tracking ───────────────────────────────────────────────────

/**
 * A row in `email_tracking`. One per send across stages 1/2/3.
 */
export interface EmailRow {
  id: string;
  stage: number;
  status: string;
  to_email: string;
  subject: string;
  body: string;
  sent_at: string | null;
  opened_at: string | null;
  replied_at: string | null;
}

// ─── API response envelopes ───────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Shape returned by /api/jobs/[jobId] (single job + its emails). */
export interface JobDetailResponse {
  success: boolean;
  job?: JobRow;
  emails?: EmailRow[];
  error?: string;
}
