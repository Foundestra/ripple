import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../src/adapters/catalog.js';
import { DependencyGraph } from '../src/core/graph.js';
import { createRipple } from '../src/app.js';
import { loadFixturePr } from '../src/adapters/fixtures.js';

const now = Date.parse('2026-11-14T06:00:00Z');
const fresh = '2026-11-14T05:59:00Z';
const old = '2026-10-01T00:00:00Z';
function graph(options = {}) {
  const { catalog, ...rest } = options;
  return new DependencyGraph({
    catalog: new Catalog(catalog || { services: { caller: { tier: 1 }, target: { tier: 1 } } }),
    edges: [{ from: 'caller', to: 'target', protocol: 'grpc', last_seen: fresh }],
    source: 'prometheus', capturedAt: fresh, environment: 'production', now, ...rest,
  });
}
function experiment(options = {}) {
  return { flag: 'targetFailure', origin: 'recorded', environment: 'production', recorded_at: fresh,
    verdicts: [{ from: 'caller', to: 'target', result: 'hard', evidence: 'Caller fails with target' }], ...options };
}

test('runtime evidence does not turn protocol hypotheses into validated behavior', () => {
  const e = graph().edge('caller', 'target');
  assert.deepEqual(e.dependency_types, ['runtime']);
  assert.equal(e.kind, 'hard');
  assert.equal(e.failure_behavior, 'unknown');
  assert.equal(e.confidence, 'medium');
  assert.equal(e.evidence[0].status, 'observed');
});

test('fresh recorded same-environment experiment validates failure behavior', () => {
  const e = graph({ experiments: [experiment()] }).edge('caller', 'target');
  assert.equal(e.failure_behavior, 'hard');
  assert.equal(e.confidence, 'high');
  assert.equal(e.evidence[1].validates_failure_behavior, true);
});

for (const [name, options, graphOptions] of [
  ['sample', { origin: 'sample' }, {}],
  ['stale', { recorded_at: old }, {}],
  ['undated', { recorded_at: null }, {}],
  ['future', { recorded_at: '2027-01-01' }, {}],
  ['wrong environment', { environment: 'staging' }, {}],
  ['unknown environment', { environment: null }, {}],
  ['mock', {}, { mock: true }],
]) {
  test(`${name} experiment cannot validate production behavior`, () => {
    const e = graph({ ...graphOptions, experiments: [experiment(options)] }).edge('caller', 'target');
    assert.equal(e.failure_behavior, 'unknown');
    assert.notEqual(e.confidence, 'high');
  });
}

test('owner override is an assertion, not an experiment validation', () => {
  const e = graph({ catalog: { edge_overrides: [{ from: 'caller', to: 'target', kind: 'soft', reason: 'Owner says fallback exists' }] }, experiments: [experiment()] }).edge('caller', 'target');
  assert.equal(e.kind, 'soft');
  assert.equal(e.failure_behavior, 'unknown');
  assert.equal(e.evidence.at(-1).status, 'asserted');
});

test('static dependency types coexist and appear without observed traffic', () => {
  const g = graph({ edges: [], catalog: { manual_edges: [{ from: 'caller', to: 'target', dependency_types: ['shared_code', 'contract'], reason: 'Generated client imports shared library' }] } });
  const e = g.edge('caller', 'target');
  assert.deepEqual(e.dependency_types, ['shared_code', 'contract']);
  assert.equal(e.evidence[0].status, 'inferred');
  assert.equal(e.freshness, 'unknown');
  assert.equal(g.upstream('target')[0].evidence_complete, false);
  assert.equal(g.upstream('target')[0].potential_impact, 'unknown');
});

test('seeded and stale observations cannot claim fresh runtime confidence', () => {
  for (const opts of [{ source: 'seeded' }, { stale: true }, { capturedAt: old, edges: [{ from: 'caller', to: 'target', last_seen: old }] }]) {
    assert.equal(graph(opts).edge('caller', 'target').confidence, 'unknown');
  }
});

test('invalid dependency types fail explicitly', () => {
  assert.throws(() => graph({ edges: [{ from: 'a', to: 'b', dependency_types: ['typo'] }] }), /Invalid dependency_types/);
});

test('graph serialization and blast radius retain evidence and report partial coverage', () => {
  const g = graph();
  assert.equal(g.toJSON().schema_version, 1);
  assert.equal(g.toJSON().evidence_summary.coverage, 'partial');
  assert.equal(g.toJSON().evidence_summary.unknown_behavior_count, 1);
  assert.equal(g.upstream('target')[0].edges[0].evidence[0].source, 'prometheus');
});

test('dependency lookup failure is explicit, never a quiet approval', async () => {
  const app = await createRipple({ graph: { source: 'seeded', refreshSec: 0 }, llm: { provider: 'none' } });
  try {
    app.graphService.upstream = async () => { throw new Error('Graph unavailable'); };
    const a = await app.orchestrator.analyze(loadFixturePr(app.config.fixturesDir, 'pr1'));
    assert.equal(a.dependency_evidence.analysis_status, 'incomplete');
    assert.match(a.comment, /Incomplete analysis/);
    assert.doesNotMatch(a.headline, /Approve to proceed/);
    assert.match(a.dependency_evidence.lookup_error, /Graph unavailable/);
  } finally { await app.graphService.stop(); }
});

test('catalog types extend an observed edge instead of disappearing', () => {
  const g = graph({ catalog: { manual_edges: [{ from: 'caller', to: 'target', dependency_types: ['contract'], reason: 'Consumes API' }] } });
  assert.deepEqual(g.edge('caller', 'target').dependency_types, ['runtime', 'contract']);
});
