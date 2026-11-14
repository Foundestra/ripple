import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAssessmentStore } from '../../src/platform/persistence/assessmentStore.js';

const row = { assessment_id: 'assessment://sha256:' + '1'.repeat(64), replay_key: '1'.repeat(64), repository_id: 'repository://demo/opentelemetry-demo',
  pr_number: 103, commit_sha: 'a'.repeat(40), work_item_id: 'jira://demo/PAY-142', request_context_sha256: '2'.repeat(64),
  evaluation_at: '2026-11-14T09:00:00.000Z', valid_until: '2026-11-14T10:00:00.000Z', registry_version: 'registry', snapshot_id: 'snapshot', policy_version: 'policy',
  analysis_status: 'partial', risk_classification: 'HIGH', shadow_decision: { eligibility: 'ineligible' }, result: { assessment_id: 'assessment://sha256:' + '1'.repeat(64) } };

test('duplicate replay returns one immutable assessment', async () => {
  const store = new MemoryAssessmentStore();
  assert.equal((await store.saveAssessment(row)).replayed, false);
  assert.equal((await store.saveAssessment({ ...row, risk_classification: 'LOW' })).replayed, true);
  assert.equal((await store.listAssessments({ limit: 20 })).length, 1);
  assert.equal((await store.getAssessment(row.assessment_id)).risk_classification, 'HIGH');
});
