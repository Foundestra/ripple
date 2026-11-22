import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, buildChangedSymbols, languageOf } from '../src/adapters/static/changedSymbols.js';
import { resolveTarget, buildProtoIndex, importsOfProto } from '../src/adapters/static/protoResolver.js';
import { analyzeStatic, mergeGraphs, importsOf, createMemoryCache, StaticImportsSource, loadTreeSitterParse } from '../src/adapters/static/staticImports.js';
import { staticSymbolFactor, STATIC_FACTOR_MAX } from '../src/core/changeRisk.js';
import { Catalog } from '../src/adapters/catalog.js';

const catalog = new Catalog({
  services: {
    checkout: { tier: 1, paths: ['src/checkout/'] },
    payment: { tier: 1, paths: ['src/payment/'] },
    frontend: { tier: 1, paths: ['src/frontend/'] },
    ad: { tier: 3, paths: ['src/ad/'] },
    recommendation: { tier: 2, paths: ['src/recommendation/'] },
  },
});

// Fake parser: one import node per `import ...` line; BROKEN marks a parse failure.
const fakeParse = (text) => ({
  type: 'program',
  hasError: text.includes('BROKEN'),
  startLine: 1,
  endLine: 99,
  children: text.split('\n').filter((l) => l.startsWith('import ')).map((l, i) => ({ type: 'import_declaration', text: l, startLine: i + 1, endLine: i + 1, children: [] })),
});

test('languageOf maps java and python, nothing else', () => {
  assert.equal(languageOf('a/B.java'), 'java');
  assert.equal(languageOf('a/b.py'), 'python');
  assert.equal(languageOf('a/b.go'), null);
});

test('parseDiff tracks new-side line numbers for added and removed lines', () => {
  const diff = [
    'diff --git a/src/payment/Charge.java b/src/payment/Charge.java',
    '--- a/src/payment/Charge.java',
    '+++ b/src/payment/Charge.java',
    '@@ -4,2 +4,3 @@',
    ' ctx',
    '+added',
    ' ctx',
    '@@ -20,1 +21,0 @@',
    '-gone',
  ].join('\n');
  const [f] = parseDiff(diff);
  assert.equal(f.path, 'src/payment/Charge.java');
  assert.deepEqual([...f.changedLines], [5]);
  assert.deepEqual([...f.removedAt], [21]);
});

test('buildChangedSymbols matches hunk lines to definition spans and counts parse failures', () => {
  const tree = {
    type: 'program', hasError: false, startLine: 1, endLine: 20, children: [
      { type: 'class_declaration', name: 'Charge', startLine: 1, endLine: 10, children: [
        { type: 'method_declaration', name: 'charge', startLine: 3, endLine: 6, children: [] },
      ] },
      { type: 'method_declaration', name: 'other', startLine: 12, endLine: 15, children: [] },
    ],
  };
  const diff = 'diff --git a/src/payment/Charge.java b/src/payment/Charge.java\n+++ b/src/payment/Charge.java\n@@ -4,2 +4,3 @@\n ctx\n+added\n ctx\n';
  const diffFiles = parseDiff(diff);
  const out = buildChangedSymbols({ diffFiles, sourceFor: () => 'x', parse: () => tree });
  assert.deepEqual(out.symbols.map((s) => s.name).sort(), ['Charge', 'charge']);
  assert.equal(out.failures.length, 0);

  const noParser = buildChangedSymbols({ diffFiles, sourceFor: () => 'x', parse: null });
  assert.equal(noParser.failures[0].reason, 'parser unavailable');
  assert.equal(noParser.symbols.length, 0);
});

test('java and python import specs are extracted from normalized trees', () => {
  const java = { type: 'program', children: [{ type: 'import_declaration', text: 'import static com.acme.pay.Charge.run;', children: [] }] };
  assert.deepEqual(importsOf(java, 'java'), ['com.acme.pay.Charge.run']);
  const py = { type: 'module', children: [
    { type: 'import_statement', text: 'import pkg.mod as m, other', children: [] },
    { type: 'import_from_statement', text: 'from pkg.sub import x', children: [] },
  ] };
  assert.deepEqual(importsOf(py, 'python'), ['pkg.mod', 'other', 'pkg.sub']);
});

