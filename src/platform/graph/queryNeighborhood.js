import { canonicalJson } from '../contracts/canonicalJson.js';

export const HARD_LIMITS = Object.freeze({ depth: 1, max_nodes: 250, max_edges_per_direction: 100, max_ms: 2000, max_evidence_bytes: 256 * 1024, max_references: 100 });
export function queryNeighborhood(snapshot, serviceIds, options = {}) {
  const limits = { ...HARD_LIMITS, ...options.limits };
  for (const [key, max] of Object.entries(HARD_LIMITS)) if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > max) throw new Error(`Invalid limit: ${key}`);
  const clock = options.clock || (() => performance.now());
  const start = clock();
  const nodes = new Map(snapshot.nodes.map(n => [n.node_id, n]));
  const visited = new Set();
  const refs = new Map();
  const allEvidence = new Map(snapshot.evidence.map(e => [e.evidence_id, e]));
  const upstream = [], downstream = [], frontier = [];
  const reasons = new Set();
  function truncated(edge, direction, reason) { reasons.add(reason); frontier.push({ edge_id: edge.edge_id, direction, from_id: edge.from_id, to_id: edge.to_id }); }
  const roots = [...new Set(serviceIds)].sort();
  if (roots.some(id => !nodes.has(id))) throw new Error('Unknown changed service in snapshot');
  if (roots.length > limits.max_nodes) {
    roots.slice(limits.max_nodes).forEach(node_id => { frontier.push({ node_id, reason: 'NODE_LIMIT' }); reasons.add('NODE_LIMIT'); });
  }
  roots.slice(0, limits.max_nodes).forEach(id => visited.add(id));
  for (const root of roots.slice(0, limits.max_nodes)) {
    for (const direction of ['upstream', 'downstream']) {
      let count = 0;
      for (const edge of snapshot.edges.filter(e => direction === 'upstream' ? e.to_id === root : e.from_id === root).sort((a, b) => a.edge_id.localeCompare(b.edge_id))) {
        const other = direction === 'upstream' ? edge.from_id : edge.to_id;
        if (clock() - start >= limits.max_ms) { truncated(edge, direction, 'TIME_LIMIT'); continue; }
        if (count >= limits.max_edges_per_direction) { truncated(edge, direction, 'FANOUT_LIMIT'); continue; }
        if (!visited.has(other) && visited.size >= limits.max_nodes) { truncated(edge, direction, 'NODE_LIMIT'); continue; }
        const nextRefs = new Map(refs);
        for (const ref of [...edge.source_refs, ...(edge.behavior.evidence_refs || [])]) nextRefs.set(ref, allEvidence.get(ref));
        if (nextRefs.size > limits.max_references || Buffer.byteLength(canonicalJson([...nextRefs.values()])) > limits.max_evidence_bytes) { truncated(edge, direction, 'EVIDENCE_LIMIT'); continue; }
        count++; visited.add(other); nextRefs.forEach((value, key) => refs.set(key, value));
        const nodePath = [nodes.get(edge.from_id), nodes.get(edge.to_id)];
        const node = nodes.get(other);
        const row = { changed_service_id: root, service_id: other, nodes: nodePath, edges: [edge], relationship_type: edge.relationship_type,
          behavior: edge.behavior, evidence_refs: edge.source_refs, tier: node.tier ?? null, owners: node.owners || [],
          freshness: 'unknown', unknowns: ['SOURCE_FRESHNESS_UNVERIFIED', ...(edge.behavior.classification === 'unknown' ? ['BEHAVIOR_UNKNOWN'] : [])] };
        (direction === 'upstream' ? upstream : downstream).push(row);
      }
    }
  }
  return { upstream, downstream, coverage: snapshot.coverage, bounds: { ...limits, returned_nodes: visited.size,
    elapsed_ms: Math.max(0, clock() - start), retained_evidence_bytes: Buffer.byteLength(canonicalJson([...refs.values()])),
    truncated: reasons.size > 0, truncation_reason: [...reasons].sort(), unexplored_frontier: frontier }, evidence: [...refs.values()] };
}
