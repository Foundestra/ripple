import fs from 'node:fs';
import path from 'node:path';

// Each source returns { edges: [{ from, to, protocol, calls_per_min, error_rate, last_seen }], capturedAt, source }.
// All sources share this interface; the graph service picks one (or falls back).

export async function fetchJson(url, { timeoutMs = 5000, headers = {} } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// Live: OTel Collector `servicegraph` connector metrics in Prometheus.
export class PrometheusServiceGraphSource {
  name = 'prometheus';
  constructor({ prometheusUrl, requestMetric, failedMetric, lookbackMin }) {
    this.url = prometheusUrl.replace(/\/$/, '');
    this.requestMetric = requestMetric;
    this.failedMetric = failedMetric;
    this.lookbackMin = lookbackMin;
  }

  async query(q) {
    const body = await fetchJson(`${this.url}/api/v1/query?query=${encodeURIComponent(q)}`);
    if (body.status !== 'success') throw new Error(`Prometheus query failed: ${body.error}`);
    return body.data.result;
  }

  async fetch() {
    const w = `${this.lookbackMin}m`;
    const [calls, failed, lastSeen] = await Promise.all([
      this.query(`sum by (client, server, connection_type) (rate(${this.requestMetric}[${w}])) * 60`),
      this.query(`sum by (client, server) (rate(${this.failedMetric}[${w}])) * 60`),
      this.query(`max by (client, server) (timestamp(${this.requestMetric}))`),
    ]);
    if (!calls.length) throw new Error(`No ${this.requestMetric} series; is the servicegraph connector enabled?`);
    const failedBy = new Map(failed.map((r) => [`${r.metric.client}->${r.metric.server}`, Number(r.value[1])]));
    const seenBy = new Map(lastSeen.map((r) => [`${r.metric.client}->${r.metric.server}`, Number(r.value[1])]));
    const edges = calls
      .filter((r) => r.metric.client && r.metric.server && r.metric.client !== r.metric.server)
      .map((r) => {
        const k = `${r.metric.client}->${r.metric.server}`;
        const cpm = Number(r.value[1]);
        const ct = r.metric.connection_type || '';
        return {
          from: r.metric.client,
          to: r.metric.server,
          protocol: ct === 'messaging_system' ? 'kafka' : ct === 'database' ? 'sql' : 'grpc',
          calls_per_min: round(cpm),
          error_rate: cpm > 0 ? round((failedBy.get(k) || 0) / cpm, 4) : 0,
          last_seen: seenBy.has(k) ? new Date(seenBy.get(k) * 1000).toISOString() : null,
        };
      });
    return { edges, capturedAt: new Date().toISOString(), source: 'prometheus' };
  }
}

// Live: Jaeger's dependencies API (works out of the box with the OTel Demo).
export class JaegerDependencySource {
  name = 'jaeger';
  constructor({ jaegerUrl, lookbackMin }) {
    this.url = jaegerUrl.replace(/\/$/, '');
    this.lookbackMin = lookbackMin;
  }

  async fetch() {
    const endTs = Date.now();
    const lookback = this.lookbackMin * 60 * 1000;
    const body = await fetchJson(`${this.url}/api/dependencies?endTs=${endTs}&lookback=${lookback}`);
    const data = body.data || [];
    if (!data.length) throw new Error('Jaeger returned no dependencies; is the demo generating traffic?');
    const now = new Date().toISOString();
    const edges = data
      .filter((d) => d.parent !== d.child)
      .map((d) => ({
        from: d.parent,
        to: d.child,
        protocol: /kafka/.test(d.child) ? 'kafka' : /valkey|redis/.test(d.child) ? 'redis' : 'grpc',
        calls_per_min: round(d.callCount / this.lookbackMin),
        error_rate: null,
        last_seen: now,
      }));
    return { edges, capturedAt: now, source: 'jaeger' };
  }
}

// Seeded: offline snapshot for demos without a running stack.
export class SnapshotSource {
  name = 'seeded';
  constructor({ dataDir }) {
    this.file = path.join(dataDir, 'graph-snapshot.json');
  }

  async fetch() {
    const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return { edges: raw.edges.map((e) => ({ ...e, last_seen: e.last_seen || raw.captured_at })), capturedAt: raw.captured_at, source: 'seeded' };
  }
}

export function loadExperiments(dataDir) {
  const dir = path.join(dataDir, 'experiments');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
