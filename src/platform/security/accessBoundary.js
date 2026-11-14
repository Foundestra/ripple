export const DEMO_REPOSITORY = 'repository://demo/opentelemetry-demo';

export function createAccessBoundary({ mode }) {
  if (mode === 'operational') throw Object.assign(new Error('Operational platform mode requires an approved authentication provider'), { code: 'PLATFORM_AUTH_NOT_CONFIGURED' });
  if (mode !== 'demo') throw Object.assign(new Error('Platform access is disabled'), { code: 'PLATFORM_DISABLED' });
  return {
    authorize({ principal, action, repository }) {
      const allowed = principal?.type === 'demo_fixture' && repository === DEMO_REPOSITORY &&
        ['impact:create', 'impact:read'].includes(action);
      return { allowed, principal: principal || null, action, resource: repository || null,
        reason: allowed ? 'BUNDLED_DEMO_ONLY' : 'DENY_BY_DEFAULT' };
    },
    assert(input) {
      const decision = this.authorize(input);
      if (!decision.allowed) throw Object.assign(new Error('Platform access denied'), { code: 'ACCESS_DENIED', status: 403 });
      return decision;
    },
  };
}
