export async function acceptAuthoritativeHead(store, event) {
  if (!/^repository:\/\//.test(event.repository_id || '') || !Number.isInteger(event.pr_number) ||
      !/^[a-f0-9]{40}$/.test(event.commit_sha || '') || !event.delivery_id || Number.isNaN(Date.parse(event.source_observed_at))) {
    throw Object.assign(new Error('Invalid authoritative head event'), { code: 'INVALID_HEAD_EVENT' });
  }
  return store.acceptHead({ ...event, source_observed_at: new Date(event.source_observed_at).toISOString() });
}