test('resolvers map java, python and proto specs to repo paths and keep the rest unresolved', () => {
  const repoPaths = new Set(['src/main/java/com/acme/pay/Charge.java', 'pkg/mod.py', 'pb/demo.proto']);
  assert.equal(resolveTarget('com.acme.pay.Charge', { language: 'java', repoPaths }).path, 'src/main/java/com/acme/pay/Charge.java');
  assert.equal(resolveTarget('com.acme.pay.Charge.run', { language: 'java', repoPaths }).path, 'src/main/java/com/acme/pay/Charge.java');
  assert.equal(resolveTarget('com.acme.pay.*', { language: 'java', repoPaths }).resolved, false);
  assert.equal(resolveTarget('pkg.mod', { language: 'python', repoPaths }).path, 'pkg/mod.py');
  const rel = resolveTarget('.sibling', { language: 'python', repoPaths });
  assert.equal(rel.resolved, false);
  assert.equal(rel.conservative, true);
  assert.equal(resolveTarget('pb/demo.proto', { language: 'proto', repoPaths }).path, 'pb/demo.proto');
});

test('proto index resolves message and service symbols, and ambiguity stays unresolved', () => {
  const protoFiles = [
    { path: 'pb/demo.proto', text: 'package oteldemo;\nmessage ChargeRequest {}\nservice PaymentService {}\n' },
    { path: 'pb/other.proto', text: 'message ChargeRequest {}\n' },
  ];
  assert.deepEqual(importsOfProto('import "pb/demo.proto";\nimport public "x/y.proto";'), ['pb/demo.proto', 'x/y.proto']);
  const index = buildProtoIndex(protoFiles);
  assert.equal(resolveTarget('PaymentService', { language: 'proto', repoPaths: new Set(), protoIndex: index }).path, 'pb/demo.proto');
  assert.equal(resolveTarget('oteldemo.ChargeRequest', { language: 'proto', repoPaths: new Set(), protoIndex: index }).path, 'pb/demo.proto');
  assert.equal(resolveTarget('ChargeRequest', { language: 'proto', repoPaths: new Set(), protoIndex: index }).resolved, false);
});

test('analyzeStatic builds collapsed service edges and reports unresolved imports', () => {
  const files = [
    { path: 'src/checkout/Order.java', text: 'import com.acme.pay.Charge;\nimport com.acme.pay.Charge;\nimport java.util.List;' },
    { path: 'src/payment/Charge.java', text: 'class Charge {}' },
  ];
  const repoPaths = files.map((f) => f.path);
  assert.ok(repoPaths.includes('src/payment/Charge.java'));
  const out = analyzeStatic({ files, catalog, parse: fakeParse });
  assert.equal(out.edges.length, 0, 'fixture import paths do not match repo paths, so no edge');
  assert.equal(out.unresolved.length, 3);
  assert.ok(out.unresolved.every((u) => u.conservative));
});

test('analyzeStatic maps resolved imports to a single collapsed edge with provenance', () => {
  const files = [
    { path: 'src/checkout/Order.java', text: 'import com.acme.pay.Charge;\nimport com.acme.pay.Charge;' },
    { path: 'src/payment/com/acme/pay/Charge.java', text: 'class Charge {}' },
  ];
  const out = analyzeStatic({ files, catalog, parse: fakeParse });
  assert.equal(out.edges.length, 1);
  assert.deepEqual([out.edges[0].from, out.edges[0].to, out.edges[0].protocol, out.edges[0].origin], ['checkout', 'payment', 'static', 'static']);
  assert.deepEqual(out.edges[0].dependency_types, ['shared_code']);
  assert.equal(out.edges[0].evidence.length, 2);
});

test('parse failures above 10 percent trip the circuit breaker, at or below do not', () => {
  const ok = (i) => ({ path: `src/frontend/F${i}.java`, text: 'import x.Y;' });
  const ten = Array.from({ length: 10 }, (_, i) => ok(i));
  const one = analyzeStatic({ files: [...ten, { path: 'src/frontend/Bad.java', text: 'BROKEN' }], catalog, parse: fakeParse });
  assert.equal(one.failed, 1);
  assert.equal(one.incomplete, false, '1 of 11 is 9.1 percent');
  const two = analyzeStatic({ files: [...ten, { path: 'src/frontend/Bad.java', text: 'BROKEN' }, { path: 'src/frontend/Bad2.java', text: 'BROKEN' }], catalog, parse: fakeParse });
  assert.equal(two.incomplete, true, '2 of 12 is 16.7 percent');
  const noParser = analyzeStatic({ files: [{ path: 'src/frontend/A.java', text: 'import x.Y;' }], catalog, parse: null });
  assert.equal(noParser.incomplete, true);
});

