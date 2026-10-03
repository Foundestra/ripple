#!/usr/bin/env node
// Creates Ripple's GitHub App with GitHub's App-manifest flow, then stores its
// credentials in Secret Manager. No copy-pasting of keys.
//
//   node infra/github/create-app.mjs --owner <user-or-org> --webhook-url https://ripple-….run.app/webhook/github --project <gcp-project>
//
// What happens:
//   1. A local page (http://localhost:3456) posts the App manifest to GitHub.
//   2. You confirm the App name on GitHub; GitHub redirects back with a one-time code.
//   3. The code is exchanged for the App ID, private key and webhook secret
//      (POST /app-manifests/{code}/conversions).
//   4. The private key and webhook secret are added to Secret Manager
//      (ripple-github-app-private-key, ripple-github-webhook-secret), and a copy
//      is written to infra/github/.app/ (git-ignored).
//   5. You install the App on the repository Ripple should review.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    owner: { type: 'string' },
    org: { type: 'boolean', default: false },
    'webhook-url': { type: 'string' },
    name: { type: 'string', default: 'Ripple PR Risk' },
    project: { type: 'string' },
    'secret-prefix': { type: 'string', default: 'ripple' },
    port: { type: 'string', default: '3456' },
  },
});

if (!values.owner || !values['webhook-url']) {
  console.error('usage: node infra/github/create-app.mjs --owner <user-or-org> [--org] --webhook-url <url> [--project <gcp-project>]');
  process.exit(1);
}

const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
const web = (process.env.GITHUB_WEB_URL || 'https://github.com').replace(/\/$/, '');
const port = Number(values.port);
const state = crypto.randomUUID();

function buildManifest({ name, webhookUrl, redirectUrl }) {
  const template = JSON.parse(fs.readFileSync(path.join(HERE, 'app-manifest.json'), 'utf8'));
  return {
    ...template,
    name,
    hook_attributes: { ...template.hook_attributes, url: webhookUrl },
    redirect_url: redirectUrl,
  };
}

const manifest = buildManifest({ name: values.name, webhookUrl: values['webhook-url'], redirectUrl: `http://localhost:${port}/callback` });
const target = values.org
  ? `${web}/organizations/${encodeURIComponent(values.owner)}/settings/apps/new?state=${state}`
  : `${web}/settings/apps/new?state=${state}`;

const escape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const page = `<!doctype html><meta charset="utf-8"><title>Create Ripple GitHub App</title>
<body style="font:16px system-ui;max-width:640px;margin:60px auto">
<h1>Create the Ripple GitHub App</h1>
<p>This sends Ripple's App manifest to GitHub${values.org ? ` for the <b>${escape(values.owner)}</b> organization` : ''}. You'll confirm the name there.</p>
<pre style="background:#f4f4f4;padding:12px;overflow:auto">${escape(JSON.stringify(manifest, null, 2))}</pre>
<form action="${escape(target)}" method="post">
<input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
<button style="font-size:18px;padding:10px 18px">Create GitHub App →</button>
</form></body>`;

function addSecret(secret, value) {
  execFileSync('gcloud', ['secrets', 'versions', 'add', secret, '--project', values.project, '--data-file=-'], { input: value, stdio: ['pipe', 'ignore', 'inherit'] });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  if (url.pathname !== '/callback') {
    res.writeHead(404);
    return res.end();
  }
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Missing code or state mismatch. Start again from http://localhost:' + port);
  }
  try {
    const r = await fetch(`${api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ripple-create-app' },
    });
    if (!r.ok) throw new Error(`GitHub conversion failed: HTTP ${r.status} ${await r.text()}`);
    const app = await r.json();

    const dir = path.join(HERE, '.app');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'private-key.pem'), app.pem, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ id: app.id, slug: app.slug, html_url: app.html_url, client_id: app.client_id, webhook_secret: app.webhook_secret }, null, 2), { mode: 0o600 });

    const stored = [];
    if (values.project) {
      addSecret(`${values['secret-prefix']}-github-app-private-key`, app.pem);
      stored.push(`${values['secret-prefix']}-github-app-private-key`);
      if (app.webhook_secret) {
        addSecret(`${values['secret-prefix']}-github-webhook-secret`, app.webhook_secret);
        stored.push(`${values['secret-prefix']}-github-webhook-secret`);
      }
    }

    const install = `${app.html_url}/installations/new`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;max-width:640px;margin:60px auto">
<h1>✔ GitHub App created</h1><p>App ID: <b>${app.id}</b></p>
<p><a href="${escape(install)}">Install it on the repository Ripple should review →</a></p>
<p>You can close this tab; the terminal has the next steps.</p></body>`);

    console.log(`\n✔ Created GitHub App "${app.slug}" (ID ${app.id})`);
    console.log(`  Credentials saved to ${path.relative(process.cwd(), dir)}/ (git-ignored)`);
    if (stored.length) console.log(`  Stored in Secret Manager: ${stored.join(', ')}`);
    else console.log('  Not stored in Secret Manager (no --project): add infra/github/.app/private-key.pem to ripple-github-app-private-key yourself.');
    console.log('\nNext:');
    console.log(`  1. Install the App on the repository to review: ${install}`);
    console.log(`  2. Set github_app_id = "${app.id}" in infra/terraform/terraform.tfvars`);
    console.log('  3. Run infra/scripts/deploy.sh again\n');
    setTimeout(() => server.close(() => process.exit(0)), 500);
  } catch (err) {
    console.error(err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(err.message);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Open http://localhost:${port} and click "Create GitHub App".`);
  if (values.project) console.log(`Credentials will be stored in Secret Manager in project ${values.project}.`);
});
