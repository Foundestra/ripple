// Ripple presenter dashboard. Plain ES modules, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const SVG = 'http://www.w3.org/2000/svg';
const api = async (path, opts) => {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};
const el = (tag, attrs = {}, ...kids) => {
  const n = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.setAttribute('class', v);
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
};
const pct = (x) => `${(x * 100).toFixed(x < 0.01 && x > 0 ? 1 : 0)}%`;

const state = { graph: null, status: null, experiments: [], prs: [], expIndex: 0, running: false };

/* ---------------- theme + navigation ---------------- */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('ripple-theme', t); } catch {}
  if (state.experiments.length) drawExperiment(false);
}
try { const t = localStorage.getItem('ripple-theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
$('#themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

const slides = $$('.slide');
const deck = $('#deck');
for (const s of slides) $('#steps').append(el('a', { href: `#${s.id}`, 'data-id': s.id, text: s.dataset.step }));
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) if (e.isIntersecting) for (const a of $$('#steps a')) a.classList.toggle('active', a.dataset.id === e.target.id);
  },
  { root: deck, threshold: 0.55 },
);
slides.forEach((s) => io.observe(s));
const current = () => {
  const top = deck.scrollTop;
  let idx = 0;
  slides.forEach((s, i) => { if (s.offsetTop - 80 <= top) idx = i; });
  return idx;
};
const go = (i) => slides[Math.max(0, Math.min(slides.length - 1, i))].scrollIntoView({ behavior: 'smooth' });

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || $('#diffDialog').open) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(current() + 1); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); go(current() - 1); }
  else if (['1', '2', '3'].includes(e.key)) {
    const pr = state.prs[Number(e.key) - 1];
    if (pr) { go(slides.findIndex((s) => s.id === 'prs')); runPr(pr); }
  } else if (e.key === 't' || e.key === 'T') $('#themeBtn').click();
  else if (e.key === 'r' || e.key === 'R') { if (current() === slides.findIndex((s) => s.id === 'experiment')) drawExperiment(true); }
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(slides.length - 1);
});

/* ---------------- dependency graph ---------------- */
function layout(graph) {
  const nodes = graph.nodes.filter((n) => n.kind !== 'synthetic');
  const names = new Set(nodes.map((n) => n.name));
  const edges = graph.edges.filter((e) => names.has(e.from) && names.has(e.to));
  const callers = new Map(nodes.map((n) => [n.name, []]));
  for (const e of edges) callers.get(e.to).push(e.from);
  // longest path from roots -> column
  const depth = new Map();
  const d = (n, seen = new Set()) => {
    if (depth.has(n)) return depth.get(n);
    if (seen.has(n)) return 0;
    seen.add(n);
    const v = callers.get(n).length ? Math.max(...callers.get(n).map((c) => d(c, seen) + 1)) : 0;
    depth.set(n, v);
    return v;
  };
  nodes.forEach((n) => d(n.name));
  const cols = [];
  for (const n of nodes) (cols[depth.get(n.name)] ||= []).push(n);
  // order within columns by barycenter of callers (two sweeps)
  const pos = new Map();
  cols.forEach((c) => c.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name)).forEach((n, i) => pos.set(n.name, i / Math.max(1, c.length - 1))));
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const c of cols.slice(1)) {
      const bc = (n) => { const cs = callers.get(n.name); return cs.length ? cs.reduce((s, x) => s + pos.get(x), 0) / cs.length : 0.5; };
      c.sort((a, b) => bc(a) - bc(b));
      c.forEach((n, i) => pos.set(n.name, c.length === 1 ? bc(n) : i / (c.length - 1)));
    }
  }
  const W = 1200, H = 640, padX = 90, padY = 50;
  const xy = new Map();
  cols.forEach((c, ci) => {
    const x = padX + (ci * (W - 2 * padX)) / Math.max(1, cols.length - 1);
    const span = Math.min(H - 2 * padY, (c.length - 1) * 88);
    c.forEach((n, i) => {
      const y = c.length === 1 ? H / 2 : H / 2 - span / 2 + (i * span) / (c.length - 1);
      xy.set(n.name, { x, y });
    });
  });
  return { nodes, edges, xy, W, H };
}

