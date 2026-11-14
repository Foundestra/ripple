import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAssessment } from '../../src/platform/impact/buildAssessment.js';
import { MemoryAssessmentStore } from '../../src/platform/persistence/assessmentStore.js';

const payment='service://astronomy-shop/payment', checkout='service://astronomy-shop/checkout';
const registry={registry_version:'registry://demo/astronomy-shop@1.0.0#sha256:'+'1'.repeat(64),source_sha256:'1'.repeat(64),
  repositories:[{id:'repository://demo/opentelemetry-demo'}],shared_contract_files:['pb/demo.proto'],
  services:[{id:payment,tier:{value:1,source:'demo_manifest',authority:'demo_only'},owners:[{team:'@payments',source:'demo_manifest'}]},{id:checkout,tier:{value:1,source:'demo_manifest',authority:'demo_only'},owners:[]}],
  components:[{id:'component://demo/opentelemetry-demo/payment',repository_id:'repository://demo/opentelemetry-demo',service_ids:[payment],path_rules:[{prefix:'src/payment/',precedence:100}],contract_symbols:[]},{id:'component://demo/opentelemetry-demo/shared',repository_id:'repository://demo/opentelemetry-demo',service_ids:[payment],path_rules:[{prefix:'pb/demo.proto',precedence:200}],contract_symbols:['ChargeResponse']}]};
const evidence={evidence_id:'evidence://demo/edge/1',source_system:'seeded',source_reference:'graph-source:1',status:'declared',observed_at:'2026-11-14T08:00:00.000Z'};
const edge={edge_id:'edge://sha256:'+'2'.repeat(64),from_id:checkout,to_id:payment,relationship_type:'CALLS',environment:'demo',source_refs:[evidence.evidence_id],evidence_status:'declared',observed_at:evidence.observed_at,behavior:{classification:'unknown',operation:'Charge',failure_mode:'unknown',basis:'seeded protocol is not validation',evidence_refs:[evidence.evidence_id]}};
const snapshot={snapshot_id:'snapshot://sha256:'+'3'.repeat(64),graph_version:'sha256:'+'4'.repeat(64),registry_version:registry.registry_version,content_sha256:'4'.repeat(64),validation_status:'validated_partial',coverage:[{adapter:'seeded',signal:'dependency',status:'mock',observed_from:'2026-11-14T08:00:00.000Z',observed_until:'2026-11-14T08:00:00.000Z',freshness:'unknown',limit:100,truncated:false,errors:[],unknowns:['PRODUCTION_COVERAGE_UNKNOWN']}],nodes:[{node_id:payment,entity_type:'service',tier:registry.services[0].tier,owners:registry.services[0].owners},{node_id:checkout,entity_type:'service',tier:registry.services[1].tier,owners:[]}],edges:[edge],evidence:[evidence]};
const policy={policy_version:'policy://platform-shadow@1.0.0#sha256:'+'5'.repeat(64),source_sha256:'5'.repeat(64)};
const request={schema_version:'ripple.impact-request.v1',work_item_id:'jira://demo/PAY-142',repository:'repository://demo/opentelemetry-demo',pr_number:103,commit_sha:'d5ef0f8f7b2773fd894951d06de077415648f97b',evaluation_at:'2026-11-14T09:00:00.000Z',files:[{path:'pb/demo.proto',status:'modified',contract_symbols:['ChargeResponse']},{path:'src/payment/charge.js',status:'modified'}],request_context:{source:'demo_fixture',fixture_id:'pr3',legacy_level:'high'},signals:['mandatory_contract_change'],controls:[{id:'payment-checkout-contract',status:'missing'},{id:'human-review',status:'missing'}]};

