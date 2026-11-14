import { createHash } from 'node:crypto';

// Canonical data only. Reject values JSON.stringify would silently discard.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Canonical JSON requires finite JSON data');
}

export const contentHash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function frozenCopy(value) {
  const copy = JSON.parse(canonicalJson(value));
  function freeze(node) {
    if (node && typeof node === 'object') { Object.values(node).forEach(freeze); Object.freeze(node); }
    return node;
  }
  return freeze(copy);
}
