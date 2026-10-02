#!/usr/bin/env node
// Ripple OTel mock: a simulated OpenTelemetry Demo (Astronomy Shop) for laptops
// without Docker. It serves the same HTTP APIs Ripple reads from a real stack:
//
//   Prometheus  /api/v1/query          servicegraph + spanmetrics series
//   Jaeger      /…/api/dependencies    caller -> callee call counts
//   flagd       a JSON flag file in the OpenTelemetry Demo's own format
//
// Traffic comes from data/graph-snapshot.json. Failures are injected by flags in
// the flag file (the experiment runner flips them exactly as it does on the real
// demo) and propagate upstream according to data/mock/scenario.json, which Ripple
// never reads: it has to discover hard vs soft edges by experiment.
//
// It identifies itself (Prometheus buildinfo / Jaeger body) so Ripple labels
// everything it produces as "mock", never "live".

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

export const MOCK_APP = 'ripple-otel-mock'; // also in src/adapters/graphSources.js
const REQ = 'traces_service_graph_request_total';
const FAILED = 'traces_service_graph_request_failed_total';
const SPAN = 'traces_span_metrics_calls_total';

export class OtelSimulation {
  constructor({ dataDir = path.join(ROOT, 'data'), flagdFile, noise = true } = {}) {
    const snap = JSON.parse(fs.readFileSync(path.join(dataDir, 'graph-snapshot.json'), 'utf8'));
    this.scenario = JSON.parse(fs.readFileSync(path.join(dataDir, 'mock', 'scenario.json'), 'utf8'));
    this.edges = snap.edges.map(({ from, to, protocol, calls_per_min }) => ({ from, to, protocol, cpm: calls_per_min }));
    this.flagdFile = flagdFile;
    this.noise = noise;
    this.services = [...new Set(this.edges.flatMap((e) => [e.from, e.to]))];
  }

  flags() {
    try {
      return JSON.parse(fs.readFileSync(this.flagdFile, 'utf8')).flags || {};
    } catch {
      return {};
    }
  }

  // Active fault per service from the flag file: fraction of its own requests that fail.
  faults() {
    const out = {};
    const flags = this.flags();
    for (const [name, rule] of Object.entries(this.scenario.flags)) {
      const f = flags[name];
      if (!f || f.state === 'DISABLED') continue;
      const v = f.variants?.[f.defaultVariant];
      let frac = 0;
      if (rule.effect === 'variant_fraction') frac = Number(v) || 0;
      else if (rule.effect === 'on_means') frac = v === true || Number(v) > 0 ? rule.value : 0;
      else if (rule.effect === 'variant_fraction_scaled') frac = Math.min(1, (Number(v) || 0) * rule.scale);
      if (frac > 0) out[rule.service] = Math.max(out[rule.service] || 0, frac);
    }
    return out;
  }

  propagation(e) {
    const k = `${e.from}->${e.to}`;
    if (k in this.scenario.propagation) return this.scenario.propagation[k];
    return e.protocol === 'kafka' ? this.scenario.default_async_propagation : this.scenario.default_sync_propagation;
  }

