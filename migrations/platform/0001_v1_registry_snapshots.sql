CREATE TABLE platform_registry_versions (
  registry_version text PRIMARY KEY, registry_id text NOT NULL, scope text NOT NULL CHECK(scope = 'demo'),
  semantic_version text NOT NULL, content_sha256 text NOT NULL UNIQUE, manifest_json jsonb NOT NULL,
  validated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(registry_id, semantic_version), CHECK(octet_length(manifest_json::text) <= 1048576)
);
CREATE TABLE platform_graph_snapshots (
  snapshot_id text PRIMARY KEY, graph_version text NOT NULL, registry_version text NOT NULL REFERENCES platform_registry_versions,
  environment text NOT NULL CHECK(environment = 'demo'), content_sha256 text NOT NULL UNIQUE,
  validation_status text NOT NULL CHECK(validation_status IN ('validated_complete','validated_partial')),
  bounded_snapshot_json jsonb NOT NULL, coverage_json jsonb NOT NULL, source_versions_json jsonb NOT NULL,
  created_at timestamptz NOT NULL, CHECK(octet_length(bounded_snapshot_json::text) <= 1048576)
);
CREATE TABLE platform_graph_nodes (
  snapshot_id text NOT NULL REFERENCES platform_graph_snapshots, node_id text NOT NULL, entity_type text NOT NULL,
  attributes_json jsonb NOT NULL, PRIMARY KEY(snapshot_id,node_id)
);
CREATE TABLE platform_graph_edges (
  snapshot_id text NOT NULL REFERENCES platform_graph_snapshots, edge_id text NOT NULL,
  from_id text NOT NULL, to_id text NOT NULL, relationship_type text NOT NULL
    CHECK(relationship_type IN ('CALLS','PUBLISHES_TO','CONSUMES_FROM','READS_FROM','WRITES_TO','DEPENDS_ON')),
  behavior jsonb NOT NULL, evidence_json jsonb NOT NULL, observed_at timestamptz,
  PRIMARY KEY(snapshot_id,edge_id), FOREIGN KEY(snapshot_id,from_id) REFERENCES platform_graph_nodes(snapshot_id,node_id),
  FOREIGN KEY(snapshot_id,to_id) REFERENCES platform_graph_nodes(snapshot_id,node_id)
);
CREATE INDEX platform_graph_edges_from ON platform_graph_edges(snapshot_id,from_id);
CREATE INDEX platform_graph_edges_to ON platform_graph_edges(snapshot_id,to_id);
CREATE TABLE platform_snapshot_evidence (
  snapshot_id text NOT NULL REFERENCES platform_graph_snapshots, evidence_id text NOT NULL,
  source_system text NOT NULL, source_reference text NOT NULL, status text NOT NULL,
  observed_at timestamptz, bounded_evidence_json jsonb NOT NULL,
  PRIMARY KEY(snapshot_id,evidence_id), CHECK(octet_length(bounded_evidence_json::text) <= 262144)
);
CREATE TABLE platform_snapshot_events (
  event_id text PRIMARY KEY, snapshot_id text NOT NULL REFERENCES platform_graph_snapshots,
  event_type text NOT NULL CHECK(event_type IN ('PUBLISHED','SUPERSEDES','REJECTED')),
  related_snapshot_id text REFERENCES platform_graph_snapshots, occurred_at timestamptz NOT NULL DEFAULT now(), details_json jsonb NOT NULL
);
CREATE TABLE platform_active_snapshots (
  environment text PRIMARY KEY, snapshot_id text NOT NULL UNIQUE REFERENCES platform_graph_snapshots,
  publication_event_id text NOT NULL REFERENCES platform_snapshot_events, generation bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION platform_reject_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'platform facts are insert-only'; END;
$$;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['platform_registry_versions','platform_graph_snapshots','platform_graph_nodes','platform_graph_edges','platform_snapshot_evidence','platform_snapshot_events'] LOOP
    EXECUTE format('CREATE TRIGGER reject_fact_mutation BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION platform_reject_fact_mutation()', name);
  END LOOP;
END $$;
