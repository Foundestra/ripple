import { randomUUID } from 'node:crypto';
import { frozenCopy } from '../contracts/canonicalJson.js';

// Explicit test store. Runtime demo wiring rejects this store unless injected by a test.
export class MemoryAssessmentStore {
  #assessments = new Map();
  #replays = new Map();
  #events = [];
  #heads = new Map();
  #active = new Map();
  #deliveries = new Map();

  async saveAssessment(record) {
    const head = this.#heads.get(`${record.repository_id}#${record.pr_number}`);
    if (head?.ambiguous) throw Object.assign(new Error('Authoritative head is ambiguous'),{code:'HEAD_AMBIGUOUS',status:409});
    if (head && head.commit_sha !== record.commit_sha) throw Object.assign(new Error('Commit is not the accepted head'), { code: 'HEAD_SUPERSEDED', status: 409 });
    const duplicate = this.#replays.get(record.replay_key);
    if (duplicate) return { record: frozenCopy(this.#assessments.get(duplicate)), replayed: true };
    const stored = frozenCopy(record);
    this.#assessments.set(stored.assessment_id, stored);
    this.#replays.set(stored.replay_key, stored.assessment_id);
    this.#events.push(frozenCopy({ event_id: randomUUID(), assessment_id: stored.assessment_id, event_type: 'CREATED', head_sha: stored.commit_sha }));
    const key = `${stored.repository_id}#${stored.pr_number}`;
    const acceptedHead = this.#heads.get(key);
    if (!acceptedHead || acceptedHead.commit_sha === stored.commit_sha) {
      const prior = this.#active.get(key);
      if (prior && prior !== stored.assessment_id) this.#events.push(frozenCopy({ event_id: randomUUID(), assessment_id: prior,
        related_assessment_id: stored.assessment_id, event_type: 'SUPERSEDED', head_sha: stored.commit_sha }));
      this.#active.set(key, stored.assessment_id);
      this.#events.push(frozenCopy({ event_id: randomUUID(), assessment_id: stored.assessment_id, event_type: 'ACTIVATED', head_sha: stored.commit_sha }));
    }
    return { record: frozenCopy(stored), replayed: false };
  }
  async getAssessment(id) { return this.#assessments.has(id) ? frozenCopy(this.#assessments.get(id)) : null; }
  async getByReplayKey(key) { const id = this.#replays.get(key); return id ? this.getAssessment(id) : null; }
  async getCurrentHead(repository, prNumber) { return frozenCopy(this.#heads.get(`${repository}#${prNumber}`) || null); }
  async getActiveAssessment(repository, prNumber) {
    const id = this.#active.get(`${repository}#${prNumber}`);
    return id ? this.getAssessment(id) : null;
  }
  async listAssessments({ work_item_id, repository_id, pr_number, commit_sha, limit = 20 }) {
    return frozenCopy([...this.#assessments.values()].filter(row =>
      (!work_item_id || row.work_item_id === work_item_id) && (!repository_id || row.repository_id === repository_id) &&
      (!pr_number || row.pr_number === pr_number) && (!commit_sha || row.commit_sha === commit_sha))
      .sort((a, b) => b.evaluation_at.localeCompare(a.evaluation_at) || b.assessment_id.localeCompare(a.assessment_id)).slice(0, limit));
  }
  async acceptHead({ repository_id, pr_number, commit_sha, delivery_id, source_observed_at }) {
    const key = `${repository_id}#${pr_number}`;
    const deliveryKey = `${key}#${delivery_id}`;
    if (this.#deliveries.has(deliveryKey)) return frozenCopy({ ...this.#deliveries.get(deliveryKey), disposition: 'duplicate' });
    const current = this.#heads.get(key);
    const ambiguous=!!current && source_observed_at===current.source_observed_at && commit_sha!==current.commit_sha;
    const event = frozenCopy({ event_id: randomUUID(), repository_id, pr_number, commit_sha, delivery_id,
      source_observed_at, accepted_at: new Date().toISOString(), disposition: ambiguous?'quarantined_ambiguous':!current || source_observed_at > current.source_observed_at ? 'accepted' : 'rejected_out_of_order' });
    if (event.disposition==='quarantined_ambiguous') {
      const oldAssessment=this.#active.get(key);
      this.#heads.set(key,frozenCopy({...current,ambiguous:true,candidate_shas:[...new Set([...(current.candidate_shas||[current.commit_sha]),commit_sha])].sort()}));
      this.#active.delete(key);
      if(oldAssessment) this.#events.push(frozenCopy({event_id:randomUUID(),assessment_id:oldAssessment,event_type:'INVALIDATED_BY_AMBIGUOUS_HEAD',head_sha:null,details:{head_event_id:event.event_id}}));
    }
    if (event.disposition === 'accepted') {
      const oldAssessment = this.#active.get(key);
      this.#heads.set(key, frozenCopy({...event,ambiguous:false,candidate_shas:[commit_sha]}));
      const active = oldAssessment ? this.#assessments.get(oldAssessment) : null;
      if (active && active.commit_sha !== commit_sha) {
        this.#active.delete(key);
        this.#events.push(frozenCopy({ event_id: randomUUID(), assessment_id: oldAssessment,
          event_type: 'INVALIDATED_BY_NEW_HEAD', head_sha: commit_sha, details: { head_event_id: event.event_id } }));
      }
    }
    this.#deliveries.set(deliveryKey, event);
    return event;
  }
  async assessmentEvents() { return frozenCopy(this.#events); }
  async rebuildAssessmentProjections() {
    this.#active.clear();
    for (const event of this.#events) {
      if (event.event_type === 'ACTIVATED') {
        const row = this.#assessments.get(event.assessment_id);
        const head = row && this.#heads.get(`${row.repository_id}#${row.pr_number}`);
        if (!head || head.commit_sha === row.commit_sha) this.#active.set(`${row.repository_id}#${row.pr_number}`, row.assessment_id);
      } else if (event.event_type === 'INVALIDATED_BY_NEW_HEAD' || event.event_type === 'SUPERSEDED') {
        const row = this.#assessments.get(event.assessment_id);
        if (row && this.#active.get(`${row.repository_id}#${row.pr_number}`) === row.assessment_id) this.#active.delete(`${row.repository_id}#${row.pr_number}`);
      }
    }
  }
}
