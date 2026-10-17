import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function deploy(scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ripple-deploy-test-'));
  try {
    const scripts = path.join(root, 'infra/scripts');
    const terraform = path.join(root, 'infra/terraform');
    const bin = path.join(root, 'bin');
    for (const dir of [scripts, terraform, bin]) fs.mkdirSync(dir, { recursive: true });
    for (const name of ['deploy.sh', 'bootstrap-state.sh']) {
      fs.copyFileSync(path.join(source, 'infra/scripts', name), path.join(scripts, name));
      fs.chmodSync(path.join(scripts, name), 0o755);
    }
    fs.writeFileSync(path.join(terraform, 'terraform.tfvars'), 'project_id = "test-project"\nregion = "test-region"\n');
    const log = path.join(root, 'calls.jsonl');
    const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify({tool, args}) + '\\n');
if (tool === 'terraform') {
  if (args[0] === 'state') console.log('google_cloud_run_v2_service.ripple[0]');
  if (args[0] === 'output') {
    const name = args.at(-1);
    const outputs = {
      bootstrap_image: 'test-region-docker.pkg.dev/test-project/custom-images/custom:bootstrap',
      github_auth_mode: 'app', github_app_id: 'test-app-id',
      secret_ids: {gemini_api_key: 'custom-gemini', github_app_private_key: 'custom-private-key', github_token: 'custom-token'},
      webhook_url: 'https://example.test/webhook/github', service_url: 'https://example.test',
      github_app_setup: {owner: 'test-org', secret_prefix: 'custom', repository_url: 'https://github.com/test-org/custom-repo'}
    };
    const value = outputs[name];
    if (value === undefined) process.exit(1);
    console.log(typeof value === 'object' ? JSON.stringify(value) : value);
  }
}
if (tool === 'gcloud' && args[0] === 'secrets') {
  const secret = args[args.indexOf('--secret') + 1];
  console.log((process.env.SCENARIO === 'disabled-latest' && secret === 'custom-gemini') ||
    (process.env.SCENARIO === 'missing-app' && secret === 'custom-private-key') ? 'DISABLED' : 'ENABLED');
}
if (tool === 'curl') {
  if (process.env.SCENARIO === 'unhealthy') process.exit(22);
  console.log(JSON.stringify({graph: {source: 'prometheus', mock: true}, llm: 'gemini', github: {mode: 'app'}}));
}
`;
    for (const tool of ['terraform', 'gcloud', 'curl', 'sleep']) {
      fs.writeFileSync(path.join(bin, tool), stub, { mode: 0o755 });
    }
    const result = spawnSync('bash', [path.join(scripts, 'deploy.sh')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: log, SCENARIO: scenario },
      encoding: 'utf8', timeout: 30000,
    });
    if (result.error) throw result.error;
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    return { ...result, calls };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('redeploy refreshes settings without removing the existing service', () => {
  const result = deploy('healthy');
  assert.equal(result.status, 0, result.stderr);
  const applies = result.calls.filter(c => c.tool === 'terraform' && c.args[0] === 'apply');
  assert.ok(applies[0].args.includes('-refresh-only'));
  assert.ok(!applies.some(c => c.args.includes('deploy_service=false')));
  assert.match(result.stdout, /Ripple is live/);
  const probes = result.calls.filter(c => c.tool === 'curl');
  assert.ok(probes.every(c => c.args.at(-1).endsWith('/api/status') && c.args.includes('--max-time')));
  const bucketUpdate = result.calls.find(c => c.tool === 'gcloud' && c.args[0] === 'storage' && c.args[2] === 'update');
  assert.ok(bucketUpdate.args.includes('--versioning'));
});

test('disabled latest secret blocks deployment even if older versions may exist', () => {
  const result = deploy('disabled-latest');
  assert.equal(result.status, 2, result.stderr);
  assert.ok(!result.calls.some(c => c.tool === 'terraform' && c.args[0] === 'apply' && !c.args.includes('-refresh-only')));
  const checks = result.calls.filter(c => c.tool === 'gcloud' && c.args[0] === 'secrets');
  assert.ok(checks.every(c => c.args[2] === 'describe' && c.args[3] === 'latest'));
});

test('missing App instructions use configured owner, repository and secret prefix', () => {
  const result = deploy('missing-app');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /--owner "test-org"/);
  assert.match(result.stdout, /--secret-prefix "custom"/);
  assert.match(result.stdout, /--repo-url "https:\/\/github.com\/test-org\/custom-repo"/);
  assert.match(result.stdout, /Add --org/);
});

test('failed public health checks never report deployment success', () => {
  const result = deploy('unhealthy');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /service did not become healthy/);
  assert.doesNotMatch(result.stdout, /Ripple is live/);
});
