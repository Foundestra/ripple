import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAssessmentStore } from '../../src/platform/persistence/assessmentStore.js';
import { acceptAuthoritativeHead } from '../../src/platform/impact/headState.js';
import { readAssessment } from '../../src/platform/impact/readAssessments.js';

test('new head invalidates before reanalysis and older heads cannot reactivate', async () => {
  const store = new MemoryAssessmentStore(); const id='assessment://sha256:'+'1'.repeat(64);
  await store.saveAssessment({assessment_id:id,replay_key:'1'.repeat(64),repository_id:'repository://demo/opentelemetry-demo',pr_number:103,commit_sha:'a'.repeat(40),work_item_id:'jira://demo/PAY-142',request_context_sha256:'2'.repeat(64),evaluation_at:'2026-11-14T09:00:00.000Z',valid_until:'2026-11-14T10:00:00.000Z',registry_version:'r',snapshot_id:'s',policy_version:'p',analysis_status:'partial',risk_classification:'HIGH',shadow_decision:{eligibility:'ineligible'},result:{assessment_id:id,shadow_decision:{eligibility:'ineligible'},valid_until:'2026-11-14T10:00:00.000Z'}});
  const accepted = await acceptAuthoritativeHead(store,{repository_id:'repository://demo/opentelemetry-demo',pr_number:103,commit_sha:'b'.repeat(40),delivery_id:'d2',source_observed_at:'2026-11-14T09:10:00.000Z'});
  assert.equal(accepted.disposition,'accepted');
  assert.equal((await readAssessment(store,id,{now:'2026-11-14T09:20:00.000Z'})).current_eligibility,'invalidated_by_new_head');
  const old = await acceptAuthoritativeHead(store,{repository_id:'repository://demo/opentelemetry-demo',pr_number:103,commit_sha:'a'.repeat(40),delivery_id:'d1',source_observed_at:'2026-11-14T09:05:00.000Z'});
  assert.equal(old.disposition,'rejected_out_of_order'); assert.equal((await store.getCurrentHead('repository://demo/opentelemetry-demo',103)).commit_sha,'b'.repeat(40));
  await assert.rejects(()=>store.saveAssessment({assessment_id:'assessment://sha256:'+'3'.repeat(64),replay_key:'3'.repeat(64),repository_id:'repository://demo/opentelemetry-demo',pr_number:103,commit_sha:'a'.repeat(40)}),{code:'HEAD_SUPERSEDED'});
  await acceptAuthoritativeHead(store,{repository_id:'repository://demo/opentelemetry-demo',pr_number:103,commit_sha:'a'.repeat(40),delivery_id:'d3',source_observed_at:'2026-11-14T09:15:00.000Z'});
  await store.rebuildAssessmentProjections();
  assert.equal(await store.getActiveAssessment('repository://demo/opentelemetry-demo',103),null,'a returning SHA cannot reactivate an invalidated assessment');
  assert.equal((await readAssessment(store,id,{now:'2026-11-14T09:20:00.000Z'})).current_eligibility,'invalidated_by_new_head');
});
