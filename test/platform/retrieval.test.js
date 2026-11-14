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
  await store.saveAssessment(row(2,'2026-11-14T11:00:00.000Z'));
  const getHead=store.getCurrentHead.bind(store), getActive=store.getActiveAssessment.bind(store);
  let headReads=0,activeReads=0;
  store.getCurrentHead=async(...args)=>{headReads++; return getHead(...args);};
  store.getActiveAssessment=async(...args)=>{activeReads++; return getActive(...args);};
  assert.equal((await readAssessmentHistory(store,{work_item_id:value.work_item_id},{limit:2,now:'2026-11-14T09:30:00.000Z'})).count,2);
  assert.deepEqual({headReads,activeReads},{headReads:1,activeReads:1},'history loads state once per PR, not once per row');
  await assert.rejects(() => readAssessmentHistory(store, {}, { limit: 101 }), { code: 'HISTORY_LIMIT_EXCEEDED' });
});
