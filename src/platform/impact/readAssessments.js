import { frozenCopy } from '../contracts/canonicalJson.js';

export function deriveAssessment(record, { now = new Date().toISOString(), currentHead = null, activeAssessmentId = null } = {}) {
  if (!record) return null;
  let current_eligibility = record.shadow_decision.eligibility;
  let reevaluation_required = false;
  const reasons = [];
  if(currentHead?.ambiguous){
    current_eligibility='invalidated_by_ambiguous_head'; reevaluation_required=true; reasons.push('HEAD_AMBIGUOUS');
  } else if (currentHead && (currentHead.commit_sha !== record.commit_sha || !activeAssessmentId)) {
    current_eligibility = 'invalidated_by_new_head'; reevaluation_required = true; reasons.push('HEAD_SUPERSEDED');
  } else if (now >= record.valid_until) {
    current_eligibility = 'expired'; reevaluation_required = true; reasons.push('DECISION_EXPIRED');
  } else if (activeAssessmentId && activeAssessmentId !== record.assessment_id) {
    current_eligibility = 'superseded'; reevaluation_required = true; reasons.push('ASSESSMENT_SUPERSEDED');
  }
  return frozenCopy({ ...record.result, current_eligibility, reevaluation_required,
    current_state_reasons: reasons, head_valid: !currentHead || (!currentHead.ambiguous && currentHead.commit_sha === record.commit_sha) });
}

export async function readAssessment(store, id, options = {}) {
  const record = await store.getAssessment(id);
  if (!record) return null;
  const [head, active] = await Promise.all([
    store.getCurrentHead(record.repository_id, record.pr_number),
    store.getActiveAssessment(record.repository_id, record.pr_number),
  ]);
  return deriveAssessment(record, { ...options, currentHead: head, activeAssessmentId: active?.assessment_id });
}

export async function readAssessmentHistory(store, filter, { limit = 20, now } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('History limit exceeded'), { code: 'HISTORY_LIMIT_EXCEEDED', status: 422 });
  const rows = await store.listAssessments({ ...filter, limit });
  const contexts = new Map();
  for (const row of rows) {
    const key = `${row.repository_id}#${row.pr_number}`;
    if (!contexts.has(key)) {
      const head = await store.getCurrentHead(row.repository_id, row.pr_number);
      const active = await store.getActiveAssessment(row.repository_id, row.pr_number);
      contexts.set(key, { currentHead: head, activeAssessmentId: active?.assessment_id });
    }
  }
  const results = rows.map(row => deriveAssessment(row, { now, ...contexts.get(`${row.repository_id}#${row.pr_number}`) }));
  const active = results.find(row => !row.reevaluation_required) || null;
  return frozenCopy({ schema_version:'ripple.impact-history.v1',current:active,history:results,count:results.length,limit });
}
