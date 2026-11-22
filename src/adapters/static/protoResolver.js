// Import resolution for the static adapter: Java, Python and proto import specs
// are mapped to repo-relative paths. Anything that cannot be resolved is reported
// as unresolved with conservative: true. It is never silently dropped.

// Suffix matching lets a Java source root (src/main/java/...) or a Python package
// root be found without configuration. An ambiguous suffix counts as unresolved.
function findRepoPath(candidate, repoPaths) {
  if (repoPaths.has(candidate)) return candidate;
  const matches = [...repoPaths].filter((p) => p.endsWith('/' + candidate));
  return matches.length === 1 ? matches[0] : null;
}

export function importsOfProto(text) {
  return [...text.matchAll(/^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/gm)].map((m) => m[1]);
}

export function buildProtoIndex(protoFiles) {
  const symbols = new Map(); // bare or fully-qualified name -> Set<path>
  for (const f of protoFiles) {
    const pkg = f.text.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? null;
    for (const m of f.text.matchAll(/^\s*(?:message|service|enum)\s+(\w+)/gm)) {
      for (const key of [m[1], pkg ? `${pkg}.${m[1]}` : null].filter(Boolean)) {
        if (!symbols.has(key)) symbols.set(key, new Set());
        symbols.get(key).add(f.path);
      }
    }
  }
  return { symbols };
}

// com.acme.pay.Charge -> com/acme/pay/Charge.java. Static member imports
// (com.acme.pay.Charge.run) fall back to the enclosing class. Wildcards stay unresolved.
export function resolveJava(spec, repoPaths) {
  if (spec.endsWith('.*')) return null;
  const parts = spec.split('.');
  for (let i = parts.length; i >= 1; i--) {
    const hit = findRepoPath(`${parts.slice(0, i).join('/')}.java`, repoPaths);
    if (hit) return hit;
  }
  return null;
}

// pkg.mod -> pkg/mod.py or pkg/mod/__init__.py. Relative imports stay unresolved.
export function resolvePython(spec, repoPaths) {
  if (spec.startsWith('.')) return null;
  const base = spec.split('.').join('/');
  return findRepoPath(`${base}.py`, repoPaths) ?? findRepoPath(`${base}/__init__.py`, repoPaths);
}

function resolveProto(spec, repoPaths, protoIndex) {
  if (spec.endsWith('.proto')) return findRepoPath(spec, repoPaths);
  const paths = protoIndex?.symbols.get(spec);
  return paths && paths.size === 1 ? [...paths][0] : null;
}

export function resolveTarget(spec, { language, repoPaths, protoIndex = null }) {
  let path = null;
  if (language === 'java') path = resolveJava(spec, repoPaths);
  else if (language === 'python') path = resolvePython(spec, repoPaths);
  else if (language === 'proto') path = resolveProto(spec, repoPaths, protoIndex);
  return path
    ? { resolved: true, path, spec, language }
    : { resolved: false, path: null, spec, language, conservative: true };
}
