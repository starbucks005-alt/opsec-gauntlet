-- ─────────────────────────────────────────────────────────────────────────────
-- Greylander Press — Gauntlet schema
-- Apply this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: safe to re-run; uses IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── gauntlet_runs ────────────────────────────────────────────────────────────
-- One row per Gauntlet diagnostic run. Lives forever; status flows
-- 'running' → 'complete' | 'failed' | 'archived'.
create table if not exists public.gauntlet_runs (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  created_at            timestamptz not null default now(),

  -- Input metadata
  manuscript_filename   text,
  manuscript_word_count integer,
  manuscript_page_count integer,
  scope                 text not null,                -- 'full_manuscript' | 'full_chapter' | 'excerpt'
  excerpt_context       jsonb,                         -- {position, protagonist, prior_scene} when scope='excerpt'

  -- Report Card output
  honesty_score         text,                          -- 'professional' | 'competent' | 'developmental' | 'foundational'
  pillar_bands          jsonb,                         -- {sensory_depth, dialogue_vitality, pacing_tension, structural_integrity, character_agency}
  pillar_findings       jsonb,                         -- per-pillar: {summary, holes:[{ref, finding}]}
  stagnation_flags      jsonb,                         -- {patterns:[...], routed_to_enricher:bool, density_per_pattern:{}}
  chapter_heat_map      jsonb,                         -- [{chapter, bands, findings}, ...] when chapters detected
  executive_summary     text,
  red_ink_list          jsonb,                         -- [{rank, finding, author_action}, ...]
  tool_recommendations  jsonb,                         -- [{tool, excerpt, diagnosis, why}, ...]

  -- Engine audit
  model                 text not null default 'claude-sonnet-4-6',
  pass_count            integer not null default 3,
  pass_raw_bands        jsonb,                         -- 3 raw outputs before median, for reproducibility audit
  validator_regens      integer not null default 0,
  parsed_text           text,                          -- transient: PDF text passed from init → background; cleared on completion for privacy

  -- Performance + feedback
  elapsed_runtime_ms    integer,
  user_feedback         jsonb,                         -- {helpful:bool, comment:text} once feedback UI ships

  -- Billing + status
  credits_charged       integer not null default 0,
  status                text not null default 'running',  -- 'running' | 'complete' | 'failed' | 'archived'
  error_message         text
);

create index if not exists gauntlet_runs_user_idx
  on public.gauntlet_runs (user_id, created_at desc);

create index if not exists gauntlet_runs_status_idx
  on public.gauntlet_runs (status, created_at desc);

-- Idempotent column adds for upgrading pre-existing tables
alter table public.gauntlet_runs add column if not exists parsed_text text;
-- 2026-05-01: user-picked scope tier (chapter|novella_20k|novella_50k|manuscript).
-- Drives billing; backend `scope` column still holds the eval-prompt scope (full_chapter|full_manuscript).
alter table public.gauntlet_runs add column if not exists user_scope text;

-- ── Row Level Security ───────────────────────────────────────────────────────
-- Users can read their own runs; service role bypasses RLS for inserts/updates
-- from the function backend.
alter table public.gauntlet_runs enable row level security;

drop policy if exists gauntlet_runs_owner_select on public.gauntlet_runs;
create policy gauntlet_runs_owner_select
  on public.gauntlet_runs for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy → only service role can write.

-- ── gauntlet_validator_failures ──────────────────────────────────────────────
-- Sidecar log: every time the anti-sycophancy validator hard-fails (3 regens
-- in a row produced banned phrases), capture for engine debugging.
create table if not exists public.gauntlet_validator_failures (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid references public.gauntlet_runs(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  scope         text,
  prompt_excerpt text,                                  -- first 500 chars of input prompt
  attempts      jsonb                                   -- [{attempt:1, output_excerpt, banned_phrases_matched:[...]}]
);

alter table public.gauntlet_validator_failures enable row level security;
-- No user policies → admin-only via service role / dashboard.

-- ── gauntlet_pattern3_flags ──────────────────────────────────────────────────
-- Measurement loop for Pattern 3 (Abstract Summary) regex proxy.
-- Logs every flagged paragraph so we can review false-positive rate at run #50.
-- If FP rate > 20%, upgrade to LLM-confirmation step.
create table if not exists public.gauntlet_pattern3_flags (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid references public.gauntlet_runs(id) on delete cascade,
  created_at          timestamptz not null default now(),
  paragraph_text      text not null,                    -- the flagged paragraph
  paragraph_index     integer,                          -- position in manuscript (0-based)
  sensory_word_count  integer,
  abstract_verb_count integer,
  sentence_count      integer,
  reviewed            boolean not null default false,   -- has a human reviewed this flag?
  is_false_positive   boolean,                          -- null until reviewed
  reviewer_note       text
);

alter table public.gauntlet_pattern3_flags enable row level security;
-- Admin-only via service role / dashboard.

-- ── Helpful: a view for FP rate review ───────────────────────────────────────
create or replace view public.gauntlet_pattern3_fp_rate as
select
  count(*)                                            as total_flagged,
  count(*) filter (where reviewed)                    as total_reviewed,
  count(*) filter (where is_false_positive)           as false_positives,
  case
    when count(*) filter (where reviewed) > 0
    then round(
      100.0 * count(*) filter (where is_false_positive)
      / count(*) filter (where reviewed), 2
    )
    else null
  end                                                 as fp_rate_pct
from public.gauntlet_pattern3_flags;

-- Done.
