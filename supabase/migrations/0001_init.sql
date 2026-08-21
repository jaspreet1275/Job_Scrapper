replied-- =============================================================================
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
