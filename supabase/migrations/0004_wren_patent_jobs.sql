-- 0004_wren_patent_jobs.sql
--
-- Background job storage for Wren patent analysis.
--
-- Netlify Background Functions return 202 immediately and continue
-- running for up to 15 minutes. They cannot return the result via
-- HTTP, so we persist it here keyed on a client-generated job_id.
--
-- Lifecycle:
--   1. Client POSTs to tg-wren-patent-analyze-background with a fresh
--      job_id. Function inserts row with status='pending'.
--   2. Function runs the LLM. On success it updates the row to
--      status='done' with the full result JSONB. On failure it sets
--      status='error' with an error message.
--   3. Client polls tg-wren-patent-status with the job_id every few
--      seconds until status is no longer 'pending'.

create table if not exists tg_wren_patent_jobs (
  job_id        uuid primary key,
  status        text not null default 'pending',
  result        jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index if not exists tg_wren_patent_jobs_status_idx
  on tg_wren_patent_jobs (status, created_at desc);
