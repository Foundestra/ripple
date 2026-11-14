CREATE TABLE IF NOT EXISTS platform_assessments (
  assessment_id text PRIMARY KEY,
  replay_key text NOT NULL UNIQUE,
  repository_id text NOT NULL,
  pr_number bigint NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  work_item_id text NOT NULL,
  request_context_sha256 text NOT NULL,
  evaluation_at timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  registry_version text NOT NULL REFERENCES platform_registry_versions(registry_version),
  snapshot_id text NOT NULL REFERENCES platform_graph_snapshots(snapshot_id),
  policy_version text NOT NULL,
  analysis_status text NOT NULL CHECK (analysis_status IN ('complete','partial','insufficient_evidence','failed')),
  risk_classification text NOT NULL CHECK (risk_classification IN ('HIGH','MEDIUM','LOW','UNKNOWN')),
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(octet_length(result_json::text) <= 1048576)
);
CREATE INDEX IF NOT EXISTS platform_assessments_pr_idx ON platform_assessments(repository_id,pr_number,evaluation_at DESC);
CREATE INDEX IF NOT EXISTS platform_assessments_work_idx ON platform_assessments(work_item_id,evaluation_at DESC);
CREATE INDEX IF NOT EXISTS platform_assessments_commit_idx ON platform_assessments(repository_id,commit_sha);

CREATE TABLE IF NOT EXISTS platform_shadow_decisions (
  decision_id text PRIMARY KEY,
  assessment_id text NOT NULL UNIQUE REFERENCES platform_assessments(assessment_id),
  outcome text NOT NULL,
  eligibility text NOT NULL,
  authorization_status text NOT NULL CHECK (authorization_status = 'not_evaluated'),
  reasons_json jsonb NOT NULL,
  controls_json jsonb NOT NULL,
  evidence_refs_json jsonb NOT NULL,
  valid_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_assessment_events (
  event_id uuid PRIMARY KEY,
  assessment_id text NOT NULL REFERENCES platform_assessments(assessment_id),
  event_type text NOT NULL,
  related_assessment_id text REFERENCES platform_assessments(assessment_id),
  head_sha text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS platform_assessment_events_assessment_idx ON platform_assessment_events(assessment_id,occurred_at);

CREATE TABLE IF NOT EXISTS platform_pr_head_events (
  event_id uuid PRIMARY KEY,
  repository_id text NOT NULL,
  pr_number bigint NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  delivery_id text NOT NULL,
  source_observed_at timestamptz NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  disposition text NOT NULL CHECK (disposition IN ('accepted','rejected_out_of_order','duplicate')),
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(repository_id,pr_number,delivery_id)
);

CREATE TABLE IF NOT EXISTS platform_current_pr_heads (
  repository_id text NOT NULL,
  pr_number bigint NOT NULL,
  commit_sha text NOT NULL,
  head_event_id uuid NOT NULL UNIQUE REFERENCES platform_pr_head_events(event_id),
  source_observed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(repository_id,pr_number)
);

CREATE TABLE IF NOT EXISTS platform_active_assessments (
  repository_id text NOT NULL,
  pr_number bigint NOT NULL,
  assessment_id text NOT NULL UNIQUE REFERENCES platform_assessments(assessment_id),
  commit_sha text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(repository_id,pr_number)
);

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['platform_assessments','platform_shadow_decisions','platform_assessment_events','platform_pr_head_events'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reject_fact_mutation_' || name AND tgrelid = to_regclass(name)) THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION platform_reject_fact_mutation()', 'reject_fact_mutation_' || name, name);
    END IF;
  END LOOP;
END $$;
