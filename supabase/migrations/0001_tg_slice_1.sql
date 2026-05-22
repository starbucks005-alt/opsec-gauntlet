-- ============================================================================
-- The Gauntlet — Slice 1 schema
-- Tables: tg_submissions, tg_claims, tg_evaluations, tg_judge_outputs, tg_triangulations
-- Conventions mirrored from gauntlet_runs / honest_reviews:
--   * user_id uuid NOT NULL, no FK (auth provider is source of truth)
--   * gen_random_uuid() for PKs
--   * timestamptz with default now()
--   * jsonb for structured findings
--   * RLS: owner SELECT only; writes via service role
-- ============================================================================

-- ─── tg_submissions ─────────────────────────────────────────────────────────
CREATE TABLE tg_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  type            text NOT NULL,
  title           text NOT NULL,
  description     text NOT NULL,
  goal_audience   text,
  constraints     text,
  self_assessment jsonb,
  status          text NOT NULL DEFAULT 'draft'
);

CREATE INDEX tg_submissions_user_id_idx ON tg_submissions(user_id);
CREATE INDEX tg_submissions_status_idx  ON tg_submissions(status);

ALTER TABLE tg_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tg_submissions_owner_select
  ON tg_submissions FOR SELECT
  USING (auth.uid() = user_id);


-- ─── tg_claims ──────────────────────────────────────────────────────────────
CREATE TABLE tg_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES tg_submissions(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  text          text NOT NULL,
  claim_type    text
);

CREATE INDEX tg_claims_submission_id_idx ON tg_claims(submission_id);

ALTER TABLE tg_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY tg_claims_owner_select
  ON tg_claims FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tg_submissions s
      WHERE s.id = tg_claims.submission_id
        AND s.user_id = auth.uid()
    )
  );


-- ─── tg_evaluations ─────────────────────────────────────────────────────────
CREATE TABLE tg_evaluations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id          uuid NOT NULL REFERENCES tg_submissions(id) ON DELETE CASCADE,
  user_id                uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  status                 text NOT NULL DEFAULT 'queued',
  model                  text NOT NULL DEFAULT 'claude-sonnet-4-6',
  orchestration_version  text NOT NULL DEFAULT 'slice-1',
  triad                  jsonb NOT NULL,
  stage                  text NOT NULL DEFAULT 'clarity',
  recommendation_payload jsonb,
  report_object          jsonb,
  error_message          text,
  elapsed_runtime_ms     integer,
  credits_charged        integer NOT NULL DEFAULT 0
);

CREATE INDEX tg_evaluations_submission_id_idx ON tg_evaluations(submission_id);
CREATE INDEX tg_evaluations_user_id_idx       ON tg_evaluations(user_id);
CREATE INDEX tg_evaluations_status_idx        ON tg_evaluations(status);

ALTER TABLE tg_evaluations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tg_evaluations_owner_select
  ON tg_evaluations FOR SELECT
  USING (auth.uid() = user_id);


-- ─── tg_judge_outputs ───────────────────────────────────────────────────────
CREATE TABLE tg_judge_outputs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id      uuid NOT NULL REFERENCES tg_evaluations(id) ON DELETE CASCADE,
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

CREATE INDEX tg_judge_outputs_evaluation_id_idx ON tg_judge_outputs(evaluation_id);

ALTER TABLE tg_judge_outputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tg_judge_outputs_owner_select
  ON tg_judge_outputs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tg_evaluations e
      WHERE e.id = tg_judge_outputs.evaluation_id
        AND e.user_id = auth.uid()
    )
  );


-- ─── tg_triangulations ──────────────────────────────────────────────────────
CREATE TABLE tg_triangulations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id        uuid NOT NULL REFERENCES tg_evaluations(id) ON DELETE CASCADE,
  created_at           timestamptz NOT NULL DEFAULT now(),
  matrix               jsonb NOT NULL,
  agreement_dimensions jsonb NOT NULL,
  conflict_dimensions  jsonb NOT NULL,
  coverage_gaps        jsonb NOT NULL,
  composite_score      numeric(3,2)
);

CREATE INDEX tg_triangulations_evaluation_id_idx ON tg_triangulations(evaluation_id);

ALTER TABLE tg_triangulations ENABLE ROW LEVEL SECURITY;

CREATE POLICY tg_triangulations_owner_select
  ON tg_triangulations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM tg_evaluations e
      WHERE e.id = tg_triangulations.evaluation_id
        AND e.user_id = auth.uid()
    )
  );
