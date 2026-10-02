// Renders the one PR comment a human can act on in 30 seconds.

export const MARKER = '<!-- ripple:risk-review -->';

const BADGE = {
  low: { icon: '🟢', label: 'LOW risk' },
  medium: { icon: '🟡', label: 'MEDIUM risk' },
  high: { icon: '🔴', label: 'HIGH risk' },
};

export function renderComment(a) {
  const b = BADGE[a.gate.level];
  const out = [MARKER, `### ${b.icon} Ripple: ${b.label}`, '', `**${a.headline}**`, ''];

  if (a.gate.level === 'low') {
    out.push('No extra reviewers or checks needed. Specialist agents skipped.', '');
    out.push(factorsBlock(a), footer(a));
    return out.join('\n');
  }

  const r = a.agents;

  // 1. Blast radius
  const blast = r['blast-radius'];
  if (blast) {
    const changed = blast.changed.map((s) => `\`${s.name}\` (tier ${s.tier})`).join(', ');
    const hardCount = blast.rows.filter((x) => x.allHard).length;
    out.push(`#### 💥 Blast radius`);
    out.push(
      `${blast.rows.length + blast.more} service${blast.rows.length + blast.more === 1 ? '' : 's'} upstream of ${changed} within ${blast.maxHops} hops` +
        (hardCount ? `, **${hardCount} via hard edges**.` : ', all via soft edges.'),
      '',
    );
    out.push('| Service | Tier | Dependency chain | Impact |', '|---|---|---|---|');
    for (const row of blast.rows) {
      out.push(`| \`${row.service}\` | ${row.tier} | ${chain(row)} | ${row.allHard ? '**breaks**' : 'degrades'} |`);
    }
    if (blast.more) out.push(`| _+${blast.more} more_ | | | |`);
    out.push('', '<sub>⇒ hard edge (failure propagates) · ⇢ soft edge (caller degrades gracefully)</sub>');
    const why = uniqueEdges(blast.rows).filter((e) => e.kind_source !== 'protocol');
    if (why.length) {
      out.push('', '<details><summary>Why these edges are hard or soft</summary>', '');
      for (const e of why) out.push(`- \`${e.from}\` → \`${e.to}\` **${e.kind}**: ${e.kind_reason}`);
      out.push('', '</details>');
    }
    out.push('');
  }

  // 2. Past incidents
  const hist = r['incident-historian'];
  if (hist?.matches.length) {
    out.push('#### 🧯 Past incidents');
    for (const m of hist.matches) {
      const i = m.incident;
      out.push(`- **${i.id}** · ${i.severity} · ${i.date}: ${i.title} _(similarity ${m.score}${m.strength === 'related' ? ', related' : ''})_`);
      out.push(`  - RCA: ${i.rca}`);
      if (m.strength === 'match' && i.watch_for?.length) out.push(`  - Watch for: ${i.watch_for[0]}`);
    }
    out.push('');
  }

  // 3. Planning
  const intent = r['intent-verifier'];
  if (intent) {
    const icon = { match: '✅', partial: '⚠️', mismatch: '❌', missing: '❔' }[intent.status];
    const label = { match: 'Diff matches the ticket', partial: 'Diff partly outside the ticket', mismatch: "Diff doesn't match the ticket", missing: 'No ticket' }[intent.status];
    const t = intent.ticket;
    out.push(`#### 🎫 Planning check${t ? `: ${t.url ? `[${t.key}](${t.url})` : t.key} "${t.summary}"` : ''}`);
    out.push(`${icon} **${label}**`);
    for (const c of intent.covered || []) out.push(`- ✔︎ ${c}`);
    for (const x of intent.reasons || []) out.push(`- ✖︎ ${x}`);
    if (intent.assessment) out.push(`- _${intent.assessment.by}:_ ${intent.assessment.summary}`);
    out.push('');
  }

  // 4. Reviewers
  const rev = r['reviewer-router'];
  if (rev && (rev.reviewers.length || rev.cc.length)) {
    out.push('#### 👀 Suggested reviewers');
    for (const x of rev.reviewers) out.push(`- @${x.login}${x.team ? ` (${x.team})` : ''}: ${x.reason}`);
    for (const x of rev.cc) out.push(`- cc @${x.login}${x.team ? ` (${x.team})` : ''}: ${x.reason}`);
    out.push('');
  }

  // 5. Checks
  const checks = r['checks-planner']?.checks || [];
  if (checks.length) {
    out.push('#### ✅ Before merging');
    for (const c of checks) out.push(`- [ ] ${c}`);
    out.push('');
  }

  out.push(factorsBlock(a), footer(a));
  return out.join('\n');
}

function factorsBlock(a) {
  const rows = a.gate.factors.map((f) => `| ${f.points ? `+${f.points}` : '0'} | ${f.family} | ${f.label} |`);
  return [
    `<details><summary>Why ${a.gate.level.toUpperCase()}: score ${a.gate.score} (medium ≥ ${a.gate.thresholds.medium}, high ≥ ${a.gate.thresholds.high})</summary>`,
    '',
    '| Points | Signal | Factor |',
    '|---|---|---|',
    ...rows,
    a.gate.capped ? '\n_Capped at MEDIUM: no hard-edge tier-1 dependents, breaking change or migration._' : '',
    '',
    '</details>',
    '',
  ].join('\n');
}

function footer(a) {
  const s = a.sources;
  const graph = `graph: ${s.graph}${s.graphMock ? ' (OTel mock)' : ''}${s.graphStale ? ' (fallback)' : ''}`;
  return `<sub>Ripple advises; a human makes the merge call. · ${graph} · planning: ${s.planning} · incidents: ${s.incidents} · ${a.timings.totalMs} ms</sub>`;
}

function chain(row) {
  // Arrow per edge: ⇒ hard, ⇢ soft
  let s = `\`${row.path[0]}\``;
  row.edges.forEach((e) => {
    s += ` ${e.kind === 'hard' ? '⇒' : '⇢'} \`${e.to}\``;
  });
  return s;
}

function uniqueEdges(rows) {
  const m = new Map();
  for (const r of rows) for (const e of r.edges) m.set(`${e.from}->${e.to}`, e);
  return [...m.values()];
}
