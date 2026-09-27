import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { parseUnifiedDiff, fromGitHubFiles } from '../src/core/diff.js';
import { analyzeChange, diffProto } from '../src/core/changeRisk.js';
import { loadCatalog } from '../src/adapters/catalog.js';
import { DependencyGraph } from '../src/core/graph.js';
import { SnapshotSource, loadExperiments } from '../src/adapters/graphSources.js';
import { createRipple } from '../src/app.js';
import { loadFixturePr, prFromPatch } from '../src/adapters/fixtures.js';

const dataDir = path.join(ROOT, 'data');
const catalog = loadCatalog(dataDir);

async function seededGraph() {
  const snap = await new SnapshotSource({ dataDir }).fetch();
  return new DependencyGraph({ edges: snap.edges, catalog, experiments: loadExperiments(dataDir), source: 'seeded', capturedAt: snap.capturedAt });
}

test('parses unified diffs with hunk headers', () => {
  const pr = loadFixturePr(path.join(ROOT, 'fixtures', 'prs'), 'pr3');
  assert.deepEqual(pr.files.map((f) => f.path), ['pb/demo.proto', 'src/payment/charge.js']);
  assert.equal(pr.files[1].hunks[0].header, 'module.exports.charge = async request => {');
  assert.equal(pr.files[0].additions, 4);
  assert.equal(pr.files[0].deletions, 1);
});

test('GitHub files payload normalizes to the same shape', () => {
  const [f] = fromGitHubFiles([{ filename: 'a.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,2 +1,2 @@ fn x() {\n ctx\n-old\n+new' }]);
  assert.equal(f.hunks[0].header, 'fn x() {');
  assert.deepEqual(f.hunks[0].lines.map((l) => l.type), [' ', '-', '+']);
});

test('proto diff detects removed, renamed, renumbered and added fields', () => {
  const file = (lines) => ({ path: 'x.proto', hunks: [{ header: '', lines }] });
  const L = (type, text) => ({ type, text });
  const removed = diffProto(file([L(' ', 'message A {'), L('-', '  string id = 1;'), L('+', '  string other = 2;')]));
  assert.deepEqual(removed.map((c) => [c.kind, c.field, c.breaking]), [['removed', 'id', true], ['added', 'other', false]]);
  const renamed = diffProto(file([L(' ', 'message A {'), L('-', '  string id = 1;'), L('+', '  string ident = 1;')]));
  assert.equal(renamed[0].kind, 'renamed');
  const renumbered = diffProto(file([L(' ', 'message A {'), L('-', '  string id = 1;'), L('+', '  string id = 4;')]));
  assert.equal(renumbered[0].kind, 'renumbered');
  const reserved = diffProto(file([L(' ', 'message A {'), L('+', '  reserved 1;')]));
  assert.equal(reserved.length, 0);
});

test('shared proto changes are attributed to the owning service', () => {
  const pr = loadFixturePr(path.join(ROOT, 'fixtures', 'prs'), 'pr3');
  const c = analyzeChange({ files: pr.files, catalog });
  assert.deepEqual(c.serviceNames, ['payment']);
  assert.equal(c.breakingChanges[0].detail, 'Removes `ChargeResponse.transaction_id` (field 1)');
  assert.equal(c.contractChanges.filter((x) => !x.breaking).length, 2);
});

test('copy-only changes are recognised', () => {
  const pr = loadFixturePr(path.join(ROOT, 'fixtures', 'prs'), 'pr1');
  const c = analyzeChange({ files: pr.files, catalog });
  assert.equal(c.copyOnly, true);
  assert.equal(c.apiSurface.length, 0);
});

test('edges: protocol default, experiment promotion, owner override', async () => {
  const g = await seededGraph();
  assert.equal(g.edge('checkout', 'payment').kind_source, 'experiment');
  assert.equal(g.edge('checkout', 'payment').kind, 'hard');
  assert.equal(g.edge('frontend', 'ad').kind, 'soft');
  assert.equal(g.edge('checkout', 'kafka').kind, 'soft');
  assert.equal(g.edge('cart', 'valkey-cart').kind, 'hard'); // cache starts soft, owner says hard
  assert.equal(g.edge('cart', 'valkey-cart').kind_source, 'owner');
  assert.equal(g.edge('accounting', 'postgresql').origin, 'manual');
});

