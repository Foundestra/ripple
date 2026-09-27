import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so the demo runs with `npm start` and no extra deps.
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const env = (key, fallback) => process.env[key] ?? fallback;
const num = (key, fallback) => Number(process.env[key] ?? fallback);
const bool = (key, fallback) => {
  const v = process.env[key];
  return v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);
};

export function loadConfig() {
  return {
    port: num('PORT', 4000),
    dataDir: env('RIPPLE_DATA_DIR', path.join(ROOT, 'data')),
    fixturesDir: path.join(ROOT, 'fixtures', 'prs'),

    // Dependency graph: prometheus (servicegraph connector) | jaeger | seeded | postgres
    graph: {
      source: env('RIPPLE_GRAPH_SOURCE', 'auto'),
      store: env('RIPPLE_GRAPH_STORE', 'memory'), // memory | postgres
      refreshSec: num('RIPPLE_GRAPH_REFRESH_SEC', 60),
      lookbackMin: num('RIPPLE_GRAPH_LOOKBACK_MIN', 60),
      maxHops: num('RIPPLE_MAX_HOPS', 3),
      prometheusUrl: env('PROMETHEUS_URL', 'http://localhost:9090'),
      jaegerUrl: env('JAEGER_URL', 'http://localhost:8080/jaeger/ui'),
      requestMetric: env('RIPPLE_SERVICEGRAPH_REQUEST_METRIC', 'traces_service_graph_request_total'),
      failedMetric: env('RIPPLE_SERVICEGRAPH_FAILED_METRIC', 'traces_service_graph_request_failed_total'),
    },

    postgresUrl: env('DATABASE_URL', ''),

    planning: {
      source: env('RIPPLE_PLANNING_SOURCE', 'seeded'), // seeded | jira
      jiraUrl: env('JIRA_URL', ''),
      jiraEmail: env('JIRA_EMAIL', ''),
      jiraToken: env('JIRA_API_TOKEN', ''),
    },

    incidents: {
      source: env('RIPPLE_INCIDENT_SOURCE', 'seeded'),
      matchThreshold: num('RIPPLE_INCIDENT_MATCH', 0.3),
      relatedThreshold: num('RIPPLE_INCIDENT_RELATED', 0.15),
    },

    llm: {
      provider: env('RIPPLE_LLM', process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'none'),
      geminiKey: env('GEMINI_API_KEY', ''),
      geminiModel: env('GEMINI_MODEL', 'gemini-2.5-flash'),
      anthropicKey: env('ANTHROPIC_API_KEY', ''),
      anthropicModel: env('ANTHROPIC_MODEL', 'claude-sonnet-5'),
      timeoutMs: num('RIPPLE_LLM_TIMEOUT_MS', 12000),
    },

    github: {
      token: env('GITHUB_TOKEN', ''),
      appId: env('GITHUB_APP_ID', ''),
      privateKey: env('GITHUB_APP_PRIVATE_KEY', '').replace(/\\n/g, '\n'),
      privateKeyPath: env('GITHUB_APP_PRIVATE_KEY_PATH', ''),
      webhookSecret: env('GITHUB_WEBHOOK_SECRET', ''),
      apiUrl: env('GITHUB_API_URL', 'https://api.github.com'),
      requestReviewers: bool('RIPPLE_REQUEST_REVIEWERS', false),
      publicUrl: env('RIPPLE_PUBLIC_URL', ''),
    },

    // Demo pacing: adds small visible delays so the pipeline animation reads on stage.
    demoPacing: bool('RIPPLE_DEMO_PACING', true),
  };
}
