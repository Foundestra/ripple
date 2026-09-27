// Small TF-IDF + cosine similarity index. Deterministic and dependency-free, so
// incident recall works offline. An embedding provider can replace it behind
// the same `search(query)` interface.

const STOP = new Set(
  'a an and are as at be but by for from has have in into is it its of on or that the this to was were will with we our not no only after before when while then than so if all any can'.split(' '),
);

export function tokenize(text) {
  return (text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase -> camel Case
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export class TfIdfIndex {
  // ignore: extra terms to drop (e.g. service names, so sharing a service alone isn't similarity)
  constructor(docs, { ignore = [] } = {}) {
    this.ignore = new Set(ignore);
    this.docs = docs.map((d) => ({ id: d.id, tf: termFreq(this.#tokens(d.text)) }));
    const df = new Map();
    for (const d of this.docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    const n = this.docs.length;
    this.idf = new Map([...df].map(([t, c]) => [t, Math.log((n + 1) / (c + 1)) + 1]));
    for (const d of this.docs) d.vec = this.#weigh(d.tf);
  }

  #tokens(text) {
    return tokenize(text).filter((t) => !this.ignore.has(t));
  }

  #weigh(tf) {
    const v = new Map();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * (this.idf.get(t) ?? 0);
      if (w > 0) {
        v.set(t, w);
        norm += w * w;
      }
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  }

  search(text) {
    const q = this.#weigh(termFreq(this.#tokens(text)));
    return this.docs
      .map((d) => {
        let s = 0;
        const shared = [];
        for (const [t, w] of q) {
          const dw = d.vec.get(t);
          if (dw) {
            s += w * dw;
            shared.push(t);
          }
        }
        return { id: d.id, score: s, shared };
      })
      .sort((a, b) => b.score - a.score);
  }
}

function termFreq(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}
