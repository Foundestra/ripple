import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrometheusServiceGraphSource, JaegerDependencySource, SnapshotSource, loadExperiments } from '../src/adapters/graphSources.js';
import { startOtelMock, OtelSimulation, evalPromQL } from '../src/mock/otelMock.js';
import { DependencyGraph } from '../src/core/graph.js';
import { loadCatalog } from '../src/adapters/catalog.js';
import { runExperiment } from '../src/experiments/runner.js';
import { ROOT } from '../src/config.js';

const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, () => r({ s, url: `http://localhost:${s.address().port}` })); });
const vector = (res, rows) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: rows } })); };

test('Prometheus servicegraph source builds edges with protocol, rate and error rate', async () => {
  const { s, url } = await listen((req, res) => {
    const q = new URL(req.url, 'http://x').searchParams.get('query') || '';
    if (!q) return vector(res, []); // buildinfo etc.
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

test('experiment runner discovers hard and soft edges against the OTel mock, and restores the flag', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-exp-'));
  const flagd = path.join(tmp, 'flagd.json');
  fs.copyFileSync(path.join(ROOT, 'data', 'mock', 'demo.flagd.json'), flagd);
  const original = fs.readFileSync(flagd, 'utf8');
  const mock = await startOtelMock({ port: 0, flagdFile: flagd });
  try {
    const url = `http://localhost:${mock.port}`;
    const live = await new PrometheusServiceGraphSource({ prometheusUrl: url, requestMetric: 'traces_service_graph_request_total', failedMetric: 'traces_service_graph_request_failed_total', lookbackMin: 60 }).fetch();
    assert.equal(live.mock, true, 'mock identifies itself');
    const graph = new DependencyGraph({ edges: live.edges, catalog: loadCatalog(path.join(ROOT, 'data')), mock: true });
    const config = { dataDir: tmp, graph: { prometheusUrl: url, requestMetric: 'traces_service_graph_request_total', failedMetric: 'traces_service_graph_request_failed_total' } };
    const run = (flag, target, variant) => runExperiment({ config, graph, flag, target, variant, flagdFile: flagd, baselineSec: 0.2, durationSec: 0.3, recoverySec: 0.05, stepSec: 0.05, log: () => {} });

    const pay = await run('paymentFailure', 'payment', '100%');
    const v = Object.fromEntries(pay.verdicts.map((x) => [`${x.from}->${x.to}`, x]));
    assert.equal(v['checkout->payment'].result, 'hard');
    assert.equal(v['frontend->checkout'].result, 'hard', 'frontend serves far more than checkout traffic, but propagation still shows the hard edge');
    assert.ok(v['frontend->checkout'].during_error < 0.1, 'frontend overall error rate barely moves');
    assert.equal(pay.environment, 'mock');
    assert.equal(fs.readFileSync(flagd, 'utf8'), original, 'flag restored');

    const ad = await run('adFailure', 'ad', 'on');
    assert.equal(ad.verdicts.find((x) => x.from === 'frontend').result, 'soft');
    assert.ok(fs.existsSync(path.join(tmp, 'runtime', 'experiments', 'adFailure.json')));
    const loaded = loadExperiments(tmp);
    assert.deepEqual(loaded.map((x) => x.flag).sort(), ['adFailure', 'paymentFailure']);
  } finally {
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('OTel mock speaks the PromQL subset Ripple uses, and the Jaeger API', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-mock-'));
  const flagd = path.join(tmp, 'flagd.json');
  fs.copyFileSync(path.join(ROOT, 'data', 'mock', 'demo.flagd.json'), flagd);
  const sim = new OtelSimulation({ flagdFile: flagd, noise: false });
  const one = (q) => Number(evalPromQL(q, sim.state())[0].value[1]);
  const ratio = (s) => one(`sum(rate(traces_span_metrics_calls_total{service_name="${s}",status_code="STATUS_CODE_ERROR"}[30s])) / sum(rate(traces_span_metrics_calls_total{service_name="${s}"}[30s]))`);
  assert.ok(ratio('payment') < 0.01);
  const doc = JSON.parse(fs.readFileSync(flagd, 'utf8'));
  doc.flags.paymentFailure.defaultVariant = '50%';
  fs.writeFileSync(flagd, JSON.stringify(doc));
  assert.ok(Math.abs(ratio('payment') - 0.5) < 0.01);
  assert.ok(ratio('checkout') > 0.45);
  const grouped = evalPromQL('sum by (client, server, connection_type) (rate(traces_service_graph_request_total[60m])) * 60', sim.state());
  assert.equal(grouped.find((r) => r.metric.client === 'checkout' && r.metric.server === 'kafka').metric.connection_type, 'messaging_system');
  assert.throws(() => evalPromQL('histogram_quantile(0.9, foo)', sim.state()), /unsupported/);

  const mock = await startOtelMock({ port: 0, flagdFile: flagd });
  try {
    const j = await new JaegerDependencySource({ jaegerUrl: `http://localhost:${mock.port}/jaeger/ui`, lookbackMin: 60 }).fetch();
    assert.equal(j.mock, true);
    assert.ok(j.edges.some((e) => e.from === 'checkout' && e.to === 'payment'));
    const flip = await fetch(`http://localhost:${mock.port}/flags/adFailure?variant=on`, { method: 'POST' });
    assert.equal(flip.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(flagd, 'utf8')).flags.adFailure.defaultVariant, 'on');
  } finally {
    await mock.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
