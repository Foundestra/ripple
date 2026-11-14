import { contentHash, frozenCopy } from '../contracts/canonicalJson.js';

const SIGNAL_CODES = Object.freeze({
  destructive_change: 'DESTRUCTIVE_CHANGE', security_change: 'SECURITY_CHANGE',
  mandatory_contract_change: 'MANDATORY_CONTRACT_CHANGE', mandatory_migration: 'MANDATORY_MIGRATION',
  conflicting_required_evidence: 'CONFLICTING_REQUIRED_EVIDENCE', important_evidence_unavailable_or_stale: 'IMPORTANT_EVIDENCE_UNAVAILABLE_OR_STALE',
  multi_consumer_shared_component: 'MULTI_CONSUMER_SHARED_COMPONENT', required_identity_unresolved: 'REQUIRED_IDENTITY_UNRESOLVED',
  dependency_direction_or_behavior_unresolved: 'DEPENDENCY_BEHAVIOR_UNRESOLVED', commit_binding_unresolved: 'COMMIT_BINDING_UNRESOLVED',
  registry_or_snapshot_binding_unresolved: 'VERSION_BINDING_UNRESOLVED', required_evidence_stale: 'REQUIRED_EVIDENCE_STALE',
  sox_or_compliance_signal: 'COMPLIANCE_SIGNAL', compliance_change: 'COMPLIANCE_SIGNAL',
});

export function evaluateShadowPolicy(envelope, policy) {
  if (!/^assessment:\/\/sha256:[a-f0-9]{64}$/.test(envelope.assessment_id || '') ||
      !/^[a-f0-9]{64}$/.test(envelope.replay_key || '') ||
      envelope.assessment_id !== `assessment://sha256:${envelope.replay_key}`) throw Object.assign(new Error('A matching assessment and replay identity is required for a shadow decision'), { code: 'INVALID_ASSESSMENT_IDENTITY' });
  const reasons = new Set();
  const tiers = envelope.direct_tiers || [];
  const signals = new Set(envelope.signals || []);
  const controls = envelope.controls || [];
  const missing = controls.filter(c => c.status !== 'passed' || !c.authority).map(c => c.id).sort();
  const satisfied = controls.filter(c => c.status === 'passed' && c.authority).map(c => c.id).sort();
  const required = controls.map(c => c.id).sort();
  let risk;

  if (tiers.some(t => t?.value === 1 && t.authority && t.authority !== 'unknown')) reasons.add('DIRECT_TIER_1');
  if ((envelope.dependencies?.critical_hard_consumers || []).some(row => row.tier?.value === 1 && row.tier.authority && row.tier.authority !== 'unknown')) reasons.add('TIER_1_HARD_CONSUMER');
  for (const signal of signals) if (['destructive_change', 'security_change', 'mandatory_contract_change', 'mandatory_migration', 'conflicting_required_evidence'].includes(signal)) reasons.add(SIGNAL_CODES[signal]);
  if (reasons.size) risk = 'HIGH';

  if (!risk) {
    if (tiers.some(t => t?.value === 2 && t.authority && t.authority !== 'unknown')) reasons.add('DIRECT_TIER_2');
    if ((envelope.dependencies?.soft_consumers || []).some(row => row.tier?.value === 1 && row.tier.authority && row.tier.authority !== 'unknown')) reasons.add('TIER_1_SOFT_CONSUMER');
    for (const signal of signals) if (['important_evidence_unavailable_or_stale', 'multi_consumer_shared_component'].includes(signal)) reasons.add(SIGNAL_CODES[signal]);
    if (reasons.size) risk = 'MEDIUM';
  }

  if (!risk) {
    if (!envelope.commit_sha) reasons.add('COMMIT_BINDING_UNRESOLVED');
    if ((tiers.length === 0 && envelope.commit_sha) || tiers.some(t => t?.value == null || !t.authority || t.authority === 'unknown')) reasons.add('REQUIRED_TIER_UNRESOLVED');
    if (missing.length) reasons.add('REQUIRED_CONTROL_MISSING');
    if (envelope.traversal?.truncated) reasons.add('TRAVERSAL_TRUNCATED');
    if (envelope.dependencies?.fresh === false) reasons.add('REQUIRED_EVIDENCE_STALE');
    if (envelope.dependencies?.evidence_complete === false) reasons.add('REQUIRED_EVIDENCE_INCOMPLETE');
    for (const signal of signals) if (SIGNAL_CODES[signal] && !['compliance_change', 'sox_or_compliance_signal'].includes(signal)) reasons.add(SIGNAL_CODES[signal]);
    if (envelope.analysis_status !== 'complete' && reasons.size === 0) reasons.add('ANALYSIS_INCOMPLETE');
    if (reasons.size) risk = 'UNKNOWN';
  }

  if (!risk) {
    const low = tiers.length > 0 && tiers.every(t => [3, 4].includes(t.value) && t.authority && t.authority !== 'unknown') &&
      !envelope.dependencies?.critical_hard_consumers?.length && envelope.dependencies?.evidence_complete === true &&
      envelope.dependencies?.fresh === true && !envelope.traversal?.truncated && missing.length === 0 &&
      satisfied.includes('required-tests') && ![...signals].some(s => /security|migration|compliance|sox/.test(s));
    if (low) { risk = 'LOW'; reasons.add('LOW_CRITERIA_SATISFIED'); }
    else { risk = 'UNKNOWN'; reasons.add('LOW_CRITERIA_NOT_PROVEN'); }
  }

  const compliance = [...signals].some(s => /compliance|sox/.test(s));
  const eligible = risk === 'LOW' && envelope.analysis_status === 'complete' && !compliance && missing.length === 0;
  const evaluation = new Date(envelope.evaluation_at);
  const ttlMs = Number(envelope.ttl_ms || 60 * 60 * 1000);
  const candidates = [evaluation.getTime()+ttlMs,...(envelope.evidence_expiries||[]).map(value=>new Date(value).getTime())];
  if(candidates.some(value=>!Number.isFinite(value))) throw new Error('Invalid evidence expiry');
  const valid_until = new Date(Math.min(...candidates)).toISOString();
  const core = {
    schema_version: 'ripple.shadow-decision.v1', risk_classification: risk,
    analysis_status: envelope.analysis_status, outcome: eligible ? 'would_allow_bypass' : 'would_lock',
    eligibility: eligible ? 'eligible_for_bypass' : 'ineligible',
    authorization: { status: 'not_evaluated', authorization_id: null },
    reason_codes: [...reasons].sort(), required_controls: required, satisfied_controls: satisfied,
    missing_controls: missing, policy_version: policy.policy_version,
    evidence_refs: [...new Set(envelope.evidence_refs || [])].sort(), evaluation_at: envelope.evaluation_at,
    valid_until, reevaluation: { required_after: valid_until, reasons: ['EVIDENCE_FRESHNESS_BOUNDARY'] },
    human_action: eligible ? 'A human may review bypass eligibility; no deploy authorization was issued.' :
      'Review the risk and missing controls; no deploy authorization was issued.',
  };
  const decision_id = `decision://sha256:${contentHash({ assessment_id: envelope.assessment_id,
    replay_key: envelope.replay_key, decision: core })}`;
  return frozenCopy({ decision_id, ...core });
}
