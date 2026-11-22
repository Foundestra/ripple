// Changed-symbol detection. parseDiff maps unified-diff hunks to new-side line
// numbers; definitionsOf walks a normalized syntax tree; buildChangedSymbols
// intersects the two. Parse failures are counted, never silently dropped.
// Normalized node shape: { type, name, text?, startLine, endLine, hasError?, children }.

const LANGUAGES = { '.java': 'java', '.py': 'python' };
const DEFINITION_TYPES = {
  java: new Map([
    ['class_declaration', 'class'],
    ['interface_declaration', 'interface'],
    ['enum_declaration', 'enum'],
    ['method_declaration', 'method'],
    ['constructor_declaration', 'constructor'],
  ]),
  python: new Map([
    ['class_definition', 'class'],
    ['function_definition', 'function'],
  ]),
};

export function languageOf(filePath) {
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? null : LANGUAGES[filePath.slice(dot)] ?? null;
}

// Returns [{ path, changedLines:Set<newLine>, removedAt:Set<newLine> }].
// removedAt records the new-side position where lines were deleted, so a
// removal inside a definition still counts as a change to that definition.
export function parseDiff(text) {
  const files = [];
  let file = null;
  let inHunk = false;
  let newLine = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      file = { path: m ? m[2] : '', changedLines: new Set(), removedAt: new Set() };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk && line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      if (p !== '/dev/null') file.path = p;
      continue;
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      inHunk = true;
      newLine = Number(h[1]);
      continue;
    }
    if (!inHunk) continue;
    const type = line[0];
    if (type === '+') {
      file.changedLines.add(newLine);
      newLine++;
    } else if (type === '-') {
      file.removedAt.add(newLine);
    } else if (type === ' ') {
      newLine++;
    }
  }
  return files;
}

export function definitionsOf(root, language) {
  const kinds = DEFINITION_TYPES[language];
  if (!kinds) return [];
  const out = [];
  const walk = (node) => {
    const kind = kinds.get(node.type);
    if (kind && node.name) out.push({ name: node.name, kind, startLine: node.startLine, endLine: node.endLine });
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  return out;
}

// diffFiles: output of parseDiff. sourceFor(path) -> post-change text or null.
// parse(text, language) -> normalized root (throws or hasError on failure), or null when no parser exists.
export function buildChangedSymbols({ diffFiles, sourceFor, parse }) {
  const symbols = [];
  const failures = [];
  let analyzed = 0;
  for (const f of diffFiles) {
    const language = languageOf(f.path);
    if (!language || f.changedLines.size + f.removedAt.size === 0) continue;
    analyzed++;
    if (!parse) {
      failures.push({ path: f.path, reason: 'parser unavailable' });
      continue;
    }
    const text = sourceFor(f.path);
    if (text == null) {
      failures.push({ path: f.path, reason: 'source unavailable' });
      continue;
    }
    let root;
    try {
      root = parse(text, language);
    } catch (err) {
      failures.push({ path: f.path, reason: err.message });
      continue;
    }
    if (!root || root.hasError) {
      failures.push({ path: f.path, reason: 'parse error' });
      continue;
    }
    const touched = [...f.changedLines, ...f.removedAt];
    for (const d of definitionsOf(root, language)) {
      if (touched.some((l) => l >= d.startLine && l <= d.endLine)) {
        symbols.push({ path: f.path, language, name: d.name, kind: d.kind, startLine: d.startLine, endLine: d.endLine });
      }
    }
  }
  return { symbols, analyzed, failures };
}
