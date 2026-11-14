import { contentHash, frozenCopy } from '../contracts/canonicalJson.js';
import { assertId, safePath } from './ids.js';
import { validateContract } from '../contracts/validate.js';

export function registryContent(manifest) {
  const { source_sha256, registry_version, created_at, published_at, ...content } = manifest;
  return content;
}
export function loadRegistry(manifest) {
  validateContract('registry', manifest);
  if (manifest.schema_version !== 'ripple.registry.v1' || manifest.scope !== 'demo' ||
      !/^\d+\.\d+\.\d+$/.test(manifest.version || '') || !/^registry:\/\/[a-z0-9._-]+\/[a-z0-9._-]+$/.test(manifest.registry_id || '')) {
    throw new Error('Invalid demo registry');
  }
  const sha = contentHash(registryContent(manifest));
  if (sha !== manifest.source_sha256) throw new Error('Registry content hash mismatch');
  const ids = new Set();
  for (const [kind, rows] of [['repository', manifest.repositories], ['service', manifest.services], ['component', manifest.components]]) {
    if (!Array.isArray(rows)) throw new Error(`Missing ${kind} records`);
    for (const row of rows) {
      assertId(row.id, kind);
      if (ids.has(row.id)) throw new Error('Duplicate canonical identity');
      ids.add(row.id);
    }
  }
  const serviceIds = new Set(manifest.services.map(s => s.id));
  const repositoryIds = new Set(manifest.repositories.map(r => r.id));
  for (const component of manifest.components) {
    if (!repositoryIds.has(component.repository_id) || !component.service_ids?.length ||
        component.service_ids.some(id => !serviceIds.has(id))) throw new Error('Unresolved component reference');
    for (const rule of component.path_rules || []) {
      if (!safePath(rule.prefix.replace(/\/$/, '')) || !Number.isInteger(rule.precedence)) throw new Error('Invalid path mapping');
    }
    for (const mapping of component.symbol_mappings || []) if (!component.service_ids.includes(mapping.service_id)) throw new Error('Invalid contract symbol owner');
  }
  for (const repository of manifest.repositories) {
    if (repository.scope !== 'demo' || (repository.fallback?.service_ids || []).some(id => !serviceIds.has(id))) throw new Error('Invalid demo repository mapping');
  }
  for (const service of manifest.services) {
    if (service.tier?.value != null && (!Number.isInteger(service.tier.value) || service.tier.value < 1 || service.tier.value > 4)) throw new Error('Invalid tier');
    if (service.tier?.authority && service.tier.authority !== 'demo_only') throw new Error('Demo cannot claim production authority');
    if ((service.aliases || []).some(alias => alias.canonical_id && alias.canonical_id !== service.id)) throw new Error('Conflicting alias canonical identity');
    if ((service.owners || []).some(owner => owner.authority === 'authoritative')) throw new Error('Demo cannot claim production ownership');
  }
  return frozenCopy({ ...manifest, registry_version: `${manifest.registry_id}@${manifest.version}#sha256:${sha}` });
}

export function resolveAlias(registry, type, value) {
  if (registry.services.some(service => (service.aliases || []).some(alias => alias.type === type && alias.value === value && alias.status === 'conflicting'))) return null;
  const candidates = registry.services.filter(service => (service.aliases || []).some(alias =>
    alias.type === type && alias.value === value && ['declared', 'validated'].includes(alias.status)));
  return candidates.length === 1 ? candidates[0].id : null;
}
