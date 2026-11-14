import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAssessmentStore } from '../../src/platform/persistence/assessmentStore.js';
import { readAssessment, readAssessmentHistory } from '../../src/platform/impact/readAssessments.js';

function row(n, validUntil) { const id = `assessment://sha256:${String(n).repeat(64)}`; return { assessment_id:id,replay_key:String(n).repeat(64),repository_id:'repository://demo/opentelemetry-demo',pr_number:103,commit_sha:'a'.repeat(40),work_item_id:'jira://demo/PAY-142',request_context_sha256:'b'.repeat(64),evaluation_at:`2026-11-14T09:0${n}:00.000Z`,valid_until:validUntil,registry_version:'r',snapshot_id:'s',policy_version:'p',analysis_status:'complete',risk_classification:'LOW',shadow_decision:{eligibility:'eligible_for_bypass'},result:{assessment_id:id,shadow_decision:{eligibility:'eligible_for_bypass'},valid_until:validUntil} }; }

test('reads derive expiry without mutating stored result and bound history', async () => {
  const store = new MemoryAssessmentStore();
  const value = row(1, '2026-11-14T10:00:00.000Z'); await store.saveAssessment(value);
  const read = await readAssessment(store, value.assessment_id, { now: '2026-11-14T10:00:00.000Z' });
  assert.equal(read.current_eligibility, 'expired'); assert.equal(read.reevaluation_required, true);
  assert.equal((await store.getAssessment(value.assessment_id)).result.current_eligibility, undefined);
  assert.equal((await readAssessmentHistory(store, { work_item_id: value.work_item_id }, { limit: 1 })).count, 1);
  await assert.rejects(() => readAssessmentHistory(store, {}, { limit: 101 }), { code: 'HISTORY_LIMIT_EXCEEDED' });
});
