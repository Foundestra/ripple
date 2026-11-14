import { readFile } from 'node:fs/promises';
import { contentHash } from '../contracts/canonicalJson.js';
import { resolveAlias } from '../identity/registry.js';
import { buildSnapshot } from '../graph/buildSnapshot.js';

export function adaptDemoGraph(registry, source) {
  const { source_sha256, published_at, publication_timestamp, publication_timestamps, ...content } = source;
  if (source.scope !== 'demo' || source.authority !== 'seeded_mock' || source.environment !== 'demo' ||
      source.registry_id !== registry.registry_id || contentHash(content) !== source_sha256 ||
      !Array.isArray(source.edges) || source.edges.length > 2500) throw new Error('Invalid demo graph source');
  const edges = [], evidence = [], unknowns = ['PRODUCTION_COVERAGE_UNKNOWN', 'BEHAVIOR_NOT_VALIDATED'];
  const evidenceIds = new Set();
  for (const record of source.edges) {
    const from_id = resolveAlias(registry, 'seeded_graph_name', record.canonical_direction?.from || record.from);
    const to_id = resolveAlias(registry, 'seeded_graph_name', record.canonical_direction?.to || record.to);
    if (!from_id || !to_id) { unknowns.push(`UNRESOLVED_OBSERVATION:${record.observation_id}`); continue; }
    for (const id of record.evidence_refs || []) {
      if (evidenceIds.has(id)) continue;
      evidenceIds.add(id);
      evidence.push({ evidence_id: id, source_system: 'demo_fixture', source_reference: record.source_reference,
        status: 'declared', observed_at: record.observed_at, environment: 'demo', scope: 'demo',
        metadata: { description: 'Seeded graph observation; not live telemetry or validated failure behavior.' } });
    }
    edges.push({ from_id, to_id, relationship_type: record.relationship_type, environment: 'demo',
      source_refs: record.evidence_refs, evidence_status: 'declared', observed_at: record.observed_at,
      behavior: { classification: 'unknown', operation: 'unknown', failure_mode: 'unknown',
        basis: 'Seeded protocol and traffic do not validate failure behavior.', evidence_refs: [] } });
  }
  const observed = source.edges.map(e => e.observed_at).filter(time => typeof time === 'string' && Number.isFinite(Date.parse(time))).sort();
  for (const record of (source.unresolved_observations || []).slice(0, 100)) unknowns.push(`UNRESOLVED_OBSERVATION:${record.observation_id || 'unknown'}`);
  return buildSnapshot({ registry,
    nodes: registry.services.map(service => ({ node_id: service.id, entity_type: 'service', tier: service.tier || null, owners: service.owners || [] })),
    edges, evidence, environment: 'demo', created_at: observed.at(-1) || '2026-11-14T09:00:00.000Z',
    source_versions: [{ source: source.source_id, version: `${source.source_version}#sha256:${source_sha256}`, observed_at: observed.at(-1) || '2026-11-14T09:00:00.000Z' }],
    coverage: [{ adapter: 'demo_graph', signal: 'dependency_observations', status: 'mock', observed_from: observed[0] || null,
      observed_until: observed.at(-1) || null, freshness: 'unknown', limit: 2500, truncated: Boolean(source.coverage?.truncated), errors: [], unknowns: unknowns.slice(0, 100) }] });
}

export async function loadDemoSnapshot(registry) {
  const source = JSON.parse(await readFile(new URL('../../../data/platform/demo/graph-source.json', import.meta.url), 'utf8'));
  return adaptDemoGraph(registry, source);
}
