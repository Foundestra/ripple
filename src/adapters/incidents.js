import fs from 'node:fs';
import path from 'node:path';
import { TfIdfIndex } from '../core/similarity.js';

// Incident + RCA memory. Seeded from data/incidents; a PagerDuty / incident.io
// adapter would implement `all()` with the same shape.
export class SeededIncidents {
  name = 'seeded';
  constructor({ dataDir }) {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'incidents', 'incidents.json'), 'utf8'));
    this.incidents = raw.incidents;
  }

  async all() {
    return this.incidents;
  }
}

export function incidentText(i) {
  return [i.title, i.summary, i.rca, (i.watch_for || []).join(' '), (i.tags || []).join(' '), (i.services || []).join(' ')].join('\n');
}

// Recall: text similarity between the change and each incident, boosted when the
// incident involved the changed service itself.
export class IncidentRecall {
  constructor(incidents, { matchThreshold, relatedThreshold, serviceNames = [] }) {
    this.incidents = new Map(incidents.map((i) => [i.id, i]));
    // Service overlap is scored separately below; as text it would make every
    // change to a service "similar" to every incident in that service.
    const ignore = serviceNames.filter((n) => !n.includes('-')).map((n) => n.toLowerCase());
    this.index = new TfIdfIndex(
      incidents.map((i) => ({ id: i.id, text: incidentText(i) })),
      { ignore },
    );
    this.matchThreshold = matchThreshold;
    this.relatedThreshold = relatedThreshold;
  }

  recall({ queryText, changedServices }) {
    return this.index
      .search(queryText)
      .map((r) => {
        const inc = this.incidents.get(r.id);
        const overlap = (inc.services || []).filter((s) => changedServices.includes(s));
        // The first service listed is where the incident started.
        const origin = changedServices.includes(inc.services?.[0]);
        const score = r.score > 0 ? Math.min(1, r.score + (origin ? 0.1 : overlap.length ? 0.05 : 0)) : 0;
        return {
          incident: inc,
          score: Math.round(score * 100) / 100,
          textScore: Math.round(r.score * 100) / 100,
          sharedTerms: r.shared.slice(0, 8),
          serviceOverlap: overlap,
          strength: score >= this.matchThreshold ? 'match' : score >= this.relatedThreshold ? 'related' : 'none',
        };
      })
      .filter((r) => r.strength !== 'none')
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }
}
