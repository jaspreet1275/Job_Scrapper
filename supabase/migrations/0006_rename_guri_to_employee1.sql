-- Rename the 'guri' Gmail slot to 'employee1'.
--
-- The label IS the env-var prefix — getOAuthConfig() reads
-- GMAIL_<LABEL>_CLIENT_ID / _CLIENT_SECRET / _DISPLAY_NAME — so renaming the
-- row is what switches that slot over to the GMAIL_EMPLOYEE1_* credentials.
-- No application code references the old label; it only appears in comments.
--
-- 'employee1' satisfies gmail_accounts.label_format ('^[a-z][a-z0-9_]{1,31}$').

update public.gmail_accounts
set label = 'employee1'
where label = 'guri';

-- Cover a fresh DB where 0005's seed hasn't been renamed (or was never run).
insert into public.gmail_accounts (label, is_connected) values
  ('employee1', false)
on conflict (label) do nothing;

-- settings.parse_gmail_selection stores a label (or 'both'); its check
-- constraint has to list the new value or saving the dropdown fails.
-- Migrate any row still pointing at the old label before swapping the check.
update public.settings
set parse_gmail_selection = 'employee1'
where parse_gmail_selection = 'guri';

alter table public.settings
  drop constraint if exists settings_parse_gmail_selection_check;

alter table public.settings
  add constraint settings_parse_gmail_selection_check
  check (parse_gmail_selection in ('both', 'employee1', 'employee'));
