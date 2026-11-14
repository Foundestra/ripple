import { randomUUID } from 'node:crypto';
import { frozenCopy } from '../contracts/canonicalJson.js';
import { migratePlatform } from './migrate.js';

function record(row) {
  if (!row) return null;
  const result = row.result_json;
  return frozenCopy({ assessment_id: row.assessment_id, replay_key: row.replay_key,
    repository_id: row.repository_id, pr_number: Number(row.pr_number), commit_sha: row.commit_sha,
    work_item_id: row.work_item_id, request_context_sha256: row.request_context_sha256,
    evaluation_at: new Date(row.evaluation_at).toISOString(), valid_until: new Date(row.valid_until).toISOString(),
    registry_version: row.registry_version, snapshot_id: row.snapshot_id, policy_version: row.policy_version,
    analysis_status: row.analysis_status, risk_classification: row.risk_classification,
    shadow_decision: result.shadow_decision, result });
}

function headEvent(row, disposition = row?.disposition) {
  if (!row) return null;
  return frozenCopy({ ...row, pr_number: Number(row.pr_number), disposition,
    source_observed_at: new Date(row.source_observed_at).toISOString(),
    accepted_at: new Date(row.accepted_at).toISOString() });
}

export class PostgresAssessmentStore {
  constructor(pool) { this.pool = pool; }
  async init() { await migratePlatform(this.pool); }
  async saveAssessment(value) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`platform-head:${value.repository_id}#${value.pr_number}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('platform-assessment-projections'))");
      const acceptedHead = await client.query('SELECT commit_sha,ambiguous FROM platform_current_pr_heads WHERE repository_id=$1 AND pr_number=$2', [value.repository_id,value.pr_number]);
      if (acceptedHead.rows[0]?.ambiguous) throw Object.assign(new Error('Authoritative head is ambiguous'),{code:'HEAD_AMBIGUOUS',status:409});
      if (acceptedHead.rows.length && acceptedHead.rows[0].commit_sha !== value.commit_sha) throw Object.assign(new Error('Commit is not the accepted head'), { code: 'HEAD_SUPERSEDED', status: 409 });
      const inserted = await client.query(`INSERT INTO platform_assessments
        (assessment_id,replay_key,repository_id,pr_number,commit_sha,work_item_id,request_context_sha256,evaluation_at,valid_until,registry_version,snapshot_id,policy_version,analysis_status,risk_classification,result_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(replay_key) DO NOTHING RETURNING *`,
      [value.assessment_id,value.replay_key,value.repository_id,value.pr_number,value.commit_sha,value.work_item_id,value.request_context_sha256,
        value.evaluation_at,value.valid_until,value.registry_version,value.snapshot_id,value.policy_version,value.analysis_status,value.risk_classification,value.result]);
      if (!inserted.rows.length) {
        const prior = await client.query('SELECT * FROM platform_assessments WHERE replay_key=$1', [value.replay_key]);
        await client.query('COMMIT');
        return { record: record(prior.rows[0]), replayed: true };
      }
      const decision = value.shadow_decision;
      await client.query(`INSERT INTO platform_shadow_decisions(decision_id,assessment_id,outcome,eligibility,authorization_status,reasons_json,controls_json,evidence_refs_json,valid_until)
        VALUES($1,$2,$3,$4,'not_evaluated',$5,$6,$7,$8)`, [decision.decision_id,value.assessment_id,decision.outcome,decision.eligibility,
        JSON.stringify(decision.reason_codes),{ required: decision.required_controls, satisfied: decision.satisfied_controls, missing: decision.missing_controls },JSON.stringify(decision.evidence_refs),decision.valid_until]);
      await client.query("INSERT INTO platform_assessment_events(event_id,assessment_id,event_type,head_sha) VALUES($1,$2,'CREATED',$3)", [randomUUID(),value.assessment_id,value.commit_sha]);
      if (!acceptedHead.rows.length || acceptedHead.rows[0].commit_sha === value.commit_sha) {
        const prior = await client.query('SELECT assessment_id FROM platform_active_assessments WHERE repository_id=$1 AND pr_number=$2', [value.repository_id,value.pr_number]);
        await client.query(`INSERT INTO platform_active_assessments(repository_id,pr_number,assessment_id,commit_sha) VALUES($1,$2,$3,$4)
          ON CONFLICT(repository_id,pr_number) DO UPDATE SET assessment_id=$3,commit_sha=$4,updated_at=now()`, [value.repository_id,value.pr_number,value.assessment_id,value.commit_sha]);
        if (prior.rows[0] && prior.rows[0].assessment_id !== value.assessment_id) await client.query("INSERT INTO platform_assessment_events(event_id,assessment_id,event_type,related_assessment_id,head_sha) VALUES($1,$2,'SUPERSEDED',$3,$4)", [randomUUID(),prior.rows[0].assessment_id,value.assessment_id,value.commit_sha]);
        await client.query("INSERT INTO platform_assessment_events(event_id,assessment_id,event_type,head_sha) VALUES($1,$2,'ACTIVATED',$3)", [randomUUID(),value.assessment_id,value.commit_sha]);
      }
      await client.query('COMMIT');
      return { record: record(inserted.rows[0]), replayed: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async getAssessment(id) { const result = await this.pool.query('SELECT * FROM platform_assessments WHERE assessment_id=$1',[id]); return record(result.rows[0]); }
  async getByReplayKey(key) { const result = await this.pool.query('SELECT * FROM platform_assessments WHERE replay_key=$1',[key]); return record(result.rows[0]); }
  async getCurrentHead(repository, prNumber) { const result = await this.pool.query('SELECT repository_id,pr_number,commit_sha,head_event_id,source_observed_at,ambiguous,candidate_shas_json FROM platform_current_pr_heads WHERE repository_id=$1 AND pr_number=$2',[repository,prNumber]); if(!result.rows[0]) return null; const {candidate_shas_json,...row}=result.rows[0]; return frozenCopy({ ...row, candidate_shas:candidate_shas_json, pr_number:Number(row.pr_number),source_observed_at:new Date(row.source_observed_at).toISOString() }); }
  async getActiveAssessment(repository, prNumber) { const result = await this.pool.query('SELECT a.* FROM platform_active_assessments p JOIN platform_assessments a USING(assessment_id) WHERE p.repository_id=$1 AND p.pr_number=$2',[repository,prNumber]); return record(result.rows[0]); }
  async listAssessments(filter) {
    const values = [], where = [];
    for (const [field, value] of Object.entries({ work_item_id: filter.work_item_id, repository_id: filter.repository_id, pr_number: filter.pr_number, commit_sha: filter.commit_sha })) if (value != null) { values.push(value); where.push(`${field}=$${values.length}`); }
    values.push(filter.limit || 20);
    const result = await this.pool.query(`SELECT * FROM platform_assessments ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY evaluation_at DESC,assessment_id DESC LIMIT $${values.length}`,values);
    return result.rows.map(record);
  }
  async acceptHead(event) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`platform-head:${event.repository_id}#${event.pr_number}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('platform-assessment-projections'))");
      const current = await client.query('SELECT * FROM platform_current_pr_heads WHERE repository_id=$1 AND pr_number=$2 FOR UPDATE',[event.repository_id,event.pr_number]);
      const duplicate = await client.query('SELECT * FROM platform_pr_head_events WHERE repository_id=$1 AND pr_number=$2 AND delivery_id=$3',[event.repository_id,event.pr_number,event.delivery_id]);
      if (duplicate.rows.length) { await client.query('COMMIT'); return headEvent(duplicate.rows[0], 'duplicate'); }
      const sameTime=current.rows.length && new Date(event.source_observed_at).valueOf()===new Date(current.rows[0].source_observed_at).valueOf();
      const disposition = sameTime && event.commit_sha!==current.rows[0].commit_sha?'quarantined_ambiguous':!current.rows.length || new Date(event.source_observed_at) > new Date(current.rows[0].source_observed_at) ? 'accepted' : 'rejected_out_of_order';
      const id = randomUUID();
      const inserted = await client.query(`INSERT INTO platform_pr_head_events(event_id,repository_id,pr_number,commit_sha,delivery_id,source_observed_at,disposition)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[id,event.repository_id,event.pr_number,event.commit_sha,event.delivery_id,event.source_observed_at,disposition]);
      if(disposition==='quarantined_ambiguous') {
        const active=await client.query('DELETE FROM platform_active_assessments WHERE repository_id=$1 AND pr_number=$2 RETURNING assessment_id',[event.repository_id,event.pr_number]);
        const candidates=[...new Set([...(current.rows[0].candidate_shas_json||[current.rows[0].commit_sha]),event.commit_sha])].sort();
        await client.query('UPDATE platform_current_pr_heads SET ambiguous=true,candidate_shas_json=$3,updated_at=now() WHERE repository_id=$1 AND pr_number=$2',[event.repository_id,event.pr_number,JSON.stringify(candidates)]);
        if(active.rows[0]) await client.query("INSERT INTO platform_assessment_events(event_id,assessment_id,event_type,details_json) VALUES($1,$2,'INVALIDATED_BY_AMBIGUOUS_HEAD',$3)",[randomUUID(),active.rows[0].assessment_id,{head_event_id:id}]);
      }
      if (disposition === 'accepted') {
        const active = await client.query('SELECT assessment_id,commit_sha FROM platform_active_assessments WHERE repository_id=$1 AND pr_number=$2',[event.repository_id,event.pr_number]);
        await client.query(`INSERT INTO platform_current_pr_heads(repository_id,pr_number,commit_sha,head_event_id,source_observed_at,ambiguous,candidate_shas_json) VALUES($1,$2,$3,$4,$5,false,$6)
          ON CONFLICT(repository_id,pr_number) DO UPDATE SET commit_sha=$3,head_event_id=$4,source_observed_at=$5,ambiguous=false,candidate_shas_json=$6,updated_at=now()`,[event.repository_id,event.pr_number,event.commit_sha,id,event.source_observed_at,JSON.stringify([event.commit_sha])]);
        if (active.rows[0] && active.rows[0].commit_sha !== event.commit_sha) {
          await client.query('DELETE FROM platform_active_assessments WHERE repository_id=$1 AND pr_number=$2',[event.repository_id,event.pr_number]);
          await client.query("INSERT INTO platform_assessment_events(event_id,assessment_id,event_type,head_sha,details_json) VALUES($1,$2,'INVALIDATED_BY_NEW_HEAD',$3,$4)",[randomUUID(),active.rows[0].assessment_id,event.commit_sha,{head_event_id:id}]);
        }
      }
      await client.query('COMMIT'); return headEvent(inserted.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async rebuildAssessmentProjections() {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtext('platform-assessment-projections'))");
      await client.query('DELETE FROM platform_active_assessments');
      await client.query(`INSERT INTO platform_active_assessments(repository_id,pr_number,assessment_id,commit_sha)
        SELECT DISTINCT ON(a.repository_id,a.pr_number) a.repository_id,a.pr_number,a.assessment_id,a.commit_sha FROM platform_assessments a
        LEFT JOIN platform_current_pr_heads h ON h.repository_id=a.repository_id AND h.pr_number=a.pr_number
        WHERE (h.commit_sha IS NULL OR (h.ambiguous=false AND h.commit_sha=a.commit_sha)) AND NOT EXISTS (
          SELECT 1 FROM platform_assessment_events e WHERE e.assessment_id=a.assessment_id AND e.event_type IN('SUPERSEDED','INVALIDATED_BY_NEW_HEAD','INVALIDATED_BY_AMBIGUOUS_HEAD'))
        ORDER BY a.repository_id,a.pr_number,a.evaluation_at DESC`);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