function drawGraph() {
  const g = state.graph;
  const svg = $('#graphSvg');
  svg.replaceChildren();
  const { nodes, edges, xy, W, H } = layout(g);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const NW = 132, NH = 40;
  const edgeLayer = el('svg:g');
  const badgeLayer = el('svg:g');
  const nodeLayer = el('svg:g');
  svg.append(edgeLayer, badgeLayer, nodeLayer);

  for (const e of edges) {
    const a = xy.get(e.from), b = xy.get(e.to);
    const x1 = a.x + NW / 2, x2 = b.x - NW / 2, mx = (x1 + x2) / 2;
    const d = `M${x1},${a.y} C${mx},${a.y} ${mx},${b.y} ${x2},${b.y}`;
    const path = el('svg:path', { d, class: `g-edge ${e.kind}`, 'data-from': e.from, 'data-to': e.to });
    const hit = el('svg:path', { d, class: 'g-edge-hit' });
    hit.addEventListener('mousemove', (ev) => showTip(ev, edgeTip(e)));
    hit.addEventListener('mouseleave', hideTip);
    edgeLayer.append(path, hit);
    if (e.kind_source === 'experiment' || e.kind_source === 'owner') {
      const t = 0.5, px = (1 - t) ** 3 * x1 + 3 * (1 - t) ** 2 * t * mx + 3 * (1 - t) * t ** 2 * mx + t ** 3 * x2;
      const py = (a.y + b.y) / 2;
      const badge = el('svg:g', { class: 'g-badge', 'data-from': e.from, 'data-to': e.to, transform: `translate(${px},${py})` },
        el('svg:circle', { r: 8, style: e.kind_source === 'owner' ? 'fill: var(--muted)' : '' }),
        el('svg:text', { y: 3, text: e.kind_source === 'owner' ? 'O' : '✓' }));
      badge.addEventListener('mousemove', (ev) => showTip(ev, edgeTip(e)));
      badge.addEventListener('mouseleave', hideTip);
      badgeLayer.append(badge);
    }
  }
  for (const n of nodes) {
    const p = xy.get(n.name);
    const infra = ['cache', 'queue', 'database', 'proxy'].includes(n.kind);
    const node = el('svg:g', { class: `g-node t${n.tier}${infra ? ' infra' : ''}`, 'data-name': n.name, transform: `translate(${p.x - NW / 2},${p.y - NH / 2})`, tabindex: 0, role: 'button', 'aria-label': `${n.name}, tier ${n.tier}` },
      el('svg:rect', { class: 'body', width: NW, height: NH, rx: 10 }),
      el('svg:text', { class: 'name', x: 12, y: 18, text: n.name }),
      el('svg:text', { class: 'tierlabel', x: 12, y: 32, text: `tier ${n.tier} · ${n.kind}` }));
    node.addEventListener('click', () => selectService(n.name));
    node.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') selectService(n.name); });
    nodeLayer.append(node);
  }
  svg.addEventListener('click', (ev) => { if (ev.target === svg) selectService(null); });

  const hard = g.edges.filter((e) => e.kind === 'hard').length;
  const live = g.source === 'prometheus' || g.source === 'jaeger';
  const services = g.nodes.filter((n) => n.kind !== 'synthetic').length;
  $('#graphSub').textContent = live
    ? `Rebuilt from live ${g.source === 'prometheus' ? 'OTel servicegraph metrics' : 'Jaeger traces'} across ${services} services, ${g.edges.length} edges (${hard} hard). Refreshed ${timeAgo(g.captured_at)}.`
    : `${services} services, ${g.edges.length} edges (${hard} hard). Showing the offline snapshot${g.stale ? ' because the live stack is unreachable' : ''}; start the OpenTelemetry Demo for live traces.`;
}

