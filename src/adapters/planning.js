import fs from 'node:fs';
import path from 'node:path';

// Planning adapters: both return a ticket in the same shape
//   { key, summary, description, type, status, components[], assignee, acceptance[], url }

export const TICKET_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/;

export function findTicketKey(...texts) {
  for (const t of texts) {
    const m = (t || '').match(TICKET_KEY);
    if (m) return m[1];
  }
  return null;
}

export class SeededJira {
  name = 'seeded';
  constructor({ dataDir }) {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'jira', 'tickets.json'), 'utf8'));
    this.tickets = new Map(raw.tickets.map((t) => [t.key, t]));
  }

  async getTicket(key) {
    const t = this.tickets.get(key);
    return t ? { ...t, url: null } : null;
  }
}

export class JiraCloud {
  name = 'jira';
  constructor({ jiraUrl, jiraEmail, jiraToken }) {
    this.url = jiraUrl.replace(/\/$/, '');
    this.auth = 'Basic ' + Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');
  }

  async getTicket(key) {
    const res = await fetch(`${this.url}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,status,components,assignee`, {
      headers: { Authorization: this.auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Jira ${key}: HTTP ${res.status}`);
    const { fields } = await res.json();
    const description = adfToText(fields.description);
    return {
      key,
      summary: fields.summary,
      description,
      type: fields.issuetype?.name,
      status: fields.status?.name,
      components: (fields.components || []).map((c) => c.name),
      assignee: fields.assignee?.displayName,
      acceptance: [],
      url: `${this.url}/browse/${key}`,
    };
  }
}

// Jira Cloud returns descriptions as Atlassian Document Format.
function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text;
  return (node.content || []).map(adfToText).join(node.type === 'paragraph' ? '\n' : ' ');
}

export function createPlanningAdapter(config) {
  return config.planning.source === 'jira' && config.planning.jiraUrl ? new JiraCloud(config.planning) : new SeededJira(config);
}
