import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = path.join(ROOT, 'schemas/platform/v1');
const EXAMPLE_DIR = path.join(SCHEMA_DIR, 'examples');

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const schemas = Object.fromEntries(
  fs.readdirSync(SCHEMA_DIR)
    .filter(file => file.endsWith('.schema.json'))
    .map(file => [file.replace('.schema.json', ''), readJson(path.join(SCHEMA_DIR, file))])
);

const examples = Object.fromEntries(
  fs.readdirSync(EXAMPLE_DIR)
    .filter(file => file.endsWith('.json'))
    .map(file => [file.replace('.json', ''), readJson(path.join(EXAMPLE_DIR, file))])
);

const typeMatches = (value, expected) => {
  if (expected === 'null') return value === null;
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === expected;
};

const resolvePointer = (root, ref) => {
  assert.match(ref, /^#\//, `only local JSON pointers are supported: ${ref}`);
  return ref.slice(2).split('/').reduce((value, segment) => value[segment.replaceAll('~1', '/').replaceAll('~0', '~')], root);
};

/**
 * Minimal test-only validator for the deliberately restricted P0 schema subset.
 * It returns stable, readable paths and has no runtime dependency.
 */
export function validateSchema(schema, value, root = schema, location = '$') {
  if (schema.$ref) return validateSchema(resolvePointer(root, schema.$ref), value, root, location);

  if (schema.anyOf) {
    const results = schema.anyOf.map(candidate => validateSchema(candidate, value, root, location));
    if (!results.some(errors => errors.length === 0)) return [`${location} does not match anyOf`];
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(candidate => validateSchema(candidate, value, root, location).length === 0).length;
    if (matches !== 1) return [`${location} matches ${matches} oneOf alternatives`];
  }

  const errors = [];
  if (schema.const !== undefined && !Object.is(value, schema.const)) errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) errors.push(`${location} is not in enum`);

  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some(type => typeMatches(value, type))) {
      errors.push(`${location} must have type ${expected.join('|')}`);
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${location} is shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${location} is longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${location} does not match ${schema.pattern}`);
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value)))) {
      errors.push(`${location} is not a UTC date-time`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${location} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${location} is above ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${location} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${location} has more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, root, `${location}[${index}]`)));
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${location}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validateSchema(schema.properties[key], item, root, `${location}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${location}.${key} is not allowed`);
    }
  }
  return errors;
}

const assertValid = (schema, value) => assert.deepEqual(validateSchema(schema, value), []);
const clone = value => structuredClone(value);

const canonicalJson = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};
const sha256 = value => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');

test('schemas use only the self-contained supported keyword subset', () => {
  const supported = new Set(['$schema', '$id', '$defs', '$ref', 'title', 'type', 'required', 'properties', 'additionalProperties', 'enum', 'const', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf', 'pattern', 'format', 'minLength', 'maxLength']);
  const visit = (schema, root, location) => {
    for (const key of Object.keys(schema)) assert.ok(supported.has(key), `${location} uses unsupported keyword ${key}`);
    if (schema.$ref) assert.ok(resolvePointer(root, schema.$ref), `${location} has unresolved ref ${schema.$ref}`);
    for (const [key, child] of Object.entries(schema.$defs || {})) visit(child, root, `${location}.$defs.${key}`);
    for (const [key, child] of Object.entries(schema.properties || {})) visit(child, root, `${location}.properties.${key}`);
    if (schema.items) visit(schema.items, root, `${location}.items`);
    for (const [index, child] of (schema.anyOf || []).entries()) visit(child, root, `${location}.anyOf[${index}]`);
    for (const [index, child] of (schema.oneOf || []).entries()) visit(child, root, `${location}.oneOf[${index}]`);
    if (schema.type === 'object') assert.equal(schema.additionalProperties, false, `${location} must be strict`);
  };
  for (const [name, schema] of Object.entries(schemas)) visit(schema, schema, name);
});

test('all published examples validate against their contracts', () => {
  const contractFor = name => name.startsWith('impact-result-') ? 'impact-result' : name.replace(/-(demo|partial)$/, '');
  for (const [name, example] of Object.entries(examples)) {
    const contract = contractFor(name);
    assert.ok(schemas[contract], `missing schema mapping for ${name}`);
    assert.deepEqual(validateSchema(schemas[contract], example), [], `${name} must validate`);
  }
});

test('registry and snapshot examples obey canonical hash exclusions', () => {
  const registry = clone(examples['registry-demo']);
  const expectedRegistryHash = registry.source_sha256;
  delete registry.source_sha256;
  assert.equal(sha256(registry), expectedRegistryHash);

  const snapshot = clone(examples['graph-snapshot-partial']);
  const expectedSnapshotHash = snapshot.content_sha256;
  for (const key of ['snapshot_id', 'graph_version', 'content_sha256', 'created_at']) delete snapshot[key];
  assert.equal(sha256(snapshot), expectedSnapshotHash);
  assert.equal(examples['graph-snapshot-partial'].graph_version, `sha256:${expectedSnapshotHash}`);
  assert.equal(examples['graph-snapshot-partial'].snapshot_id, `snapshot://sha256:${expectedSnapshotHash}`);
});

test('a canonical registry service may retain an unknown tier and is never defaulted to Tier 3', () => {
  const registry = clone(examples['registry-demo']);
  const payment = registry.services.find(service => service.id === 'service://astronomy-shop/payment');
  payment.tier = null;
  assertValid(schemas.registry, registry);
  assert.equal(payment.tier, null);
  assert.notEqual(payment.tier?.value, 3);
});

