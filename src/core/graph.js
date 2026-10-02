// Dependency graph with hard/soft edge classification and N-hop blast radius.
//
// Classification order (later wins):
//   1. protocol / callee kind: sync HTTP/gRPC/SQL start HARD; Kafka and cache calls start SOFT
//   2. failure experiments: if injected downstream failures show up as upstream errors -> HARD,
//      if they don't -> SOFT (confirmed)
//   3. owner overrides from the service catalog

const SOFT_PROTOCOLS = new Set(['kafka', 'messaging', 'redis', 'cache']);
const SOFT_CALLEE_KINDS = new Set(['cache', 'queue']);

export class DependencyGraph {
  constructor({ edges, catalog, experiments = [], source = 'unknown', capturedAt = null, stale = false, error = null, mock = false }) {
    this.catalog = catalog;
    this.source = source;
    this.mock = mock;
    this.capturedAt = capturedAt;
    this.stale = stale;
    this.error = error;
    this.experiments = experiments;
    this.edges = [];
    this.byKey = new Map();

    for (const e of edges) this.#addEdge({ ...e, origin: e.origin || 'traces' });
    for (const m of catalog.manualEdges) {
      if (!this.byKey.has(key(m.from, m.to))) {
        this.#addEdge({ from: m.from, to: m.to, protocol: m.protocol || 'grpc', origin: 'manual', origin_reason: m.reason, last_seen: null });
      }
    }
    this.#classify();
  }

  #addEdge(e) {
    const edge = {
      from: e.from,
      to: e.to,
      protocol: e.protocol || 'grpc',
      calls_per_min: e.calls_per_min ?? null,
      error_rate: e.error_rate ?? null,
      last_seen: e.last_seen ?? this.capturedAt,
      origin: e.origin,
      origin_reason: e.origin_reason,
    };
    this.edges.push(edge);
    this.byKey.set(key(edge.from, edge.to), edge);
  }

  #classify() {
    for (const e of this.edges) {
      const callee = this.catalog.get(e.to);
      const async = SOFT_PROTOCOLS.has(e.protocol) || callee.kind === 'queue' || callee.inbound === 'async';
      if (async || SOFT_CALLEE_KINDS.has(callee.kind)) {
        e.kind = 'soft';
        e.kind_source = 'protocol';
        e.kind_reason = `${async && e.protocol !== 'redis' ? 'Async messaging' : 'Cache call'} starts soft`;
      } else {
        e.kind = 'hard';
        e.kind_source = 'protocol';
        e.kind_reason = `Synchronous ${e.protocol.toUpperCase()} call on the request path starts hard`;
      }
    }
    for (const exp of this.experiments) {
      for (const v of exp.verdicts || []) {
        const e = this.byKey.get(key(v.from, v.to));
        if (!e) continue;
        e.kind = v.result;
        e.kind_source = 'experiment';
        e.experiment = { flag: exp.flag, origin: exp.origin, environment: exp.environment || null, propagation: v.propagation ?? null, baseline_error: v.baseline_error, during_error: v.during_error };
        e.kind_reason =
          v.result === 'hard'
            ? `Verified by failure experiment \`${exp.flag}\`: ${v.evidence}`
            : `Failure experiment \`${exp.flag}\` did not propagate: ${v.evidence}`;
      }
    }
    for (const o of this.catalog.edgeOverrides) {
      const e = this.byKey.get(key(o.from, o.to));
      if (!e) continue;
      e.kind = o.kind;
      e.kind_source = 'owner';
      e.kind_reason = o.reason;
    }
  }

  edge(from, to) {
    return this.byKey.get(key(from, to)) ?? null;
  }

  nodes() {
    const names = new Set();
    for (const e of this.edges) {
      names.add(e.from);
      names.add(e.to);
    }
    return [...names].map((name) => {
      const s = this.catalog.get(name);
      return { name, tier: s.tier, kind: s.kind, team: s.team, owners: s.owners, description: s.description, unknown: !!s.unknown };
    });
  }

  callersOf(service) {
    return this.edges.filter((e) => e.to === service && this.catalog.get(e.from).kind !== 'synthetic');
  }

  // Everything upstream of `service` within maxHops. For each affected service we keep
  // the most severe path: an all-hard chain beats a chain with a soft edge, then fewer hops.
  // Hard + tier 1 = "breaks"; any soft edge on the way = "degrades".
  upstream(service, maxHops = 3) {
    const best = new Map();
    const walk = (node, chain, visited) => {
      if (chain.length >= maxHops) return;
      for (const e of this.callersOf(node)) {
        if (visited.has(e.from)) continue;
        const next = [e, ...chain];
        const allHard = next.every((x) => x.kind === 'hard');
        const cur = best.get(e.from);
        if (!cur || (allHard && !cur.allHard) || (allHard === cur.allHard && next.length < cur.edges.length)) {
          best.set(e.from, { service: e.from, hops: next.length, edges: next, allHard });
        }
        walk(e.from, next, new Set([...visited, e.from]));
      }
    };
    walk(service, [], new Set([service]));

    return [...best.values()]
      .map((b) => {
        const s = this.catalog.get(b.service);
        return {
          service: b.service,
          tier: s.tier,
          team: s.team,
          owners: s.owners || [],
          hops: b.hops,
          path: [b.edges[0].from, ...b.edges.map((x) => x.to)],
          edges: b.edges.map((x) => ({ from: x.from, to: x.to, kind: x.kind, kind_source: x.kind_source, kind_reason: x.kind_reason })),
          allHard: b.allHard,
          impact: b.allHard ? 'breaks' : 'degrades',
        };
      })
      .sort((a, b) => Number(b.allHard) - Number(a.allHard) || a.tier - b.tier || a.hops - b.hops || a.service.localeCompare(b.service));
  }

  toJSON() {
    return {
      source: this.source,
      mock: this.mock,
      captured_at: this.capturedAt,
      stale: this.stale,
      error: this.error,
      nodes: this.nodes(),
      edges: this.edges,
    };
  }
}

const key = (a, b) => `${a}->${b}`;
