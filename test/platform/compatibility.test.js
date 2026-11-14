import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { startServer } from '../../src/server.js';
import { MemoryAssessmentStore } from '../../src/platform/persistence/assessmentStore.js';
import { MemorySnapshotStore } from '../../src/platform/persistence/memoryStore.js';
import { validateContract } from '../../src/platform/contracts/validate.js';

async function assertApiError(response,status,code){
  assert.equal(response.status,status); const body=await response.json();
  validateContract('api-error',body); assert.equal(body.error.code,code); assert.ok(body.error.message.length<=512);
  return body;
}
test('platform is off by default and existing configuration remains available', () => {
  const prior=process.env.RIPPLE_PLATFORM_MODE; delete process.env.RIPPLE_PLATFORM_MODE;
  try { const config=loadConfig(); assert.equal(config.platform.mode,'off'); assert.ok(config.graph); assert.ok(config.github); }
  finally { if(prior===undefined) delete process.env.RIPPLE_PLATFORM_MODE; else process.env.RIPPLE_PLATFORM_MODE=prior; }
});

test('platform routes are absent when off and isolated when explicitly enabled', async () => {
  const quiet={error(){},info(){}};
  const off=await startServer({port:0,log:quiet,graph:{source:'seeded',refreshSec:0},llm:{provider:'none'},platform:{mode:'off'}});
  try { assert.equal((await fetch(`http://localhost:${off.port}/api/platform/v1/impacts/missing`)).status,404); }
  finally { await off.close(); }

  const assessmentStore=new MemoryAssessmentStore();
  const demo=await startServer({port:0,log:quiet,graph:{source:'seeded',refreshSec:0},llm:{provider:'none'},platform:{mode:'demo',assessmentStore,snapshotStore:new MemorySnapshotStore()}});
  try {
    const base=`http://localhost:${demo.port}`;
    const post=await fetch(`${base}/api/platform/v1/impact`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixture_id:'pr3'})});
    assert.equal(post.status,200); const result=await post.json();
    assert.equal(result.risk_classification,'HIGH'); assert.equal(result.shadow_decision.authorization.status,'not_evaluated');
    const get=await fetch(`${base}/api/platform/v1/impacts/${result.assessment_id}`); assert.equal(get.status,200);
    const derived=await get.json(); assert.equal(derived.assessment_id,result.assessment_id); validateContract('impact-result',derived);
    const historyResponse=await fetch(`${base}/api/platform/v1/work-items/${encodeURIComponent(result.work_item_id)}/impact?limit=20`);
    assert.equal(historyResponse.status,200); const history=await historyResponse.json(); validateContract('impact-history',history);
    for(const item of history.history) validateContract('impact-result',item);
    for(const invalidCommit of ['short','a'.repeat(10000)]) await assertApiError(await fetch(`${base}/api/platform/v1/work-items/${encodeURIComponent(result.work_item_id)}/impact?commit_sha=${invalidCommit}`),422,'INVALID_COMMIT_SHA');
    const oversized=await fetch(`${base}/api/platform/v1/impact`,{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(256*1024+1)});
    const oversizedError=await assertApiError(oversized,413,'REQUEST_TOO_LARGE');
    assert.deepEqual(oversizedError,{schema_version:'ripple.api-error.v1',error:{code:'REQUEST_TOO_LARGE',message:'Platform request exceeds 256 KiB',retryable:false,details:[]}});
    await assertApiError(await fetch(`${base}/api/platform/v1/impact`,{method:'POST',headers:{'content-type':'application/json'},body:'{'}),400,'INVALID_REQUEST');
    for(const body of ['null','[]']) await assertApiError(await fetch(`${base}/api/platform/v1/impact`,{method:'POST',headers:{'content-type':'application/json'},body}),400,'INVALID_REQUEST');
    await assertApiError(await fetch(`${base}/api/platform/v1/impacts/assessment://sha256:${'f'.repeat(64)}`),404,'NOT_FOUND');
    const normalized={schema_version:'ripple.impact-request.v1',work_item_id:'jira://demo/PAY-999',repository:'repository://other/repo',pr_number:999,commit_sha:'a'.repeat(40),evaluation_at:'2026-11-14T09:00:00.000Z',files:[{path:'src/a.js',status:'modified'}],request_context:{source:'demo_fixture',fixture_id:'normalized'}};
    await assertApiError(await fetch(`${base}/api/platform/v1/impact`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(normalized)}),403,'ACCESS_DENIED');
    await assertApiError(await fetch(`${base}/api/platform/v1/impact`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...normalized,repository:'repository://demo/opentelemetry-demo',unexpected:true})}),422,'INVALID_CONTRACT');
    assessmentStore.getAssessment=async()=>{throw Object.assign(new Error('relation platform_assessments does not exist; secret SQL follows'),{code:'42P01'});};
    const internal=await assertApiError(await fetch(`${base}/api/platform/v1/impacts/assessment://sha256:${'e'.repeat(64)}`),500,'INTERNAL_ERROR');
    assert.equal(internal.error.message,'Platform request failed');
    assert.ok((await (await fetch(`${base}/api/graph`)).json()).edges.length>0,'legacy route remains available');
  } finally { await demo.close(); }

  const limited=await startServer({port:0,log:quiet,graph:{source:'seeded',refreshSec:0},llm:{provider:'none'},platform:{mode:'demo',maxResultBytes:512,assessmentStore:new MemoryAssessmentStore(),snapshotStore:new MemorySnapshotStore()}});
  try { await assertApiError(await fetch(`http://localhost:${limited.port}/api/platform/v1/impact`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixture_id:'pr3'})}),422,'RESULT_TOO_LARGE'); }
  finally { await limited.close(); }
});

test('runtime demo requires durable storage and operational mode fails closed', async () => {
  const common={port:0,postgresUrl:'',log:{error(){},info(){}},graph:{source:'seeded',refreshSec:0},llm:{provider:'none'}};
  await assert.rejects(()=>startServer({...common,platform:{mode:'demo'}}),{code:'PLATFORM_DATABASE_REQUIRED'});
  await assert.rejects(()=>startServer({...common,platform:{mode:'operational'}}),{code:'PLATFORM_AUTH_NOT_CONFIGURED'});
});
