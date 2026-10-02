#!/usr/bin/env node
// Deliver a real GitHub PR to a local Ripple as a signed pull_request webhook,
// with no public URL or tunnel needed. Ripple then fetches the PR's files and posts
// its comment and status to GitHub with your GITHUB_TOKEN, exactly as for a
// real webhook delivery.
//
//   npm run webhook:replay -- --repo you/opentelemetry-demo --pr 3
//   npm run webhook:replay -- --repo you/opentelemetry-demo --pr 3 --url http://localhost:4000/webhook/github
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.js';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    pr: { type: 'string' },
    url: { type: 'string', default: 'http://localhost:4000/webhook/github' },
    action: { type: 'string', default: 'opened' },
  },
});
if (!values.repo || !values.pr) {
  console.error('usage: npm run webhook:replay -- --repo owner/name --pr <number> [--url http://localhost:4000/webhook/github]');
  process.exit(1);
}

const cfg = loadConfig().github;
if (!cfg.token) {
  console.error('GITHUB_TOKEN is not set (put it in .env)');
  process.exit(1);
}
const [owner, name] = values.repo.split('/');
const res = await fetch(`${cfg.apiUrl.replace(/\/$/, '')}/repos/${owner}/${name}/pulls/${values.pr}`, {
  headers: { Authorization: `token ${cfg.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ripple-replay' },
});
if (!res.ok) {
  console.error(`GitHub: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
const pr = await res.json();
const repoInfo = pr.base.repo;
const payload = JSON.stringify({ action: values.action, number: pr.number, pull_request: pr, repository: repoInfo, sender: pr.user });
const headers = { 'Content-Type': 'application/json', 'X-GitHub-Event': 'pull_request', 'X-GitHub-Delivery': crypto.randomUUID() };
if (cfg.webhookSecret) headers['X-Hub-Signature-256'] = 'sha256=' + crypto.createHmac('sha256', cfg.webhookSecret).update(payload).digest('hex');

const out = await fetch(values.url, { method: 'POST', headers, body: payload });
console.log(`Delivered ${values.repo}#${pr.number} "${pr.title}" -> ${values.url}: HTTP ${out.status} ${await out.text()}`);
if (out.status === 202) console.log('Ripple is analyzing it now; the comment appears on the PR in a few seconds.');
