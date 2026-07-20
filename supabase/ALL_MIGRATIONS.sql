-- ============ 0001_init.sql ============
-- =============================================================================
-- Job Scraper Dashboard — Initial Schema
-- Tables: jobs_v2 (scraped postings) + email_tracking (outreach/opens/replies).
-- settings holds the single-row dashboard config.
-- =============================================================================

-- ── 1. JOBS_V2 (scraped postings) ────────────────────────────────────────────
create table public.jobs_v2 (
  job_id text not null,
  title text not null,
  company text not null,
  description text null,
  url text null,
  location text null,
  platform text not null,
  method text not null,
  job_type text null,
  posted_at date null,
  scraped_at timestamp with time zone null default now(),
  enrichment jsonb null,
  email_status text null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  constraint jobs_v2_pkey1 primary key (job_id),
  constraint chk_email_status check (
    (
      (email_status is null)
      or (
        email_status = any (
          array[
            'enriched'::text,
            'sent'::text,
            'opened'::text,
            'replied'::text
          ]
        )
      )
    )
  ),
  constraint chk_method check (
    (
      method = any (array['search'::text, 'gmail-alert'::text])
    )
  ),
  constraint chk_platform check (
    (
      platform = any (
        array[
          'linkedin'::text,
          'upwork'::text,
          'indeed'::text,
          'remoteok'::text
        ]
      )
    )
  )
) TABLESPACE pg_default;


-- ── 2. EMAIL_TRACKING (every email sent + opens/replies) ─────────────────────
create table public.email_tracking (
  id uuid not null default gen_random_uuid (),
  job_id text not null,
  to_email text not null,
  subject text not null,
  body text not null,
  stage smallint not null,
  thread_id text null,
  status text not null default 'sent'::text,
  sent_at timestamp with time zone null default now(),
  opened_at timestamp with time zone null,
  replied_at timestamp with time zone null,
  reply_from text null,
  reply_snippet text null,
  created_at timestamp with time zone null default now(),
  updated_at timestamp with time zone null default now(),
  tracking_id text null,
  constraint email_tracking_pkey primary key (id),
  constraint email_tracking_tracking_id_key unique (tracking_id),
  constraint email_tracking_job_id_fkey foreign KEY (job_id) references jobs_v2 (job_id) on delete CASCADE,
  constraint chk_status check (
    (
      status = any (
        array['sent'::text, 'opened'::text, 'replied'::text]
      )
    )
  )
) TABLESPACE pg_default;

create index IF not exists idx_et_job_id on public.email_tracking using btree (job_id) TABLESPACE pg_default;

create index IF not exists idx_et_status on public.email_tracking using btree (status) TABLESPACE pg_default;

create index IF not exists idx_et_thread on public.email_tracking using btree (thread_id) TABLESPACE pg_default;

create index IF not exists idx_et_stage on public.email_tracking using btree (stage) TABLESPACE pg_default;

create index IF not exists idx_et_tracking on public.email_tracking using btree (tracking_id) TABLESPACE pg_default;


-- ── 3. SETTINGS (single-row dashboard config) ────────────────────────────────
create table public.settings (
  id integer not null default 1,
  auto_mode_enabled boolean not null default false,
  daily_send_limit integer not null default 50,
  send_window_start_hour integer not null default 11,
  gmail_refresh_token text null,
  last_scrape_at timestamp with time zone null,
  last_followup_check_at timestamp with time zone null,
  last_reply_check_at timestamp with time zone null,
  updated_at timestamp with time zone null default now(),
  max_emails_per_run integer null default 25,
  platform_filter text null default 'linkedin'::text,
  daily_schedule_hour integer null,
  send_gmail_refresh_token text null,
  technologies jsonb null default '[]'::jsonb,
  constraint settings_pkey primary key (id),
  constraint settings_singleton check ((id = 1))
) TABLESPACE pg_default;

insert into public.settings (id) values (1) on conflict (id) do nothing;


-- ── 4. updated_at auto-touch trigger (used by jobs_v2 + email_tracking) ──────
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_jobs_v2_updated_at on jobs_v2;
create trigger trg_jobs_v2_updated_at
  before update on jobs_v2
  for each row execute function set_updated_at();

drop trigger if exists trg_email_tracking_updated_at on email_tracking;
create trigger trg_email_tracking_updated_at
  before update on email_tracking
  for each row execute function set_updated_at();

-- ============ 0002_prompts.sql ============
-- =============================================================================
-- Saved Prompts library
-- Per-user library of reusable prompt bodies that the job detail page can pick
-- from when generating outreach emails. Selected prompt is appended to the
-- baseline Manatanu email prompt as a USER OVERRIDE block (same path that the
-- "Refine with prompt" modal already uses).
-- =============================================================================

