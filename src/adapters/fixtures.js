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