function edgeTip(e) {
  return [
    ['b', `${e.from} → ${e.to}`],
    ['row', 'edge', `${e.kind.toUpperCase()} (${e.kind_source})`],
    ['row', 'protocol', e.protocol],
    e.calls_per_min != null && ['row', 'calls/min', String(e.calls_per_min)],
    e.error_rate != null && ['row', 'error rate', pct(e.error_rate)],
    e.last_seen && ['row', 'last seen', timeAgo(e.last_seen)],
    ['p', e.kind_reason],
  ].filter(Boolean);
}

function selectService(name) {
  const svg = $('#graphSvg');
  $$('.g-node', svg).forEach((n) => n.classList.toggle('selected', n.dataset.name === name));
  $$('.hl', svg).forEach((n) => n.classList.remove('hl', 'flow'));
  const panel = $('#graphPanel');
  if (!name) {
    svg.classList.remove('focus');
    panel.replaceChildren(el('p', { class: 'muted', text: 'Click a service to see its blast radius: everything upstream that breaks or degrades if it fails.' }));
    return;
  }
  const g = state.graph;
  const rows = upstream(g, name, 3);
  svg.classList.add('focus');
  const onPath = new Set([name]);
  const edgeKeys = new Set();
  for (const r of rows) {
    r.path.forEach((p) => onPath.add(p));
    r.edges.forEach((e) => edgeKeys.add(`${e.from}->${e.to}`));
  }
  $$('.g-node', svg).forEach((n) => n.classList.toggle('hl', onPath.has(n.dataset.name)));
  $$('.g-edge, .g-badge', svg).forEach((p) => {
    const on = edgeKeys.has(`${p.dataset.from}->${p.dataset.to}`);
    p.classList.toggle('hl', on);
    if (on && p.classList.contains('g-edge')) p.classList.add('flow');
  });
  const n = g.nodes.find((x) => x.name === name);
  panel.replaceChildren(
    el('p', { class: 'eyebrow', text: 'Blast radius' }),
    el('h3', { text: name }),
    el('p', { class: 'muted', text: n.description || '' }),
    el('dl', { class: 'kv' },
      el('dt', { text: 'tier' }), el('dd', { text: String(n.tier) }),
      el('dt', { text: 'team' }), el('dd', { text: n.team || 'unowned' }),
      el('dt', { text: 'owners' }), el('dd', { text: (n.owners || []).join(', ') || '—' })),
    el('b', { text: rows.length ? `${rows.length} upstream service${rows.length > 1 ? 's' : ''} within 3 hops` : 'Nothing upstream depends on it' }),
    el('ul', {}, rows.map((r) =>
      el('li', {},
        el('b', { text: r.service }), el('span', { class: `impact ${r.allHard ? 'breaks' : 'degrades'}`, text: r.allHard ? 'breaks' : 'degrades' }),
        el('span', { class: 'path', text: [r.path[0], ...r.edges.map((e) => `${e.kind === 'hard' ? '⇒' : '⇢'} ${e.to}`)].join(' ') })))),
  );
}

// Client-side mirror of DependencyGraph.upstream() for interactive exploration.
function upstream(g, service, maxHops) {
  const best = new Map();
  const synthetic = new Set(g.nodes.filter((n) => n.kind === 'synthetic').map((n) => n.name));
  const tier = new Map(g.nodes.map((n) => [n.name, n.tier]));
  const walk = (node, chain, visited) => {
    if (chain.length >= maxHops) return;
    for (const e of g.edges.filter((x) => x.to === node && !synthetic.has(x.from))) {
      if (visited.has(e.from)) continue;
      const next = [e, ...chain];
      const allHard = next.every((x) => x.kind === 'hard');
      const cur = best.get(e.from);
      if (!cur || (allHard && !cur.allHard) || (allHard === cur.allHard && next.length < cur.edges.length)) best.set(e.from, { service: e.from, edges: next, allHard });
      walk(e.from, next, new Set([...visited, e.from]));
    }
  };
  walk(service, [], new Set([service]));
  return [...best.values()]
    .map((b) => ({ ...b, path: [b.edges[0].from, ...b.edges.map((x) => x.to)], tier: tier.get(b.service) }))
    .sort((a, b) => Number(b.allHard) - Number(a.allHard) || a.tier - b.tier || a.edges.length - b.edges.length);
}

