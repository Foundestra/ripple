import { validId } from '../identity/ids.js';
import { validDateTime } from '../contracts/validate.js';

export async function acceptAuthoritativeHead(store, event) {
  if (!event || !validId(event.repository_id, 'repository') || !Number.isSafeInteger(event.pr_number) || event.pr_number < 1 ||
      !/^[a-f0-9]{40}$/.test(event.commit_sha || '') || typeof event.delivery_id !== 'string' ||
      !event.delivery_id.trim() || Buffer.byteLength(event.delivery_id) > 256 || !validDateTime(event.source_observed_at)) {
    throw Object.assign(new Error('Invalid authoritative head event'), { code: 'INVALID_HEAD_EVENT' });
  }
  return store.acceptHead({ ...event, source_observed_at: new Date(event.source_observed_at).toISOString() });
}
