import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresAssessmentStore } from '../../src/platform/persistence/postgresAssessmentStore.js';
import { evaluateShadowPolicy } from '../../src/platform/policy/evaluateShadowPolicy.js';

const url=process.env.RIPPLE_PLATFORM_TEST_DATABASE_URL;
test('Postgres assessments are replay-safe, immutable, and head-invalidated transactionally',{skip:!url&&'set RIPPLE_PLATFORM_TEST_DATABASE_URL'},async()=>{
  const {Pool}=await import('pg'); const schema=`assessment_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
  const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`}); const store=new PostgresAssessmentStore(pool);
  try {
    await store.init();
    await pool.query(`INSERT INTO platform_registry_versions(registry_version,registry_id,scope,semantic_version,content_sha256,manifest_json) VALUES($1,'registry://demo/test','demo','1.0.0',$2,'{}')`,['registry-version','1'.repeat(64)]);
    await pool.query(`INSERT INTO platform_graph_snapshots(snapshot_id,graph_version,registry_version,environment,content_sha256,validation_status,bounded_snapshot_json,coverage_json,source_versions_json,created_at) VALUES('snapshot','sha256:${'2'.repeat(64)}','registry-version','demo',$1,'validated_partial','{}','[]','[]',now())`,['2'.repeat(64)]);
    const policy={policy_version:'policy://platform-shadow@1.0.0#sha256:'+'9'.repeat(64)};
    const decisionInput={analysis_status:'complete',commit_sha:'a'.repeat(40),evaluation_at:'2026-11-14T09:00:00.000Z',direct_tiers:[{value:3,authority:'demo_only'}],signals:[],controls:[{id:'required-tests',status:'passed',authority:'demo_only'}],traversal:{truncated:false},dependencies:{critical_hard_consumers:[],evidence_complete:true,fresh:true}};
    const id='assessment://sha256:'+'3'.repeat(64), replay='3'.repeat(64);
    const decision=evaluateShadowPolicy({...decisionInput,assessment_id:id,replay_key:replay},policy);
    const value={assessment_id:id,replay_key:replay,repository_id:'repository://demo/opentelemetry-demo',pr_number:103,commit_sha:'a'.repeat(40),work_item_id:'jira://demo/PAY-142',request_context_sha256:'5'.repeat(64),evaluation_at:'2026-11-14T09:00:00.000Z',valid_until:decision.valid_until,registry_version:'registry-version',snapshot_id:'snapshot',policy_version:'policy-version',analysis_status:'complete',risk_classification:'LOW',shadow_decision:decision,result:{assessment_id:id,shadow_decision:decision,valid_until:decision.valid_until}};
    const id2='assessment://sha256:'+'6'.repeat(64), replay2='6'.repeat(64);
    const decision2=evaluateShadowPolicy({...decisionInput,assessment_id:id2,replay_key:replay2,commit_sha:'b'.repeat(40)},policy);
    const value2={...value,assessment_id:id2,replay_key:replay2,commit_sha:'b'.repeat(40),request_context_sha256:'7'.repeat(64),shadow_decision:decision2,result:{assessment_id:id2,shadow_decision:decision2,valid_until:decision2.valid_until}};
    assert.notEqual(decision.decision_id,decision2.decision_id);
    const {decision_id:_first,...firstBody}=decision, {decision_id:_second,...secondBody}=decision2;
    assert.deepEqual(firstBody,secondBody,'assessment identity is the only decision difference');
    assert.equal((await store.saveAssessment(value)).replayed,false); assert.equal((await store.saveAssessment(value)).replayed,true);
    assert.equal((await store.saveAssessment(value2)).replayed,false);
    const counts=await pool.query('SELECT (SELECT count(*) FROM platform_assessments) assessments,(SELECT count(*) FROM platform_shadow_decisions) decisions');
    assert.deepEqual(counts.rows[0],{assessments:'2',decisions:'2'});
    for(const [delivery_id,source_observed_at] of [['same-1','2026-11-14T09:01:00.000Z'],['same-2','2026-11-14T09:02:00.000Z']]) {
      await store.acceptHead({repository_id:value.repository_id,pr_number:103,commit_sha:value2.commit_sha,delivery_id,source_observed_at});
      const active=await store.getActiveAssessment(value.repository_id,103);
      assert.equal(active.assessment_id,id2); assert.equal(active.shadow_decision.eligibility,'eligible_for_bypass');
    }
    assert.equal(Number((await pool.query("SELECT count(*) count FROM platform_assessment_events WHERE event_type='INVALIDATED_BY_NEW_HEAD'")).rows[0].count),0);
    const ambiguous=await store.acceptHead({repository_id:value.repository_id,pr_number:103,commit_sha:'c'.repeat(40),delivery_id:'ambiguous',source_observed_at:'2026-11-14T09:02:00.000Z'});
    assert.equal(ambiguous.disposition,'quarantined_ambiguous'); assert.equal((await store.getCurrentHead(value.repository_id,103)).ambiguous,true);
    assert.equal(await store.getActiveAssessment(value.repository_id,103),null);
    await assert.rejects(()=>store.saveAssessment({...value2,assessment_id:'assessment://sha256:'+'8'.repeat(64),replay_key:'8'.repeat(64)}),{code:'HEAD_AMBIGUOUS'});
    assert.equal(Number((await pool.query("SELECT count(*) count FROM platform_assessment_events WHERE event_type='INVALIDATED_BY_AMBIGUOUS_HEAD'")).rows[0].count),1);
    await assert.rejects(()=>pool.query("UPDATE platform_assessments SET risk_classification='HIGH' WHERE assessment_id=$1",[id]),/insert-only/);
    await store.acceptHead({repository_id:value.repository_id,pr_number:103,commit_sha:'c'.repeat(40),delivery_id:'delivery-2',source_observed_at:'2026-11-14T09:10:00.000Z'});
    assert.equal(await store.getActiveAssessment(value.repository_id,103),null);
    const stale=await store.acceptHead({repository_id:value.repository_id,pr_number:103,commit_sha:'a'.repeat(40),delivery_id:'delivery-1',source_observed_at:'2026-11-14T09:05:00.000Z'});
    assert.equal(stale.disposition,'rejected_out_of_order');
    await store.acceptHead({repository_id:value.repository_id,pr_number:103,commit_sha:'a'.repeat(40),delivery_id:'delivery-3',source_observed_at:'2026-11-14T09:15:00.000Z'});
    await store.rebuildAssessmentProjections();
    assert.equal(await store.getActiveAssessment(value.repository_id,103),null,'projection rebuild must not reactivate invalidated facts');
  } finally { await pool.end(); const cleanup=new Pool({connectionString:url}); await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); await cleanup.end(); }
});
