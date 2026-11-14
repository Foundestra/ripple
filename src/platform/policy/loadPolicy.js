import fs from 'node:fs';
import { parse } from 'yaml';
import { contentHash, frozenCopy } from '../contracts/canonicalJson.js';

export function loadPolicy(input) {
  const policy = typeof input === 'string' || input instanceof URL ? parse(fs.readFileSync(input, 'utf8')) : input;
  if (policy?.schema_version !== 'ripple.shadow-policy.v1' || policy.scope !== 'shadow_only' ||
      !/^\d+\.\d+\.\d+$/.test(policy.version || '') || !/^policy:\/\//.test(policy.policy_id || '')) throw new Error('Invalid shadow policy');
  const { source_sha256, ...content } = policy;
  const sha = contentHash(content);
  if (source_sha256 !== sha) throw new Error('Shadow policy content hash mismatch');
  return frozenCopy({ ...policy, policy_version: `${policy.policy_id}@${policy.version}#sha256:${sha}` });
}