test('strict request constraints reject extra fields, invalid identity, and hard-limit overflow', () => {
  const extra = clone(examples['impact-request']);
  extra.unreviewed = true;
  assert.match(validateSchema(schemas['impact-request'], extra).join('\n'), /not allowed/);

  const badSha = clone(examples['impact-request']);
  badSha.commit_sha = 'abc123';
  assert.match(validateSchema(schemas['impact-request'], badSha).join('\n'), /does not match/);

  const tooManyFiles = clone(examples['impact-request']);
  tooManyFiles.files = Array.from({ length: 101 }, (_, index) => ({ path: `src/file-${index}.js`, status: 'modified' }));
  assert.match(validateSchema(schemas['impact-request'], tooManyFiles).join('\n'), /more than 100 items/);

  const unsafePath = clone(examples['impact-request']);
  unsafePath.files[0].path = '../secret';
  assert.match(validateSchema(schemas['impact-request'], unsafePath).join('\n'), /does not match/);
});

test('graph schema freezes canonical edges and bounded evidence, never a persisted inverse', () => {
  const snapshot = examples['graph-snapshot-partial'];
  assertValid(schemas['graph-snapshot'], snapshot);
  assert.ok(snapshot.edges.length > 0);
  assert.ok(snapshot.evidence.length > 0);

  const inverse = clone(snapshot);
  inverse.edges[0].relationship_type = 'CALLED_BY';
  assert.match(validateSchema(schemas['graph-snapshot'], inverse).join('\n'), /not in enum/);

  const missingEvidence = clone(snapshot);
  delete missingEvidence.evidence;
  assert.match(validateSchema(schemas['graph-snapshot'], missingEvidence).join('\n'), /evidence is required/);
});

test('unknown-time declarations are explicit, partial, and cannot claim validated behavior', () => {
  const snapshot = clone(examples['graph-snapshot-partial']);
  snapshot.edges[0].evidence_status = 'declared';
  snapshot.edges[0].observed_at = null;
  snapshot.edges[0].behavior.classification = 'unknown';
  snapshot.edges[0].behavior.failure_mode = 'unknown';
  snapshot.edges[0].behavior.basis = 'Declared catalog dependency without an observation time';
  snapshot.edges[0].behavior.evidence_refs = [];
  snapshot.evidence[0].status = 'declared';
  snapshot.evidence[0].observed_at = null;
  assertValid(schemas['graph-snapshot'], snapshot);
  assert.equal(snapshot.validation_status, 'validated_partial');
  assert.equal(snapshot.edges[0].behavior.classification, 'unknown');

  snapshot.edges[0].behavior.classification = 'hard';
  assert.match(validateSchema(schemas['graph-snapshot'], snapshot).join('\n'), /does not match anyOf/);
});

test('complete, partial, insufficient, and unknown examples preserve conservative policy semantics', () => {
  const complete = examples['impact-result-complete'];
  const partial = examples['impact-result-partial'];
  const insufficient = examples['impact-result-insufficient-evidence'];
  const unknown = examples['impact-result-unknown'];

  assert.equal(complete.analysis_status, 'complete');
  assert.equal(complete.risk_classification, 'LOW');
  assert.equal(complete.bounds.truncated, false);
  assert.deepEqual(complete.unknowns, []);
  assert.equal(complete.shadow_decision.eligibility, 'eligible_for_bypass');
  assert.equal(complete.shadow_decision.outcome, 'would_allow_bypass');

  assert.equal(partial.analysis_status, 'partial');
  assert.equal(partial.risk_classification, 'HIGH', 'known HIGH triggers win despite partial coverage');
  assert.deepEqual(partial.downstream, []);
  assert.ok(partial.coverage.some(row => row.unknowns.length > 0), 'empty paths retain partial coverage unknowns');
  assert.equal(partial.shadow_decision.eligibility, 'ineligible');

  assert.equal(insufficient.analysis_status, 'insufficient_evidence');
  assert.equal(insufficient.commit_sha, null);
  assert.equal(insufficient.risk_classification, 'UNKNOWN');
  assert.equal(insufficient.shadow_decision.outcome, 'would_lock');

  assert.equal(unknown.risk_classification, 'UNKNOWN');
  assert.notEqual(unknown.risk_classification, 'LOW');
  assert.equal(unknown.shadow_decision.eligibility, 'ineligible');

  for (const example of [partial, insufficient, unknown]) {
    assert.notEqual(example.risk_classification, 'LOW');
    assert.equal(example.shadow_decision.authorization.status, 'not_evaluated');
    assert.equal(example.shadow_decision.authorization.authorization_id, null);
  }
});

test('truncation and unknown evidence cannot be represented as LOW eligibility', () => {
  const truncatedLow = clone(examples['impact-result-complete']);
  truncatedLow.bounds.truncated = true;
  truncatedLow.bounds.truncation_reason = ['NODE_LIMIT'];
  truncatedLow.bounds.unexplored_frontier = [{ node_id: 'service://astronomy-shop/payment', reason: 'NODE_LIMIT' }];
  assert.match(validateSchema(schemas['impact-result'], truncatedLow).join('\n'), /does not match anyOf/);

  const invalidAuthorization = clone(examples['shadow-decision']);
  invalidAuthorization.authorization.status = 'authorized';
  assert.match(validateSchema(schemas['shadow-decision'], invalidAuthorization).join('\n'), /must equal/);
});

test('stable API errors reject undocumented codes', () => {
  assertValid(schemas['api-error'], examples['api-error']);
  const undocumented = clone(examples['api-error']);
  undocumented.error.code = 'INTERNAL_ERROR';
  assert.match(validateSchema(schemas['api-error'], undocumented).join('\n'), /not in enum/);
});
