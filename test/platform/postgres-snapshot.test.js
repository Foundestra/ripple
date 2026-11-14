import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registryFixture, snapshotFixture } from './support/fixtures.js';
import { PostgresSnapshotStore } from '../../src/platform/persistence/postgresStore.js';
import { validateSnapshot } from '../../src/platform/graph/validateSnapshot.js';
import { buildSnapshot } from '../../src/platform/graph/buildSnapshot.js';
const url = process.env.RIPPLE_PLATFORM_TEST_DATABASE_URL;
test('Postgres snapshot migration, deduplication, reconstruction, immutability and projection rebuild', { skip: !url }, async () => {
  const { Pool } = await import('pg');
  const schema = `platform_snapshot_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
  const store = new PostgresSnapshotStore(pool);
  try {
    await store.init(); await store.init();
    const registry = registryFixture(), snapshot = snapshotFixture(registry);
    const [a, b] = await Promise.all([store.publishSnapshot(registry, snapshot), store.publishSnapshot(registry, snapshot)]);
    assert.deepEqual(a, b);
    assert.deepEqual(validateSnapshot(await store.getSnapshot(snapshot.snapshot_id), registry), snapshot);
    await assert.rejects(pool.query('UPDATE platform_graph_snapshots SET graph_version=$1 WHERE snapshot_id=$2', ['changed', snapshot.snapshot_id]), /insert-only/);
    await store.rebuildSnapshotProjections();
    assert.equal((await store.getActiveSnapshot()).snapshot_id, snapshot.snapshot_id);
    assert.equal(Number((await pool.query('SELECT count(*) FROM platform_snapshot_events WHERE snapshot_id=$1 AND event_type=$2', [snapshot.snapshot_id, 'PUBLISHED'])).rows[0].count), 1);
    // Losing a rebuildable projection must not reset immutable event ordering.
    await pool.query('DELETE FROM platform_active_snapshots');
    const next = buildSnapshot({ registry, nodes: snapshot.nodes, edges: snapshot.edges, evidence: snapshot.evidence,
      coverage: snapshot.coverage, source_versions: [{ ...snapshot.source_versions[0], version: 'v2' }], environment: 'demo', created_at: snapshot.created_at });
    await store.publishSnapshot(registry, next);
    await store.rebuildSnapshotProjections();
    assert.equal((await store.getActiveSnapshot()).snapshot_id, next.snapshot_id);
    // Force a database failure after a candidate begins; no active state changes.
    await pool.query("CREATE FUNCTION fail_snapshot_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated write failure'; END $$");
    await pool.query('CREATE TRIGGER test_write_failure BEFORE INSERT ON platform_graph_nodes FOR EACH ROW EXECUTE FUNCTION fail_snapshot_insert()');
    const broken = buildSnapshot({ registry, nodes: snapshot.nodes, edges: snapshot.edges, evidence: snapshot.evidence,
      coverage: snapshot.coverage, source_versions: [{ ...snapshot.source_versions[0], version: 'v3' }], environment: 'demo', created_at: snapshot.created_at });
    await assert.rejects(store.publishSnapshot(registry, broken), /simulated write failure/);
    assert.equal(await store.getSnapshot(broken.snapshot_id), null);
    assert.equal((await store.getActiveSnapshot()).snapshot_id, next.snapshot_id);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
