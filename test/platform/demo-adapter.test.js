import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadDemoRegistry } from '../../src/platform/adapters/demoRegistryAdapter.js';
import { adaptDemoGraph, loadDemoSnapshot } from '../../src/platform/adapters/demoGraphAdapter.js';
import { validateSnapshot } from '../../src/platform/graph/validateSnapshot.js';
import { resolveChangedPaths, resolveChangedPath } from '../../src/platform/identity/resolveChangedPaths.js';
import { loadRegistry } from '../../src/platform/identity/registry.js';
import { contentHash } from '../../src/platform/contracts/canonicalJson.js';
import { registryFixture, service } from './support/fixtures.js';

function amendedRegistry(edit) {
  const { source_sha256, registry_version, ...raw } = structuredClone(registryFixture());
  edit(raw);
  return loadRegistry({ ...raw, source_sha256: contentHash(raw) });
}
test('demo adapter retains 18 canonical nodes, 22 declared edges and explicit unknown time', async () => {
  const registry = await loadDemoRegistry(), snapshot = validateSnapshot(await loadDemoSnapshot(registry), registry);
  assert.equal(snapshot.nodes.length, 18); assert.equal(snapshot.edges.length, 22);
  assert.equal(snapshot.edges.filter(e => e.observed_at === null).length, 1);
  assert.ok(snapshot.edges.every(e => e.behavior.classification === 'unknown'));
  assert.equal(snapshot.validation_status, 'validated_partial');
  assert.ok(snapshot.coverage.every(c => c.status === 'mock' && c.freshness === 'unknown'));
  assert.ok(snapshot.edges.some(e => e.relationship_type === 'CONSUMES_FROM' && e.from_id === service('accounting') && e.to_id === service('kafka')));
  assert.equal((await loadDemoSnapshot(registry)).snapshot_id, snapshot.snapshot_id);
  const resolution = resolveChangedPaths([{ path: 'pb/demo.proto', contract_symbols: ['ChargeResponse'] }], registry, 'repository://demo/opentelemetry-demo');
  assert.deepEqual(resolution[0].service_ids, [service('payment')]);
  assert.deepEqual(resolution[0].component_ids, ['component://demo/opentelemetry-demo/shared-demo-proto']);
});
test('source hash and unresolved observations cannot create canonical services', async () => {
  const registry = await loadDemoRegistry();
  const source = JSON.parse(await readFile(new URL('../../data/platform/demo/graph-source.json', import.meta.url), 'utf8'));
  source.edges[0].canonical_direction.from = 'unreviewed-service';
  assert.throws(() => adaptDemoGraph(registry, source), /Invalid demo graph source/);
  const { source_sha256, ...raw } = source;
  const snapshot = adaptDemoGraph(registry, { ...raw, source_sha256: contentHash(raw) });
  assert.equal(snapshot.nodes.length, 18); assert.equal(snapshot.edges.length, 21);
  assert.ok(snapshot.coverage[0].unknowns.some(s => s.startsWith('UNRESOLVED_OBSERVATION:')));
});
test('ambiguous paths, polyrepo identity and explicit fallback remain separate', () => {
  const ambiguous = amendedRegistry(raw => raw.components.push({ ...raw.components[0], id: 'component://demo/shop/bank', service_ids: [service('bank')] }));
  const input = { repository_id: 'repository://demo/shop', path: 'src/payment/a.js' };
  assert.equal(resolveChangedPath(input, ambiguous).resolution, 'unresolved');
  const polyrepo = amendedRegistry(raw => {
    raw.repositories.push({ ...raw.repositories[0], id: 'repository://demo/other' });
    raw.components.push({ ...raw.components[0], id: 'component://demo/other/bank', repository_id: 'repository://demo/other', service_ids: [service('bank')] });
  });
  assert.deepEqual(resolveChangedPath(input, polyrepo).service_ids, [service('payment')]);
  assert.deepEqual(resolveChangedPath({ ...input, repository_id: 'repository://demo/other' }, polyrepo).service_ids, [service('bank')]);
  const fallback = amendedRegistry(raw => { raw.repositories[0].fallback = { behavior: 'map_to_services', service_ids: [service('bank')] }; });
  const result = resolveChangedPath({ ...input, path: 'unmapped/file.js' }, fallback);
  assert.equal(result.resolution, 'repository_fallback'); assert.equal(result.fallback_used, true);
});
test('unknown tier stays null and segment boundaries do not match unrelated prefixes', () => {
  const registry = amendedRegistry(raw => { raw.services[0].tier = null; raw.components[0].path_rules[0].prefix = 'src/payment'; });
  assert.equal(registry.services[0].tier, null);
  assert.equal(resolveChangedPath({ repository_id: 'repository://demo/shop', path: 'src/payments/a.js' }, registry).resolution, 'unresolved');
});
