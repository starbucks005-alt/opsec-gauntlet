-- ─────────────────────────────────────────────────────────────────────────────
-- Greylander Press — Workshop async jobs
-- Apply this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: safe to re-run; uses IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.workshop_jobs (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz,

  assist_mode         text not null,                -- enrich | dialogue | continue | diagnose | rebuild

  -- Transient inputs (cleared on completion for privacy + size)
  manuscript_text     text,
  working_section     text,

  -- Output
  result              text,
  credits_charged     integer not null default 0,
  credits_remaining   integer,

  -- Status flow: queued → running → complete | failed
  status              text not null default 'queued',
  error_message       text,

  -- Anthropic stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
  stop_reason         text
);

-- Idempotent column add for upgrading pre-existing tables
alter table public.workshop_jobs add column if not exists stop_reason text;

create index if not exists workshop_jobs_user_idx
  on public.workshop_jobs (user_id, created_at desc);

create index if not exists workshop_jobs_status_idx
  on public.workshop_jobs (status, created_at desc);

alter table public.workshop_jobs enable row level security;

drop policy if exists workshop_jobs_owner_select on public.workshop_jobs;
create policy workshop_jobs_owner_select
  on public.workshop_jobs for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy → only service role can write.