/* ---------------- tooltip ---------------- */
function showTip(ev, lines) {
  const t = $('#tooltip');
  t.replaceChildren(...lines.map((l) => {
    if (l[0] === 'b') return el('b', { text: l[1] });
    if (l[0] === 'p') return el('p', { style: 'margin:6px 0 0;color:var(--ink-2)', text: l[1] });
    if (l[0] === 'swatch') return el('div', { class: 'row' }, el('span', {}, el('i', { style: `background:${l[3]}` }), l[1]), el('span', { text: l[2] }));
    return el('div', { class: 'row' }, el('span', { text: l[1] }), el('span', { text: l[2] }));
  }));
  t.hidden = false;
  const r = t.getBoundingClientRect();
  t.style.left = `${Math.min(ev.clientX + 14, innerWidth - r.width - 8)}px`;
  t.style.top = `${Math.min(ev.clientY + 14, innerHeight - r.height - 8)}px`;
}
const hideTip = () => ($('#tooltip').hidden = true);

/* ---------------- failure experiment ---------------- */
function renderExpTabs() {
  const tabs = $('#expTabs');
  tabs.replaceChildren(...state.experiments.map((x, i) =>
    el('button', { role: 'tab', 'aria-selected': String(i === state.expIndex), text: `${x.flag} → ${x.target}`, onclick: () => { state.expIndex = i; renderExpTabs(); drawExperiment(true); } })));
}

