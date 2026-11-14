import { buildAssessment } from '../impact/buildAssessment.js';
import { readAssessment, readAssessmentHistory } from '../impact/readAssessments.js';
import { ASSESSMENT_HARD_LIMITS, normalizeImpactRequest } from '../impact/requestIdentity.js';

const PREFIX = '/api/platform/v1/';
const errorStatus = { REQUEST_TOO_LARGE: 413, FILE_LIMIT_EXCEEDED: 422, PATH_TOO_LONG: 422,
  HISTORY_LIMIT_EXCEEDED: 422, INVALID_REPOSITORY: 422, INVALID_COMMIT_SHA: 422,
  INVALID_EVALUATION_AT: 422, HEAD_SUPERSEDED: 409, SNAPSHOT_VERSION_CONFLICT: 409,
  NO_VALIDATED_SNAPSHOT: 503, ASSESSMENT_TIME_LIMIT: 504, ACCESS_DENIED: 403 };
const stableCodes = new Set(['REQUEST_TOO_LARGE','FILE_LIMIT_EXCEEDED','PATH_TOO_LONG','HISTORY_LIMIT_EXCEEDED',
  'INVALID_REPOSITORY','INVALID_COMMIT_SHA','INVALID_EVALUATION_AT','HEAD_SUPERSEDED','SNAPSHOT_VERSION_CONFLICT',
  'NO_VALIDATED_SNAPSHOT','ASSESSMENT_TIME_LIMIT']);

const response = (status, body) => ({ status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const errorResponse = (status, code, message) => response(status, { schema_version: 'ripple.api-error.v1',
  error: { code, message: String(message).slice(0, 512), retryable: ['NO_VALIDATED_SNAPSHOT','ASSESSMENT_TIME_LIMIT'].includes(code), details: [] } });

async function body(req, maximum) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error('Platform request exceeds 256 KiB'), { code: 'REQUEST_TOO_LARGE', status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Malformed JSON request'), { code: 'INVALID_REQUEST', status: 400 }); }
}

export function createPlatformRouter({ registry, snapshotStore, assessmentStore, policy, accessBoundary, fixtureLoader, limits = {}, clock = () => new Date() }) {
  const boundedResponse = (status, value) => {
    const result = response(status, value);
    if (Buffer.byteLength(result.body) <= (limits.max_result_bytes ?? ASSESSMENT_HARD_LIMITS.max_result_bytes)) return result;
    return response(500, { error: { code: 'RESULT_TOO_LARGE', message: 'Platform response exceeds limit' } });
  };
  return async function route(req, url) {
    if (!url.pathname.startsWith(PREFIX)) return null;
    try {
      const principal = { type: 'demo_fixture', id: 'principal://demo/fixture' };
      if (req.method === 'POST' && url.pathname === `${PREFIX}impact`) {
        const input = await body(req, limits.max_body_bytes ?? ASSESSMENT_HARD_LIMITS.max_body_bytes);
        if (input.fixture_id && (Object.keys(input).length !== 1 || typeof input.fixture_id !== 'string')) throw Object.assign(new Error('Fixture requests accept only fixture_id'), { code: 'INVALID_REQUEST', status: 400 });
        const request = input.fixture_id ? fixtureLoader(input.fixture_id) : (() => {
          const paths = (input.files || []).map(file => file.path || '');
          const signals = [];
          if (paths.some(value => /\.proto$/.test(value))) signals.push('mandatory_contract_change');
          if (paths.some(value => /(?:^|\/)migrations?\/|\.sql$/.test(value))) signals.push('mandatory_migration');
          return { ...input, signals, controls: [{ id: 'required-tests', status: 'missing', authority: null }] };
        })();
        const { validateContract } = await import('../contracts/validate.js');
        const contractRequest = { schema_version: request.schema_version, work_item_id: request.work_item_id,
          repository: request.repository, pr_number: request.pr_number, commit_sha: request.commit_sha,
          evaluation_at: request.evaluation_at, files: request.files, request_context: {
            source: request.request_context?.source, fixture_id: request.request_context?.fixture_id } };
        normalizeImpactRequest(request, limits);
        validateContract('impact-request', input.fixture_id ? contractRequest : input);
        accessBoundary.assert({ principal, action: 'impact:create', repository: request.repository });
        const snapshot = await snapshotStore.getActiveSnapshot('demo');
        const result = await buildAssessment({ request, registry, snapshot, policy, store: assessmentStore, limits, clock });
        return boundedResponse(200, result);
      }
      if (req.method !== 'GET') return response(404, { error: { code: 'NOT_FOUND', message: 'Platform route not found' } });
      const assessmentMatch = url.pathname.match(/^\/api\/platform\/v1\/impacts\/(assessment:\/\/sha256:[a-f0-9]{64})$/);
      if (assessmentMatch) {
        accessBoundary.assert({ principal, action: 'impact:read', repository: 'repository://demo/opentelemetry-demo' });
        const result = await readAssessment(assessmentStore, assessmentMatch[1], { now: clock().toISOString() });
        return result ? boundedResponse(200, result) : response(404, { error: { code: 'NOT_FOUND', message: 'Assessment not found' } });
      }
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > (limits.max_history ?? ASSESSMENT_HARD_LIMITS.max_history)) throw Object.assign(new Error('History limit exceeded'), { code: 'HISTORY_LIMIT_EXCEEDED', status: 422 });
      const commit_sha = url.searchParams.get('commit_sha') || undefined;
      const workMatch = url.pathname.match(/^\/api\/platform\/v1\/work-items\/(.+)\/impact$/);
      if (workMatch) {
        accessBoundary.assert({ principal, action: 'impact:read', repository: 'repository://demo/opentelemetry-demo' });
        return boundedResponse(200, await readAssessmentHistory(assessmentStore, { work_item_id: decodeURIComponent(workMatch[1]), commit_sha }, { limit, now: clock().toISOString() }));
      }
      const prMatch = url.pathname.match(/^\/api\/platform\/v1\/repositories\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)\/impact$/);
      if (prMatch) {
        const repository = `repository://${prMatch[1]}/${prMatch[2]}`;
        accessBoundary.assert({ principal, action: 'impact:read', repository });
        return boundedResponse(200, await readAssessmentHistory(assessmentStore, { repository_id: repository, pr_number: Number(prMatch[3]), commit_sha }, { limit, now: clock().toISOString() }));
      }
      return response(404, { error: { code: 'NOT_FOUND', message: 'Platform route not found' } });
    } catch (error) {
      const code = error.code || 'INTERNAL_ERROR';
      if (stableCodes.has(code)) return errorResponse(error.status || errorStatus[code], code, error.message);
      return response(error.status || errorStatus[code] || 500, { error: { code, message: code === 'INTERNAL_ERROR' ? 'Platform request failed' : error.message } });
    }
  };
}
