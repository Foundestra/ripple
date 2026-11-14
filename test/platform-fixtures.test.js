import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const demoDir = path.join(ROOT, 'data', 'platform', 'demo');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function readYaml(relativePath) {
  return YAML.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

function canonicalSourceHash(document) {
  const content = structuredClone(document);
  delete content.source_sha256;
  delete content.published_at;
  delete content.publication_timestamp;
  delete content.publication_timestamps;
  return crypto.createHash('sha256').update(JSON.stringify(sortKeys(content))).digest('hex');
}

const registry = readYaml('data/platform/demo/registry.yaml');
const graphSource = readJson('data/platform/demo/graph-source.json');
const policy = readYaml('policy/platform-shadow-v1.yaml');
const policyCases = readJson('data/platform/demo/policy-cases.json');
const lineage = readJson('data/platform/demo/fixture-lineage/pr3.json');
const catalog = readYaml('data/catalog.yaml');
const seededGraph = readJson('data/graph-snapshot.json');

test('platform fixture hashes use recursively key-sorted canonical content', () => {
  for (const [name, document] of Object.entries({ registry, graphSource, policy, policyCases, lineage })) {
    assert.match(document.source_sha256, /^[a-f0-9]{64}$/, `${name} has a full SHA-256`);
    assert.equal(document.source_sha256, canonicalSourceHash(document), `${name} canonical hash matches its content`);
  }

  const reordered = { z: 1, nested: { z: 2, a: 1 }, a: 2, source_sha256: 'ignored' };
  const equivalent = { a: 2, nested: { a: 1, z: 2 }, z: 1 };
  assert.equal(canonicalSourceHash(reordered), canonicalSourceHash(equivalent));

  const publicationOnlyChange = { ...registry, published_at: '2099-01-01T00:00:00Z' };
  assert.equal(canonicalSourceHash(publicationOnlyChange), registry.source_sha256);
});

test('DEMO registry explicitly maps every catalog service without promoting telemetry aliases', () => {
  assert.equal(registry.scope, 'demo');
  assert.equal(registry.authority, 'demo_only');
  assert.equal(registry.repositories.length, 1);
  assert.equal(registry.repositories[0].id, 'repository://demo/opentelemetry-demo');
  assert.equal(registry.repositories[0].fallback.behavior, 'unresolved');

  const catalogNames = Object.keys(catalog.services).sort();
  const registryNames = registry.services.map((service) => service.id.split('/').at(-1)).sort();
  assert.deepEqual(registryNames, catalogNames);

  for (const service of registry.services) {
    const name = service.id.split('/').at(-1);
    const source = catalog.services[name];
    assert.deepEqual(service.tier, { value: source.tier, source: 'demo_manifest', authority: 'demo_only' });
    assert.equal(service.owners[0].team, source.team);
    assert.deepEqual(service.contacts, source.owners);
    assert.ok(service.aliases.some((alias) => alias.type === 'catalog_name' && alias.value === name && alias.status === 'declared'));
    assert.ok(service.aliases.some((alias) => alias.type === 'seeded_graph_name' && alias.value === name && alias.status === 'declared'));
    assert.ok(service.aliases.some((alias) => alias.type === 'otel_service_name' && alias.value === name && alias.status === 'unresolved'));
  }

  assert.deepEqual(
    registry.unresolved_alias_types.map((alias) => alias.type).sort(),
    ['datadog_service', 'deployment_unit', 'kubernetes_workload', 'pagerduty_service'],
  );
});

test('components retain repository-aware paths and shared proto symbol ownership', () => {
  assert.deepEqual(registry.shared_contract_files, catalog.shared_contract_files);
  const sourceComponents = registry.components.filter((component) => component.classification === 'service_source');
  assert.equal(sourceComponents.length, Object.keys(catalog.services).length);

  for (const component of sourceComponents) {
    assert.equal(component.repository_id, 'repository://demo/opentelemetry-demo');
    assert.equal(component.service_ids.length, 1);
    const name = component.service_ids[0].split('/').at(-1);
    assert.deepEqual(component.path_rules.map((rule) => rule.prefix), catalog.services[name].paths);
    assert.deepEqual(component.contract_symbols, catalog.services[name].contracts || []);
  }

  const shared = registry.components.find((component) => component.classification === 'shared_contract');
  assert.deepEqual(shared.path_rules, [{ prefix: 'pb/demo.proto', precedence: 200, classification: 'shared' }]);
  const sourceMappings = Object.entries(catalog.services)
    .filter(([, service]) => service.contracts?.length)
    .map(([name, service]) => ({ service_id: `service://astronomy-shop/${name}`, symbols: service.contracts }))
    .sort((a, b) => a.service_id.localeCompare(b.service_id));
  const manifestMappings = shared.symbol_mappings
    .map(({ service_id, symbols }) => ({ service_id, symbols }))
    .sort((a, b) => a.service_id.localeCompare(b.service_id));
  assert.deepEqual(manifestMappings, sourceMappings);
  assert.ok(shared.symbol_mappings.find((mapping) => mapping.service_id.endsWith('/payment')).symbols.includes('ChargeResponse'));
});

test('graph source preserves every seeded edge and records canonical async direction', () => {
  const seeded = graphSource.edges.filter((edge) => edge.source_reference === 'data/graph-snapshot.json');
  assert.equal(seeded.length, seededGraph.edges.length);
  assert.deepEqual(
    seeded.map(({ from, to, protocol, calls_per_min, error_rate }) => ({ from, to, protocol, calls_per_min, error_rate })),
    seededGraph.edges,
  );

  const consumers = seeded.filter((edge) => edge.relationship_type === 'CONSUMES_FROM');
  assert.deepEqual(consumers.map((edge) => [edge.from, edge.to]).sort(), [['kafka', 'accounting'], ['kafka', 'fraud-detection']]);
  for (const edge of consumers) {
    assert.deepEqual(edge.canonical_direction, {
      from: edge.to,
      to: edge.from,
      transform: 'reverse_seed_channel_delivery_to_consumer',
    });
  }

  const manual = graphSource.edges.filter((edge) => edge.source_reference === 'data/catalog.yaml');
  assert.equal(manual.length, catalog.manual_edges.length);
  assert.deepEqual(manual.map(({ from, to, protocol }) => ({ from, to, protocol })), catalog.manual_edges.map(({ from, to, protocol }) => ({ from, to, protocol })));
  assert.ok(graphSource.edges.every((edge) => edge.behavior.classification === 'unknown'));
  assert.ok(graphSource.edges.every((edge) => edge.evidence_refs.length > 0 && edge.behavior.evidence_refs.length > 0));
  assert.equal(graphSource.coverage.validation_status, 'validated_partial');
  assert.equal(graphSource.coverage.production_complete, false);
});

test('policy cases cover precedence and never allow incomplete evidence to become LOW', () => {
  assert.deepEqual(policy.deterministic_precedence, ['HIGH', 'MEDIUM', 'UNKNOWN', 'LOW']);
  assert.equal(policyCases.policy.source_sha256, policy.source_sha256);

  const classifications = new Set(policyCases.cases.map((fixture) => fixture.expected.risk_classification));
  assert.deepEqual(classifications, new Set(['HIGH', 'MEDIUM', 'UNKNOWN', 'LOW']));

  const knownControls = new Set(policy.known_controls.map((control) => control.id));
  for (const fixture of policyCases.cases) {
    for (const control of fixture.input.controls) {
      assert.ok(knownControls.has(control.id), `${fixture.id} uses known control ${control.id}`);
    }
  }

  const conservativeCases = ['missing-required-control', 'stale-required-evidence', 'truncated-traversal', 'unknown-tier', 'insufficient-commit-binding'];
  for (const id of conservativeCases) {
    const fixture = policyCases.cases.find((candidate) => candidate.id === id);
    assert.ok(fixture, `case ${id} exists`);
    assert.notEqual(fixture.expected.risk_classification, 'LOW');
    assert.equal(fixture.expected.outcome, 'would_lock');
    assert.equal(fixture.expected.eligibility, 'ineligible');
  }

  const low = policyCases.cases.find((fixture) => fixture.expected.risk_classification === 'LOW');
  assert.equal(low.input.analysis_status, 'complete');
  assert.equal(low.input.traversal.truncated, false);
  assert.ok(low.input.controls.every((control) => control.status === 'passed' && control.authority));
});

test('PAY-142 lineage remains source-derived and explicitly unknown where evidence is absent', () => {
  const ticket = readJson('data/jira/tickets.json').tickets.find((item) => item.key === 'PAY-142');
  const incident = readJson('data/incidents/incidents.json').incidents.find((item) => item.id === 'INC-2031');
  const meta = readJson('fixtures/prs/pr3-payment-contract/meta.json');
  const patch = fs.readFileSync(path.join(ROOT, 'fixtures', 'prs', 'pr3-payment-contract', 'diff.patch'), 'utf8');

  assert.equal(lineage.steps.jira_work_item.summary, ticket.summary);
  assert.deepEqual(lineage.steps.jira_work_item.acceptance, ticket.acceptance);
  assert.equal(lineage.steps.jira_work_item.live_jira_called, false);
  assert.deepEqual(lineage.steps.agent_session, {
    status: 'unknown',
    id: null,
    reason: 'No agent event or session identity exists in the fixture.',
  });
  assert.equal(lineage.steps.change_identity.commit_sha, meta.platform.commit_sha);
  assert.equal(lineage.steps.change_identity.live_github_verified, false);
  assert.match(patch, /reserved "transaction_id"/);
  assert.match(patch, /string currency_code = 3/);
  assert.equal(lineage.steps.incident_similarity.incident_id, incident.id);
  assert.equal(lineage.steps.incident_similarity.status, 'declared_demo');
  assert.equal(lineage.steps.upstream[0].behavior, 'unknown');
  assert.equal(lineage.steps.downstream.known_absence, false);
  assert.equal(lineage.steps.ci_observation.authority_for_required_contract_control, false);
  assert.deepEqual(lineage.steps.expected_policy_result, {
    analysis_status: 'partial',
    risk_classification: 'HIGH',
    reason_codes: ['DIRECT_TIER_1', 'MANDATORY_CONTRACT_CHANGE'],
    outcome: 'would_lock',
    eligibility: 'ineligible',
    authorization: { status: 'not_evaluated', authorization_id: null },
    missing_controls: ['payment-checkout-contract', 'human-review'],
    human_action: 'Payments and checkout owners review the breaking contract change and missing contract test; no deploy authorization was issued.',
  });
  assert.equal(lineage.steps.deployment_verification.status, 'not_applicable_not_deployed');
});

test('legacy PR metadata gains fixed synthetic identities without changing demo fields', () => {
  const expected = {
    pr1: { file: 'pr1-ad-copy', number: 101, level: 'low', sha: '01f4001b500fdfb117ff480ed32bb92c61c2b130' },
    pr2: { file: 'pr2-recommendation-response', number: 102, level: 'medium', sha: 'cc3db747a289104c3c82ef837c36093e8f731051' },
    pr3: { file: 'pr3-payment-contract', number: 103, level: 'high', sha: 'd5ef0f8f7b2773fd894951d06de077415648f97b' },
  };

  for (const [id, fixture] of Object.entries(expected)) {
    const meta = readJson(`fixtures/prs/${fixture.file}/meta.json`);
    assert.equal(meta.id, id);
    assert.equal(meta.number, fixture.number);
    assert.equal(meta.demo.expected, fixture.level);
    assert.deepEqual(meta.platform, {
      repository_id: 'repository://demo/opentelemetry-demo',
      commit_sha: fixture.sha,
      commit_identity: 'synthetic_demo_identity',
      live_github_verified: false,
    });
    assert.match(meta.platform.commit_sha, /^[a-f0-9]{40}$/);
  }
});
