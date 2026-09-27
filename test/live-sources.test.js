import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrometheusServiceGraphSource, JaegerDependencySource, SnapshotSource } from '../src/adapters/graphSources.js';
import { DependencyGraph } from '../src/core/graph.js';
import { loadCatalog } from '../src/adapters/catalog.js';
import { runExperiment } from '../src/experiments/runner.js';
import { ROOT } from '../src/config.js';

const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, () => r({ s, url: `http://localhost:${s.address().port}` })); });
const vector = (res, rows) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: rows } })); };

test('Prometheus servicegraph source builds edges with protocol, rate and error rate', async () => {
  const { s, url } = await listen((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('query');
    if (q.includes('timestamp(')) return vector(res, [{ metric: { client: 'checkout', server: 'payment' }, value: [0, '1790000000'] }]);
    if (q.includes('failed_total')) return vector(res, [{ metric: { client: 'checkout', server: 'payment' }, value: [0, '3'] }]);
    vector(res, [
      { metric: { client: 'checkout', server: 'payment', connection_type: '' }, value: [0, '60'] },
      { metric: { client: 'checkout', server: 'accounting', connection_type: 'messaging_system' }, value: [0, '40'] },
    ]);
  });
  try {
    const src = new PrometheusServiceGraphSource({ prometheusUrl: url, requestMetric: 'traces_service_graph_request_total', failedMetric: 'traces_service_graph_request_failed_total', lookbackMin: 60 });
    const { edges } = await src.fetch();
    const pay = edges.find((e) => e.to === 'payment');
    assert.equal(pay.calls_per_min, 60);
    assert.equal(pay.error_rate, 0.05);
    assert.equal(pay.last_seen, new Date(1790000000 * 1000).toISOString());
    assert.equal(edges.find((e) => e.to === 'accounting').protocol, 'kafka');
  } finally {
    s.close();
  }
});

test('Jaeger dependencies source', async () => {
  const { s, url } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ parent: 'frontend', child: 'checkout', callCount: 600 }, { parent: 'checkout', child: 'accounting', callCount: 60 }] }));
  });
  try {
    const { edges } = await new JaegerDependencySource({ jaegerUrl: url, lookbackMin: 60 }).fetch();
    assert.equal(edges[0].calls_per_min, 10);
    const g = new DependencyGraph({ edges, catalog: loadCatalog(path.join(ROOT, 'data')) });
    assert.equal(g.edge('checkout', 'accounting').kind, 'soft', 'kafka consumers are async-inbound');
    assert.equal(g.edge('frontend', 'checkout').kind, 'hard');
  } finally {
    s.close();
  }
});

test('experiment runner flips flagd, measures, restores, and records verdicts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-exp-'));
  const flagd = path.join(tmp, 'demo.flagd.json');
  const original = JSON.stringify({ flags: { paymentFailure: { defaultVariant: 'off', variants: { off: 0, '100%': 1 } } } }, null, 2);
  fs.writeFileSync(flagd, original);
  fs.mkdirSync(path.join(tmp, 'data'));
  const on = () => JSON.parse(fs.readFileSync(flagd, 'utf8')).flags.paymentFailure.defaultVariant !== 'off';

  // Fake Prometheus: while the flag is on, payment and checkout error; frontend absorbs it.
  const { s, url } = await listen((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('query');
    if (q === 'up') return vector(res, [{ metric: {}, value: [0, '1'] }]);
    const failing = on() && (/"payment"/.test(q) || /service_name="checkout"/.test(q) || /client="checkout"/.test(q));
    vector(res, [{ metric: {}, value: [0, failing ? '0.9' : '0.001'] }]);
  });
  try {
    const snap = await new SnapshotSource({ dataDir: path.join(ROOT, 'data') }).fetch();
    const graph = new DependencyGraph({ edges: snap.edges, catalog: loadCatalog(path.join(ROOT, 'data')) });
    const config = { dataDir: path.join(tmp, 'data'), graph: { prometheusUrl: url, requestMetric: 'req_total', failedMetric: 'failed_total' } };
    const out = await runExperiment({ config, graph, flag: 'paymentFailure', target: 'payment', flagdFile: flagd, baselineSec: 0.2, durationSec: 0.4, recoverySec: 0.1, stepSec: 0.02, log: () => {} });
    assert.equal(fs.readFileSync(flagd, 'utf8'), original, 'flag restored');
    const v = Object.fromEntries(out.verdicts.map((x) => [`${x.from}->${x.to}`, x.result]));
    assert.equal(v['checkout->payment'], 'hard');
    assert.equal(v['frontend->checkout'], 'soft');
    assert.ok(fs.existsSync(path.join(tmp, 'data', 'experiments', 'paymentFailure.json')));
  } finally {
    s.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
