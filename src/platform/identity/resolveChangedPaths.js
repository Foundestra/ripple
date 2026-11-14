import { safePath } from './ids.js';

export function resolveChangedPath(file, registry) {
  const { repository_id, path, previous_path } = file;
  if (!safePath(path) || (previous_path != null && !safePath(previous_path))) throw Object.assign(new Error('Invalid changed path'), { code: 'INVALID_PATH' });
  const base = { repository_id, path, component_ids: [], service_ids: [], resolution: 'unresolved', registry_version: registry.registry_version,
    confidence: 'unknown', fallback_used: false, warnings: [], classification: 'source' };
  const repository = registry.repositories.find(r => r.id === repository_id);
  if (!repository) return { ...base, warnings: ['UNRESOLVED_REPOSITORY'] };
  if (/(^|\/)(docs?\/|README(?:\.|$))|\.(md|rst)$/i.test(path)) base.classification = 'docs';
  if (/(^|\/)genproto\/|_pb2(?:_grpc)?\.py$|\.pb\.go$/.test(path)) base.classification = 'generated';
  const matchPath = value => {
    const matches = registry.components.filter(c => c.repository_id === repository_id).flatMap(c => (c.path_rules || [])
      .filter(rule => value === rule.prefix || value.startsWith(rule.prefix.endsWith('/') ? rule.prefix : `${rule.prefix}/`))
      .map(rule => ({ c, length: rule.prefix.length, precedence: rule.precedence })));
    if (!matches.length) return [];
    matches.sort((a, b) => b.length - a.length || b.precedence - a.precedence || a.c.id.localeCompare(b.c.id));
    return matches.filter(m => m.length === matches[0].length && m.precedence === matches[0].precedence).map(m => m.c);
  };
  let components = matchPath(path);
  if (previous_path) components = [...components, ...matchPath(previous_path)];
  components = [...new Map(components.map(c => [c.id, c])).values()];
  const shared = (registry.shared_contract_files || []).some(p => (typeof p === 'string' ? p : p.path) === path);
  if (shared) {
    // A shared contract is never attributed from a substring in an arbitrary patch.
    // Symbols are explicit normalized change observations, bound into request identity.
    const symbols = file.contract_symbols || [];
    const sharedComponents = registry.components.filter(c => c.repository_id === repository_id && c.classification === 'shared_contract' &&
      (c.path_rules || []).some(rule => rule.prefix === path));
    components = sharedComponents.length ? sharedComponents.filter(c => (c.symbol_mappings || []).some(mapping =>
      ['declared', 'validated'].includes(mapping.status) && symbols.some(symbol => mapping.symbols.includes(symbol)))) :
      registry.components.filter(c => c.repository_id === repository_id && symbols.some(s => c.contract_symbols?.includes(s)));
    if (!components.length) return { ...base, warnings: ['SHARED_CONTRACT_SYMBOLS_UNRESOLVED'] };
    if (sharedComponents.length) {
      const mappings = components.flatMap(c => c.symbol_mappings.filter(mapping => ['declared', 'validated'].includes(mapping.status) && symbols.some(symbol => mapping.symbols.includes(symbol))));
      const unresolved = symbols.filter(symbol => !mappings.some(mapping => mapping.symbols.includes(symbol)));
      if (symbols.some(symbol => new Set(mappings.filter(mapping => mapping.symbols.includes(symbol)).map(mapping => mapping.service_id)).size > 1)) {
        return { ...base, warnings: ['CONFLICTING_CONTRACT_SYMBOL_OWNERS'] };
      }
      return { ...base, component_ids: components.map(c => c.id).sort(), service_ids: [...new Set(mappings.map(mapping => mapping.service_id))].sort(),
        resolution: 'shared_component', confidence: 'authoritative_demo', warnings: unresolved.length ? ['PARTIAL_CONTRACT_SYMBOL_RESOLUTION'] : [] };
    }
  }
  if (components.length > 1 && !shared && !previous_path) return { ...base, warnings: ['AMBIGUOUS_PATH_MAPPING'] };
  if (components.length) return { ...base, component_ids: components.map(c => c.id).sort(),
    service_ids: [...new Set(components.flatMap(c => c.service_ids))].sort(),
    resolution: shared || components.some(c => c.service_ids.length > 1) ? 'shared_component' : 'exact_path_mapping', confidence: 'authoritative_demo' };
  const fallback = repository.fallback?.behavior === 'map_to_services' ? repository.fallback.service_ids || [] : [];
  if (fallback.length && fallback.every(id => registry.services.some(s => s.id === id))) return { ...base,
    service_ids: [...fallback].sort(), resolution: 'repository_fallback', confidence: 'declared_demo', fallback_used: true, warnings: ['REPOSITORY_FALLBACK_USED'] };
  return { ...base, warnings: ['UNMAPPED_PATH'] };
}

export const resolveChangedPaths = (files, registry, repository_id) => files.map(file => resolveChangedPath({ ...file, repository_id }, registry));
