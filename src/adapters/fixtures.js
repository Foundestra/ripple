import fs from 'node:fs';
import path from 'node:path';
import { parseUnifiedDiff } from '../core/diff.js';

// Demo PRs: real patches against the OpenTelemetry Demo, plus PR metadata.
// scripts/create-demo-prs.sh opens the same patches as real PRs on a fork.
export function listFixtures(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'meta.json')))
    .sort()
    .map((d) => {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, d, 'meta.json'), 'utf8'));
      const diff = fs.readFileSync(path.join(dir, d, 'diff.patch'), 'utf8');
      return { ...meta, dir: d, diff };
    });
}

export function loadFixturePr(dir, id) {
  const f = listFixtures(dir).find((x) => x.id === id || x.dir === id);
  if (!f) return null;
  return {
    fixture: f.id,
    number: f.number,
    title: f.title,
    body: f.body,
    branch: f.branch,
    author: f.author,
    repo: 'demo/opentelemetry-demo',
    url: null,
    ci: f.ci,
    files: parseUnifiedDiff(f.diff),
  };
}

export function prFromPatch({ patch, title = '', body = '', branch = '', author = 'unknown', ci = { state: 'unknown' } }) {
  return { title, body, branch, author, number: null, repo: null, url: null, ci, files: parseUnifiedDiff(patch) };
}

// The platform route is deliberately limited to bundled, reviewed demo input.
export function loadPlatformFixture(dir, id) {
  const fixture = listFixtures(dir).find((row) => row.id === id || row.dir === id);
  if (!fixture || fixture.id !== 'pr3') return null;
  const lineagePath = path.resolve(dir, '..', '..', 'data', 'platform', 'demo', 'fixture-lineage', 'pr3.json');
  if (!fs.existsSync(lineagePath)) return null;
  const lineage = JSON.parse(fs.readFileSync(lineagePath, 'utf8'));
  const files = lineage.steps.changed_files.map(file => {
    const resolution = lineage.steps.identity_resolution.find(row => row.path === file.path);
    return { path: file.path, status: file.status,
      ...(resolution?.matched_symbols ? { contract_symbols: resolution.matched_symbols } : {}) };
  });
  return {
    schema_version: 'ripple.impact-request.v1',
    work_item_id: lineage.steps.jira_work_item.id,
    repository: lineage.steps.change_identity.repository_id,
    pr_number: lineage.steps.change_identity.pull_request_number,
    commit_sha: lineage.steps.change_identity.commit_sha,
    evaluation_at: lineage.evaluation_at,
    files,
    request_context: { source: 'demo_fixture', fixture_id: fixture.id, legacy_level: lineage.steps.legacy_compatibility.expected_level },
    signals: ['mandatory_contract_change'],
    controls: lineage.steps.required_controls.map(control => ({ id: control.id, status: control.status, authority: null })),
  };
}
