import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAssessmentStore } from '../../src/platform/persistence/assessmentStore.js';
import { acceptAuthoritativeHead } from '../../src/platform/impact/headState.js';
import { readAssessment } from '../../src/platform/impact/readAssessments.js';

test('head events reject malformed canonical identity and observation context', async () => {
  const store = new MemoryAssessmentStore();
  const valid = { repository_id: 'repository://demo/opentelemetry-demo', pr_number: 103,
    commit_sha: 'a'.repeat(40), delivery_id: 'delivery', source_observed_at: '2026-11-14T09:00:00Z' };
  for (const event of [null, { ...valid, repository_id: 'repository://invalid' }, { ...valid, pr_number: -1 },
    { ...valid, delivery_id: 'x'.repeat(257) }, { ...valid, source_observed_at: '2026-02-30T09:00:00Z' }]) {
    await assert.rejects(acceptAuthoritativeHead(store, event), { code: 'INVALID_HEAD_EVENT' });
  }
  assert.equal(await store.getCurrentHead(valid.repository_id, valid.pr_number), null);
});

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

test('initial and newer head observations preserve an active assessment at the same SHA', async () => {
  const store=new MemoryAssessmentStore(), id='assessment://sha256:'+'4'.repeat(64);
  await store.saveAssessment({assessment_id:id,replay_key:'4'.repeat(64),repository_id:'repository://demo/opentelemetry-demo',pr_number:104,commit_sha:'d'.repeat(40),work_item_id:'jira://demo/PAY-143',request_context_sha256:'5'.repeat(64),evaluation_at:'2026-11-14T09:00:00.000Z',valid_until:'2026-11-14T10:00:00.000Z',registry_version:'r',snapshot_id:'s',policy_version:'p',analysis_status:'complete',risk_classification:'LOW',shadow_decision:{eligibility:'eligible_for_bypass'},result:{assessment_id:id,shadow_decision:{eligibility:'eligible_for_bypass'},valid_until:'2026-11-14T10:00:00.000Z'}});
  for(const [delivery_id,source_observed_at] of [['same-1','2026-11-14T09:01:00.000Z'],['same-2','2026-11-14T09:02:00.000Z']]) {
    const event=await acceptAuthoritativeHead(store,{repository_id:'repository://demo/opentelemetry-demo',pr_number:104,commit_sha:'d'.repeat(40),delivery_id,source_observed_at});
    assert.equal(event.disposition,'accepted'); assert.equal((await store.getActiveAssessment('repository://demo/opentelemetry-demo',104)).assessment_id,id);
  }
  assert.equal((await store.assessmentEvents()).filter(event=>event.event_type==='INVALIDATED_BY_NEW_HEAD').length,0);
  assert.equal((await readAssessment(store,id,{now:'2026-11-14T09:30:00.000Z'})).current_eligibility,'eligible_for_bypass');
  const ambiguous=await acceptAuthoritativeHead(store,{repository_id:'repository://demo/opentelemetry-demo',pr_number:104,commit_sha:'e'.repeat(40),delivery_id:'ambiguous',source_observed_at:'2026-11-14T09:02:00.000Z'});
  assert.equal(ambiguous.disposition,'quarantined_ambiguous'); assert.equal((await store.getCurrentHead('repository://demo/opentelemetry-demo',104)).ambiguous,true);
  assert.equal(await store.getActiveAssessment('repository://demo/opentelemetry-demo',104),null);
  await assert.rejects(()=>store.saveAssessment({assessment_id:'assessment://sha256:'+'9'.repeat(64),replay_key:'9'.repeat(64),repository_id:'repository://demo/opentelemetry-demo',pr_number:104,commit_sha:'e'.repeat(40)}),{code:'HEAD_AMBIGUOUS'});
  const quarantined=await readAssessment(store,id,{now:'2026-11-14T09:30:00.000Z'});
  assert.equal(quarantined.current_eligibility,'invalidated_by_ambiguous_head'); assert.equal(quarantined.head_valid,false);
  assert.equal((await acceptAuthoritativeHead(store,{repository_id:'repository://demo/opentelemetry-demo',pr_number:104,commit_sha:'f'.repeat(40),delivery_id:'stale',source_observed_at:'2026-11-14T09:01:30.000Z'})).disposition,'rejected_out_of_order');
  assert.equal((await acceptAuthoritativeHead(store,{repository_id:'repository://demo/opentelemetry-demo',pr_number:104,commit_sha:'e'.repeat(40),delivery_id:'recovery',source_observed_at:'2026-11-14T09:03:00.000Z'})).disposition,'accepted');
  assert.equal((await store.getCurrentHead('repository://demo/opentelemetry-demo',104)).ambiguous,false);
});
