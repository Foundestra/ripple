// Specialist agents. The risk gate decides which run: LOW PRs skip all of them,
// MEDIUM and HIGH fan out in parallel to the ones their signals call for.
// Each agent is deterministic; when an LLM is configured, the intent verifier
// and narrator add model-written judgement and fall back silently on error.

export const AGENTS = [
  {
    name: 'blast-radius',
    title: 'Blast radius mapper',
    needed: (ctx) => ctx.blast.length > 0,
    run: async (ctx) => ({
      changed: ctx.change.services.map((s) => ({ name: s.name, tier: s.tier })),
      rows: ctx.blast.slice(0, 8),
      more: Math.max(0, ctx.blast.length - 8),
      maxHops: ctx.maxHops,
    }),
  },
  {
    name: 'incident-historian',
    title: 'Incident historian',
    needed: (ctx) => ctx.incidents.length > 0,
    run: async (ctx) => ({ matches: ctx.incidents }),
  },
  {
    name: 'intent-verifier',
    title: 'Intent verifier',
    needed: (ctx) => !!ctx.intent,
    run: async (ctx, llm) => {
      const out = { ...ctx.intent, ticket: ctx.intent.ticket ? pickTicket(ctx.intent.ticket) : null, assessment: null };
      if (llm.enabled && ctx.intent.ticket) {
        const res = await llm.json(
          'You check whether a pull request matches the Jira ticket it links to. Be concrete and brief. Output JSON: {"status":"match|partial|mismatch","summary":"one sentence"}.',
          `Ticket ${ctx.intent.key}: ${ctx.intent.ticket.summary}\n${ctx.intent.ticket.description}\nAcceptance: ${(ctx.intent.ticket.acceptance || []).join('; ')}\n\nPR title: ${ctx.pr.title}\nPR body: ${ctx.pr.body}\n\nDiff summary:\n${diffSummary(ctx.change)}`,
        );
        if (res?.summary && ['match', 'partial', 'mismatch'].includes(res.status)) out.assessment = { by: llm.name, status: res.status, summary: res.summary };
      }
      return out;
    },
  },
  {
    name: 'reviewer-router',
    title: 'Reviewer router',
    needed: () => true,
    run: async (ctx) => routeReviewers(ctx),
  },
  {
    name: 'checks-planner',
    title: 'Pre-merge checks planner',
    needed: () => true,
    run: async (ctx) => ({ checks: planChecks(ctx) }),
  },
  {
    name: 'narrator',
    title: 'Narrator',
    needed: (_ctx, llm) => llm.enabled,
    run: async (ctx, llm) => {
      const res = await llm.json(
        'You write the one-line verdict for a PR risk review. Max 30 words. Name the change, who depends on it and how (hard edges break, soft edges degrade), and any matching past incident or ticket mismatch. No hedging, no emoji. Output JSON: {"headline":"..."}.',
        `Risk: ${ctx.gate.level.toUpperCase()} (score ${ctx.gate.score})\nFactors:\n${ctx.gate.factors.map((f) => `- ${f.label}`).join('\n')}\n\nDraft headline: ${ctx.headline}`,
      );
      return { headline: res?.headline || null, by: llm.name };
    },
  },
];

export async function runAgents(ctx, llm, { onEvent = () => {} } = {}) {
  const selected = AGENTS.map((a) => ({ agent: a, run: ctx.gate.level !== 'low' && a.needed(ctx, llm) }));
  const results = {};
  const trace = [];
  await Promise.all(
    selected.map(async ({ agent, run }) => {
      if (!run) {
        const reason = ctx.gate.level === 'low' ? 'Low risk: specialist agents skipped' : 'Not needed for this PR';
        trace.push({ name: agent.name, title: agent.title, status: 'skipped', reason });
        onEvent({ stage: 'agent', name: agent.name, status: 'skipped', reason });
        return;
      }
      onEvent({ stage: 'agent', name: agent.name, status: 'running' });
      const t0 = performance.now();
      try {
        results[agent.name] = await agent.run(ctx, llm);
        const ms = Math.round(performance.now() - t0);
        trace.push({ name: agent.name, title: agent.title, status: 'done', ms });
        onEvent({ stage: 'agent', name: agent.name, status: 'done', ms });
      } catch (err) {
        const ms = Math.round(performance.now() - t0);
        trace.push({ name: agent.name, title: agent.title, status: 'error', ms, error: err.message });
        onEvent({ stage: 'agent', name: agent.name, status: 'error', ms, error: err.message });
      }
    }),
  );
  trace.sort((a, b) => AGENTS.findIndex((x) => x.name === a.name) - AGENTS.findIndex((x) => x.name === b.name));
  return { results, trace };
}

