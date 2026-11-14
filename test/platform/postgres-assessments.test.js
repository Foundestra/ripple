import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgresAssessmentStore } from '../../src/platform/persistence/postgresAssessmentStore.js';

const url=process.env.RIPPLE_PLATFORM_TEST_DATABASE_URL;
test('Postgres assessments are replay-safe, immutable, and head-invalidated transactionally',{skip:!url&&'set RIPPLE_PLATFORM_TEST_DATABASE_URL'},async()=>{
  const {Pool}=await import('pg'); const schema=`assessment_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
  const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`}); const store=new PostgresAssessmentStore(pool);
  try {
    await store.init();
    await pool.query(`INSERT INTO platform_registry_versions(registry_version,registry_id,scope,semantic_version,content_sha256,manifest_json) VALUES($1,'registry://demo/test','demo','1.0.0',$2,'{}')`,['registry-version','1'.repeat(64)]);
    await pool.query(`INSERT INTO platform_graph_snapshots(snapshot_id,graph_version,registry_version,environment,content_sha256,validation_status,bounded_snapshot_json,coverage_json,source_versions_json,created_at) VALUES('snapshot','sha256:${'2'.repeat(64)}','registry-version','demo',$1,'validated_partial','{}','[]','[]',now())`,['2'.repeat(64)]);
    const id='assessment://sha256:'+'3'.repeat(64), decision={decision_id:'decision://sha256:'+'4'.repeat(64),outcome:'would_lock',eligibility:'ineligible',authorization:{status:'not_evaluated',authorization_id:null},reason_codes:['DIRECT_TIER_1'],required_controls:[],satisfied_controls:[],missing_controls:[],evidence_refs:[],valid_until:'2026-11-14T10:00:00.000Z'};
    const value={assessment_id:id,replay_key:'3'.repeat(64),repository_id:'repository://demo/opentelemetry-demo',pr_number:103,commit_sha:'a'.repeat(40),work_item_id:'jira://demo/PAY-142',request_context_sha256:'5'.repeat(64),evaluation_at:'2026-11-14T09:00:00.000Z',valid_until:decision.valid_until,registry_version:'registry-version',snapshot_id:'snapshot',policy_version:'policy-version',analysis_status:'partial',risk_classification:'HIGH',shadow_decision:decision,result:{assessment_id:id,shadow_decision:decision,valid_until:decision.valid_until}};
    assert.equal((await store.saveAssessment(value)).replayed,false); assert.equal((await store.saveAssessment(value)).replayed,true);
    await assert.rejects(()=>pool.query("UPDATE platform_assessments SET risk_classification='LOW' WHERE assessment_id=$1",[id]),/insert-only/);
    await store.acceptHead({repository_id:value.repository_id,pr_number:103,commit_sha:'b'.repeat(40),delivery_id:'delivery-2',source_observed_at:'2026-11-14T09:10:00.000Z'});
    assert.equal(await store.getActiveAssessment(value.repository_id,103),null);
    const stale=await store.acceptHead({repository_id:value.repository_id,pr_number:103,commit_sha:'a'.repeat(40),delivery_id:'delivery-1',source_observed_at:'2026-11-14T09:05:00.000Z'});
    assert.equal(stale.disposition,'rejected_out_of_order');
    await store.acceptHead({repository_id:value.repository_id,pr_number:103,commit_sha:'a'.repeat(40),delivery_id:'delivery-3',source_observed_at:'2026-11-14T09:15:00.000Z'});
    await store.rebuildAssessmentProjections();
    assert.equal(await store.getActiveAssessment(value.repository_id,103),null,'projection rebuild must not reactivate invalidated facts');
  } finally { await pool.end(); const cleanup=new Pool({connectionString:url}); await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); await cleanup.end(); }
});
