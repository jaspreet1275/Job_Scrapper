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
