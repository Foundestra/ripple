import crypto from 'node:crypto';
import fs from 'node:fs';
import { fromGitHubFiles } from '../core/diff.js';
import { MARKER } from '../core/comment.js';

// GitHub REST client. Auth is either a GitHub App (preferred: enables the
// Checks API) or a personal access token (falls back to commit statuses).
export class GitHubClient {
  constructor(cfg) {
    this.api = cfg.apiUrl.replace(/\/$/, '');
    this.token = cfg.token;
    this.appId = cfg.appId;
    this.privateKey = cfg.privateKey || (cfg.privateKeyPath ? fs.readFileSync(cfg.privateKeyPath, 'utf8') : '');
    this.installationTokens = new Map();
  }

  get configured() {
    return !!(this.token || (this.appId && this.privateKey));
  }

  get isApp() {
    return !!(this.appId && this.privateKey);
  }

  appJwt() {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: this.appId })}`;
    const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(this.privateKey, 'base64url');
    return `${unsigned}.${sig}`;
  }

  async authHeader(installationId) {
    if (this.isApp && installationId) {
      const cached = this.installationTokens.get(installationId);
      if (cached && cached.expires > Date.now() + 60_000) return `token ${cached.token}`;
      const res = await this.raw('POST', `/app/installations/${installationId}/access_tokens`, null, `Bearer ${this.appJwt()}`);
      this.installationTokens.set(installationId, { token: res.token, expires: Date.parse(res.expires_at) });
      return `token ${res.token}`;
    }
    if (this.token) return `token ${this.token}`;
    throw new Error('GitHub is not configured: set GITHUB_TOKEN or GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY');
  }

  async raw(method, path, body, auth) {
    const res = await fetch(path.startsWith('http') ? path : this.api + path, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ripple-pr-risk',
        ...(auth ? { Authorization: auth } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  }

  async req(method, path, body, installationId) {
    return this.raw(method, path, body, await this.authHeader(installationId));
  }

  async paginate(path, installationId, max = 10) {
    const out = [];
    for (let page = 1; page <= max; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const items = await this.req('GET', `${path}${sep}per_page=100&page=${page}`, null, installationId);
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  // Build Ripple's PR input from a pull_request payload.
  async loadPr({ owner, repo, number, installationId, pr }) {
    const files = await this.paginate(`/repos/${owner}/${repo}/pulls/${number}/files`, installationId, 30);
    const ci = await this.ciState({ owner, repo, sha: pr.head.sha, installationId }).catch(() => ({ state: 'unknown' }));
    return {
      number,
      title: pr.title,
      body: pr.body || '',
      branch: pr.head.ref,
      author: pr.user?.login,
      repo: `${owner}/${repo}`,
      url: pr.html_url,
      headSha: pr.head.sha,
      ci,
      files: fromGitHubFiles(files),
    };
  }

  async ciState({ owner, repo, sha, installationId }) {
    const [status, checks] = await Promise.all([
      this.req('GET', `/repos/${owner}/${repo}/commits/${sha}/status`, null, installationId),
      this.req('GET', `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`, null, installationId),
    ]);
    const runs = (checks.check_runs || []).filter((r) => r.app?.slug !== 'ripple' && !/^Ripple/.test(r.name));
    const statuses = (status.statuses || []).filter((s) => s.context !== 'ripple/risk');
    if (runs.some((r) => ['failure', 'timed_out', 'cancelled'].includes(r.conclusion)) || statuses.some((s) => ['failure', 'error'].includes(s.state))) {
      return { state: 'failure' };
    }
    if (runs.some((r) => r.status !== 'completed') || statuses.some((s) => s.state === 'pending')) return { state: 'pending' };
    if (runs.length || statuses.length) return { state: 'success' };
    return { state: 'unknown' };
  }

  // One comment per PR, updated in place on every push.
  async upsertComment({ owner, repo, number, body, installationId }) {
    const comments = await this.paginate(`/repos/${owner}/${repo}/issues/${number}/comments`, installationId, 5);
    const mine = comments.find((c) => c.body?.includes(MARKER));
    if (mine) return this.req('PATCH', `/repos/${owner}/${repo}/issues/comments/${mine.id}`, { body }, installationId);
    return this.req('POST', `/repos/${owner}/${repo}/issues/${number}/comments`, { body }, installationId);
  }

  // Advisory only: LOW -> success, MEDIUM/HIGH -> neutral. Ripple never blocks a merge.
  async publishVerdict({ owner, repo, sha, analysis, installationId, detailsUrl }) {
    const title = `${analysis.level.toUpperCase()} risk: ${stripMd(analysis.headline)}`.slice(0, 140);
    if (this.isApp) {
      return this.req(
        'POST',
        `/repos/${owner}/${repo}/check-runs`,
        {
          name: 'Ripple risk review',
          head_sha: sha,
          status: 'completed',
          conclusion: analysis.level === 'low' ? 'success' : 'neutral',
          details_url: detailsUrl || undefined,
          output: { title, summary: analysis.comment.replace(MARKER, '').slice(0, 60000) },
        },
        installationId,
      );
    }
    return this.req(
      'POST',
      `/repos/${owner}/${repo}/statuses/${sha}`,
      { state: 'success', context: 'ripple/risk', description: title.slice(0, 140), target_url: detailsUrl || undefined },
      installationId,
    );
  }

  async requestReviewers({ owner, repo, number, logins, installationId }) {
    if (!logins.length) return null;
    return this.req('POST', `/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, { reviewers: logins }, installationId);
  }
}

export function verifySignature(secret, rawBody, signature) {
  if (!secret) return true;
  if (!signature?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Check-run titles and status descriptions are plain text: drop markdown emphasis and code ticks, keep identifiers like transaction_id intact.
const stripMd = (s) => s.replace(/[*`]/g, '');
