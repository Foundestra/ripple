import { canonicalJson, frozenCopy } from '../contracts/canonicalJson.js';
import { resolveChangedPaths } from '../identity/resolveChangedPaths.js';
import { queryNeighborhood } from '../graph/queryNeighborhood.js';
import { evaluateShadowPolicy } from '../policy/evaluateShadowPolicy.js';
import { normalizeImpactRequest, requestIdentity } from './requestIdentity.js';

const OBSERVATION_FRESHNESS_TTL_MS=60*60*1000;
function validityBound(value,evaluationMs){const parsed=value?new Date(value).getTime():NaN; return Number.isFinite(parsed)?parsed:evaluationMs;}

function directFacts(registry, serviceIds) {
  return serviceIds.map(id => {
    const service = registry.services.find(row => row.id === id);
    return { service_id: id, tier: service?.tier || null, owners: service?.owners || [] };
  });
}

export async function buildAssessment({ request: input, registry, snapshot, policy, store, limits = {}, clock = () => new Date() }) {
  const request = normalizeImpactRequest(input, limits);
  if (!snapshot) throw Object.assign(new Error('No validated graph snapshot'), { code: 'NO_VALIDATED_SNAPSHOT', status: 503 });
  if (snapshot.registry_version !== registry.registry_version) throw Object.assign(new Error('Snapshot registry binding conflict'), { code: 'SNAPSHOT_VERSION_CONFLICT', status: 409 });
  const started = performance.now();
  const identity = requestIdentity(request, { snapshot_id: snapshot.snapshot_id, registry_version: registry.registry_version, policy_version: policy.policy_version });
  const currentHead = await store.getCurrentHead(request.repository, request.pr_number);
  if(currentHead?.ambiguous) throw Object.assign(new Error('Authoritative head is ambiguous'),{code:'HEAD_AMBIGUOUS',status:409});
  if (currentHead && currentHead.commit_sha !== request.commit_sha) throw Object.assign(new Error('Commit is not the accepted head'), { code: 'HEAD_SUPERSEDED', status: 409 });
  const duplicate = await store.getByReplayKey(identity.replay_key);
  if (duplicate) return frozenCopy(duplicate.result);
  const resolution = resolveChangedPaths(request.files, registry, request.repository);
  const contractResolution = resolution.map(({ classification: _classification, ...row }) => ({
    ...row, confidence: row.confidence === 'declared_demo' ? 'descriptive' : row.confidence,
  }));
  const serviceIds = [...new Set(resolution.flatMap(row => row.service_ids))].sort();
  const neighborhood = serviceIds.length ? queryNeighborhood(snapshot, serviceIds, { limits: {
    depth: 1, max_nodes: request.limits.max_nodes, max_edges_per_direction: request.limits.max_edges_per_direction,
    max_ms: request.limits.max_ms, max_evidence_bytes: request.limits.max_evidence_bytes,
    max_references: request.limits.max_references,
  } }) : { upstream: [], downstream: [], coverage: snapshot.coverage, evidence: [], bounds: {
    depth: 1, max_nodes: request.limits.max_nodes, max_edges_per_direction: request.limits.max_edges_per_direction,
    max_ms: request.limits.max_ms, max_evidence_bytes: request.limits.max_evidence_bytes,
    max_references: request.limits.max_references, returned_nodes: 0, elapsed_ms: 0,
    retained_evidence_bytes: 0, truncated: false, truncation_reason: [], unexplored_frontier: [],
  } };
  if (performance.now() - started > request.limits.max_ms) throw Object.assign(new Error('Assessment time limit exceeded'), { code: 'ASSESSMENT_TIME_LIMIT', status: 504 });

  const direct = directFacts(registry, serviceIds);
  const warnings = resolution.flatMap(row => row.warnings || []);
  const unknownPaths = [...neighborhood.upstream, ...neighborhood.downstream].filter(row => row.behavior.classification === 'unknown');
  const evaluationMs=new Date(request.evaluation_at).getTime();
  const validityMs=[validityBound(registry.valid_until,evaluationMs),validityBound(snapshot.valid_until,evaluationMs),validityBound(policy.valid_until,evaluationMs),
    ...(snapshot.coverage||[]).map(row=>validityBound(row.valid_until,evaluationMs)),...(snapshot.source_versions||[]).map(row=>validityBound(row.valid_until,evaluationMs)),
    ...neighborhood.evidence.map(item=>item.valid_until?validityBound(item.valid_until,evaluationMs):item.observed_at?new Date(item.observed_at).getTime()+OBSERVATION_FRESHNESS_TTL_MS:evaluationMs)];
  const validityFresh=validityMs.every(value=>Number.isFinite(value)&&value>evaluationMs);
  const coverageComplete = snapshot.validation_status === 'validated_complete' && snapshot.coverage.every(row =>
    row.status === 'real' && row.freshness === 'fresh' && !row.truncated && !(row.errors || []).length && !(row.unknowns || []).length);
  const partial = !coverageComplete || !validityFresh || warnings.length > 0 || neighborhood.bounds.truncated || unknownPaths.length > 0 ||
    request.controls.some(control => control.status !== 'passed');
  const analysis_status = serviceIds.length === 0 ? 'insufficient_evidence' : partial ? 'partial' : 'complete';
  const hardConsumers = neighborhood.upstream.filter(row => row.behavior.classification === 'hard' && row.tier?.value === 1);
  const policyEnvelope = {
    assessment_id: identity.assessment_id, replay_key: identity.replay_key,
    analysis_status, commit_sha: request.commit_sha, evaluation_at: request.evaluation_at,
    direct_tiers: direct.map(row => row.tier || { value: null, authority: 'unknown' }), signals: request.signals,
    controls: request.controls, traversal: neighborhood.bounds,
    dependencies: { critical_hard_consumers: hardConsumers,
      soft_consumers: neighborhood.upstream.filter(row => row.behavior.classification === 'soft'),
      evidence_complete: coverageComplete,
      fresh: coverageComplete && validityFresh && neighborhood.upstream.concat(neighborhood.downstream).every(row => row.freshness === 'fresh') },
    evidence_refs: neighborhood.evidence.map(row => row.evidence_id), ttl_ms: 60 * 60 * 1000,
    evidence_expiries:validityMs.map(value=>new Date(value).toISOString()),
  };
  const decision = evaluateShadowPolicy(policyEnvelope, policy);
  const summary = {
    direct_tiers: direct.map(row => row.tier),
    highest_known_tier: direct.map(row => row.tier?.value).filter(Number.isInteger).sort((a, b) => a - b)[0] || null,
    critical_hard_consumers: hardConsumers.map(row => row.service_id),
    hard_paths: [...neighborhood.upstream, ...neighborhood.downstream].filter(row => row.behavior.classification === 'hard').length,
    soft_paths: [...neighborhood.upstream, ...neighborhood.downstream].filter(row => row.behavior.classification === 'soft').length,
    unknown_paths: unknownPaths.length,
    required_evidence_gaps: [...new Set([...warnings, ...decision.missing_controls])].sort(),
  };
  const unknowns = [...new Set([
    ...warnings,
    ...snapshot.coverage.flatMap(row => [...(row.errors || []), ...(row.unknowns || []), ...(row.freshness === 'fresh' ? [] : ['SOURCE_FRESHNESS_UNVERIFIED'])]),
    ...(!validityFresh?['VALIDITY_UNVERIFIED_OR_EXPIRED']:[]),
    ...neighborhood.upstream.flatMap(row => row.unknowns), ...neighborhood.downstream.flatMap(row => row.unknowns),
  ])].slice(0, 100);
  const result = {
    schema_version: 'ripple.impact-result.v1', assessment_id: identity.assessment_id,
    replay_key: identity.replay_key, request_context_sha256: identity.request_context_sha256,
    repository: request.repository, pr_number: request.pr_number, commit_sha: request.commit_sha,
    work_item_id: request.work_item_id, evaluation_at: request.evaluation_at,
    versions: { registry_version: registry.registry_version, registry_sha256: registry.source_sha256,
      snapshot_id: snapshot.snapshot_id, graph_version: snapshot.graph_version, snapshot_sha256: snapshot.content_sha256,
      policy_version: policy.policy_version, policy_sha256: policy.source_sha256 },
    resolution: contractResolution, direct_services: direct, upstream: neighborhood.upstream, downstream: neighborhood.downstream,
    coverage: neighborhood.coverage, bounds: neighborhood.bounds, summary, unknowns,
    analysis_status, risk_classification: decision.risk_classification, shadow_decision: decision,
    legacy_risk: { level: request.request_context.legacy_level || null, score: null, factors: [], authority: 'none', use: 'display_only' },
    human_action: decision.human_action, created_at: clock().toISOString(), valid_until: decision.valid_until,
  };
  if (Buffer.byteLength(canonicalJson(result)) > request.limits.max_result_bytes) throw Object.assign(new Error('Assessment result exceeds limit'), { code: 'RESULT_TOO_LARGE', status: 422 });
  const { validateContract } = await import('../contracts/validate.js');
  validateContract('impact-result', result);
  const record = { assessment_id: result.assessment_id, replay_key: result.replay_key,
    repository_id: result.repository, pr_number: result.pr_number, commit_sha: result.commit_sha,
    work_item_id: result.work_item_id, request_context_sha256: result.request_context_sha256,
    evaluation_at: result.evaluation_at, valid_until: result.valid_until, registry_version: registry.registry_version,
    snapshot_id: snapshot.snapshot_id, policy_version: policy.policy_version,
    analysis_status, risk_classification: decision.risk_classification, shadow_decision: decision, result };
  const saved = await store.saveAssessment(record);
  return frozenCopy(saved.record.result);
}
