-- ─────────────────────────────────────────────────────────────────────────────
-- Greylander Press — Catalog submissions
--
-- Two listing types share this table:
--   listing_type='imprint'      → GP-published works (publish.html flow)
--   listing_type='made_with_gp' → guest authors who used GP tools (per-work
--                                 opt-in modal at creation time)
-- Both flow through the same admin review (status: submitted → published|rejected)
-- via admin-catalog.js.
--
-- Idempotent. Apply in Supabase Dashboard → SQL Editor → New query.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.submissions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  submitted_at    timestamptz not null default now(),

  title           text not null,
  author_name     text,
  genre           text,
  project_type    text,                       -- source tool / type
  blurb           text,
  trim_size       text,
  word_count      integer,
  isbn_requested  boolean default false,

  listing_type    text not null,              -- 'imprint' | 'made_with_gp'
  status          text not null default 'submitted'  -- submitted | under_review | published | rejected
);

create index if not exists submissions_listing_status_idx
  on public.submissions (listing_type, status, submitted_at desc);

create index if not exists submissions_user_idx
  on public.submissions (user_id, submitted_at desc);

alter table public.submissions enable row level security;

-- Anyone can read published rows (powers the public catalog page).
drop policy if exists submissions_public_read on public.submissions;
create policy submissions_public_read
  on public.submissions for select
  using (status = 'published');

-- Authenticated users can read their own submissions regardless of status
-- (so they can see their pending listings in their own dashboard later).
drop policy if exists submissions_owner_read on public.submissions;
create policy submissions_owner_read
  on public.submissions for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy → only service role (functions) can write.
