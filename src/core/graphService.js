import { DependencyGraph } from './graph.js';
import { PrometheusServiceGraphSource, JaegerDependencySource, SnapshotSource, loadExperiments } from '../adapters/graphSources.js';
import { PostgresGraphStore } from '../adapters/postgresGraphStore.js';

// Owns the current dependency graph: pulls from the configured source on a
// schedule, falls back to the seeded snapshot if the live stack is unreachable,
// and (optionally) mirrors the graph into Postgres for CTE blast-radius queries.
export class GraphService {
  constructor(config, catalog, { log = console } = {}) {
    this.config = config;
    this.catalog = catalog;
    this.log = log;
    const g = config.graph;
    const all = {
      prometheus: new PrometheusServiceGraphSource(g),
      jaeger: new JaegerDependencySource(g),
      seeded: new SnapshotSource({ dataDir: config.dataDir }),
    };
    this.sources = g.source === 'auto' ? [all.prometheus, all.jaeger, all.seeded] : [all[g.source] || all.seeded, all.seeded];
    this.sources = [...new Set(this.sources)];
    this.graph = null;
    this.store = null;
    this.attempts = [];
    this.listeners = new Set();
  }

  async init() {
    if (this.config.graph.store === 'postgres') {
      this.store = new PostgresGraphStore(this.config.postgresUrl);
      await this.store.init();
    }
    await this.refresh();
    return this;
  }

  start() {
    const sec = this.config.graph.refreshSec;
    if (sec > 0) this.timer = setInterval(() => this.refresh().catch((e) => this.log.error('[graph] refresh failed', e)), sec * 1000);
    this.timer?.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    return this.store?.close();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async refresh() {
    const experiments = loadExperiments(this.config.dataDir);
    this.attempts = [];
    for (const src of this.sources) {
      try {
        const res = await src.fetch();
        const fellBack = src.name === 'seeded' && this.sources[0].name !== 'seeded';
        this.graph = new DependencyGraph({
          edges: res.edges,
          catalog: this.catalog,
          experiments,
          source: res.source,
          capturedAt: res.capturedAt,
          stale: fellBack,
          error: fellBack ? this.attempts.map((a) => `${a.source}: ${a.error}`).join('; ') : null,
        });
        this.attempts.push({ source: src.name, ok: true });
        if (this.store) await this.store.sync(this.graph);
        for (const fn of this.listeners) fn(this.graph);
        return this.graph;
      } catch (err) {
        this.attempts.push({ source: src.name, ok: false, error: err.message });
      }
    }
    throw new Error(`No graph source available: ${JSON.stringify(this.attempts)}`);
  }

  async upstream(service, maxHops = this.config.graph.maxHops) {
    if (this.store) return this.store.upstream(this.graph, service, maxHops);
    return this.graph.upstream(service, maxHops);
  }

  experiments() {
    return loadExperiments(this.config.dataDir);
  }
}
