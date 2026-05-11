-- ─────────────────────────────────────────────────────────────────────────────
-- Greylander Press — Site Reviews (Phase 07: visitor testimonials about GP)
-- Apply in Supabase Dashboard → SQL Editor → New query.
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.site_reviews (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  approved_at     timestamptz,

  reviewer_name   text not null,
  rating          integer not null check (rating between 1 and 5),
  title           text not null,
  tool            text not null,            -- General Usability | Tool Accuracy | Author Playground | Onboarding
  comment         text not null,

  status          text not null default 'pending',  -- pending | approved | rejected
  ip_hash         text                              -- optional rate-limit/abuse signal
);

create index if not exists site_reviews_status_idx
  on public.site_reviews (status, created_at desc);

alter table public.site_reviews enable row level security;

-- Anonymous visitors can read approved rows for the public listing.
drop policy if exists site_reviews_public_read on public.site_reviews;
create policy site_reviews_public_read
  on public.site_reviews for select
  using (status = 'approved');

-- No insert/update/delete policy → only service role (functions) can write.
