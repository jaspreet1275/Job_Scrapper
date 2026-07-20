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
