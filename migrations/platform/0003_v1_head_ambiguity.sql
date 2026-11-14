ALTER TABLE platform_pr_head_events
  DROP CONSTRAINT IF EXISTS platform_pr_head_events_disposition_check;
ALTER TABLE platform_pr_head_events
  ADD CONSTRAINT platform_pr_head_events_disposition_check
  CHECK(disposition IN('accepted','rejected_out_of_order','quarantined_ambiguous','duplicate'));

ALTER TABLE platform_current_pr_heads
  ADD COLUMN IF NOT EXISTS ambiguous boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS candidate_shas_json jsonb NOT NULL DEFAULT '[]'::jsonb;
