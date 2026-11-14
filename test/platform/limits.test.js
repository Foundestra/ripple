import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImpactRequest } from '../../src/platform/impact/requestIdentity.js';

const request = {schema_version:'ripple.impact-request.v1',work_item_id:'jira://demo/PAY-142',repository:'repository://demo/opentelemetry-demo',pr_number:103,commit_sha:'a'.repeat(40),evaluation_at:'2026-11-14T09:00:00.000Z',files:[{path:'src/payment/a.js',status:'modified'}],request_context:{source:'demo_fixture',fixture_id:'pr3'}};
test('request identity enforces finite hard limits and pinned identity', () => {
  assert.equal(normalizeImpactRequest(request).commit_sha,request.commit_sha);
  assert.throws(() => normalizeImpactRequest({...request,commit_sha:'short'}),{code:'INVALID_COMMIT_SHA'});
  assert.throws(() => normalizeImpactRequest({...request,files:Array.from({length:101},(_,i)=>({path:`x/${i}`,status:'modified'}))}),{code:'FILE_LIMIT_EXCEEDED'});
  assert.throws(() => normalizeImpactRequest({...request,files:[{path:'x'.repeat(1025),status:'modified'}]}),{code:'PATH_TOO_LONG'});
  assert.throws(() => normalizeImpactRequest(request,{max_files:101}),{code:'INVALID_LIMIT'});
  assert.throws(() => normalizeImpactRequest(request,{max_nodes:251}),{code:'INVALID_LIMIT'});
});
