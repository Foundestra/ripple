import { contentHash, frozenCopy } from '../contracts/canonicalJson.js';

export const ASSESSMENT_HARD_LIMITS = Object.freeze({
  max_body_bytes: 256 * 1024,
  max_files: 100,
  max_path_bytes: 1024,
  max_result_bytes: 1024 * 1024,
  max_history: 100,
  max_ms: 2000,
  max_nodes: 250,
  max_edges_per_direction: 100,
  max_evidence_bytes: 256 * 1024,
  max_references: 100,
});

function failure(code, message, status = 422) {
  throw Object.assign(new Error(message), { code, status });
}

export function normalizeImpactRequest(input, limits = {}) {
  const bounded = { ...ASSESSMENT_HARD_LIMITS };
  for (const [key, hard] of Object.entries(ASSESSMENT_HARD_LIMITS)) {
    const value = limits[key] ?? hard;
    if (!Number.isInteger(value) || value < 1 || value > hard) failure('INVALID_LIMIT', `Invalid platform limit: ${key}`);
    bounded[key] = value;
  }
  if (input?.schema_version !== 'ripple.impact-request.v1') failure('INVALID_REQUEST', 'Unsupported impact request schema');
  if (!/^repository:\/\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(input.repository || '')) failure('INVALID_REPOSITORY', 'Invalid repository identity');
  if (!/^[a-f0-9]{40}$/.test(input.commit_sha || '')) failure('INVALID_COMMIT_SHA', 'A full lowercase commit SHA is required');
  if (!Number.isInteger(input.pr_number) || input.pr_number < 1) failure('INVALID_REQUEST', 'Invalid pull request number');
  if (!input.work_item_id || typeof input.work_item_id !== 'string') failure('INVALID_REQUEST', 'Invalid work item identity');
  if (input.request_context?.source !== 'demo_fixture' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.request_context?.fixture_id || '')) failure('INVALID_REQUEST', 'Invalid demo request context');
  const evaluation = new Date(input.evaluation_at);
  if (!input.evaluation_at || Number.isNaN(evaluation.valueOf()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(input.evaluation_at)) failure('INVALID_EVALUATION_AT', 'evaluation_at must be a pinned ISO timestamp');
  if (!Array.isArray(input.files) || input.files.length === 0) failure('INVALID_REQUEST', 'At least one changed file is required');
  if (input.files.length > bounded.max_files) failure('FILE_LIMIT_EXCEEDED', 'Changed file limit exceeded');
  const files = input.files.map(file => {
    if (!['added', 'modified', 'removed', 'renamed'].includes(file?.status)) failure('INVALID_REQUEST', 'Invalid changed file status');
    for (const value of [file.path, file.previous_path].filter(Boolean)) {
      if (typeof value !== 'string' || value.startsWith('/') || value.split('/').includes('..')) failure('INVALID_REQUEST', 'Invalid changed path');
      if (Buffer.byteLength(value) > bounded.max_path_bytes) failure('PATH_TOO_LONG', 'Changed path is too long');
    }
    if (!file.path) failure('INVALID_REQUEST', 'Changed path is required');
    const normalized = { path: file.path, status: file.status };
    if (file.previous_path) normalized.previous_path = file.previous_path;
    if (file.contract_symbols) {
      if (!Array.isArray(file.contract_symbols) || file.contract_symbols.length > 100 || file.contract_symbols.some(symbol => typeof symbol !== 'string' || !symbol || symbol.length > 256)) failure('INVALID_REQUEST', 'Invalid contract symbols');
      normalized.contract_symbols = [...new Set(file.contract_symbols)].sort();
    }
    return normalized;
  }).sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
  const signals = [...new Set(input.signals || [])];
  if (signals.some(signal => typeof signal !== 'string' || !signal || signal.length > 128)) failure('INVALID_REQUEST', 'Invalid policy signal');
  signals.sort();
  const controls = (input.controls || []).map(control => {
    if (!control || typeof control.id !== 'string' || !control.id || control.id.length > 128 ||
        !['passed','missing','failed','unknown'].includes(control.status) ||
        (control.authority != null && (typeof control.authority !== 'string' || control.authority.length > 128))) failure('INVALID_REQUEST', 'Invalid control observation');
    return { id: control.id, status: control.status, authority: control.authority ?? null };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(controls.map(control => control.id)).size !== controls.length) failure('INVALID_REQUEST', 'Duplicate control observation');
  return frozenCopy({
    schema_version: input.schema_version,
    work_item_id: input.work_item_id,
    repository: input.repository,
    pr_number: input.pr_number,
    commit_sha: input.commit_sha,
    evaluation_at: evaluation.toISOString(),
    files,
    request_context: {
      source: input.request_context?.source,
      fixture_id: input.request_context?.fixture_id,
      ...(input.request_context?.legacy_level ? { legacy_level: input.request_context.legacy_level } : {}),
    },
    controls,
    signals,
    limits: bounded,
  });
}

export function requestIdentity(request, bindings) {
  const { max_body_bytes: _body, max_history: _history, ...evaluation_limits } = request.limits;
  const request_context_sha256 = contentHash({
    evaluation_at: request.evaluation_at,
    work_item_id: request.work_item_id,
    repository: request.repository,
    pr_number: request.pr_number,
    files: request.files,
    request_context: request.request_context,
    controls: request.controls,
    signals: request.signals,
    limits: evaluation_limits,
  });
  const replay_key = contentHash({ repository_id: request.repository, commit_sha: request.commit_sha,
    snapshot_id: bindings.snapshot_id, registry_version: bindings.registry_version,
    policy_version: bindings.policy_version, request_context_sha256 });
  return frozenCopy({ request_context_sha256, replay_key,
    assessment_id: `assessment://sha256:${replay_key}` });
}
