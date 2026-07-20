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
