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
