#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createRipple } from './app.js';
import { listFixtures, loadFixturePr, prFromPatch } from './adapters/fixtures.js';
import { runExperiment } from './experiments/runner.js';

const USAGE = `ripple <command>

  analyze --fixture pr1|pr2|pr3        Analyze a bundled demo PR and print the comment
  analyze --patch file.patch [--title "..."] [--body "..."] [--author x]
  analyze --all                        Analyze all demo PRs (summary table)
  graph                                Print the current dependency graph and its source
  graph snapshot                       Save the live graph as data/graph-snapshot.json
  experiment --flag paymentFailure --target payment [--variant 100%] [--flagd-file path]
             [--baseline 60] [--duration 60] [--recovery 60]
                                       Run a failure-injection experiment and record hard/soft verdicts

Common flags: --json (machine-readable output), --source prometheus|jaeger|seeded|auto`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      fixture: { type: 'string' },
      patch: { type: 'string' },
      title: { type: 'string', default: '' },
      body: { type: 'string', default: '' },
      author: { type: 'string', default: 'unknown' },
      all: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      source: { type: 'string' },
      flag: { type: 'string' },
      target: { type: 'string' },
      variant: { type: 'string' },
      'flagd-file': { type: 'string' },
      baseline: { type: 'string', default: '60' },
      duration: { type: 'string', default: '60' },
      recovery: { type: 'string', default: '60' },
      step: { type: 'string', default: '5' },
    },
  });

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return;
  }

  const overrides = { log: { error() {}, info() {} } };
  if (values.source) overrides.graph = { source: values.source, refreshSec: 0 };
  else overrides.graph = { refreshSec: 0 };
  const ripple = await createRipple(overrides);
  const { orchestrator, config, graphService } = ripple;

  if (cmd === 'analyze') {
    if (values.all) {
      const rows = [];
      for (const f of listFixtures(config.fixturesDir)) {
        const a = await orchestrator.analyze(loadFixturePr(config.fixturesDir, f.id));
        rows.push({ pr: f.id, title: f.title, expected: f.demo?.expected, verdict: a.level, score: a.gate.score, ms: a.timings.totalMs });
      }
      if (values.json) console.log(JSON.stringify(rows, null, 2));
      else console.table(rows);
      return;
    }
    let pr;
    if (values.fixture) pr = loadFixturePr(config.fixturesDir, values.fixture);
    else if (values.patch) pr = prFromPatch({ patch: fs.readFileSync(values.patch, 'utf8'), title: values.title, body: values.body, author: values.author });
    if (!pr) throw new Error('analyze needs --fixture <id>, --patch <file> or --all');
    const a = await orchestrator.analyze(pr);
    console.log(values.json ? JSON.stringify(a, null, 2) : a.comment);
    return;
  }

  if (cmd === 'graph') {
    const g = graphService.graph;
    if (positionals[0] === 'snapshot') {
      if (g.source === 'seeded') throw new Error('Current graph is already the seeded snapshot; point --source at prometheus or jaeger');
      const file = `${config.dataDir}/graph-snapshot.json`;
      const edges = g.edges.filter((e) => e.origin !== 'manual').map(({ from, to, protocol, calls_per_min, error_rate, last_seen }) => ({ from, to, protocol, calls_per_min, error_rate, last_seen }));
      fs.writeFileSync(file, JSON.stringify({ description: `Snapshot of the live ${g.source} graph`, captured_at: g.capturedAt, edges }, null, 2) + '\n');
      console.log(`Saved ${edges.length} edges from ${g.source} to ${file}`);
      return;
    }
    if (values.json) {
      console.log(JSON.stringify(g.toJSON(), null, 2));
      return;
    }
    console.log(`source: ${g.source}${g.stale ? ` (fallback: ${g.error})` : ''}  captured: ${g.capturedAt}`);
    console.table(g.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, by: e.kind_source, calls_per_min: e.calls_per_min, error_rate: e.error_rate })));
    return;
  }

  if (cmd === 'experiment') {
    if (!values.flag || !values.target) throw new Error('experiment needs --flag and --target');
    const result = await runExperiment({
      config,
      graph: graphService.graph,
      flag: values.flag,
      target: values.target,
      variant: values.variant,
      flagdFile: values['flagd-file'],
      baselineSec: Number(values.baseline),
      durationSec: Number(values.duration),
      recoverySec: Number(values.recovery),
      stepSec: Number(values.step),
      log: (m) => console.log(m),
    });
    console.table(result.verdicts);
    return;
  }

  console.log(USAGE);
  process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(`ripple: ${err.message}`);
    process.exit(1);
  });
