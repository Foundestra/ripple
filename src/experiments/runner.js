import fs from 'node:fs';
import path from 'node:path';
import { fetchJson } from '../adapters/graphSources.js';

// Failure-injection experiment:
//   1. measure baseline error rates for the target and everything up to 2 hops upstream
//   2. flip a flagd flag (e.g. paymentFailure) by editing the demo's flagd JSON
//   3. keep sampling while the failure is injected, then restore the flag
//   4. for every upstream edge u -> v: if v's errors rose and u's errors rose with it,
//      the edge is HARD; if u stayed flat, it is SOFT (u degrades gracefully)
// Results land in data/experiments/<flag>.json and feed edge classification + the replay chart.

const SPAN_CALLS = process.env.RIPPLE_SPANMETRICS_CALLS || 'traces_span_metrics_calls_total';
const SPAN_SERVICE_LABEL = process.env.RIPPLE_SPANMETRICS_SERVICE_LABEL || 'service_name';

export async function runExperiment({ config, graph, flag, target, variant, flagdFile, baselineSec, durationSec, recoverySec, stepSec = 5, log = console.log }) {
  const prom = config.graph.prometheusUrl.replace(/\/$/, '');
  const q = async (expr) => {
    const body = await fetchJson(`${prom}/api/v1/query?query=${encodeURIComponent(expr)}`);
    const v = body.data?.result?.[0]?.value?.[1];
    return v === undefined || v === 'NaN' ? 0 : Number(v);
  };
  await q('up'); // fail fast if Prometheus is unreachable

  const callers = graph.callersOf(target).map((e) => e.from);
  const grand = callers.flatMap((c) => graph.callersOf(c).map((e) => ({ from: e.from, to: c })));
  const edges = [...callers.map((c) => ({ from: c, to: target })), ...grand];
  const services = [...new Set([target, ...edges.map((e) => e.from)])];

  const serviceErr = (s) =>
    q(
      `sum(rate(${SPAN_CALLS}{${SPAN_SERVICE_LABEL}="${s}",status_code="STATUS_CODE_ERROR"}[30s])) / sum(rate(${SPAN_CALLS}{${SPAN_SERVICE_LABEL}="${s}"}[30s]))`,
    );
  const edgeErr = (e) =>
    q(
      `sum(rate(${config.graph.failedMetric}{client="${e.from}",server="${e.to}"}[30s])) / sum(rate(${config.graph.requestMetric}{client="${e.from}",server="${e.to}"}[30s]))`,
    );

  const series = [
    ...services.map((s) => ({ id: `service:${s}`, label: `${s} span errors`, role: s === target ? 'target' : 'upstream', values: [] })),
    ...edges.map((e) => ({ id: `edge:${e.from}->${e.to}`, label: `${e.from} → ${e.to} call errors`, role: 'edge', values: [] })),
  ];
  const sample = async () => {
    const values = await Promise.all([...services.map(serviceErr), ...edges.map(edgeErr)]);
    values.forEach((v, i) => series[i].values.push(Math.round(v * 10000) / 10000));
  };

  const flagdPath = flagdFile ? path.resolve(flagdFile) : null;
  const original = flagdPath ? fs.readFileSync(flagdPath, 'utf8') : null;
  const setFlag = (on) => {
    if (!flagdPath) {
      log(on ? `>>> Turn ON flag "${flag}" now (no --flagd-file given)` : `>>> Turn OFF flag "${flag}" now`);
      return;
    }
    if (!on) {
      fs.writeFileSync(flagdPath, original);
      return;
    }
    const doc = JSON.parse(original);
    const f = doc.flags?.[flag];
    if (!f) throw new Error(`Flag ${flag} not found in ${flagdPath}`);
    const v = variant || (f.variants['100%'] !== undefined ? '100%' : 'on');
    if (f.variants[v] === undefined) throw new Error(`Variant ${v} not in ${Object.keys(f.variants).join(', ')}`);
    f.defaultVariant = v;
    fs.writeFileSync(flagdPath, JSON.stringify(doc, null, 2) + '\n');
  };

  const steps = (sec) => Math.max(1, Math.round(sec / stepSec));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const phase = async (name, sec) => {
    log(`[${name}] ${sec}s`);
    for (let i = 0; i < steps(sec); i++) {
      await sample();
      await sleep(stepSec * 1000);
    }
  };

  let onAt, offAt;
  try {
    await phase('baseline', baselineSec);
    onAt = series[0].values.length * stepSec;
    setFlag(true);
    await phase(`inject ${flag}`, durationSec);
  } finally {
    offAt = series[0].values.length * stepSec;
    setFlag(false);
  }
  await phase('recovery', recoverySec);

  const nb = steps(baselineSec);
  const nd = steps(durationSec);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const errOf = (s) => {
    const v = series.find((x) => x.id === `service:${s}`).values;
    // skip the first samples of the window while rates catch up
    return { base: mean(v.slice(0, nb)), during: mean(v.slice(nb + 2, nb + nd)) };
  };
  const rose = ({ base, during }) => during - base > 0.05 && during > base * 2;

  const verdicts = edges
    .filter((e) => rose(errOf(e.to)))
    .map((e) => {
      const u = errOf(e.from);
      const hard = rose(u);
      return {
        from: e.from,
        to: e.to,
        baseline_error: round(u.base),
        during_error: round(u.during),
        result: hard ? 'hard' : 'soft',
        evidence: `${e.from} error rate ${pct(u.base)} → ${pct(u.during)} while ${e.to} was failing`,
      };
    });

  const out = {
    flag,
    variant: variant || null,
    target,
    origin: 'recorded',
    recorded_at: new Date().toISOString(),
    step_sec: stepSec,
    window: { on_at: onAt, off_at: offAt },
    series,
    verdicts,
  };
  const dir = path.join(config.dataDir, 'experiments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${flag}.json`), JSON.stringify(out, null, 2) + '\n');
  log(`Recorded ${verdicts.length} verdicts to data/experiments/${flag}.json`);
  return out;
}

const round = (n) => Math.round(n * 10000) / 10000;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
