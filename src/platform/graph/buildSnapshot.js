import { contentHash, frozenCopy } from '../contracts/canonicalJson.js';

export function snapshotContent(snapshot) {
  const { snapshot_id, graph_version, content_sha256, created_at, ...content } = snapshot;
  return content;
}
export function buildSnapshot({ registry, nodes, edges, evidence = [], coverage, source_versions, environment = 'demo', created_at, valid_until }) {
  const canonicalEdges = edges.map(edge => {
    const { edge_id, ...fact } = edge;
    return { ...fact, edge_id: `edge://sha256:${contentHash(fact)}` };
  }).sort((a, b) => a.edge_id.localeCompare(b.edge_id));
  const document = { schema_version: 'ripple.graph-snapshot.v1', registry_version: registry.registry_version, environment,
    validation_status: 'validated_partial', nodes: [...nodes].sort((a, b) => a.node_id.localeCompare(b.node_id)),
    edges: canonicalEdges, evidence: [...evidence].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id)), coverage, source_versions,
    ...(valid_until ? { valid_until } : {}) };
  const hash = contentHash(document);
  return frozenCopy({ ...document, snapshot_id: `snapshot://sha256:${hash}`, graph_version: `sha256:${hash}`, content_sha256: hash, created_at });
}
