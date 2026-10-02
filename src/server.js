import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.js';
import { createRipple } from './app.js';
import { listFixtures, loadFixturePr, prFromPatch } from './adapters/fixtures.js';
import { GitHubClient, verifySignature } from './github/client.js';

const PR_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review', 'edited']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

export async function startServer(overrides = {}) {
  const ripple = await createRipple(overrides);
  const { config, graphService, orchestrator, catalog, llm, planning, incidentSource } = ripple;
  const github = new GitHubClient(config.github);
  const log = overrides.log || console;

  const analyses = []; // newest first, capped
  const clients = new Set();
  const broadcast = (type, data) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  const remember = (a) => {
    a.id = a.id || crypto.randomUUID().slice(0, 8);
    analyses.unshift(a);
    analyses.length = Math.min(analyses.length, 50);
    broadcast('analysis', summary(a));
    return a;
  };

  graphService.onChange((g) => broadcast('graph', { source: g.source, mock: g.mock, captured_at: g.capturedAt, stale: g.stale }));
  // Experiments recorded by the CLI while the server runs show up without a restart.
  let expStamp = JSON.stringify(graphService.experiments().map((e) => e.recorded_at));
  graphService.onChange(() => {
    const stamp = JSON.stringify(graphService.experiments().map((e) => e.recorded_at));
    if (stamp !== expStamp) {
      expStamp = stamp;
      broadcast('experiments', {});
    }
  });
  graphService.start();

  // Webhook processing is serialized per PR so rapid pushes don't race.
  const queues = new Map();
  const handlePullRequest = (payload) => {
    const pr = payload.pull_request;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const key = `${owner}/${repo}#${pr.number}`;
    const run = async () => {
      const runId = crypto.randomUUID().slice(0, 8);
      broadcast('run', { runId, source: 'github', pr: { number: pr.number, title: pr.title, repo: `${owner}/${repo}` } });
      const input = await github.loadPr({ owner, repo, number: pr.number, installationId: payload.installation?.id, pr });
      const analysis = await orchestrator.analyze(input, { onEvent: (e) => broadcast('run-event', { runId, ...e }) });
      analysis.id = runId;
      analysis.source = 'github';
      remember(analysis);
      const detailsUrl = config.github.publicUrl ? `${config.github.publicUrl.replace(/\/$/, '')}/#analysis/${runId}` : null;
      await github.upsertComment({ owner, repo, number: pr.number, body: analysis.comment, installationId: payload.installation?.id });
      await github.publishVerdict({ owner, repo, sha: pr.head.sha, analysis, installationId: payload.installation?.id, detailsUrl });
      if (config.github.requestReviewers && analysis.level !== 'low') {
        const logins = (analysis.agents['reviewer-router']?.reviewers || []).map((r) => r.login).filter((l) => l !== pr.user?.login);
        await github.requestReviewers({ owner, repo, number: pr.number, logins, installationId: payload.installation?.id }).catch((e) => log.error('[github] request reviewers failed:', e.message));
      }
      log.info?.(`[github] ${key} -> ${analysis.level.toUpperCase()} (${analysis.timings.totalMs} ms)`);
    };
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(run).catch((err) => {
      log.error(`[github] ${key} failed:`, err.message);
      broadcast('error', { pr: key, error: err.message });
    });
    queues.set(key, next);
    next.finally(() => queues.get(key) === next && queues.delete(key));
  };

  const routes = {
    'GET /healthz': () => json(200, { ok: true, graph: graphService.graph?.source }),

    'GET /api/status': () =>
      json(200, {
        graph: {
          source: graphService.graph.source,
          mock: graphService.graph.mock,
          configured: config.graph.source,
          store: config.graph.store,
          stale: graphService.graph.stale,
          captured_at: graphService.graph.capturedAt,
          attempts: graphService.attempts,
        },
        experiments: graphService.experiments().map((e) => ({ flag: e.flag, origin: e.origin, environment: e.environment || null, recorded_at: e.recorded_at })),
        planning: planning.name,
        incidents: incidentSource.name,
        catalog: 'seeded',
        llm: llm.name,
        github: { configured: github.configured, mode: github.isApp ? 'app' : github.configured ? 'token' : 'none', webhookSecret: !!config.github.webhookSecret },
      }),

    'GET /api/graph': () => json(200, graphService.graph.toJSON()),

    'POST /api/graph/refresh': async () => {
      await graphService.refresh();
      return json(200, { source: graphService.graph.source });
    },

    'GET /api/experiments': () => json(200, graphService.experiments()),

    'GET /api/demo/prs': () =>
      json(
        200,
        listFixtures(config.fixturesDir).map((f) => ({
          id: f.id,
          number: f.number,
          title: f.title,
          body: f.body,
          author: f.author,
          branch: f.branch,
          expected: f.demo?.expected,
          moment: f.demo?.moment,
          diff: f.diff,
        })),
      ),

    'POST /api/analyze': async (req) => {
      const body = await readJson(req);
      const pr = body.fixture ? loadFixturePr(config.fixturesDir, body.fixture) : body.patch ? prFromPatch(body) : null;
      if (!pr) return json(400, { error: 'Pass { fixture } or { patch, title, body, author }' });
      const runId = body.runId || crypto.randomUUID().slice(0, 8);
      broadcast('run', { runId, source: 'dashboard', pr: { number: pr.number, title: pr.title } });
      const analysis = await orchestrator.analyze(pr, { onEvent: (e) => broadcast('run-event', { runId, ...e }) });
      analysis.id = runId;
      analysis.source = 'dashboard';
      return json(200, remember(analysis));
    },

    'GET /api/analyses': () => json(200, analyses.map(summary)),

    'GET /api/events': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: hello\ndata: {}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return 'streaming';
    },

    'POST /webhook/github': async (req) => {
      const raw = await readBody(req);
      if (!verifySignature(config.github.webhookSecret, raw, req.headers['x-hub-signature-256'])) return json(401, { error: 'bad signature' });
      const event = req.headers['x-github-event'];
      const payload = JSON.parse(raw.toString('utf8') || '{}');
      if (event === 'ping') return json(200, { pong: true });
      if (event !== 'pull_request' || !PR_ACTIONS.has(payload.action)) return json(202, { ignored: `${event}.${payload.action}` });
      if (payload.action === 'edited' && !payload.changes?.title && !payload.changes?.body) return json(202, { ignored: 'edit without title/body change' });
      if (!github.configured) return json(503, { error: 'GitHub credentials not configured' });
      handlePullRequest(payload);
      return json(202, { accepted: true });
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      let handler = routes[`${req.method} ${url.pathname}`];
      let result;
      if (!handler && req.method === 'GET' && url.pathname.startsWith('/api/analyses/')) {
        const a = analyses.find((x) => x.id === url.pathname.split('/').pop());
        result = a ? json(200, a) : json(404, { error: 'not found' });
      } else if (handler) {
        result = await handler(req, res);
      } else if (req.method === 'GET') {
        result = serveStatic(url.pathname);
      } else {
        result = json(404, { error: 'not found' });
      }
      if (result === 'streaming') return;
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      log.error('[http]', req.method, url.pathname, err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  await new Promise((resolve) => server.listen(config.port, resolve));
  const port = server.address().port;
  const close = async () => {
    for (const c of clients) c.end();
    await new Promise((r) => server.close(r));
    await graphService.stop();
  };
  return { server, port, close, ripple, catalog };
}

function summary(a) {
  return { id: a.id, source: a.source, pr: a.pr, level: a.level, headline: a.headline, score: a.gate.score, createdAt: a.createdAt, ms: a.timings.totalMs };
}

function json(status, body) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function serveStatic(p) {
  if (p === '/vendor/marked.js') return file(path.join(ROOT, 'node_modules', 'marked', 'lib', 'marked.umd.js'));
  const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const full = path.join(ROOT, 'public', rel);
  if (!full.startsWith(path.join(ROOT, 'public'))) return json(403, { error: 'forbidden' });
  return file(full);
}

function file(full) {
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return json(404, { error: 'not found' });
  return { status: 200, headers: { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' }, body: fs.readFileSync(full) };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) reject(new Error('payload too large'));
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  return raw.length ? JSON.parse(raw.toString('utf8')) : {};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port, ripple } = await startServer();
  const g = ripple.graphService.graph;
  console.log(`Ripple listening on http://localhost:${port}`);
  console.log(`  graph: ${g.source}${g.stale ? ` (fallback; ${g.error})` : ''}  llm: ${ripple.llm.name}  planning: ${ripple.planning.name}`);
  if (!ripple.config.github.webhookSecret) console.log('  warning: GITHUB_WEBHOOK_SECRET not set; webhook signatures are not verified');
}
