-- ─────────────────────────────────────────────────────────────────────────────
-- Greylander Press — Honest Reviews schema
-- Apply this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Idempotent: safe to re-run; uses IF NOT EXISTS guards.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.honest_reviews (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  published_at          timestamptz,                       -- null until author opts to publish

  -- Tier
  tier                  text not null,                     -- 'demo' | 'scan'

  -- Book metadata (provided by submitter)
  book_title            text not null,
  book_author           text not null,
  book_publisher        text,
  book_year             integer,
  book_isbn             text,
  cover_image_url       text,                              -- optional

  -- Submitted manuscript
  manuscript_filename   text,
  manuscript_word_count integer,
  manuscript_page_count integer,

  -- Engine output (populated when status flips to 'complete')
  honesty_score         text,                              -- band
  test_bands            jsonb,                             -- 5-Test bands
  test_findings         jsonb,                             -- per-Test summary + holes
  executive_summary     text,
  pull_quote            text,                              -- short headline-ready assessment line
  full_book_brief       jsonb,                             -- structured brief from the full-book context pass
  sampled_chapter_indices jsonb,                           -- which chapters the eval passes saw
  pass_raw_bands        jsonb,
  validator_regens      integer not null default 0,
  parsed_text           text,                              -- transient: cleared on completion for privacy

  -- Engine audit
  model                 text not null default 'claude-sonnet-4-6',
  pass_count            integer not null default 3,
  elapsed_runtime_ms    integer,

  -- Per-chapter evaluation results (5 chapters × 3 passes each)
  -- Shape: [{ chapter_index, chapter_title, status, passes:[{bands, findings_per_test, pull_quote_candidate}], median_bands }]
  chapter_evaluations   jsonb,

  -- Status flow:
  --   queued → briefing → evaluating → synthesizing → complete
  --   any → failed (error_message set)
  status                text not null default 'queued',
  error_message         text,
  credits_charged       integer not null default 0,

  -- Notification: how does the user want to be told the review is ready?
  notify_choice         text default 'wait',               -- 'wait' | 'email'
  notify_email          text,                              -- destination if notify_choice='email'
  notify_sent_at        timestamptz,                       -- set when email actually sent

  -- Publication
  is_published          boolean not null default false,    -- true = on greylanderpress.com/reviews
  slug                  text unique                        -- SEO-friendly URL fragment, set when published
);

create index if not exists honest_reviews_user_idx
  on public.honest_reviews (user_id, created_at desc);

create index if not exists honest_reviews_published_idx
  on public.honest_reviews (is_published, published_at desc)
  where is_published = true;

create index if not exists honest_reviews_status_idx
  on public.honest_reviews (status, created_at desc);

-- ── Row Level Security ───────────────────────────────────────────────────────
alter table public.honest_reviews enable row level security;

-- Owners can read their own (any status)
drop policy if exists honest_reviews_owner_select on public.honest_reviews;
create policy honest_reviews_owner_select
  on public.honest_reviews for select
  using (auth.uid() = user_id);

-- Anyone (including anon) can read PUBLISHED reviews (the public marketing surface)
drop policy if exists honest_reviews_public_select on public.honest_reviews;
create policy honest_reviews_public_select
  on public.honest_reviews for select
  using (is_published = true);

-- Owners can flip is_published once (irrevocable per product spec, enforced in app/RPC)
drop policy if exists honest_reviews_owner_publish on public.honest_reviews;
create policy honest_reviews_owner_publish
  on public.honest_reviews for update
  using (auth.uid() = user_id);

-- Done.