  // One consistent snapshot of the simulated system at time t (ms).
  state(t = Date.now()) {
    const jitter = (seed, amp) => (this.noise ? 1 + amp * Math.sin(t / 7000 + seed) * Math.cos(t / 13000 + seed * 1.7) : 1);
    const edges = this.edges.map((e, i) => ({ ...e, cpm: e.cpm * jitter(i, 0.06) }));
    const inbound = (s) => edges.filter((e) => e.to === s).reduce((a, e) => a + e.cpm, 0);
    const faults = this.faults();
    const base = (s, i) => this.scenario.base_error_rate * jitter(i * 3.1, 0.5);
    const err = new Map();
    const errOf = (s, seen = new Set()) => {
      if (err.has(s)) return err.get(s);
      if (seen.has(s)) return 0;
      seen.add(s);
      const own = Math.min(1, (faults[s] || 0) + base(s, this.services.indexOf(s)));
      const r = inbound(s) || 1;
      let ok = 1 - own;
      for (const e of edges.filter((x) => x.from === s)) {
        const share = Math.min(1, e.cpm / r); // fraction of s's requests that call e.to
        ok *= 1 - this.propagation(e) * errOf(e.to, seen) * share;
      }
      const v = Math.min(1, Math.max(0, 1 - ok));
      err.set(s, v);
      return v;
    };
    this.services.forEach((s) => errOf(s));

    const series = [];
    for (const e of edges) {
      const ct = e.protocol === 'kafka' ? 'messaging_system' : e.protocol === 'sql' ? 'database' : '';
      const labels = { client: e.from, server: e.to, connection_type: ct };
      // Async producers don't see consumer failures; sync callers see every callee failure.
      const failedFrac = e.protocol === 'kafka' ? 0 : err.get(e.to);
      series.push({ name: REQ, labels, rate: e.cpm / 60 });
      series.push({ name: FAILED, labels, rate: (e.cpm * failedFrac) / 60 });
    }
    for (const s of this.services) {
      const r = inbound(s);
      if (!r) continue;
      series.push({ name: SPAN, labels: { service_name: s, status_code: 'STATUS_CODE_OK', span_kind: 'SPAN_KIND_SERVER' }, rate: (r * (1 - err.get(s))) / 60 });
      series.push({ name: SPAN, labels: { service_name: s, status_code: 'STATUS_CODE_ERROR', span_kind: 'SPAN_KIND_SERVER' }, rate: (r * err.get(s)) / 60 });
    }
    series.push({ name: 'up', labels: { job: 'otel-mock' }, value: 1 });
    return { t, edges, err, faults, series };
  }
}

// ---- tiny PromQL subset: the expressions Ripple and its experiment runner send ----

const TERM = /^(?:(sum|max)(?:\s+by\s*\(([^)]*)\))?\s*\()?\s*(rate|timestamp)?\(?\s*(\w+)\s*(\{[^}]*\})?\s*(?:\[\w+\])?\s*\)?\s*\)?\s*(?:\*\s*([\d.]+))?$/;

function parseSelector(sel) {
  const m = {};
  for (const [, k, v] of (sel || '').matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) m[k] = v;
  return m;
}

export function evalPromQL(expr, st) {
  expr = expr.trim();
  const div = splitTopLevel(expr, '/');
  if (div) {
    const [a, b] = div.map((x) => evalPromQL(unwrap(x), st));
    const key = (r) => JSON.stringify(r.metric);
    const bBy = new Map(b.map((r) => [key(r), Number(r.value[1])]));
    return a
      .filter((r) => bBy.has(key(r)))
      .map((r) => {
        const d = bBy.get(key(r));
        return { metric: r.metric, value: [st.t / 1000, d === 0 ? 'NaN' : String(Number(r.value[1]) / d)] };
      });
  }
  if (expr === 'up') return [{ metric: { job: 'otel-mock' }, value: [st.t / 1000, '1'] }];
  const m = expr.match(TERM);
  if (!m) throw new Error(`otel-mock: unsupported query: ${expr}`);
  const [, agg, by, fn, metric, sel, mult] = m;
  const match = parseSelector(sel);
  const rows = st.series.filter((s) => s.name === metric && Object.entries(match).every(([k, v]) => s.labels[k] === v));
  const val = (s) => (fn === 'timestamp' ? st.t / 1000 : s.rate ?? s.value);
  const groups = new Map();
  const byLabels = by ? by.split(',').map((x) => x.trim()).filter(Boolean) : agg ? [] : null;
  for (const s of rows) {
    const metricLabels = byLabels === null ? s.labels : Object.fromEntries(byLabels.map((l) => [l, s.labels[l] ?? '']));
    const k = JSON.stringify(metricLabels);
    const cur = groups.get(k) || { metric: metricLabels, v: agg === 'max' ? -Infinity : 0 };
    cur.v = agg === 'max' ? Math.max(cur.v, val(s)) : cur.v + val(s);
    groups.set(k, cur);
  }
  if (!rows.length && agg && !by) return []; // like Prometheus: empty vector
  return [...groups.values()].map((g) => ({ metric: g.metric, value: [st.t / 1000, String(g.v * (mult ? Number(mult) : 1))] }));
}

function splitTopLevel(expr, op) {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === op && depth === 0) return [expr.slice(0, i), expr.slice(i + 1)];
  }
  return null;
}