function drawExperiment(animate) {
  const x = state.experiments[state.expIndex];
  if (!x) return;
  const css = getComputedStyle(document.documentElement);
  const colors = ['--series-1', '--series-2', '--series-3'].map((v) => css.getPropertyValue(v).trim());
  // At most three series: the failing target and the callers whose fate decides the edge.
  const series = [x.series.find((s) => s.role === 'target'), ...x.series.filter((s) => s.role === 'upstream'), ...x.series.filter((s) => s.role === 'edge')]
    .filter(Boolean).slice(0, 3);
  const svg = $('#expChart');
  svg.replaceChildren();
  const W = svg.clientWidth || 800, H = svg.clientHeight || 360;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const m = { l: 44, r: 150, t: 16, b: 30 };
  const n = series[0].values.length;
  const tmax = (n - 1) * x.step_sec;
  const sx = (t) => m.l + (t / tmax) * (W - m.l - m.r);
  const sy = (v) => H - m.b - v * (H - m.t - m.b);

  $('#expTitle').textContent = `Error rate while ${x.flag} fails ${x.target}`;
  $('#expNote').textContent = x.origin === 'recorded' ? `Recorded ${new Date(x.recorded_at).toLocaleString()} against the live demo.` : x.note || '';

  const axis = el('svg:g', { class: 'axis' });
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    axis.append(el('svg:line', { class: 'gridline', x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }), el('svg:text', { x: m.l - 8, y: sy(v) + 4, 'text-anchor': 'end', text: `${v * 100}%` }));
  }
  for (let t = 0; t <= tmax; t += 30) axis.append(el('svg:text', { x: sx(t), y: H - 10, 'text-anchor': 'middle', text: `${t}s` }));
  axis.append(el('svg:line', { x1: m.l, x2: W - m.r, y1: sy(0), y2: sy(0) }));
  svg.append(
    el('svg:rect', { class: 'window', x: sx(x.window.on_at), y: m.t, width: sx(x.window.off_at) - sx(x.window.on_at), height: H - m.t - m.b }),
    el('svg:text', { class: 'window-label', x: sx(x.window.on_at) + 8, y: H - m.b - 10, text: `${x.flag} ON` }),
    axis,
  );

  $('#expLegend').replaceChildren(...series.map((s, i) => el('span', {}, el('i', { style: `background:${colors[i]}` }), s.label)));

  const lines = series.map((s, i) => {
    const d = s.values.map((v, j) => `${j ? 'L' : 'M'}${sx(j * x.step_sec).toFixed(1)},${sy(v).toFixed(1)}`).join('');
    const p = el('svg:path', { class: 'series', d, stroke: colors[i] });
    svg.append(p);
    return p;
  });
  // direct labels at line ends, nudged apart
  const ends = series.map((s, i) => ({ i, y: sy(s.values.at(-1)), label: s.label }));
  ends.sort((a, b) => b.y - a.y).forEach((e, k, arr) => { if (k && arr[k - 1].y - e.y < 15) e.y = arr[k - 1].y - 15; });
  const labels = ends.map((e) => el('svg:text', { class: 'direct-label', x: W - m.r + 8, y: e.y + 4, text: e.label.replace(/ (span|call) errors$/, '').replace(' PlaceOrder errors', '') }));
  svg.append(...labels);

  // hover layer: crosshair + tooltip
  const cross = el('svg:line', { class: 'crosshair', y1: m.t, y2: H - m.b, visibility: 'hidden' });
  const dots = series.map((_, i) => el('svg:circle', { r: 4, fill: colors[i], stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }));
  const hit = el('svg:rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
  svg.append(cross, ...dots, hit);
  hit.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const j = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1))));
    const X = sx(j * x.step_sec);
    cross.setAttribute('x1', X); cross.setAttribute('x2', X); cross.setAttribute('visibility', 'visible');
    dots.forEach((d, i) => { d.setAttribute('cx', X); d.setAttribute('cy', sy(series[i].values[j])); d.setAttribute('visibility', 'visible'); });
    const t = j * x.step_sec;
    const on = t >= x.window.on_at && t < x.window.off_at;
    showTip(ev, [['b', `t = ${t}s${on ? ` · ${x.flag} ON` : ''}`], ...series.map((s, i) => ['swatch', s.label, pct(s.values[j]), colors[i]])]);
  });
  hit.addEventListener('mouseleave', () => { hideTip(); cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); });

  // verdict cards
  const vs = $('#expVerdicts');
  vs.replaceChildren(...x.verdicts.map((v) =>
    el('div', { class: 'verdict' },
      el('span', { class: `tag ${v.result}`, text: v.result.toUpperCase() }),
      el('div', { class: 'edge', text: `${v.from} → ${v.to}` }),
      el('div', { class: 'delta' }, `${pct(v.baseline_error)} → ${pct(v.during_error)} `, el('small', { text: `${v.from} errors` })),
      el('p', { text: v.result === 'hard' ? `${v.to} failing takes ${v.from} down with it. Changes to ${v.to} need ${v.from}'s owners in the review.` : `${v.from} absorbs ${v.to} failures. Ripple warns about this edge instead of blocking.` }))));

  if (!animate) { $$('.verdict', vs).forEach((v) => v.classList.add('show')); return; }
  const dur = 2600;
  lines.forEach((p) => {
    const len = p.getTotalLength();
    p.style.strokeDasharray = `${len} ${len}`;
    p.style.strokeDashoffset = len;
    p.getBoundingClientRect();
    p.style.transition = `stroke-dashoffset ${dur}ms linear`;
    p.style.strokeDashoffset = 0;
  });
  labels.forEach((l) => { l.style.opacity = 0; l.style.transition = 'opacity .4s'; setTimeout(() => (l.style.opacity = 1), dur); });
  $$('.verdict', vs).forEach((v, i) => setTimeout(() => v.classList.add('show'), dur * 0.75 + i * 250));
}
$('#replayBtn').onclick = () => drawExperiment(true);
let expPlayed = false;
new IntersectionObserver((es) => { if (es[0].isIntersecting && !expPlayed && state.experiments.length) { expPlayed = true; drawExperiment(true); } }, { root: deck, threshold: 0.5 }).observe($('#experiment'));
addEventListener('resize', () => state.experiments.length && drawExperiment(false));

