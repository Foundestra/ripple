// Additive evidence contract. Legacy `kind` remains a routing hypothesis, not proof.
export const DEPENDENCY_TYPES = ['runtime', 'shared_code', 'contract', 'data', 'deployment'];

function freshness(at, now, maxAgeSec, stale) {
  const stamp = Date.parse(at);
  if (!Number.isFinite(stamp) || stamp > now) return 'unknown';
  return stale || now - stamp > maxAgeSec * 1000 ? 'stale' : 'fresh';
}

export function dependencyEvidence(edge, graph, { now, maxAgeSec, experimentMaxAgeSec, environment }) {
  const types = [...new Set(edge.dependency_types || ['runtime'])];
  if (!types.length || types.some(t => !DEPENDENCY_TYPES.includes(t))) {
    throw new Error(`Invalid dependency_types for ${edge.from}->${edge.to}`);
  }
  const observation = {
    source: edge.origin === 'manual' ? 'catalog' : graph.source,
    status: edge.origin === 'manual' || graph.source === 'seeded' ? 'inferred' : 'observed',
    mock: graph.mock, environment,
    observed_at: edge.last_seen,
    freshness: freshness(edge.last_seen, now, maxAgeSec, graph.stale),
  };
  const evidence = [observation];
  let failureBehavior = 'unknown';
  let confidence = 'unknown';
  if (observation.status === 'observed' && !observation.mock && observation.freshness === 'fresh') confidence = 'medium';
  const exp = edge.experiment;
  if (edge.kind_source === 'experiment' && exp) {
    const item = {
      source: 'experiment', reference: exp.flag, environment: exp.environment,
      observed_at: exp.recorded_at || null,
      freshness: freshness(exp.recorded_at, now, experimentMaxAgeSec, false),
      status: exp.origin === 'sample' || graph.mock ? 'sample' : 'recorded',
    };
    const applicable = item.status === 'recorded' && item.freshness === 'fresh'
      && environment !== 'unknown' && exp.environment === environment;
    item.validates_failure_behavior = applicable;
    evidence.push(item);
    if (applicable) {
      failureBehavior = edge.kind;
      confidence = 'high';
    }
  }
  if (edge.kind_source === 'owner') {
    evidence.push({ source: 'owner', status: 'asserted', reason: edge.kind_reason, environment });
  }
  return {
    dependency_types: types,
    failure_behavior: failureBehavior,
    classification_basis: edge.kind_source,
    confidence,
    freshness: observation.freshness,
    evidence,
  };
}

export function graphEvidenceSummary(graph) {
  const edges = graph.edges;
  return {
    schema_version: 1,
    environment: graph.environment,
    edge_count: edges.length,
    unknown_behavior_count: edges.filter(e => e.failure_behavior === 'unknown').length,
    stale_edge_count: edges.filter(e => e.freshness === 'stale').length,
    unknown_freshness_count: edges.filter(e => e.freshness === 'unknown').length,
    mock: graph.mock,
    coverage: 'partial',
    coverage_note: 'No observed edge does not prove that no dependency exists. Static and contract discovery are not yet implemented.',
  };
}
