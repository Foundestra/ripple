// Planning signal: does the diff match the linked ticket's stated intent and scope?
// Deterministic heuristics run on every PR; the intent agent can add an LLM
// assessment on top for medium/high risk PRs.

const ADDITIVE_RE = /\b(additive|backwards?[- ]compatible|existing (consumers|clients|fields)|must keep working|no existing fields)\b/i;

export function checkIntent({ ticket, ticketKey, change }) {
  if (!ticket) {
    return {
      status: 'missing',
      key: ticketKey,
      reasons: [ticketKey ? `Linked ticket ${ticketKey} was not found` : 'No ticket linked in the PR title, branch or body'],
      covered: [],
    };
  }

  const text = `${ticket.summary}\n${ticket.description}\n${(ticket.acceptance || []).join('\n')}`;
  const lower = text.toLowerCase();
  const mentioned = (name) => {
    const variants = [name, name.replace(/_/g, ' '), camel(name)].map((v) => v.toLowerCase());
    return variants.some((v) => lower.includes(v));
  };

  const reasons = [];
  const covered = [];
  let severe = false;

  const components = (ticket.components || []).map((c) => c.toLowerCase());
  const outOfScope = change.serviceNames.filter((s) => components.length && !components.includes(s.toLowerCase()));
  if (outOfScope.length) {
    reasons.push(`Touches ${list(outOfScope)}, outside ${ticket.key}'s components (${list(ticket.components)})`);
  }

  for (const c of change.contractChanges) {
    if (c.breaking) {
      if (!mentioned(c.field)) {
        severe = true;
        reasons.push(`${c.detail.replace(/ \(field \d+\)$/, '')}; ${ticket.key} never mentions \`${c.field}\``);
      }
      if (ADDITIVE_RE.test(text)) {
        severe = true;
        reasons.push(`${ticket.key} says the change is additive only, but this is a breaking contract change`);
      }
    } else if (mentioned(c.field)) {
      covered.push(`${c.detail.replace(/ \(field \d+\)$/, '')}, as ${ticket.key} asks`);
    }
  }

  if (/\bno (api|contract)\b|copy only|text only/i.test(text) && (change.apiSurface.length || change.contractChanges.length)) {
    severe = true;
    reasons.push(`${ticket.key} rules out API changes, but the diff changes ${change.apiSurface[0]?.symbol ? `\`${change.apiSurface[0].symbol}\`` : 'a contract'}`);
  }

  if (!reasons.length && change.serviceNames.length) covered.push(`Scope matches ${ticket.key} (${list(ticket.components)})`);

  return {
    status: severe ? 'mismatch' : reasons.length ? 'partial' : 'match',
    key: ticket.key,
    ticket,
    reasons: [...new Set(reasons)],
    covered,
  };
}

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const list = (xs) => xs.map((x) => `\`${x}\``).join(', ');
