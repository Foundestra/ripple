import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRipple } from '../src/app.js';

// Runs only against a real Postgres: RIPPLE_TEST_DATABASE_URL=postgres://... npm test
const url = process.env.RIPPLE_TEST_DATABASE_URL;

test('Postgres recursive-CTE blast radius matches the in-memory graph', { skip: !url && 'set RIPPLE_TEST_DATABASE_URL' }, async () => {
  const { graphService } = await createRipple({ graph: { source: 'seeded', store: 'postgres', refreshSec: 0 }, postgresUrl: url, llm: { provider: 'none' } });
  try {
    const g = graphService.graph;
    for (const n of g.nodes()) {
      for (const hops of [1, 2, 3]) {
        const mem = g.upstream(n.name, hops).map((r) => [r.service, r.hops, r.allHard]);
        const pg = (await graphService.upstream(n.name, hops)).map((r) => [r.service, r.hops, r.allHard]);
        assert.deepEqual(pg, mem, `${n.name} @ ${hops} hops`);
      }
    }
  } finally {
    await graphService.stop();
  }
});
