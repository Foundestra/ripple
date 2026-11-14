import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { loadRegistry } from '../identity/registry.js';

export async function loadDemoRegistry() {
  const manifest = YAML.parse(await readFile(new URL('../../../data/platform/demo/registry.yaml', import.meta.url), 'utf8'));
  return loadRegistry(manifest);
}