test('blast radius walks N hops, excludes synthetic callers, marks hard chains', async () => {
  const g = await seededGraph();
  const up = g.upstream('payment', 3);
  assert.deepEqual(up.map((r) => r.service), ['checkout', 'frontend', 'frontend-proxy']);
  assert.ok(up.every((r) => r.allHard));
  assert.ok(!up.some((r) => r.service === 'load-generator'));
  assert.equal(g.upstream('payment', 1).length, 1);
  const rec = g.upstream('recommendation', 3);
  assert.ok(rec.every((r) => !r.allHard && r.impact === 'degrades'));
});

test('the three demo PRs get LOW, MEDIUM and HIGH', async () => {
  const { orchestrator, graphService } = await createRipple({ graph: { source: 'seeded', refreshSec: 0 }, llm: { provider: 'none' } });
  const dir = path.join(ROOT, 'fixtures', 'prs');
  const [a1, a2, a3] = await Promise.all(['pr1', 'pr2', 'pr3'].map((id) => orchestrator.analyze(loadFixturePr(dir, id))));

  assert.equal(a1.level, 'low');
  assert.ok(a1.trace.agents.every((t) => t.status === 'skipped'), 'low risk skips all agents');
  assert.match(a1.comment, /LOW risk/);

  assert.equal(a2.level, 'medium');
  assert.equal(a2.intent.status, 'match');
  assert.ok(a2.blast.every((b) => !b.allHard));
  assert.equal(a2.incidents[0].incident.id, 'INC-1877');

  assert.equal(a3.level, 'high');
  assert.equal(a3.intent.status, 'mismatch');
  assert.equal(a3.incidents[0].incident.id, 'INC-2031');
  assert.equal(a3.blast[0].service, 'checkout');
  assert.ok(a3.agents['reviewer-router'].reviewers.some((r) => r.login === 'devi-checkout'));
  assert.ok(!a3.agents['reviewer-router'].reviewers.some((r) => r.login === 'priya-payments'), 'author is never a suggested reviewer');
  assert.match(a3.comment, /checkout.*⇒.*payment/);
  await graphService.stop();
});

test('high risk is capped at medium without a way to break something', async () => {
  const { orchestrator, graphService } = await createRipple({ graph: { source: 'seeded', refreshSec: 0 }, llm: { provider: 'none' } });
  // Big non-interface change to a tier-1 service with no ticket: lots of points, nothing that breaks callers.
  const lines = Array.from({ length: 1200 }, (_, i) => `+const x${i} = ${i};`).join('\n');
  const patch = `diff --git a/src/payment/util.js b/src/payment/util.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/payment/util.js\n@@ -0,0 +1,1200 @@\n${lines}\n`;
  const a = await orchestrator.analyze(prFromPatch({ patch, title: 'refactor', ci: { state: 'failure' } }));
  assert.ok(a.gate.score >= 7, `score ${a.gate.score}`);
  assert.equal(a.level, 'medium');
  assert.equal(a.gate.capped, true);
  await graphService.stop();
});

test('docs-only PRs are low', async () => {
  const { orchestrator, graphService } = await createRipple({ graph: { source: 'seeded', refreshSec: 0 }, llm: { provider: 'none' } });
  const patch = 'diff --git a/src/payment/README.md b/src/payment/README.md\n--- a/src/payment/README.md\n+++ b/src/payment/README.md\n@@ -1 +1 @@\n-old\n+new\n';
  const a = await orchestrator.analyze(prFromPatch({ patch, title: 'PAY-142 docs' }));
  assert.equal(a.level, 'low');
  await graphService.stop();
});

test('with an LLM, intent verifier and narrator add model output; failures fall back', async () => {
  const { orchestrator, graphService } = await createRipple({ graph: { source: 'seeded', refreshSec: 0 }, llm: { provider: 'none' } });
  const pr = loadFixturePr(path.join(ROOT, 'fixtures', 'prs'), 'pr3');
  orchestrator.llm = {
    name: 'fake',
    enabled: true,
    json: async (system) => (system.includes('Jira') ? { status: 'mismatch', summary: 'Ticket asks for an additive field; PR also removes transaction_id.' } : { headline: 'Model headline.' }),
  };
  const a = await orchestrator.analyze(pr);
  assert.equal(a.headline, 'Model headline.');
  assert.match(a.comment, /_fake:_ Ticket asks for an additive field/);

  orchestrator.llm = { name: 'broken', enabled: true, json: async () => { throw new Error('quota'); } };
  const b = await orchestrator.analyze(pr);
  assert.match(b.headline, /^Removes `ChargeResponse.transaction_id`/);
  assert.equal(b.level, 'high');
  await graphService.stop();
});