const unwrap = (s) => {
  s = s.trim();
  while (s.startsWith('(') && s.endsWith(')') && splitTopLevel(s.slice(1, -1), '/') === null && balanced(s.slice(1, -1))) s = s.slice(1, -1).trim();
  return s;
};
const balanced = (s) => {
  let d = 0;
  for (const c of s) {
    if (c === '(') d++;
    if (c === ')' && --d < 0) return false;
  }
  return d === 0;
};

// ---- HTTP server ----

export async function startOtelMock({ port = Number(process.env.OTEL_MOCK_PORT || 9091), dataDir = path.join(ROOT, 'data'), flagdFile, log = console } = {}) {
  flagdFile = flagdFile || process.env.OTEL_MOCK_FLAGD_FILE || path.join(dataDir, 'runtime', 'flagd.json');
  if (!fs.existsSync(flagdFile)) {
    fs.mkdirSync(path.dirname(flagdFile), { recursive: true });
    fs.copyFileSync(path.join(dataDir, 'mock', 'demo.flagd.json'), flagdFile);
  }
  const sim = new OtelSimulation({ dataDir, flagdFile });

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/api/v1/query') {
        const q = url.searchParams.get('query') || '';
        return send(res, 200, { status: 'success', data: { resultType: 'vector', result: evalPromQL(q, sim.state()) } });
      }
      if (url.pathname === '/api/v1/status/buildinfo') {
        return send(res, 200, { status: 'success', data: { version: '0.0.0-mock', application: MOCK_APP } });
      }
      if (url.pathname.endsWith('/api/dependencies')) {
        const lookbackMin = Number(url.searchParams.get('lookback') || 3600000) / 60000;
        const st = sim.state();
        return send(res, 200, { mock: MOCK_APP, data: st.edges.map((e) => ({ parent: e.from, child: e.to, callCount: Math.round(e.cpm * lookbackMin) })) });
      }
      // Convenience control plane for live demos: GET /flags, POST /flags/<name>?variant=on
      if (url.pathname === '/flags' && req.method === 'GET') {
        const flags = sim.flags();
        return send(res, 200, Object.fromEntries(Object.entries(flags).map(([k, f]) => [k, { defaultVariant: f.defaultVariant, variants: Object.keys(f.variants) }])));
      }
      const fm = url.pathname.match(/^\/flags\/(\w+)$/);
      if (fm && req.method === 'POST') {
        const doc = JSON.parse(fs.readFileSync(flagdFile, 'utf8'));
        const f = doc.flags[fm[1]];
        if (!f) return send(res, 404, { error: `unknown flag ${fm[1]}` });
        const variant = url.searchParams.get('variant') || 'off';
        if (f.variants[variant] === undefined) return send(res, 400, { error: `variant must be one of ${Object.keys(f.variants).join(', ')}` });
        f.defaultVariant = variant;
        fs.writeFileSync(flagdFile, JSON.stringify(doc, null, 2) + '\n');
        return send(res, 200, { flag: fm[1], defaultVariant: variant });
      }
      if (url.pathname === '/' || url.pathname === '/healthz') {
        const st = sim.state();
        return send(res, 200, {
          app: MOCK_APP,
          flagdFile,
          activeFaults: st.faults,
          serviceErrorRates: Object.fromEntries([...st.err].map(([k, v]) => [k, Math.round(v * 10000) / 10000])),
        });
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 400, { status: 'error', errorType: 'bad_data', error: err.message });
    }
  });
  await new Promise((r) => server.listen(port, r));
  const actual = server.address().port;
  return { server, port: actual, flagdFile, sim, close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startOtelMock();
  console.log(`Ripple OTel mock on http://localhost:${m.port}`);
  console.log(`  Prometheus API: http://localhost:${m.port}   (PROMETHEUS_URL)`);
  console.log(`  Jaeger API:     http://localhost:${m.port}/jaeger/ui   (JAEGER_URL)`);
  console.log(`  flagd file:     ${path.relative(process.cwd(), m.flagdFile)}`);
  console.log(`  flip a flag:    curl -X POST "localhost:${m.port}/flags/paymentFailure?variant=100%25"`);
}