export function headline(ctx) {
  const { change, blast, incidents, intent, gate } = ctx;
  const top = change.services[0];
  const hard1 = blast.filter((b) => b.allHard && b.hops === 1).map((b) => `\`${b.service}\``);
  const soft1 = blast.filter((b) => !b.allHard && b.hops === 1).map((b) => `\`${b.service}\``);

  if (change.docsOnly) return 'Documentation-only change. Approve to proceed.';
  if (!top) return 'No catalogued service touched.';

  if (gate.level === 'low') {
    const what = change.copyOnly ? 'Copy-only change' : 'Internal change';
    const deps = !blast.length ? 'nothing depends on it' : hard1.length && !change.copyOnly ? `no interface change for ${join(hard1)}` : soft1.length ? `callers (${join(soft1)}) degrade gracefully` : 'no hard-dependent callers';
    return `${what} in tier-${top.tier} \`${top.name}\`; ${deps}. Approve to proceed.`;
  }

  const breaking = change.breakingChanges[0];
  const handler = change.apiSurface[0];
  let what;
  if (breaking) what = breaking.detail.replace(/ \(field \d+\)$/, '');
  else if (handler) what = `Changes \`${handler.symbol}\` behaviour in \`${handler.service}\``;
  else if (change.contractChanges.length) what = change.contractChanges[0].detail.replace(/ \(field \d+\)$/, '');
  else what = `Changes tier-${top.tier} \`${top.name}\``;

  const parts = [];
  if (hard1.length) parts.push(`${join(hard1)} ${hard1.length > 1 ? 'depend' : 'depends'} on it via a hard edge`);
  else if (soft1.length) parts.push(`${join(soft1)} ${soft1.length > 1 ? 'call' : 'calls'} it but ${soft1.length > 1 ? 'degrade' : 'degrades'} gracefully`);
  const best = incidents[0];
  if (best?.strength === 'match') parts.push(`it matches past incident ${best.incident.id}`);
  if (intent?.status === 'mismatch') parts.push(`the diff doesn't match ${intent.key}`);

  if (!parts.length) return `${what}.`;
  const tail = parts.length > 1 ? `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}` : parts[0];
  return `${what}; ${tail}.`;
}

function routeReviewers(ctx) {
  const author = ctx.pr.author;
  const reviewers = [];
  const cc = [];
  const seen = new Set([author]);
  const pick = (svc) => (ctx.catalog.get(svc).owners || []).find((o) => !seen.has(o));

  // Owners of hard-dependent callers close enough to feel it (<= 2 hops).
  for (const b of ctx.blast.filter((x) => x.allHard && x.hops <= 2)) {
    const who = pick(b.service);
    if (!who) continue;
    seen.add(who);
    reviewers.push({
      login: who,
      team: b.team,
      reason: `owns \`${b.service}\` (tier ${b.tier}), which hard-depends on ${b.hops === 1 ? `\`${b.path.at(-1)}\`` : `it via ${b.path.map((p) => `\`${p}\``).join(' → ')}`}`,
    });
    if (reviewers.length >= 3) break;
  }
  for (const s of ctx.change.services) {
    const who = pick(s.name);
    if (!who) continue;
    seen.add(who);
    reviewers.push({ login: who, team: ctx.catalog.get(s.name).team, reason: `co-owns \`${s.name}\`, the changed service` });
    break;
  }
  for (const b of ctx.blast.filter((x) => !x.allHard && x.hops === 1)) {
    const who = pick(b.service);
    if (!who) continue;
    seen.add(who);
    cc.push({ login: who, team: b.team, reason: `owns \`${b.service}\`, which calls it through a soft edge` });
    if (cc.length >= 2) break;
  }
  return { reviewers, cc };
}

function planChecks(ctx) {
  const { change, blast, incidents, intent } = ctx;
  const checks = [];
  const hard = blast.filter((b) => b.allHard);
  const soft = blast.filter((b) => !b.allHard);
  const top = change.services[0]?.name;

  if (change.breakingChanges.length) {
    const files = [...new Set(change.breakingChanges.map((c) => c.file))];
    checks.push(`Run a proto breaking-change check on ${files.map((f) => `\`${f}\``).join(', ')} (e.g. \`buf breaking --against '.git#branch=main'\`)`);
    const consumers = hard.filter((b) => b.hops === 1).map((b) => `\`${b.service}\``);
    const c = change.breakingChanges[0];
    if (consumers.length) {
      checks.push(`Migrate ${consumers.join(', ')} off \`${c.message}.${c.field}\` and deploy ${consumers.length > 1 ? 'them' : 'it'} first, or keep the field until ${consumers.length > 1 ? 'they do' : 'it does'}`);
    }
  }
  if (hard.some((b) => b.tier === 1)) {
    checks.push('Run the end-to-end checkout probes against a staging stack: `make run-telemetry-tests`');
  }
  if (soft.some((b) => b.service === 'frontend')) {
    checks.push(`Load the product page with \`${top}\` failing and confirm the frontend fallback holds (\`make run-frontend-tests\`)`);
  }
  if (soft.length && !hard.length) {
    checks.push(`Watch \`${top}\` error rate and latency after deploy; ${soft.filter((b) => b.hops === 1).map((b) => `\`${b.service}\``).join(', ')} won't page on it`);
  }
  for (const m of incidents.filter((x) => x.strength === 'match').slice(0, 2)) {
    for (const c of (m.incident.checks || []).slice(0, 1)) checks.push(`${c} _(from ${m.incident.id})_`);
  }
  if (intent?.status === 'mismatch') {
    checks.push(`Split the out-of-scope change into its own PR, or update ${intent.key} so reviewers know it's intended`);
  }
  if (change.migrations.length) checks.push('Run migrations against a production snapshot and confirm the rollback path');
  if (change.ci?.state === 'failure') checks.push('Fix failing CI before review');
  return [...new Set(checks)].slice(0, 7);
}

function pickTicket(t) {
  return { key: t.key, summary: t.summary, status: t.status, components: t.components, url: t.url };
}

function diffSummary(change) {
  return [
    `Services: ${change.serviceNames.join(', ')}`,
    ...change.contractChanges.map((c) => `Contract: ${c.detail}`),
    ...change.apiSurface.map((a) => `API handler touched: ${a.service}.${a.symbol}`),
    `Size: +${change.size.additions} -${change.size.deletions} in ${change.size.files} files`,
  ].join('\n');
}

const join = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);
