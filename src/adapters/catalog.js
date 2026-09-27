import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

// Service catalog adapter. Seeded from data/catalog.yaml; a Backstage adapter
// would implement the same shape.
export function loadCatalog(dataDir) {
  const file = path.join(dataDir, 'catalog.yaml');
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  return new Catalog(raw);
}

export class Catalog {
  constructor(raw) {
    this.raw = raw;
    this.services = new Map(Object.entries(raw.services || {}).map(([name, s]) => [name, { name, ...s }]));
    this.sharedContractFiles = raw.shared_contract_files || [];
    this.generatedPaths = raw.generated_paths || [];
    this.edgeOverrides = raw.edge_overrides || [];
    this.manualEdges = raw.manual_edges || [];

    this.contractOwner = new Map();
    for (const s of this.services.values()) {
      for (const c of s.contracts || []) this.contractOwner.set(c, s.name);
    }
  }

  get(name) {
    return (
      this.services.get(name) || {
        name,
        tier: 3,
        kind: 'service',
        team: null,
        owners: [],
        paths: [],
        unknown: true,
        description: 'Not in the service catalog',
      }
    );
  }

  has(name) {
    return this.services.has(name);
  }

  serviceForPath(filePath) {
    let best = null;
    for (const s of this.services.values()) {
      for (const p of s.paths || []) {
        if (filePath.startsWith(p) && (!best || p.length > best.len)) best = { name: s.name, len: p.length };
      }
    }
    return best?.name ?? null;
  }

  isSharedContract(filePath) {
    return this.sharedContractFiles.some((p) => filePath === p || filePath.endsWith('/' + p));
  }

  isGenerated(filePath) {
    return this.generatedPaths.some((p) => filePath.includes(p));
  }

  ownerOfContract(symbol) {
    return this.contractOwner.get(symbol) ?? null;
  }
}