create table if not exists public.prompts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Keep updated_at fresh on every UPDATE without forcing callers to set it.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists prompts_set_updated_at on public.prompts;
create trigger prompts_set_updated_at
before update on public.prompts
for each row execute function public.set_updated_at();

-- ============ 0003_enriched_at.sql ============
-- =============================================================================
-- jobs_v2.enriched_at — separate timestamp for when a job was actually enriched.
-- Needed by the Analytics timeline chart so "Enriched" counts per day are not
-- conflated with later email-status updates (sent/opened/replied) that also
-- bump updated_at via the set_updated_at trigger.
-- =============================================================================

alter table public.jobs_v2
  add column if not exists enriched_at timestamp with time zone null;

-- Backfill existing rows so the chart has data on day-1: any row already in
-- the 'enriched'+ lifecycle states gets enriched_at = updated_at as a best
-- approximation. New enrichments will write the field directly going forward.
update public.jobs_v2
set enriched_at = updated_at
where enriched_at is null
  and email_status in ('enriched', 'sent', 'opened', 'replied');

create index if not exists idx_jobs_enriched_at
  on public.jobs_v2 (enriched_at);

-- ============ 0004_schedule_times.sql ============
-- =============================================================================
-- settings.daily_schedule_times — multi-time daily cron schedule
-- Replaces the single-value daily_schedule_hour with a JSON array of IST "HH:MM"
-- strings. The cron-scrape workflow fires at every supported time and the gate
-- job picks whichever ones the user has selected via the Daily Schedule UI.
-- Empty array → scheduler disabled (manual / Auto-Scrape only).
-- =============================================================================

alter table public.settings
  add column if not exists daily_schedule_times jsonb not null default '[]'::jsonb;

comment on column public.settings.daily_schedule_times is
  'IST "HH:MM" times when the daily cron-scrape should run, e.g. ["09:30","12:30","16:00"]. Empty → scheduler off.';

-- Backfill: if a legacy single daily_schedule_hour is set, seed the new
-- array with that hour at minute 00 so users keep their previous behaviour.
update public.settings
set daily_schedule_times =
  jsonb_build_array(to_char(daily_schedule_hour, 'FM00') || ':00')
where daily_schedule_hour is not null
  and (daily_schedule_times is null or daily_schedule_times = '[]'::jsonb);

-- ============ 0005_multi_gmail_accounts.sql ============
-- Multi-Gmail account support.
--
-- Each row represents one connected Gmail. The `label` matches the env-var
-- prefix used by the OAuth client lookup — GMAIL_<LABEL>_CLIENT_ID etc —
-- so adding a 3rd account is purely a config change (env vars + insert),
-- no code modification needed.
--
-- settings.gmail_refresh_token (the legacy single-token field) is kept in
-- place so an in-flight migration doesn't strand existing deployments —
-- getAuthenticatedClient() falls back to it when gmail_accounts is empty.

create table if not exists public.gmail_accounts (
  id                bigserial primary key,
  label             text not null unique,
  email_address     text,
  refresh_token     text,
  is_connected      boolean not null default false,
  last_parsed_at    timestamptz,
  jobs_parsed_total integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Block label injection (e.g. ../admin) — only lowercase + digits + underscore,
  -- 2-32 chars, must start with a letter.
  constraint label_format check (label ~ '^[a-z][a-z0-9_]{1,31}$')
);

-- Hot-path index — parse-gmail filters by is_connected on every fire.
create index if not exists gmail_accounts_connected_idx
  on public.gmail_accounts (is_connected) where is_connected = true;

-- Auto-touch updated_at on every mutation so the UI's "last changed" pill
-- doesn't need to be hand-set in every route.
create or replace function public.touch_gmail_accounts_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_gmail_accounts_updated_at on public.gmail_accounts;
create trigger trg_gmail_accounts_updated_at
  before update on public.gmail_accounts
  for each row execute function public.touch_gmail_accounts_updated_at();

-- Seed both slot rows so dashboard UI renders "Not connected" placeholders
-- the moment env vars are configured — no manual insert step for the user.
insert into public.gmail_accounts (label, is_connected) values
  ('guri',     false),
  ('employee', false)
on conflict (label) do nothing;

-- Which account(s) the parse-gmail route should read from.
-- 'both' = loop all connected accounts. Otherwise = that single label.
-- The check constraint stays in sync with the seed labels so the dropdown
-- on the dashboard can only persist values that actually exist.
alter table public.settings
  add column if not exists parse_gmail_selection text
    not null default 'both';

-- Drop and recreate the check so re-running the migration after adding
-- new labels (e.g. 'employee2') works without manual SQL surgery.
alter table public.settings
  drop constraint if exists settings_parse_gmail_selection_check;

alter table public.settings
  add constraint settings_parse_gmail_selection_check
  check (parse_gmail_selection in ('both', 'guri', 'employee'));

