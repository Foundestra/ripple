import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import YAML from 'yaml';

test('strict schema source files contain no duplicate object keys', () => {
  const directory = new URL('../../schemas/platform/v1/', import.meta.url);
  for (const file of readdirSync(directory).filter(name => name.endsWith('.schema.json'))) {
    const source = readFileSync(new URL(file, directory), 'utf8');
    // JSON.parse silently accepts duplicate keys. The existing YAML 1.2 parser
    // accepts JSON syntax and rejects duplicate keys before discarding anything.
    assert.deepEqual(YAML.parse(source), JSON.parse(source), file);
  }
  assert.throws(() => YAML.parse('{"properties":{"valid_until":{},"valid_until":{}}}'), /unique|duplicate/i);
});
