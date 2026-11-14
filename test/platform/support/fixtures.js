import { contentHash } from '../../../src/platform/contracts/canonicalJson.js';
import { loadRegistry } from '../../../src/platform/identity/registry.js';
import { buildSnapshot } from '../../../src/platform/graph/buildSnapshot.js';
export const service = name => `service://astronomy-shop/${name}`;
export function registryFixture() {
  const raw = { schema_version: 'ripple.registry.v1', registry_id: 'registry://demo/astronomy-shop', scope: 'demo', authority: 'demo_only', version: '1.0.0', source_references: [{ path: 'data/fixture.json', status: 'declared_demo' }],
    path_classifications: { generated: [], documentation: [], shared_contract: [] }, unresolved_alias_types: [],
    repositories: [{ id: 'repository://demo/shop', scope: 'demo', aliases: [], fallback: { behavior: 'unresolved', service_ids: [] } }], services: ['checkout', 'payment', 'bank'].map(name => ({ id: service(name), lifecycle: 'active', kind: 'service', description: 'Demo service', contacts: [],
      aliases: [{ type: 'catalog_name', value: name, status: 'declared' }], tier: { value: 1, authority: 'demo_only', source: 'fixture' }, owners: [] })),
    components: [{ id: 'component://demo/shop/payment', repository_id: 'repository://demo/shop', service_ids: [service('payment')], classification: 'service_source',
      path_rules: [{ prefix: 'src/payment/', precedence: 100, classification: 'source' }], contract_symbols: ['ChargeResponse'] }], shared_contract_files: ['pb/demo.proto'] };
  return loadRegistry({ ...raw, source_sha256: contentHash(raw) });
}
export function snapshotFixture(registry = registryFixture(), extra = {}) {
  const evidence = [{ evidence_id: 'evidence://fixture/graph', source_system: 'demo_fixture', source_reference: 'fixture', status: 'declared', observed_at: '2026-11-14T09:00:00Z', environment: 'demo', scope: 'demo', metadata: {} }];
  return buildSnapshot({ registry, created_at: '2026-11-14T09:00:00Z',
    nodes: registry.services.map(s => ({ node_id: s.id, entity_type: 'service', tier: s.tier, owners: s.owners })),
    edges: [['checkout', 'payment'], ['payment', 'bank']].map(([from, to]) => ({ from_id: service(from), to_id: service(to), relationship_type: 'CALLS',
      environment: 'demo', source_refs: [evidence[0].evidence_id], observed_at: evidence[0].observed_at, evidence_status: 'declared',
      behavior: { classification: 'unknown', operation: 'unknown', failure_mode: 'unknown', basis: 'mock_fixture', evidence_refs: [] } })),
    evidence, coverage: [{ adapter: 'fixture', signal: 'dependencies', status: 'mock', observed_from: '2026-11-14T09:00:00Z', observed_until: '2026-11-14T09:00:00Z', freshness: 'unknown', limit: 2500, truncated: false, errors: [], unknowns: ['PRODUCTION_COVERAGE_UNKNOWN'] }], source_versions: [{ source: 'fixture', version: 'v1', observed_at: '2026-11-14T09:00:00Z' }], ...extra });
}
