import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessBoundary, DEMO_REPOSITORY } from '../../src/platform/security/accessBoundary.js';
test('demo access is repository and principal bounded; operational fails closed', () => {
  const boundary=createAccessBoundary({mode:'demo'});
  assert.equal(boundary.authorize({principal:{type:'demo_fixture'},action:'impact:create',repository:DEMO_REPOSITORY}).allowed,true);
  assert.throws(()=>boundary.assert({principal:{type:'anonymous'},action:'impact:create',repository:DEMO_REPOSITORY}),{code:'ACCESS_DENIED'});
  assert.throws(()=>boundary.assert({principal:{type:'demo_fixture'},action:'impact:create',repository:'repository://other/repo'}),{code:'ACCESS_DENIED'});
  assert.throws(()=>createAccessBoundary({mode:'operational'}),{code:'PLATFORM_AUTH_NOT_CONFIGURED'});
});
