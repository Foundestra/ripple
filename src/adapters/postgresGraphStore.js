// Postgres-backed graph store. Keeps the dependency graph and catalog in Postgres
// and answers blast-radius queries with a recursive CTE, so the query stays
// bounded to a few hops regardless of how many services exist.
//
// Enabled with RIPPLE_GRAPH_STORE=postgres and DATABASE_URL.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ripple_services (
  name        text PRIMARY KEY,
  tier        int  NOT NULL DEFAULT 3,
  kind        text NOT NULL DEFAULT 'service',
  team        text,
  owners      text[] NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS ripple_edges (
  from_service  text NOT NULL,
  to_service    text NOT NULL,
  protocol      text,
  kind          text NOT NULL CHECK (kind IN ('hard', 'soft')),
  kind_source   text,
  kind_reason   text,
  calls_per_min double precision,
  error_rate    double precision,
  last_seen     timestamptz,
  PRIMARY KEY (from_service, to_service)
);
CREATE INDEX IF NOT EXISTS ripple_edges_to_idx ON ripple_edges (to_service);
`;

const UPSTREAM_SQL = `
WITH RECURSIVE chain AS (
  SELECT e.from_service AS service,
         1 AS hops,
         ARRAY[e.to_service, e.from_service] AS visited,
         ARRAY[e.from_service || '->' || e.to_service] AS edge_path,
         (e.kind = 'hard') AS all_hard
  FROM ripple_edges e
  LEFT JOIN ripple_services s ON s.name = e.from_service
  WHERE e.to_service = $1 AND coalesce(s.kind, 'service') <> 'synthetic'
  UNION ALL
  SELECT e.from_service,
         c.hops + 1,
         c.visited || e.from_service,
         (e.from_service || '->' || e.to_service) || c.edge_path,
         c.all_hard AND e.kind = 'hard'
  FROM chain c
  JOIN ripple_edges e ON e.to_service = c.service
  LEFT JOIN ripple_services s ON s.name = e.from_service
  WHERE c.hops < $2
    AND NOT e.from_service = ANY(c.visited)
    AND coalesce(s.kind, 'service') <> 'synthetic'
)
SELECT DISTINCT ON (service) service, hops, edge_path, all_hard
FROM chain
ORDER BY service, all_hard DESC, hops ASC;
`;

export class PostgresGraphStore {
  constructor(url) {
    this.url = url;
    this.pool = null;
  }

  async init() {
    let pg;
    try {
      pg = (await import('pg')).default;
    } catch {
      throw new Error('RIPPLE_GRAPH_STORE=postgres needs the `pg` package: npm install pg');
    }
    this.pool = new pg.Pool({ connectionString: this.url, max: 4 });
    await this.pool.query(SCHEMA);
  }

  async sync(graph) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const n of graph.nodes()) {
        await client.query(
          `INSERT INTO ripple_services (name, tier, kind, team, owners) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (name) DO UPDATE SET tier = $2, kind = $3, team = $4, owners = $5`,
          [n.name, n.tier, n.kind, n.team, n.owners || []],
        );
      }
      await client.query('DELETE FROM ripple_edges');
      for (const e of graph.edges) {
        await client.query(
          `INSERT INTO ripple_edges (from_service, to_service, protocol, kind, kind_source, kind_reason, calls_per_min, error_rate, last_seen)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [e.from, e.to, e.protocol, e.kind, e.kind_source, e.kind_reason, e.calls_per_min, e.error_rate, e.last_seen],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // Same result shape as DependencyGraph.upstream().
  async upstream(graph, service, maxHops) {
    const { rows } = await this.pool.query(UPSTREAM_SQL, [service, maxHops]);
    return rows
      .map((r) => {
        const edges = r.edge_path.map((k) => {
          const [from, to] = k.split('->');
          const e = graph.edge(from, to);
          return { from, to, kind: e.kind, kind_source: e.kind_source, kind_reason: e.kind_reason };
        });
        const s = graph.catalog.get(r.service);
        return {
          service: r.service,
          tier: s.tier,
          team: s.team,
          owners: s.owners || [],
          hops: r.hops,
          path: [edges[0].from, ...edges.map((x) => x.to)],
          edges,
          allHard: r.all_hard,
          impact: r.all_hard ? 'breaks' : 'degrades',
        };
      })
      .sort((a, b) => Number(b.allHard) - Number(a.allHard) || a.tier - b.tier || a.hops - b.hops || a.service.localeCompare(b.service));
  }

  async close() {
    await this.pool?.end();
  }
}