/* ---------------- PR theater ---------------- */
function renderPrCards() {
  $('#prCards').replaceChildren(...state.prs.map((p, i) => {
    const add = (p.diff.match(/^\+(?!\+\+)/gm) || []).length;
    const del = (p.diff.match(/^-(?!--)/gm) || []).length;
    const files = (p.diff.match(/^diff --git/gm) || []).length;
    return el('div', { class: 'pr-card', id: `card-${p.id}`, role: 'button', tabindex: 0, onclick: () => runPr(p), onkeydown: (e) => e.key === 'Enter' && runPr(p) },
      el('span', { class: 'key', text: String(i + 1) }),
      el('span', { class: 'title', text: `#${p.number} ${p.title}` }),
      el('span', { class: 'right' },
        el('span', { class: 'badge pending', id: `badge-${p.id}`, text: 'not run' }),
        el('button', { class: 'linkish', text: 'view diff', onclick: (e) => { e.stopPropagation(); showDiff(p); } })),
      el('span', { class: 'meta' }, `${p.author} · ${files} file${files > 1 ? 's' : ''} `, el('span', { class: 'add', text: `+${add}` }), ' ', el('span', { class: 'del', text: `−${del}` })));
  }));
}

function showDiff(p) {
  $('#diffTitle').textContent = `#${p.number} ${p.title}`;
  $('#diffBody').replaceChildren(...p.diff.split('\n').filter((l) => !/^(index |--- |\+\+\+ )/.test(l)).map((l) =>
    el('span', { class: l.startsWith('diff --git') ? 'f' : l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : '', text: l.startsWith('diff --git') ? l.replace(/^diff --git a\/(\S+) b\/.*/, '$1') : l || ' ' })));
  $('#diffDialog').showModal();
}