test('per-file incremental cache returns hits on the second run', () => {
  const files = [{ path: 'src/checkout/Order.java', text: 'import com.acme.pay.Charge;' }];
  const cache = createMemoryCache();
  const first = analyzeStatic({ files, catalog, parse: fakeParse, cache });
  const second = analyzeStatic({ files, catalog, parse: fakeParse, cache });
  assert.equal(first.cache_hits, 0);
  assert.equal(second.cache_hits, 1);
});

test('StaticImportsSource caches complete results per SHA and never caches incomplete ones', async () => {
  const files = [{ path: 'src/checkout/Order.java', text: 'import com.acme.pay.Charge;' }];
  const fullCache = createMemoryCache();
  const src = new StaticImportsSource({ files, catalog, parse: fakeParse, fullCache, sha: 'abc123', now: () => '2026-11-22T00:00:00.000Z' });
  const a = await src.fetch();
  const b = await src.fetch();
  assert.equal(a.cache, 'miss');
  assert.equal(b.cache, 'full');
  assert.equal(a.source, 'static');
  const bad = new StaticImportsSource({ files: [{ path: 'src/checkout/X.java', text: 'BROKEN' }], catalog, parse: fakeParse, fullCache, sha: 'def456' });
  await bad.fetch();
  assert.equal(fullCache.get('full:def456'), undefined);
});

test('mergeGraphs keeps runtime edges authoritative and only adds gaps', () => {
  const runtime = [{ from: 'checkout', to: 'payment', kind: 'hard' }];
  const statics = [{ from: 'checkout', to: 'payment' }, { from: 'frontend', to: 'checkout' }];
  const out = mergeGraphs(runtime, statics);
  assert.equal(out.added, 1);
  assert.equal(out.deduped, 1);
  assert.equal(out.edges[0].kind, 'hard');
  assert.equal(out.edges.length, 2);
});

const serviceOf = (p) => catalog.serviceForPath(p);

test('staticSymbolFactor: +1 for one importer, +2 cap for three, nothing for runtime hard duplicates', () => {
  const symbols = [{ path: 'src/payment/Charge.java', name: 'Charge' }];
  const one = staticSymbolFactor({ symbols, staticEdges: [{ from: 'checkout', to: 'payment' }], serviceOf });
  assert.equal(one.points, 1);
  const three = staticSymbolFactor({
    symbols,
    staticEdges: [{ from: 'checkout', to: 'payment' }, { from: 'frontend', to: 'payment' }, { from: 'ad', to: 'payment' }],
    serviceOf,
  });
  assert.equal(three.points, STATIC_FACTOR_MAX);
  const deduped = staticSymbolFactor({
    symbols,
    staticEdges: [{ from: 'checkout', to: 'payment' }],
    runtimeEdges: [{ from: 'checkout', to: 'payment', kind: 'hard' }],
    serviceOf,
  });
  assert.equal(deduped.points, 0);
});

test('staticSymbolFactor adds nothing when analysis is incomplete', () => {
  const out = staticSymbolFactor({
    symbols: [{ path: 'src/payment/Charge.java' }],
    staticEdges: [{ from: 'checkout', to: 'payment' }],
    incomplete: true,
    serviceOf,
  });
  assert.equal(out.points, 0);
  assert.equal(out.incomplete, true);
});

test('tree-sitter java parser extracts imports when bindings are installed', { skip: (await loadTreeSitterParse()) ? false : 'tree-sitter bindings not installed' }, async () => {
  const parse = await loadTreeSitterParse();
  const root = parse('package a;\nimport com.acme.pay.Charge;\nclass X {}\n', 'java');
  assert.equal(root.hasError, false);
  assert.deepEqual(importsOf(root, 'java'), ['com.acme.pay.Charge']);
});
