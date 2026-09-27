// Change-risk signal family: what does the diff itself touch?
//   services (by path or by owned contract), contract changes (proto field
//   removals/renames/renumbers), API handlers, migrations, size, CI.

const FIELD_RE = /^\s*(?:repeated\s+|optional\s+)?([\w.<>, ]+?)\s+(\w+)\s*=\s*(\d+)\s*[;[]/;
const MESSAGE_RE = /^\s*(message|service|enum)\s+(\w+)\s*\{/;
const RPC_RE = /^\s*rpc\s+(\w+)\s*\(/;
const MIGRATION_RE = /(^|\/)(migrations?|migrate|db\/migrate|schema)\/|\.sql$/i;
const DOC_RE = /\.(md|mdx|txt|rst|adoc)$|(^|\/)docs?\//i;
const CONTRACT_FILE_RE = /\.proto$|openapi.*\.(ya?ml|json)$|\.avsc$|\.graphql$/i;

export function analyzeChange({ files, catalog, ci = { state: 'unknown' } }) {
  const services = new Map(); // name -> { name, reasons:Set, files:Set }
  const touch = (name, reason, file) => {
    if (!name) return;
    if (!services.has(name)) services.set(name, { name, reasons: new Set(), files: new Set() });
    services.get(name).reasons.add(reason);
    services.get(name).files.add(file);
  };

  const contractChanges = [];
  const apiSurface = [];
  const migrations = [];
  const otherContractFiles = [];
  let additions = 0;
  let deletions = 0;
  let generatedLines = 0;

  for (const f of files) {
    const generated = catalog.isGenerated(f.path);
    if (generated) generatedLines += f.additions + f.deletions;
    else {
      additions += f.additions;
      deletions += f.deletions;
    }

    if (f.path.endsWith('.proto')) {
      const changes = diffProto(f);
      for (const c of changes) {
        c.owner = catalog.ownerOfContract(c.message) || catalog.serviceForPath(f.path);
        contractChanges.push(c);
        touch(c.owner, `contract \`${c.message}\``, f.path);
      }
    } else if (CONTRACT_FILE_RE.test(f.path)) {
      otherContractFiles.push(f.path);
    }

    if (MIGRATION_RE.test(f.path)) migrations.push(f.path);

    const owner = catalog.serviceForPath(f.path);
    if (owner && !catalog.isSharedContract(f.path)) {
      touch(owner, generated ? 'generated code' : 'code', f.path);
      if (!generated) {
        for (const sym of catalog.get(owner).api_symbols || []) {
          const hit = f.hunks.find((h) => mentions(h.header, sym) || h.lines.some((l) => mentions(l.text, sym)));
          if (hit) {
            apiSurface.push({ service: owner, symbol: sym, file: f.path });
            break;
          }
        }
      }
    }
  }

  const breaking = contractChanges.filter((c) => c.breaking);
  const docsOnly = files.length > 0 && files.every((f) => DOC_RE.test(f.path));
  const copyOnly = files.length > 0 && !contractChanges.length && files.every((f) => catalog.isGenerated(f.path) || isStringLiteralOnly(f));

  const serviceList = [...services.values()]
    .map((s) => ({ name: s.name, tier: catalog.get(s.name).tier, reasons: [...s.reasons], files: [...s.files] }))
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));

  return {
    services: serviceList,
    serviceNames: serviceList.map((s) => s.name),
    contractChanges,
    breakingChanges: breaking,
    otherContractFiles,
    apiSurface,
    migrations,
    size: { files: files.length, additions, deletions, changed: additions + deletions, generatedLines },
    docsOnly,
    copyOnly,
    ci,
    unmappedFiles: files.filter((f) => !catalog.serviceForPath(f.path) && !f.path.endsWith('.proto')).map((f) => f.path),
  };
}

// Identifier-prefix match, so `ListRecommendations` also hits `ListRecommendationsResponse`.
const mentions = (text, sym) => new RegExp(`(^|[^\\w])${sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text || '');

// Compare removed vs added field declarations per message inside the hunks.
export function diffProto(file) {
  const removed = new Map(); // `${msg}.${name}` -> {msg,type,name,num}
  const added = new Map();
  const removedRpcs = [];
  for (const h of file.hunks) {
    let current = h.header.match(MESSAGE_RE)?.[2] ?? null;
    for (const l of h.lines) {
      const m = l.text.match(MESSAGE_RE);
      if (m) {
        current = m[2];
        continue;
      }
      if (/^\}/.test(l.text)) continue;
      if (l.type === ' ') continue;
      const rpc = l.text.match(RPC_RE);
      if (rpc && l.type === '-') removedRpcs.push({ message: current, rpc: rpc[1] });
      const f = l.text.match(FIELD_RE);
      if (!f || /^\s*(reserved|option)\b/.test(l.text)) continue;
      const rec = { message: current, type: f[1].trim(), name: f[2], num: Number(f[3]) };
      (l.type === '-' ? removed : added).set(`${current}.${rec.name}`, rec);
    }
  }

  const out = [];
  const addedByNum = new Map([...added.values()].map((a) => [`${a.message}#${a.num}`, a]));
  for (const [k, r] of removed) {
    const same = added.get(k);
    if (same) {
      if (same.num !== r.num) out.push(change(file, r, 'renumbered', true, `\`${r.message}.${r.name}\` renumbered ${r.num} → ${same.num}`));
      else if (same.type !== r.type) out.push(change(file, r, 'retyped', true, `\`${r.message}.${r.name}\` type ${r.type} → ${same.type}`));
      added.delete(k);
      continue;
    }
    const byNum = addedByNum.get(`${r.message}#${r.num}`);
    if (byNum && added.has(`${byNum.message}.${byNum.name}`)) {
      out.push(change(file, r, 'renamed', true, `\`${r.message}.${r.name}\` renamed to \`${byNum.name}\``));
      added.delete(`${byNum.message}.${byNum.name}`);
      continue;
    }
    out.push(change(file, r, 'removed', true, `Removes \`${r.message}.${r.name}\` (field ${r.num})`));
  }
  for (const a of added.values()) out.push(change(file, a, 'added', false, `Adds \`${a.message}.${a.name}\` (field ${a.num})`));
  for (const r of removedRpcs) out.push({ file: file.path, message: r.message, field: r.rpc, kind: 'rpc-removed', breaking: true, detail: `Removes rpc \`${r.message}.${r.rpc}\`` });
  return out;
}

const change = (file, f, kind, breaking, detail) => ({ file: file.path, message: f.message, field: f.name, fieldType: f.type, number: f.num, kind, breaking, detail });

// True when every changed line only differs from its counterpart inside string literals.
function isStringLiteralOnly(file) {
  const strip = (s) => s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""').trim();
  let changed = 0;
  for (const h of file.hunks) {
    const rem = h.lines.filter((l) => l.type === '-').map((l) => strip(l.text));
    const add = h.lines.filter((l) => l.type === '+').map((l) => strip(l.text));
    if (rem.length !== add.length) return false;
    if (rem.join('\n') !== add.join('\n')) return false;
    changed += rem.length;
  }
  return changed > 0;
}
