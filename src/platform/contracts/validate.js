import { readFileSync } from 'node:fs';
import { canonicalJson } from './canonicalJson.js';

export function validDateTime(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  if (!m || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, zone] = m;
  return +month >= 1 && +month <= 12 && +day >= 1 && +day <= new Date(Date.UTC(+year, +month, 0)).getUTCDate() &&
    +hour < 24 && +minute < 60 && +second < 60 && (zone === 'Z' || (+zone.slice(1, 3) < 24 && +zone.slice(4) < 60));
}

const equal = (a, b) => a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b);
function matchesType(type, value) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && !Array.isArray(value) && typeof value === 'object';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

// Bounded, local-reference JSON Schema evaluator. The contract suite tests the
// supported vocabulary; no remote reference or provider network I/O is possible.
export function validateSchema(schema, value, root = schema, at = '$') {
  if (schema === true) return [];
  if (schema === false) return [`${at}: prohibited value`];
  if (schema.$ref) {
    if (!schema.$ref.startsWith('#/')) throw new Error('Only local schema references are permitted');
    const target = schema.$ref.slice(2).split('/').reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
    if (!target) throw new Error('Missing local schema reference');
    return validateSchema(target, value, root, at);
  }
  const errors = [];
  if (schema.type && ![schema.type].flat().some(type => matchesType(type, value))) return [`${at}: invalid type`];
  if ('const' in schema && !equal(value, schema.const)) errors.push(`${at}: invalid constant`);
  if (schema.enum && !schema.enum.some(item => equal(item, value))) errors.push(`${at}: invalid enum`);
  for (const key of ['allOf', 'anyOf', 'oneOf']) if (schema[key]) {
    const passes = schema[key].filter(child => validateSchema(child, value, root, at).length === 0).length;
    if ((key === 'allOf' && passes !== schema[key].length) || (key === 'anyOf' && passes === 0) || (key === 'oneOf' && passes !== 1)) errors.push(`${at}: ${key} failed`);
  }
  if (schema.not && !validateSchema(schema.not, value, root, at).length) errors.push(`${at}: excluded value`);
  if (schema.if) {
    const branch = validateSchema(schema.if, value, root, at).length ? schema.else : schema.then;
    if (branch) errors.push(...validateSchema(branch, value, root, at));
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) errors.push(`${at}: string length`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: pattern mismatch`);
    if (schema.format === 'date-time' && !validDateTime(value)) errors.push(`${at}: invalid date-time`);
  }
  if (typeof value === 'number') {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity) ||
        value <= (schema.exclusiveMinimum ?? -Infinity) || value >= (schema.exclusiveMaximum ?? Infinity)) errors.push(`${at}: numeric bounds`);
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) errors.push(`${at}: array size`);
    if (schema.uniqueItems && new Set(value.map(canonicalJson)).size !== value.length) errors.push(`${at}: duplicate item`);
    if (schema.items) value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, root, `${at}[${index}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      const child = Object.hasOwn(schema.properties || {}, key) ? schema.properties[key] : null;
      if (child) errors.push(...validateSchema(child, item, root, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unknown field`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validateSchema(schema.additionalProperties, item, root, `${at}.${key}`));
    }
  }
  return errors;
}
const schemas = new Map();
export function validateContract(name, value) {
  if (!['registry', 'graph-snapshot', 'impact-request', 'impact-result', 'shadow-decision', 'api-error'].includes(name)) throw new Error('Unknown platform contract');
  if (!schemas.has(name)) schemas.set(name, JSON.parse(readFileSync(new URL(`../../../schemas/platform/v1/${name}.schema.json`, import.meta.url), 'utf8')));
  canonicalJson(value);
  const errors = validateSchema(schemas.get(name), value);
  if (errors.length) throw Object.assign(new Error(`Invalid ${name} contract: ${errors.slice(0, 5).join('; ')}`), { code: 'INVALID_CONTRACT', status: 422, errors: errors.slice(0, 20) });
  return value;
}
