import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'yaml';
import { evaluateShadowPolicy } from '../../src/platform/policy/evaluateShadowPolicy.js';
import { loadPolicy } from '../../src/platform/policy/loadPolicy.js';
import { contentHash } from '../../src/platform/contracts/canonicalJson.js';

const policy = { policy_version: 'policy://platform-shadow@1.0.0#sha256:' + 'a'.repeat(64) };
const base = { assessment_id: 'assessment://sha256:'+'1'.repeat(64), replay_key: '1'.repeat(64),
  analysis_status: 'complete', commit_sha: 'a'.repeat(40), evaluation_at: '2026-11-14T09:00:00.000Z',
  direct_tiers: [{ value: 3, authority: 'demo_only' }], signals: [], traversal: { truncated: false },
  dependencies: { critical_hard_consumers: [], evidence_complete: true, fresh: true },
  controls: [{ id: 'required-tests', status: 'passed', authority: 'demo_only' }] };

test('shadow policy is conservative and deterministic', () => {
  const low = evaluateShadowPolicy(base, policy);
  assert.equal(low.risk_classification, 'LOW');
  assert.equal(low.eligibility, 'eligible_for_bypass');
  assert.deepEqual(low, evaluateShadowPolicy(base, policy));
  const high = evaluateShadowPolicy({ ...base, analysis_status: 'partial', direct_tiers: [{ value: 1, authority: 'demo_only' }],
    signals: ['mandatory_contract_change'], controls: [{ id: 'human-review', status: 'missing' }] }, policy);
  assert.equal(high.risk_classification, 'HIGH');
  assert.equal(high.outcome, 'would_lock');
  assert.deepEqual(high.authorization, { status: 'not_evaluated', authorization_id: null });
  assert.ok(high.reason_codes.includes('DIRECT_TIER_1'));
  assert.ok(high.reason_codes.includes('MANDATORY_CONTRACT_CHANGE'));
  assert.throws(()=>evaluateShadowPolicy({...base,replay_key:'2'.repeat(64)},policy),{code:'INVALID_ASSESSMENT_IDENTITY'});
});

test('unknown, stale, missing and truncated evidence never produce LOW', () => {
  const cases = [
    { ...base, direct_tiers: [{ value: null, authority: 'unknown' }] },
    { ...base, dependencies: { ...base.dependencies, fresh: false } },
    { ...base, controls: [{ id: 'required-tests', status: 'missing' }] },
    { ...base, traversal: { truncated: true } },
  ];
  for (const input of cases) {
    const result = evaluateShadowPolicy(input, policy);
    assert.equal(result.risk_classification, 'UNKNOWN');
    assert.equal(result.eligibility, 'ineligible');
  }
});

test('bundled policy cases match exact expected classifications and reasons', () => {
  const loaded=loadPolicy(new URL('../../policy/platform-shadow-v1.yaml',import.meta.url));
  const cases=JSON.parse(fs.readFileSync(new URL('../../data/platform/demo/policy-cases.json',import.meta.url))).cases;
  for(const item of cases){
    const result=evaluateShadowPolicy({assessment_id:'assessment://sha256:'+'1'.repeat(64),replay_key:'1'.repeat(64),evaluation_at:'2026-11-14T09:00:00.000Z',commit_sha:'a'.repeat(40),...item.input},loaded);
    assert.equal(result.risk_classification,item.expected.risk_classification,item.id);
    assert.equal(result.outcome,item.expected.outcome,item.id);
    assert.equal(result.eligibility,item.expected.eligibility,item.id);
    assert.deepEqual(result.reason_codes,item.expected.reason_codes,item.id);
  }
});

test('fixed V1 loader rejects correctly rehashed semantic edits', () => {
  const raw=parse(fs.readFileSync(new URL('../../policy/platform-shadow-v1.yaml',import.meta.url),'utf8'));
  const changes=[
    policy=>policy.rules.HIGH.any.pop(),
    policy=>policy.deterministic_precedence.reverse(),
    policy=>policy.known_controls[0].authority_required=false,
    policy=>policy.decision.low_outcome.outcome='would_lock',
  ];
  for(const change of changes){
    const tampered=structuredClone(raw); change(tampered);
    const {source_sha256:_old,...content}=tampered; tampered.source_sha256=contentHash(content);
    assert.throws(()=>loadPolicy(tampered),{code:'UNSUPPORTED_POLICY_SEMANTICS'});
  }
  const bounded=structuredClone(raw); bounded.valid_until='2026-11-14T10:00:00.000Z';
  {const {source_sha256:_old,...content}=bounded; bounded.source_sha256=contentHash(content);}
  assert.equal(loadPolicy(bounded).valid_until,bounded.valid_until);
  const invalid={...bounded,valid_until:'not-a-date'}; {const {source_sha256:_old,...content}=invalid; invalid.source_sha256=contentHash(content);}
  assert.throws(()=>loadPolicy(invalid),{code:'UNSUPPORTED_POLICY_SEMANTICS'});
});
