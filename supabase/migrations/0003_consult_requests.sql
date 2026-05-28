-- 0003_consult_requests.sql
--
-- Standalone Consult intake. When a cold buyer hits /wren.html (or any
-- future EP consult landing) and submits the intake form, the request
-- lands here. Terry reviews and routes manually until Stripe is wired.
--
-- ep:           which EP the request is for ("wren" for v1; future:
--               "reid", "arjun", "matthew", "carol", "ivy", "grant",
--               "zara", "jules").
-- status:       lifecycle. "new" on insert, then "reviewed", "scoped",
--               "won", "lost", "spam". Free-text so Terry can shape it.
-- source:       where the request came from ("landing-page-form" for now;
--               future: "homepage-tile", "ep-referral", etc.)
-- summary:      the one-paragraph description the client wrote.
-- metadata:     anything else we want to keep (utm, referrer, IP if needed).

create table if not exists tg_consult_requests (
  id              uuid primary key default gen_random_uuid(),
  ep              text        not null,
  name            text        not null,
  email           text        not null,
  organization    text,
  phone           text,
  summary         text        not null,
  status          text        not null default 'new',
  source          text        not null default 'landing-page-form',
  metadata        jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  reviewed_at     timestamptz,
  notes           text
);

create index if not exists tg_consult_requests_ep_idx       on tg_consult_requests (ep);
create index if not exists tg_consult_requests_status_idx   on tg_consult_requests (status);
create index if not exists tg_consult_requests_created_idx  on tg_consult_requests (created_at desc);
