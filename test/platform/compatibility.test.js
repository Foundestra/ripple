import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { startServer } from '../../src/server.js';
import { MemoryAssessmentStore } from '../../src/platform/persistence/assessmentStore.js';
import { MemorySnapshotStore } from '../../src/platform/persistence/memoryStore.js';
import { validateContract } from '../../src/platform/contracts/validate.js';
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

  const demo=await startServer({port:0,log:quiet,graph:{source:'seeded',refreshSec:0},llm:{provider:'none'},platform:{mode:'demo',assessmentStore:new MemoryAssessmentStore(),snapshotStore:new MemorySnapshotStore()}});
  try {
    const base=`http://localhost:${demo.port}`;
    const post=await fetch(`${base}/api/platform/v1/impact`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixture_id:'pr3'})});
    assert.equal(post.status,200); const result=await post.json();
    assert.equal(result.risk_classification,'HIGH'); assert.equal(result.shadow_decision.authorization.status,'not_evaluated');
    const get=await fetch(`${base}/api/platform/v1/impacts/${result.assessment_id}`); assert.equal(get.status,200);
    assert.equal((await get.json()).assessment_id,result.assessment_id);
    const oversized=await fetch(`${base}/api/platform/v1/impact`,{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(256*1024+1)});
    assert.equal(oversized.status,413);
    const oversizedError=await oversized.json();
    assert.deepEqual(oversizedError,{schema_version:'ripple.api-error.v1',error:{code:'REQUEST_TOO_LARGE',message:'Platform request exceeds 256 KiB',retryable:false,details:[]}});
    validateContract('api-error',oversizedError);
    assert.ok((await (await fetch(`${base}/api/graph`)).json()).edges.length>0,'legacy route remains available');
  } finally { await demo.close(); }
});

test('runtime demo requires durable storage and operational mode fails closed', async () => {
  const common={port:0,postgresUrl:'',log:{error(){},info(){}},graph:{source:'seeded',refreshSec:0},llm:{provider:'none'}};
  await assert.rejects(()=>startServer({...common,platform:{mode:'demo'}}),{code:'PLATFORM_DATABASE_REQUIRED'});
  await assert.rejects(()=>startServer({...common,platform:{mode:'operational'}}),{code:'PLATFORM_AUTH_NOT_CONFIGURED'});
});
