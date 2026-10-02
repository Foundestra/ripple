#!/usr/bin/env node
// One-command full demo on a laptop, no Docker:
//   1. starts Ripple's OTel mock (simulated Astronomy Shop behind Prometheus + Jaeger APIs)
//   2. records the paymentFailure and adFailure experiments against it (flagd flag flips)
//      unless they were already recorded (pass --record to redo them)
//   3. starts Ripple pointed at the mock, refreshing the graph every 5 seconds
//
//   npm run demo:full                 # http://localhost:4000
//   npm run demo:full -- --record     # re-record experiments first
//   npm run demo:full -- --skip-experiments
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { startOtelMock } from '../src/mock/otelMock.js';

const args = new Set(process.argv.slice(2));
const mockPort = Number(process.env.OTEL_MOCK_PORT || 9091);

const mock = await startOtelMock({ port: mockPort });
console.log(`✔ OTel mock on http://localhost:${mock.port} (flag file: ${path.relative(ROOT, mock.flagdFile)})`);

// Overrides anything from .env: this script always runs against the mock.
// `auto` still falls back to the snapshot if the mock dies mid-demo.
Object.assign(process.env, {
  RIPPLE_GRAPH_SOURCE: 'auto',
  PROMETHEUS_URL: `http://localhost:${mock.port}`,
  JAEGER_URL: `http://localhost:${mock.port}/jaeger/ui`,
  RIPPLE_GRAPH_REFRESH_SEC: process.env.RIPPLE_FULL_DEMO_REFRESH_SEC || '5',
  OTEL_MOCK_FLAGD_FILE: mock.flagdFile,
});

const { createRipple } = await import('../src/app.js');
const { runExperiment } = await import('../src/experiments/runner.js');

const EXPERIMENTS = [
  { flag: 'paymentFailure', target: 'payment', variant: '100%' },
  { flag: 'adFailure', target: 'ad', variant: 'on' },
];
const runtimeDir = path.join(ROOT, 'data', 'runtime', 'experiments');
const missing = EXPERIMENTS.filter((e) => !fs.existsSync(path.join(runtimeDir, `${e.flag}.json`)));
const todo = args.has('--skip-experiments') ? [] : args.has('--record') ? EXPERIMENTS : missing;

if (todo.length) {
  const ripple = await createRipple({ graph: { refreshSec: 0 }, log: { error() {}, info() {} } });
  for (const e of todo) {
    console.log(`… recording ${e.flag} against the mock (≈40s)`);
    const out = await runExperiment({
      config: ripple.config,
      graph: ripple.graphService.graph,
      ...e,
      flagdFile: mock.flagdFile,
      baselineSec: 10,
      durationSec: 20,
      recoverySec: 10,
      stepSec: 2,
      log: () => {},
    });
    for (const v of out.verdicts) console.log(`  ${v.from} → ${v.to}: ${v.result.toUpperCase()} (${Math.round(v.propagation * 100)}% propagated)`);
  }
  await ripple.graphService.stop();
} else if (!args.has('--skip-experiments')) {
  console.log('✔ experiments already recorded (pass --record to redo them)');
}

const { startServer } = await import('../src/server.js');
const app = await startServer();
console.log(`✔ Ripple on http://localhost:${app.port}  (graph: ${app.ripple.graphService.graph.source}${app.ripple.graphService.graph.mock ? ', mock' : ''})`);
console.log('');
console.log('Try during the demo (in another terminal):');
console.log(`  curl -X POST "localhost:${mock.port}/flags/paymentFailure?variant=100%25"   # graph edges turn red within ~5s`);
console.log(`  curl -X POST "localhost:${mock.port}/flags/paymentFailure?variant=off"`);
