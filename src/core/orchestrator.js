import { analyzeChange } from './changeRisk.js';
import { checkIntent } from './intent.js';
import { classifyRisk } from './riskGate.js';
import { runAgents, headline } from './agents.js';
import { renderComment } from './comment.js';
import { findTicketKey } from '../adapters/planning.js';
import { IncidentRecall } from '../adapters/incidents.js';

// PR review flow: 3 signal families fetched in parallel -> 1 risk gate -> agents
// (skipped for LOW) -> one comment.
//
// `pr` is { title, body, branch, author, number, repo, files: [normalized diff files], ci: { state } }
export class Orchestrator {
  constructor({ config, catalog, graphService, planning, incidentSource, llm }) {
    this.config = config;
    this.catalog = catalog;
    this.graphService = graphService;
    this.planning = planning;
    this.incidentSource = incidentSource;
    this.llm = llm;
  }

  async analyze(pr, { onEvent = () => {} } = {}) {
    const t0 = performance.now();
    const timed = async (name, fn) => {
      onEvent({ stage: 'signal', name, status: 'running' });
      const s = performance.now();
      try {
        const value = await fn();
        const ms = Math.round(performance.now() - s);
        onEvent({ stage: 'signal', name, status: 'done', ms });
        return { value, ms, name };
      } catch (err) {
        const ms = Math.round(performance.now() - s);
        onEvent({ stage: 'signal', name, status: 'error', ms, error: err.message });
        return { value: null, ms, name, error: err.message };
      }
    };

    // Change risk is local and cheap; the other families need it to know which services to ask about.
    const change = analyzeChange({ files: pr.files, catalog: this.catalog, ci: pr.ci });
    const ticketKey = findTicketKey(pr.title, pr.branch, pr.body);

    const [planningSig, codeSig, buildSig] = await Promise.all([
      timed('planning', async () => {
        const ticket = ticketKey ? await this.planning.getTicket(ticketKey) : null;
        return checkIntent({ ticket, ticketKey, change });
      }),
      timed('code', async () => {
        const perService = await Promise.all(change.serviceNames.map((s) => this.graphService.upstream(s)));
        return mergeBlast(perService, change.serviceNames);
      }),
      timed('build', async () => {
        const incidents = await this.incidentSource.all();
        const recall = new IncidentRecall(incidents, { ...this.config.incidents, serviceNames: [...this.catalog.services.keys()] });
        return recall.recall({ queryText: queryText(pr, change), changedServices: change.serviceNames });
      }),
    ]);

    const intent = planningSig.value ?? { status: 'missing', key: ticketKey, reasons: [`Planning lookup failed: ${planningSig.error}`], covered: [] };
    const blast = codeSig.value ?? [];
    const incidents = buildSig.value ?? [];

    const gateStart = performance.now();
    const gate = classifyRisk({ change, blast, incidents, intent, catalog: this.catalog });
    const gateMs = Math.round(performance.now() - gateStart);
    onEvent({ stage: 'gate', level: gate.level, score: gate.score, ms: gateMs });

    const ctx = { pr, change, blast, incidents, intent, gate, catalog: this.catalog, maxHops: this.config.graph.maxHops };
    ctx.headline = headline(ctx);

    const { results, trace: agentTrace } = await runAgents(ctx, this.llm, { onEvent });
    const finalHeadline = results.narrator?.headline || ctx.headline;

    const graph = this.graphService.graph;
    const analysis = {
      pr: { number: pr.number, title: pr.title, author: pr.author, branch: pr.branch, repo: pr.repo, url: pr.url, fixture: pr.fixture },
      level: gate.level,
      headline: finalHeadline,
      gate,
      change,
      blast,
      incidents: incidents.map((m) => ({ ...m, incident: m.incident })),
      intent: { ...intent, ticket: intent.ticket ? { key: intent.ticket.key, summary: intent.ticket.summary } : null },
      agents: results,
      trace: {
        signals: [planningSig, codeSig, buildSig].map((s) => ({ name: s.name, ms: s.ms, error: s.error || null })),
        gate: { ms: gateMs, level: gate.level, score: gate.score },
        agents: agentTrace,
      },
      sources: {
        graph: graph?.source,
        graphStale: graph?.stale,
        graphStore: this.config.graph.store,
        planning: this.planning.name,
        incidents: this.incidentSource.name,
        llm: this.llm.name,
      },
      timings: { totalMs: 0 },
      createdAt: new Date().toISOString(),
    };
    analysis.timings.totalMs = Math.round(performance.now() - t0);
    analysis.comment = renderComment(analysis);
    onEvent({ stage: 'done', level: gate.level, ms: analysis.timings.totalMs });
    return analysis;
  }
}

// Union of blast radius across all changed services, excluding the changed services themselves.
function mergeBlast(perService, changed) {
  const best = new Map();
  for (const rows of perService) {
    for (const r of rows) {
      if (changed.includes(r.service)) continue;
      const cur = best.get(r.service);
      if (!cur || (r.allHard && !cur.allHard) || (r.allHard === cur.allHard && r.hops < cur.hops)) best.set(r.service, r);
    }
  }
  return [...best.values()].sort((a, b) => Number(b.allHard) - Number(a.allHard) || a.tier - b.tier || a.hops - b.hops || a.service.localeCompare(b.service));
}

function queryText(pr, change) {
  return [
    pr.title,
    pr.body,
    change.serviceNames.join(' '),
    change.contractChanges.map((c) => `${c.message} ${c.field} ${c.kind} contract proto`).join(' '),
    change.breakingChanges.length ? 'breaking-change breaking contract' : '',
    change.apiSurface.map((a) => a.symbol).join(' '),
    change.migrations.length ? 'migration schema' : '',
  ].join('\n');
}
