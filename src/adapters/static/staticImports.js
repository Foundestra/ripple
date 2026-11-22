import { createHash } from 'node:crypto';
import { languageOf } from './changedSymbols.js';
import { buildProtoIndex, importsOfProto, resolveTarget } from './protoResolver.js';

// Cold-path static adapter. Parses Java and Python imports plus proto imports,
// maps them to services through the catalog, and returns static edges. Runtime
// edges always win on collision. Static edges are never classified as hard.
// Source interface matches the other graph sources: fetch() -> { edges, capturedAt, source }.

export const CIRCUIT_BREAKER_RATIO = 0.1;
export const STATIC_PROTOCOL = 'static';

// Native bindings are optional. Returns a parse(text, language) function, or null when unavailable.
export async function loadTreeSitterParse() {
  try {
    const [TS, Java, Python] = await Promise.all([
      import('tree-sitter'),
      import('tree-sitter-java'),
      import('tree-sitter-python'),
    ]);
    const Parser = TS.default;
    const parsers = { java: new Parser(), python: new Parser() };
    parsers.java.setLanguage(Java.default);
    parsers.python.setLanguage(Python.default);
    return (text, language) => {
      const tree = parsers[language].parse(text);
      const root = toNormalized(tree.rootNode);
      root.hasError = typeof tree.rootNode.hasError === 'function' ? tree.rootNode.hasError() : !!tree.rootNode.hasError;
      return root;
    };
  } catch {
    return null;
  }
}

export function toNormalized(node) {
  return {
    type: node.type,
    name: node.childForFieldName?.('name')?.text ?? null,
    text: /import/.test(node.type) ? node.text : undefined,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    children: (node.children || []).map(toNormalized),
  };
}

// Module specs imported by a normalized Java or Python tree.
export function importsOf(root, language) {
  const out = [];
  const walk = (node) => {
    if (language === 'java' && node.type === 'import_declaration') {
      const m = node.text?.match(/^import\s+(?:static\s+)?([\w.*]+)/);
      if (m) out.push(m[1]);
    } else if (language === 'python' && node.type === 'import_statement') {
      for (const part of (node.text || '').replace(/^import\s+/, '').split(',')) {
        const mod = part.trim().split(/\s+as\s+/)[0];
        if (mod) out.push(mod);
      }
    } else if (language === 'python' && node.type === 'import_from_statement') {
      const m = node.text?.match(/^from\s+([\w.]+)\s+import/);
      if (m) out.push(m[1]);
    }
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return out;
}

export function createMemoryCache() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
    size: () => map.size,
  };
}

const sha1 = (text) => createHash('sha1').update(text).digest('hex');

// files: [{ path, text }]. parse: see loadTreeSitterParse. cache: per-file incremental cache keyed by path and content hash.
export function analyzeStatic({ files, catalog, parse = null, cache = null }) {
  const repoPaths = new Set(files.map((f) => f.path));
  const protoIndex = buildProtoIndex(files.filter((f) => f.path.endsWith('.proto')));
  const edges = new Map();
  const unresolved = [];
  let analyzed = 0;
  let failed = 0;
  let cacheHits = 0;

  for (const f of files) {
    const isProto = f.path.endsWith('.proto');
    const language = isProto ? 'proto' : languageOf(f.path);
    if (!language) continue;
    analyzed++;

    const key = `${f.path}@${sha1(f.text)}`;
    let specs = cache?.get(key);
    if (specs) {
      cacheHits++;
    } else {
      if (isProto) {
        specs = importsOfProto(f.text);
      } else {
        if (!parse) {
          failed++;
          continue;
        }
        let root = null;
        try {
          root = parse(f.text, language);
        } catch {
          root = null;
        }
        if (!root || root.hasError) {
          failed++;
          continue;
        }
        specs = importsOf(root, language);
      }
      cache?.set(key, specs);
    }

    const from = catalog.serviceForPath(f.path);
    for (const spec of specs) {
      const target = resolveTarget(spec, { language, repoPaths, protoIndex });
      if (!target.resolved) {
        unresolved.push({ from: f.path, spec, conservative: true });
        continue;
      }
      const to = catalog.serviceForPath(target.path);
      if (!from || !to || from === to) continue;
      const k = `${from}->${to}`;
      if (!edges.has(k)) {
        edges.set(k, { from, to, protocol: STATIC_PROTOCOL, calls_per_min: null, error_rate: null, last_seen: null, origin: 'static', dependency_types: new Set(), evidence: [] });
      }
      const edge = edges.get(k);
      edge.dependency_types.add(isProto ? 'contract' : 'shared_code');
      edge.evidence.push({ file: f.path, target: target.path });
    }
  }

  const ratio = analyzed ? failed / analyzed : 0;
  return {
    edges: [...edges.values()].map((e) => ({ ...e, dependency_types: [...e.dependency_types].sort() })),
    unresolved,
    analyzed,
    failed,
    parse_failure_ratio: Math.round(ratio * 1000) / 1000,
    incomplete: ratio > CIRCUIT_BREAKER_RATIO,
    cache_hits: cacheHits,
  };
}

// Runtime edges are authoritative. Static edges only fill gaps. Returns a new list; inputs are not mutated.
export function mergeGraphs(runtimeEdges, staticEdges) {
  const runtime = new Set(runtimeEdges.map((e) => `${e.from}->${e.to}`));
  const additions = staticEdges.filter((e) => !runtime.has(`${e.from}->${e.to}`));
  return { edges: [...runtimeEdges, ...additions], added: additions.length, deduped: staticEdges.length - additions.length };
}

export class StaticImportsSource {
  name = 'static';
  constructor({ files, catalog, parse = null, cache = null, fullCache = null, sha = null, now = () => new Date().toISOString() }) {
    this.files = files;
    this.catalog = catalog;
    this.parse = parse;
    this.cache = cache;
    this.fullCache = fullCache;
    this.sha = sha;
    this.now = now;
  }

  // Full-result cache per commit SHA. Incomplete results are never cached, because a missing parser may be the cause.
  async fetch() {
    const fullKey = this.sha ? `full:${this.sha}` : null;
    const cached = fullKey ? this.fullCache?.get(fullKey) : undefined;
    if (cached) return { ...cached, cache: 'full' };
    const result = analyzeStatic({ files: this.files, catalog: this.catalog, parse: this.parse, cache: this.cache });
    const out = { ...result, capturedAt: this.now(), source: 'static' };
    if (fullKey && !out.incomplete) this.fullCache?.set(fullKey, out);
    return { ...out, cache: 'miss' };
  }
}
