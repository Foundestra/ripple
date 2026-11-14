import { randomUUID } from 'node:crypto';
import { validateSnapshot } from '../graph/validateSnapshot.js';
import { frozenCopy } from '../contracts/canonicalJson.js';
import { migratePlatform } from './migrate.js';

export class PostgresSnapshotStore {
  constructor(pool) { this.pool = pool; }
  async init() { await migratePlatform(this.pool); }
  async publishSnapshot(registry, snapshot) {
    validateSnapshot(snapshot, registry);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`platform-snapshot:${snapshot.environment}`]);
      const priorRegistry = await client.query('SELECT content_sha256 FROM platform_registry_versions WHERE registry_id=$1 AND semantic_version=$2', [registry.registry_id, registry.version]);
      if (priorRegistry.rows.length && priorRegistry.rows[0].content_sha256 !== registry.source_sha256) throw Object.assign(new Error('Registry version content conflict'), { code: 'SNAPSHOT_VERSION_CONFLICT' });
      await client.query('INSERT INTO platform_registry_versions(registry_version,registry_id,scope,semantic_version,content_sha256,manifest_json) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [registry.registry_version, registry.registry_id, registry.scope, registry.version, registry.source_sha256, registry]);
      const inserted = await client.query('INSERT INTO platform_graph_snapshots(snapshot_id,graph_version,registry_version,environment,content_sha256,validation_status,bounded_snapshot_json,coverage_json,source_versions_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING snapshot_id',
        [snapshot.snapshot_id, snapshot.graph_version, snapshot.registry_version, snapshot.environment, snapshot.content_sha256, snapshot.validation_status, snapshot, JSON.stringify(snapshot.coverage), JSON.stringify(snapshot.source_versions), snapshot.created_at]);
      if (inserted.rows.length) {
        for (const node of snapshot.nodes) await client.query('INSERT INTO platform_graph_nodes(snapshot_id,node_id,entity_type,attributes_json) VALUES($1,$2,$3,$4)', [snapshot.snapshot_id, node.node_id, node.entity_type, node]);
        for (const edge of snapshot.edges) await client.query('INSERT INTO platform_graph_edges(snapshot_id,edge_id,from_id,to_id,relationship_type,behavior,evidence_json,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [snapshot.snapshot_id, edge.edge_id, edge.from_id, edge.to_id, edge.relationship_type, edge.behavior, edge, edge.observed_at]);
        for (const evidence of snapshot.evidence) await client.query('INSERT INTO platform_snapshot_evidence(snapshot_id,evidence_id,source_system,source_reference,status,observed_at,bounded_evidence_json) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [snapshot.snapshot_id, evidence.evidence_id, evidence.source_system, evidence.source_reference, evidence.status, evidence.observed_at, evidence]);
      }
      const current = await client.query('SELECT snapshot_id,generation FROM platform_active_snapshots WHERE environment=$1 FOR UPDATE', [snapshot.environment]);
      const old = current.rows[0];
      if (old?.snapshot_id !== snapshot.snapshot_id) {
        const publication = randomUUID();
        // Publication order comes from immutable events, not a rebuildable pointer.
        const generations = await client.query("SELECT coalesce(max((details_json->>'generation')::bigint),0)+1 AS generation FROM platform_snapshot_events WHERE event_type='PUBLISHED' AND details_json->>'environment'=$1", [snapshot.environment]);
        const generation = Number(generations.rows[0].generation);
        await client.query("INSERT INTO platform_snapshot_events(event_id,snapshot_id,event_type,related_snapshot_id,details_json) VALUES($1,$2,'PUBLISHED',$3,$4)", [publication, snapshot.snapshot_id, old?.snapshot_id || null, { generation, environment: snapshot.environment }]);
        if (old) await client.query("INSERT INTO platform_snapshot_events(event_id,snapshot_id,event_type,related_snapshot_id,details_json) VALUES($1,$2,'SUPERSEDES',$3,$4)", [randomUUID(), snapshot.snapshot_id, old.snapshot_id, { environment: snapshot.environment }]);
        await client.query('INSERT INTO platform_active_snapshots(environment,snapshot_id,publication_event_id,generation) VALUES($1,$2,$3,$4) ON CONFLICT(environment) DO UPDATE SET snapshot_id=$2,publication_event_id=$3,generation=$4,updated_at=now()', [snapshot.environment, snapshot.snapshot_id, publication, generation]);
      }
      const stored = await client.query('SELECT bounded_snapshot_json FROM platform_graph_snapshots WHERE snapshot_id=$1', [snapshot.snapshot_id]);
      await client.query('COMMIT');
      return frozenCopy(stored.rows[0].bounded_snapshot_json);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async getSnapshot(id) {
    const result = await this.pool.query('SELECT bounded_snapshot_json FROM platform_graph_snapshots WHERE snapshot_id=$1', [id]);
    return result.rows.length ? frozenCopy(result.rows[0].bounded_snapshot_json) : null;
  }
  async getActiveSnapshot(environment = 'demo') {
    const result = await this.pool.query('SELECT s.bounded_snapshot_json FROM platform_active_snapshots a JOIN platform_graph_snapshots s USING(snapshot_id) WHERE a.environment=$1', [environment]);
    return result.rows.length ? frozenCopy(result.rows[0].bounded_snapshot_json) : null;
  }
  async rebuildSnapshotProjections() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('platform-snapshot:demo'))");
      await client.query('DELETE FROM platform_active_snapshots');
      await client.query(`INSERT INTO platform_active_snapshots(environment,snapshot_id,publication_event_id,generation)
        SELECT DISTINCT ON (s.environment) s.environment,e.snapshot_id,e.event_id,(e.details_json->>'generation')::bigint
        FROM platform_snapshot_events e JOIN platform_graph_snapshots s USING(snapshot_id)
        WHERE e.event_type='PUBLISHED' ORDER BY s.environment,(e.details_json->>'generation')::bigint DESC`);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
