import fs from 'node:fs';
import path from 'node:path';
import { fetchJson } from '../adapters/graphSources.js';
import { MOCK_APP } from '../mock/otelMock.js';

// Failure-injection experiment:
//   1. measure baseline rates for the target and everything up to 2 hops upstream
//   2. flip a flagd flag (e.g. paymentFailure) by editing the demo's flagd JSON
//   3. keep sampling while the failure is injected, then restore the flag
//   4. for every upstream edge u -> v whose calls started failing, measure PROPAGATION:
//        extra failed requests served by u  /  extra failed calls from u to v
//      ~1 means every failed call to v became a failed request of u (HARD edge);
//      ~0 means u absorbed the failures (SOFT edge, u degrades gracefully).
//      Using u's overall error rate instead would misread busy callers: frontend
//      serves far more than checkout traffic, so its error rate barely moves even
//      though every checkout failure reaches the user.
// Results land in <dataDir>/runtime/experiments/<flag>.json (git-ignored) and feed
// edge classification + the replay chart. Copy a file to data/experiments/ to commit it.

const SPAN_CALLS = process.env.RIPPLE_SPANMETRICS_CALLS || 'traces_span_metrics_calls_total';
const SPAN_SERVICE_LABEL = process.env.RIPPLE_SPANMETRICS_SERVICE_LABEL || 'service_name';
export const HARD_PROPAGATION = 0.4;

export async function runExperiment({ config, graph, flag, target, variant, flagdFile, baselineSec, durationSec, recoverySec, stepSec = 5, outDir, log = console.log }) {
  const prom = config.graph.prometheusUrl.replace(/\/$/, '');
  const req = config.graph.requestMetric;
  const failed = config.graph.failedMetric;
  const q = async (expr) => {
    const body = await fetchJson(`${prom}/api/v1/query?query=${encodeURIComponent(expr)}`);
    const v = body.data?.result?.[0]?.value?.[1];
    return v === undefined || v === 'NaN' ? 0 : Number(v);
  };
  await q('up'); // fail fast if Prometheus is unreachable
  const build = await fetchJson(`${prom}/api/v1/status/buildinfo`).catch(() => null);
  const environment = build?.data?.application === MOCK_APP ? 'mock' : 'live';

  const callers = graph.callersOf(target).map((e) => e.from);
  const grand = callers.flatMap((c) => graph.callersOf(c).map((e) => ({ from: e.from, to: c })));
  const edges = [...callers.map((c) => ({ from: c, to: target })), ...grand];
  const services = [...new Set([target, ...edges.map((e) => e.from)])];

  // Chart series (error ratios) ...
  const serviceErr = (s) =>
    q(`sum(rate(${SPAN_CALLS}{${SPAN_SERVICE_LABEL}="${s}",status_code="STATUS_CODE_ERROR"}[30s])) / sum(rate(${SPAN_CALLS}{${SPAN_SERVICE_LABEL}="${s}"}[30s]))`);
  const edgeErr = (e) => q(`sum(rate(${failed}{client="${e.from}",server="${e.to}"}[30s])) / sum(rate(${req}{client="${e.from}",server="${e.to}"}[30s]))`);
  // ... and absolute failure rates (per second) for the verdicts.
  const inboundFailed = (s) => q(`sum(rate(${failed}{server="${s}"}[30s]))`);
  const edgeFailed = (e) => q(`sum(rate(${failed}{client="${e.from}",server="${e.to}"}[30s]))`);

  const series = [
    ...services.map((s) => ({ id: `service:${s}`, label: `${s} span errors`, role: s === target ? 'target' : callers.includes(s) ? 'upstream' : 'context', values: [] })),
    ...edges.map((e) => ({ id: `edge:${e.from}->${e.to}`, label: `${e.from} → ${e.to} call errors`, role: e.to === target ? 'edge' : 'upstream-edge', values: [] })),
  ];
  const raw = { inbound: Object.fromEntries(services.map((s) => [s, []])), edge: Object.fromEntries(edges.map((e) => [`${e.from}->${e.to}`, []])) };
  const sample = async () => {
    const [ratios, inb, ef] = await Promise.all([
      Promise.all([...services.map(serviceErr), ...edges.map(edgeErr)]),
      Promise.all(services.map(inboundFailed)),
      Promise.all(edges.map(edgeFailed)),
    ]);
    ratios.forEach((v, i) => series[i].values.push(round(v)));
    services.forEach((s, i) => raw.inbound[s].push(inb[i]));
    edges.forEach((e, i) => raw.edge[`${e.from}->${e.to}`].push(ef[i]));
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
  // skip the first samples of the window while rate() windows catch up
  const split = (xs) => ({ base: mean(xs.slice(0, nb)), during: mean(xs.slice(nb + Math.min(2, nd - 1), nb + nd)) });
  const ratioOf = (s) => split(series.find((x) => x.id === `service:${s}`).values);

  const verdicts = [];
  for (const e of edges) {
    const k = `${e.from}->${e.to}`;
    const callFail = split(raw.edge[k]);
    const extraCallFailures = callFail.during - callFail.base;
    if (extraCallFailures <= 1e-6 || callFail.during < callFail.base * 2) continue; // calls to e.to didn't start failing
    const served = split(raw.inbound[e.from]);
    const propagation = Math.max(0, Math.min(1, (served.during - served.base) / extraCallFailures));
    const u = ratioOf(e.from);
    const hard = propagation >= HARD_PROPAGATION;
    verdicts.push({
      from: e.from,
      to: e.to,
      propagation: round(propagation),
      baseline_error: round(u.base),
      during_error: round(u.during),
      result: hard ? 'hard' : 'soft',
      evidence: `${Math.round(propagation * 100)}% of failed calls to ${e.to} surfaced as failed ${e.from} requests (${e.from} errors ${pct(u.base)} → ${pct(u.during)})`,
    });
  }

  const out = {
    flag,
    variant: variant || null,
    target,
    origin: 'recorded',
    environment,
    source: prom,
    recorded_at: new Date().toISOString(),
    step_sec: stepSec,
    window: { on_at: onAt, off_at: offAt },
    series,
    verdicts,
  };
  const dir = outDir || path.join(config.dataDir, 'runtime', 'experiments');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${flag}.json`), JSON.stringify(out, null, 2) + '\n');
  log(`Recorded ${verdicts.length} verdicts (${environment}) to ${path.relative(process.cwd(), path.join(dir, `${flag}.json`))}`);
  return out;
}

const round = (n) => Math.round(n * 10000) / 10000;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