test('PAY-142 builds a version-bound conservative impact assessment', async () => {
  const store=new MemoryAssessmentStore();
  const result=await buildAssessment({request,registry,snapshot,policy,store,clock:()=>new Date('2026-11-14T09:00:01.000Z')});
  assert.equal(result.analysis_status,'partial'); assert.equal(result.risk_classification,'HIGH');
  assert.equal(result.shadow_decision.outcome,'would_lock'); assert.equal(result.shadow_decision.eligibility,'ineligible');
  assert.equal(result.shadow_decision.authorization.status,'not_evaluated'); assert.equal(result.upstream[0].service_id,checkout);
  assert.equal(result.downstream.length,0); assert.equal(result.versions.snapshot_id,snapshot.snapshot_id);
  assert.ok(Object.isFrozen((await store.getAssessment(result.assessment_id)).result));
  assert.equal((await buildAssessment({request,registry,snapshot,policy,store})).assessment_id,result.assessment_id);
  await store.acceptHead({repository_id:request.repository,pr_number:request.pr_number,commit_sha:'e'.repeat(40),delivery_id:'new-head',source_observed_at:'2026-11-14T09:05:00.000Z'});
  await assert.rejects(()=>buildAssessment({request,registry,snapshot,policy,store}),{code:'HEAD_SUPERSEDED'});
});

test('earliest validity boundary is pinned and unknown or expired validity cannot produce LOW',async()=>{
  const at='2026-11-14T09:00:00.000Z',later='2026-11-14T11:00:00.000Z',early='2026-11-14T09:20:00.000Z';
  const lowRegistry={...registry,valid_until:later,services:registry.services.map(service=>({...service,tier:{...service.tier,value:3}}))};
  const lowEvidence={...evidence,status:'observed',observed_at:'2026-11-14T08:30:00.000Z',valid_until:later};
  const lowEdge={...edge,evidence_status:'observed',observed_at:lowEvidence.observed_at,behavior:{...edge.behavior,classification:'soft'}};
  const lowSnapshot={...snapshot,valid_until:later,validation_status:'validated_complete',source_versions:[{source:'seeded',version:'v1',observed_at:'2026-11-14T08:30:00.000Z',valid_until:later}],coverage:[{...snapshot.coverage[0],status:'real',freshness:'fresh',unknowns:[],valid_until:later}],nodes:snapshot.nodes.map(node=>({...node,tier:{...node.tier,value:3}})),edges:[lowEdge],evidence:[lowEvidence]};
  const lowPolicy={...policy,valid_until:later};
  const lowRequest={...request,evaluation_at:at,files:[{path:'src/payment/charge.js',status:'modified'}],signals:[],controls:[{id:'required-tests',status:'passed',authority:'demo_only'}]};
  const baseline=await buildAssessment({request:lowRequest,registry:lowRegistry,snapshot:lowSnapshot,policy:lowPolicy,store:new MemoryAssessmentStore(),clock:()=>new Date(at)});
  assert.equal(baseline.valid_until,'2026-11-14T10:00:00.000Z');
  const noPath=await buildAssessment({request:lowRequest,registry:lowRegistry,snapshot:{...lowSnapshot,edges:[],evidence:[]},policy:lowPolicy,store:new MemoryAssessmentStore(),clock:()=>new Date(at)});
  assert.equal(noPath.risk_classification,'LOW');
  const variants=[
    [ {...lowRegistry,valid_until:early},lowSnapshot,lowPolicy,early ],
    [ lowRegistry,{...lowSnapshot,valid_until:early},lowPolicy,early ],
    [ lowRegistry,lowSnapshot,{...lowPolicy,valid_until:early},early ],
    [ lowRegistry,{...lowSnapshot,evidence:[{...lowEvidence,valid_until:early}]},lowPolicy,early ],
    [ lowRegistry,{...lowSnapshot,evidence:[(({valid_until,...rest})=>rest)(lowEvidence)]},lowPolicy,'2026-11-14T09:30:00.000Z' ],
  ];
  for(const [r,s,p,expected] of variants){const result=await buildAssessment({request:lowRequest,registry:r,snapshot:s,policy:p,store:new MemoryAssessmentStore(),clock:()=>new Date(at)}); assert.equal(result.valid_until,expected);}
  for(const [r,expected] of [[{...lowRegistry,valid_until:'2026-11-14T08:59:00.000Z'},'2026-11-14T08:59:00.000Z'],[(({valid_until,...rest})=>rest)(lowRegistry),at]]){
    const result=await buildAssessment({request:lowRequest,registry:r,snapshot:lowSnapshot,policy:lowPolicy,store:new MemoryAssessmentStore(),clock:()=>new Date(at)});
    assert.equal(result.analysis_status,'partial'); assert.notEqual(result.risk_classification,'LOW'); assert.equal(result.valid_until,expected);
  }
});
