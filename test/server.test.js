import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { startServer } from '../src/server.js';
import { verifySignature } from '../src/github/client.js';

const quiet = { error() {}, info() {} };

const PR7 = {
  number: 7,
  title: 'PAY-142: currency code on charge response',
  body: '',
  head: { sha: 'abc123', ref: 'feature' },
  user: { login: 'priya-payments' },
  html_url: 'https://github.com/acme/shop/pull/7',
  base: { repo: { name: 'shop', owner: { login: 'acme' } } },
};

// Minimal fake of the GitHub REST endpoints Ripple uses.
function fakeGitHub(patchFiles) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url.startsWith('/repos/acme/shop/pulls/7/files')) return send(200, patchFiles);
      if (req.url === '/repos/acme/shop/pulls/7') return send(200, PR7);
      if (req.url.includes('/commits/abc123/status')) return send(200, { statuses: [{ context: 'ci/build', state: 'success' }] });
      if (req.url.includes('/commits/abc123/check-runs')) return send(200, { check_runs: [] });
      if (req.url.startsWith('/repos/acme/shop/issues/7/comments') && req.method === 'GET') return send(200, []);
      if (req.url === '/repos/acme/shop/issues/7/comments' && req.method === 'POST') return send(201, { id: 1 });
      if (req.url === '/repos/acme/shop/statuses/abc123') return send(201, {});
      send(404, { message: 'not found' });
    });
  });
  return new Promise((r) => server.listen(0, () => r({ server, calls, url: `http://localhost:${server.address().port}` })));
}

// Turn the bundled fixture patch into the GitHub "PR files" payload shape.
function filesPayload(fixture) {
  const diff = fs.readFileSync(path.join(ROOT, 'fixtures', 'prs', fixture, 'diff.patch'), 'utf8');
  return diff
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((chunk) => {
      const filename = chunk.match(/^a\/(\S+)/)[1];
      const patch = chunk.slice(chunk.indexOf('@@'));
      const lines = patch.split('\n');
      return { filename, status: 'modified', additions: lines.filter((l) => l[0] === '+').length, deletions: lines.filter((l) => l[0] === '-').length, patch };
    });
}

test('signature verification', () => {
  const body = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(verifySignature('s3cret', body, sig), true);
  assert.equal(verifySignature('s3cret', body, 'sha256=00'), false);
  assert.equal(verifySignature('s3cret', body, undefined), false);
});

test('webhook -> analysis -> PR comment + status on GitHub', async () => {
  const gh = await fakeGitHub(filesPayload('pr3-payment-contract'));
  const secret = 'hook-secret';
  const app = await startServer({
    port: 0,
    log: quiet,
    graph: { source: 'seeded', refreshSec: 0 },
    llm: { provider: 'none' },
    github: { token: 'test-token', apiUrl: gh.url, webhookSecret: secret, appId: '', privateKey: '', privateKeyPath: '', requestReviewers: false, publicUrl: 'http://ripple.test' },
  });
  try {
    const payload = JSON.stringify({
      action: 'opened',
      repository: { name: 'shop', owner: { login: 'acme' } },
      pull_request: { number: 7, title: 'PAY-142: currency code on charge response', body: '', head: { sha: 'abc123', ref: 'feature' }, user: { login: 'priya-payments' }, html_url: 'https://github.com/acme/shop/pull/7' },
    });
    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const post = (s) => fetch(`http://localhost:${app.port}/webhook/github`, { method: 'POST', headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': s }, body: payload });

    assert.equal((await post('sha256=bad')).status, 401);
    assert.equal((await post(sig)).status, 202);

    for (let i = 0; i < 50 && !gh.calls.some((c) => c.url.includes('/statuses/')); i++) await new Promise((r) => setTimeout(r, 50));
    const comment = gh.calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/7/comments'));
    assert.ok(comment, 'comment posted');
    assert.match(comment.body.body, /HIGH risk/);
    assert.match(comment.body.body, /INC-2031/);
    assert.equal(comment.auth, 'token test-token');
    const status = gh.calls.find((c) => c.url.includes('/statuses/abc123'));
    assert.equal(status.body.state, 'success', 'advisory: never blocks');
    assert.match(status.body.description, /^HIGH risk/);
    assert.match(status.body.target_url, /^http:\/\/ripple\.test\/#analysis\//);

    const list = await (await fetch(`http://localhost:${app.port}/api/analyses`)).json();
    assert.equal(list[0].source, 'github');
    assert.equal(list[0].level, 'high');
  } finally {
    await app.close();
    gh.server.close();
  }
});

test('dashboard API serves graph, demo PRs and analyses', async () => {
  const app = await startServer({ port: 0, log: quiet, graph: { source: 'seeded', refreshSec: 0 }, llm: { provider: 'none' } });
  try {
    const base = `http://localhost:${app.port}`;
    const graph = await (await fetch(`${base}/api/graph`)).json();
    assert.ok(graph.edges.length > 15);
    const prs = await (await fetch(`${base}/api/demo/prs`)).json();
    assert.deepEqual(prs.map((p) => p.expected), ['low', 'medium', 'high']);
    const a = await (await fetch(`${base}/api/analyze`, { method: 'POST', body: JSON.stringify({ fixture: 'pr2' }) })).json();
    assert.equal(a.level, 'medium');
    const html = await (await fetch(base)).text();
    assert.match(html, /<title>Ripple<\/title>/);
    assert.equal((await fetch(`${base}/vendor/marked.js`)).status, 200);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  } finally {
    await app.close();
  }
});

test('replay-webhook script delivers a real PR as a signed webhook', async () => {
  const gh = await fakeGitHub(filesPayload('pr3-payment-contract'));
  const github = { token: 'test-token', apiUrl: gh.url, webhookSecret: 'replay-secret', appId: '', privateKey: '', privateKeyPath: '', requestReviewers: false, publicUrl: '' };
  const app = await startServer({ port: 0, log: quiet, graph: { source: 'seeded', refreshSec: 0 }, llm: { provider: 'none' }, github });
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise((resolve, reject) =>
      execFile(process.execPath, [path.join(ROOT, 'scripts', 'replay-webhook.js'), '--repo', 'acme/shop', '--pr', '7', '--url', `http://localhost:${app.port}/webhook/github`], {
        env: { ...process.env, GITHUB_TOKEN: 'test-token', GITHUB_API_URL: gh.url, GITHUB_WEBHOOK_SECRET: 'replay-secret' },
      }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))),
    );
    assert.match(out, /HTTP 202/);
    for (let i = 0; i < 50 && !gh.calls.some((c) => c.url.includes('/statuses/')); i++) await new Promise((r) => setTimeout(r, 50));
    const comment = gh.calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/7/comments'));
    assert.match(comment.body.body, /HIGH risk/);
  } finally {
    await app.close();
    gh.server.close();
  }
});
