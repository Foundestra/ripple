import { contentHash, canonicalJson } from '../contracts/canonicalJson.js';
import { snapshotContent } from './buildSnapshot.js';
import { validateContract } from '../contracts/validate.js';
import { loadRegistry } from '../identity/registry.js';

export const RELATIONSHIPS = ['CALLS', 'PUBLISHES_TO', 'CONSUMES_FROM', 'READS_FROM', 'WRITES_TO', 'DEPENDS_ON'];
export function validateSnapshot(snapshot, registry) {
  const { registry_version, ...manifest } = registry;
  if (loadRegistry(manifest).registry_version !== registry_version) throw new Error('Invalid registry version binding');
  validateContract('graph-snapshot', snapshot);
  if (!['validated_complete', 'validated_partial'].includes(snapshot.validation_status) || snapshot.environment !== 'demo' ||
      snapshot.registry_version !== registry.registry_version || !Number.isFinite(Date.parse(snapshot.created_at))) throw new Error('Invalid snapshot binding');
  if (Buffer.byteLength(canonicalJson(snapshot)) > 1024 * 1024) throw new Error('Snapshot exceeds document limit');
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges) || !Array.isArray(snapshot.evidence) || snapshot.nodes.length > 250 || snapshot.edges.length > 2500) throw new Error('Snapshot bounds exceeded');
  const nodes = new Set(snapshot.nodes.map(n => n.node_id));
  const registryIds = new Set(registry.services.map(n => n.id));
  if (nodes.size !== snapshot.nodes.length || [...nodes].some(id => !registryIds.has(id))) throw new Error('Snapshot has unreviewed or duplicate node');
  const evidence = new Map(snapshot.evidence.map(e => [e.evidence_id, e]));
  if (evidence.size !== snapshot.evidence.length || evidence.size > 100 || Buffer.byteLength(canonicalJson(snapshot.evidence)) > 256 * 1024) throw new Error('Evidence limits exceeded');
  const edgeIds = new Set();
  for (const edge of snapshot.edges) {
    const { edge_id, ...content } = edge;
    if (edge_id !== `edge://sha256:${contentHash(content)}` || edgeIds.has(edge_id)) throw new Error('Invalid edge hash or duplicate');
    edgeIds.add(edge_id);
    if (!nodes.has(edge.from_id) || !nodes.has(edge.to_id) || !RELATIONSHIPS.includes(edge.relationship_type) || edge.environment !== snapshot.environment) throw new Error('Invalid edge reference');
    if (!['hard', 'soft', 'unknown'].includes(edge.behavior?.classification) || !edge.source_refs?.length ||
        (edge.observed_at !== null && !Number.isFinite(Date.parse(edge.observed_at))) || !['observed', 'declared', 'inferred', 'validated', 'stale'].includes(edge.evidence_status)) throw new Error('Missing edge provenance');
    if (edge.source_refs.some(ref => !evidence.has(ref))) throw new Error('Unresolved evidence reference');
    if (edge.observed_at === null && (snapshot.validation_status !== 'validated_partial' || edge.evidence_status !== 'declared' ||
        edge.behavior.classification !== 'unknown' || edge.source_refs.some(ref => evidence.get(ref).status !== 'declared'))) throw new Error('Unknown declaration time cannot support validated behavior or complete coverage');
    if (edge.behavior.classification !== 'unknown') {
      if (!edge.behavior.operation || !edge.behavior.failure_mode || !edge.behavior.evidence_refs?.length ||
          edge.behavior.evidence_refs.some(ref => evidence.get(ref)?.status !== 'validated' || evidence.get(ref)?.environment !== snapshot.environment || evidence.get(ref)?.scope !== 'demo')) throw new Error('Unvalidated failure behavior');
    }
  }
  const hash = contentHash(snapshotContent(snapshot));
  if (hash !== snapshot.content_sha256 || snapshot.snapshot_id !== `snapshot://sha256:${hash}` || snapshot.graph_version !== `sha256:${hash}`) throw new Error('Snapshot hash mismatch');
  if (snapshot.validation_status === 'validated_complete' && snapshot.coverage.some(source =>
    source.truncated || source.errors.length || source.unknowns.length || source.freshness !== 'fresh' || ['pending', 'unavailable'].includes(source.status))) throw new Error('Inconsistent complete coverage');
  return snapshot;
}
