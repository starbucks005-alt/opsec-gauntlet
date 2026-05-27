-- ============================================================================
-- The Gauntlet — Slice 2: Pre-EP "before" scoring (Path 2)
--
-- Adds the storage for the live before/after delta. The flow:
--   1. Visitor pastes brief in welcome modal -> frozen as original_description
--   2. Visitor walks corridor, EP tools modify the working brief
--   3. Intake stores BOTH the final description AND the frozen original
--   4. Chamber runs the post-EP scoring (existing tg_evaluations/_judge_outputs/
--      _triangulations) AND fires tg-score-original-bg which writes a parallel
--      scoring of the original brief into the _before tables below
--   5. Report joins both and renders the before/after delta
--
-- Both new tables key on submission_id (not evaluation_id) because the original
-- brief is frozen at intake - one canonical pre-EP scoring per submission,
-- even if the visitor re-runs the chamber later with a different triad.
--
-- Apply in Supabase SQL Editor. Idempotent: uses IF NOT EXISTS guards.
-- ============================================================================

-- ── 1. Frozen original brief on tg_submissions ──────────────────────────────
ALTER TABLE tg_submissions
  ADD COLUMN IF NOT EXISTS original_description text;


-- ── 2. tg_judge_outputs_before ──────────────────────────────────────────────
-- Mirror of tg_judge_outputs, keyed on submission. One row per
-- (submission, judge, dimension) for the pre-EP pass.
CREATE TABLE IF NOT EXISTS tg_judge_outputs_before (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id      uuid NOT NULL REFERENCES tg_submissions(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  judge_id           text NOT NULL,
  stage              text NOT NULL,
  dimension_scores   jsonb NOT NULL,
  stage_critique     text NOT NULL,
  critical_flaws     jsonb,
  risk_flags         jsonb,
  retrieved_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence         numeric(3,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS tg_judge_outputs_before_submission_id_idx
  ON tg_judge_outputs_before(submission_id);

ALTER TABLE tg_judge_outputs_before ENABLE ROW LEVEL SECURITY;

CREATE POLICY tg_judge_outputs_before_owner_select
  ON tg_judge_outputs_before FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tg_submissions s
      WHERE s.id = tg_judge_outputs_before.submission_id
        AND s.user_id = auth.uid()
    )
  );


-- ── 3. tg_triangulations_before ─────────────────────────────────────────────
-- Mirror of tg_triangulations, keyed on submission. One row per submission.
CREATE TABLE IF NOT EXISTS tg_triangulations_before (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id        uuid NOT NULL UNIQUE REFERENCES tg_submissions(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  matrix               jsonb NOT NULL,
  agreement_dimensions jsonb NOT NULL,
  conflict_dimensions  jsonb NOT NULL,
  coverage_gaps        jsonb NOT NULL,
  composite_score      numeric(3,2)
);

CREATE INDEX IF NOT EXISTS tg_triangulations_before_submission_id_idx
  ON tg_triangulations_before(submission_id);

ALTER TABLE tg_triangulations_before ENABLE ROW LEVEL SECURITY;

CREATE POLICY tg_triangulations_before_owner_select
  ON tg_triangulations_before FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tg_submissions s
      WHERE s.id = tg_triangulations_before.submission_id
        AND s.user_id = auth.uid()
    )
  );


-- ============================================================================
-- Rollback (manual, if needed):
--   DROP TABLE IF EXISTS tg_triangulations_before;
--   DROP TABLE IF EXISTS tg_judge_outputs_before;
--   ALTER TABLE tg_submissions DROP COLUMN IF EXISTS original_description;
-- ============================================================================
