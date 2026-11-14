import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, canonicalJson } from '../../src/platform/contracts/canonicalJson.js';
import { loadRegistry, resolveAlias } from '../../src/platform/identity/registry.js';
import { resolveChangedPath } from '../../src/platform/identity/resolveChangedPaths.js';
import { buildSnapshot } from '../../src/platform/graph/buildSnapshot.js';
import { validateSnapshot } from '../../src/platform/graph/validateSnapshot.js';
import { queryNeighborhood } from '../../src/platform/graph/queryNeighborhood.js';
import { SnapshotPublisher } from '../../src/platform/graph/snapshotPublisher.js';
import { MemorySnapshotStore } from '../../src/platform/persistence/memoryStore.js';

import { service, registryFixture, snapshotFixture } from './support/fixtures.js';
test('canonical hashes ignore object key order but reject lossy JSON', () => {
  assert.equal(contentHash({ b: 1, a: [2] }), contentHash({ a: [2], b: 1 }));
  for (const value of [undefined, NaN, Infinity, { x: undefined }, new Date()]) assert.throws(() => canonicalJson(value));
});
test('registry hash, unknown identity and demo authority fail closed', () => {
  const registry = registryFixture();
  assert.equal(resolveAlias(registry, 'catalog_name', 'payment'), service('payment'));
  assert.equal(resolveAlias(registry, 'catalog_name', 'missing'), null);
  assert.equal(resolveAlias(registry, 'otel_service_name', 'payment'), null);
  assert.throws(() => loadRegistry({ ...registry, source_sha256: 'a'.repeat(64) }));
});
test('repository-aware path, shared symbol, generated, docs and unknown results', () => {
  const registry = registryFixture();
  const resolve = (path, extra = {}) => resolveChangedPath({ repository_id: 'repository://demo/shop', path, ...extra }, registry);
  assert.deepEqual(resolve('src/payment/charge.js').service_ids, [service('payment')]);
  assert.equal(resolve('src/payment/charge.js', { repository_id: 'repository://other/shop' }).resolution, 'unresolved');
  assert.equal(resolve('src/payments/charge.js').resolution, 'unresolved');
  assert.equal(resolve('pb/demo.proto').resolution, 'unresolved');
  assert.equal(resolve('pb/demo.proto', { contract_symbols: ['ChargeResponse'] }).resolution, 'shared_component');
  assert.equal(resolve('README.md').classification, 'docs');
  assert.equal(resolve('genproto/demo.pb.go').classification, 'generated');
  assert.deepEqual(resolve('src/new/charge.js', { previous_path: 'src/payment/charge.js' }).service_ids, [service('payment')]);
  for (const path of ['/etc/passwd', '../secret', 'src/../secret', 'src\\payment\\x', 'src/./x', 'src//x']) assert.throws(() => resolve(path));
});
test('snapshots are immutable and publication time does not change content identity', () => {
  const registry = registryFixture(), first = snapshotFixture(registry);
  const later = snapshotFixture(registry, { created_at: '2026-11-14T10:00:00Z' });
  assert.equal(first.snapshot_id, later.snapshot_id);
  assert.equal(validateSnapshot(first, registry), first);
  assert.throws(() => { first.nodes[0].node_id = 'x'; });
  assert.throws(() => validateSnapshot({ ...first, content_sha256: 'b'.repeat(64) }, registry));
});
test('unknown sources cannot create nodes and protocol cannot validate hard/soft', () => {
  const registry = registryFixture(), first = snapshotFixture(registry);
  const edges = structuredClone(first.edges); edges[0].behavior.classification = 'soft';
  const unsupported = snapshotFixture(registry, { edges });
  assert.throws(() => validateSnapshot(unsupported, registry), /Unvalidated/);
  assert.throws(() => validateSnapshot(snapshotFixture(registry, { nodes: [...first.nodes, { node_id: service('invented'), entity_type: 'service', tier: null, owners: [] }] }), registry), /unreviewed/);
  const dangling = structuredClone(first.edges);
  dangling[0].behavior.evidence_refs = ['evidence://fixture/missing'];
  const invalid = snapshotFixture(registry, { edges: dangling });
  assert.throws(() => validateSnapshot(invalid, registry), /Unresolved behavior evidence/);
  assert.throws(() => queryNeighborhood(invalid, [service('payment')]), { code: 'NO_VALIDATED_SNAPSHOT' });
});
test('snapshot validity boundaries bind content identity', () => {
  const registry = registryFixture();
  const first = snapshotFixture(registry, { valid_until: '2026-11-14T09:10:00Z' });
  const second = snapshotFixture(registry, { valid_until: '2026-11-14T09:20:00Z' });
  assert.notEqual(first.snapshot_id, second.snapshot_id);
  assert.equal(validateSnapshot(first, registry).valid_until, '2026-11-14T09:10:00Z');
});
test('one-hop traversal returns canonical upstream and downstream paths', () => {
  const result = queryNeighborhood(snapshotFixture(), [service('payment')]);
  assert.equal(result.upstream[0].service_id, service('checkout'));
  assert.equal(result.downstream[0].service_id, service('bank'));
  assert.deepEqual(result.upstream[0].nodes.map(n => n.node_id), [service('checkout'), service('payment')]);
  assert.equal(result.upstream[0].behavior.classification, 'unknown');
  assert.equal(result.coverage[0].status, 'mock');
});
test('node, evidence, fanout and time bounds expose truncation and frontier', () => {
  const snapshot = snapshotFixture();
  const result = queryNeighborhood(snapshot, [service('payment')], { limits: { max_nodes: 1 } });
  assert.equal(result.bounds.truncated, true); assert.equal(result.bounds.returned_nodes, 1);
  assert.equal(result.bounds.unexplored_frontier.length, 2);
  assert.equal(queryNeighborhood(snapshot, [service('payment')], { limits: { max_evidence_bytes: 1 } }).bounds.truncated, true);
  let tick = 0;
  assert.equal(queryNeighborhood(snapshot, [service('payment')], { clock: () => tick++ * 2000 }).bounds.truncated, true);
  assert.throws(() => queryNeighborhood(snapshot, [], { limits: { depth: 2 } }));
  assert.throws(() => queryNeighborhood(snapshot, [service('unknown')]));
  const registry = registryFixture();
  const wide = snapshotFixture(registry, { edges: [...snapshot.edges, { ...snapshot.edges[0], from_id: service('payment'), to_id: service('checkout') }] });
  const bounded = queryNeighborhood(wide, [service('payment')], { limits: { max_edges_per_direction: 1 } });
  assert.equal(bounded.downstream.length, 1);
  assert.ok(bounded.bounds.truncation_reason.includes('FANOUT_LIMIT'));
});
test('registry version content changes and alias conflicts cannot silently resolve', async () => {
  const first = registryFixture(), store = new MemorySnapshotStore();
  await store.publishSnapshot(first, snapshotFixture(first));
  const { registry_version, source_sha256, ...raw } = structuredClone(first);
  raw.services[0].aliases.push({ type: 'catalog_name', value: 'checkout', status: 'conflicting' });
  const conflict = loadRegistry({ ...raw, source_sha256: contentHash(raw) });
  assert.equal(resolveAlias(conflict, 'catalog_name', 'checkout'), null);
  await assert.rejects(store.publishSnapshot(conflict, snapshotFixture(conflict)), { code: 'SNAPSHOT_VERSION_CONFLICT' });
});
test('direction edge limits apply across all changed roots', () => {
  const result = queryNeighborhood(snapshotFixture(), [service('checkout'), service('payment')], { limits: { max_edges_per_direction: 1 } });
  assert.equal(result.downstream.length, 1);
  assert.ok(result.upstream.length <= 1);
  assert.equal(result.bounds.truncated, true);
  assert.ok(result.bounds.truncation_reason.includes('FANOUT_LIMIT'));
  assert.equal(result.bounds.unexplored_frontier[0].direction, 'downstream');
});
test('publisher preserves LKG after validation and durability failure', async () => {
  const registry = registryFixture(), store = new MemorySnapshotStore(), publisher = new SnapshotPublisher(store);
  const first = await publisher.publish(registry, async () => snapshotFixture(registry));
  await assert.rejects(publisher.publish(registry, async () => ({ ...first, content_sha256: 'a'.repeat(64) })));
  assert.equal(publisher.current.snapshot_id, first.snapshot_id);
  const failing = new SnapshotPublisher({ publishSnapshot: async () => { throw new Error('database failed'); } });
  await assert.rejects(failing.publish(registry, async () => first)); assert.equal(failing.current, null);
  assert.equal((await store.getActiveSnapshot()).snapshot_id, first.snapshot_id);
});
test('publication is serialized, retries deduplicate, and projections rebuild', async () => {
  const registry = registryFixture(), store = new MemorySnapshotStore(), publisher = new SnapshotPublisher(store);
  const order = [];
  const first = publisher.publish(registry, async () => { order.push(1); await Promise.resolve(); return snapshotFixture(registry); });
  const second = publisher.publish(registry, async () => { order.push(2); return snapshotFixture(registry); });
  assert.equal((await first).snapshot_id, (await second).snapshot_id);
  assert.deepEqual(order, [1, 2]);
  assert.equal((await store.snapshotEvents()).length, 1);
  await store.rebuildSnapshotProjections();
  assert.equal((await store.getActiveSnapshot()).snapshot_id, publisher.current.snapshot_id);
  const restored = new SnapshotPublisher(store); await restored.restore();
  assert.deepEqual(restored.current, publisher.current);
});