const AGENT_LABELS = { 'blast-radius': ['Blast radius', 'N-hop chain'], 'incident-historian': ['Incidents', 'RCA recall'], 'intent-verifier': ['Intent', 'diff vs ticket'], 'reviewer-router': ['Reviewers', 'owners to ask'], 'checks-planner': ['Checks', 'before merge'], narrator: ['Narrator', 'LLM verdict'] };
function resetPipeline() {
  $$('.pl-node[data-sig]').forEach((n) => { n.className = 'pl-node'; $('.ms', n).textContent = ''; });
  const gate = $('#plGate');
  gate.className = 'pl-node gate';
  $('small', gate).textContent = 'low · medium · high';
  $('.ms', gate).textContent = '';
  $('#plAgents').replaceChildren(...Object.entries(AGENT_LABELS).map(([k, [t, s]]) => el('div', { class: 'pl-node agent', 'data-agent': k }, el('b', { text: t }), el('small', { text: s }), el('span', { class: 'ms' }))));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runPr(p) {
  if (state.running) return;
  state.running = true;
  $$('.pr-card').forEach((c) => c.classList.toggle('active', c.id === `card-${p.id}`));
  const badge = $(`#badge-${p.id}`);
  badge.className = 'badge pending';
  badge.textContent = 'analyzing';
  resetPipeline();
  $('#commentBody').replaceChildren(el('div', { class: 'empty' }, el('p', { text: `Ripple is reviewing #${p.number}…` })));
  $('#commentMeta').textContent = 'is typing…';
  try {
    $$('.pl-node[data-sig]').forEach((n) => n.classList.add('running'));
    const [a] = await Promise.all([api('/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixture: p.id }) }), sleep(700)]);
    await playPipeline(a);
    showAnalysis(a, p);
  } catch (err) {
    $('#commentBody').replaceChildren(el('div', { class: 'empty' }, el('p', { text: `Analysis failed: ${err.message}` })));
    badge.textContent = 'error';
  } finally {
    state.running = false;
  }
}

// The analysis itself takes milliseconds; the reveal is paced so the audience can follow it.
// Timings shown are the real ones from the server.
async function playPipeline(a) {
  for (const s of a.trace.signals) {
    const n = $(`.pl-node[data-sig="${s.name}"]`);
    n.className = `pl-node ${s.error ? 'error' : 'done'}`;
    $('.ms', n).textContent = `${s.ms} ms`;
    await sleep(140);
  }
  await sleep(250);
  const gate = $('#plGate');
  gate.className = `pl-node gate ${a.level}`;
  $('small', gate).textContent = `${a.level.toUpperCase()} · score ${a.gate.score}`;
  $('.ms', gate).textContent = `${a.trace.gate.ms} ms`;
  await sleep(450);
  const ran = a.trace.agents.filter((x) => x.status !== 'skipped');
  for (const t of a.trace.agents) if (t.status === 'skipped') $(`.pl-node[data-agent="${t.name}"]`).className = 'pl-node agent skipped';
  if (ran.length) {
    ran.forEach((t) => ($(`.pl-node[data-agent="${t.name}"]`).className = 'pl-node agent running'));
    await sleep(650);
    for (const t of ran) {
      const n = $(`.pl-node[data-agent="${t.name}"]`);
      n.className = `pl-node agent ${t.status === 'error' ? 'error' : 'done'}`;
      $('.ms', n).textContent = `${t.ms} ms`;
      await sleep(110);
    }
  }
  await sleep(200);
}

function showAnalysis(a, p) {
  const body = $('#commentBody');
  body.classList.remove('landing');
  body.innerHTML = sanitize(window.marked.parse(a.comment));
  void body.offsetWidth;
  body.classList.add('landing');
  body.scrollTop = 0;
  $('#commentMeta').textContent = `commented on #${a.pr.number ?? ''} · ${a.timings.totalMs} ms`;
  if (p) {
    const badge = $(`#badge-${p.id}`);
    badge.className = `badge ${a.level}`;
    badge.textContent = a.level.toUpperCase();
  }
}

// Comment markdown includes text from PRs and tickets; strip anything executable.
function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach((n) => n.remove());
  tpl.content.querySelectorAll('*').forEach((n) => {
    for (const at of [...n.attributes]) {
      if (/^on/i.test(at.name) || (/^(href|src|xlink:href)$/i.test(at.name) && /^\s*(javascript|data):/i.test(at.value))) n.removeAttribute(at.name);
    }
  });
  const d = document.createElement('div');
  d.append(tpl.content);
  return d.innerHTML;
}

/* ---------------- live feed (GitHub webhooks) ---------------- */
function addFeedItem(s) {
  if (s.source !== 'github') return;
  $('#feed').hidden = false;
  const li = el('li', { onclick: async () => showAnalysis(await api(`/api/analyses/${s.id}`)) },
    el('span', { class: `badge ${s.level}`, text: s.level.toUpperCase() }),
    el('span', { text: `${s.pr.repo || ''}#${s.pr.number} ${s.pr.title}` }));
  $('#feedList').prepend(li);
}
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('analysis', async (e) => {
    const s = JSON.parse(e.data);
    if (s.source !== 'github') return;
    addFeedItem(s);
    if (!state.running) showAnalysis(await api(`/api/analyses/${s.id}`));
  });
  es.addEventListener('graph', () => refreshGraph());
}

/* ---------------- status: live vs seeded ---------------- */
function renderStatus() {
  const s = state.status;
  const liveGraph = s.graph.source === 'prometheus' || s.graph.source === 'jaeger';
  const recorded = s.experiments.filter((e) => e.origin === 'recorded');
  const rows = [
    ['Dependency edges and chains', liveGraph ? 'live' : s.graph.stale ? 'fallback' : 'seeded', liveGraph ? `OTel traces via ${s.graph.source === 'prometheus' ? 'Collector servicegraph → Prometheus' : 'Jaeger dependencies API'}${s.graph.store === 'postgres' ? ', recursive CTEs in Postgres' : ''}` : 'Offline snapshot of the demo call graph (live stack not reachable)'],
    ['Hard vs. soft classification', recorded.length ? 'live' : 'seeded', recorded.length ? `flagd failure injection + trace correlation (${recorded.map((e) => e.flag).join(', ')})` : `Sample recordings (${s.experiments.map((e) => e.flag).join(', ')}); run npm run experiment to record live ones`],
    ['Change risk and CI', s.github.configured ? 'live' : 'live', s.github.configured ? `Real PRs via GitHub webhook (${s.github.mode === 'app' ? 'GitHub App + Checks API' : 'token + commit status'})` : 'Real OpenTelemetry Demo patches parsed from the diff (connect GitHub for webhooks)'],
    ['Service tier and owners', 'seeded', 'Hand-written catalog YAML (data/catalog.yaml)'],
    ['Jira tickets', s.planning === 'jira' ? 'live' : 'seeded', s.planning === 'jira' ? 'Jira Cloud REST API' : '7 tickets linked to the demo PRs (data/jira/tickets.json)'],
    ['Incidents and RCAs', s.incidents === 'seeded' ? 'seeded' : 'live', '10 writeups, several from failures triggered on purpose (data/incidents)'],
    ['Specialist agents', s.llm === 'none' ? 'seeded' : 'live', s.llm === 'none' ? 'Deterministic agents (set GEMINI_API_KEY for model-written judgement)' : `Deterministic agents + ${s.llm} for intent and verdict`],
  ];
  $('#statusTable tbody').replaceChildren(...rows.map(([a, st, src]) =>
    el('tr', {}, el('td', { text: a }), el('td', {}, el('span', { class: `pill ${st}`, text: st === 'fallback' ? 'Fallback' : st === 'live' ? 'Live' : 'Seeded' })), el('td', { text: src }))));

  const chip = $('#graphChip');
  const color = liveGraph ? 'var(--good)' : s.graph.stale ? 'var(--warning)' : 'var(--muted)';
  chip.replaceChildren(el('span', { class: 'dot', style: `background:${color}` }), `graph: ${liveGraph ? `live · ${s.graph.source}` : s.graph.stale ? 'snapshot (live unreachable)' : 'snapshot'}`);
  chip.title = s.graph.attempts.map((x) => `${x.source}: ${x.ok ? 'ok' : x.error}`).join('\n');
}

function renderHeroStats() {
  const g = state.graph;
  const hard = g.edges.filter((e) => e.kind === 'hard').length;
  const verified = g.edges.filter((e) => e.kind_source === 'experiment').length;
  $('#heroStats').replaceChildren(
    el('div', { class: 'stat' }, el('b', { text: String(g.nodes.filter((n) => n.kind !== 'synthetic').length) }), el('span', { text: 'services mapped' })),
    el('div', { class: 'stat' }, el('b', { text: String(g.edges.length) }), el('span', { text: `dependency edges (${hard} hard)` })),
    el('div', { class: 'stat' }, el('b', { text: String(verified) }), el('span', { text: 'edges verified by breaking them' })),
    el('div', { class: 'stat' }, el('b', { text: '3' }), el('span', { text: 'signal families per PR' })),
  );
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

async function refreshGraph() {
  [state.graph, state.status] = await Promise.all([api('/api/graph'), api('/api/status')]);
  drawGraph();
  renderStatus();
  renderHeroStats();
}

async function init() {
  const [experiments, prs, analyses] = await Promise.all([api('/api/experiments'), api('/api/demo/prs'), api('/api/analyses')]);
  state.experiments = experiments.sort((a, b) => (a.flag === 'paymentFailure' ? -1 : b.flag === 'paymentFailure' ? 1 : 0));
  state.prs = prs;
  await refreshGraph();
  renderExpTabs();
  drawExperiment(false);
  renderPrCards();
  resetPipeline();
  analyses.reverse().forEach(addFeedItem);
  connectEvents();
}
init().catch((err) => {
  document.body.prepend(el('div', { style: 'position:fixed;top:60px;left:20px;right:20px;z-index:50;padding:12px;border-radius:10px;background:var(--critical);color:#fff', text: `Ripple failed to load: ${err.message}` }));
});
