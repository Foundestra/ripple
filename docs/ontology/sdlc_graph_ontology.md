# AI SDLC Graph Ontology (Ripple v2.0)

## Overview
Formal ontology defining the nodes and edges for Ripple's hybrid static-plus-runtime graph, integrating static AST symbols, runtime OpenTelemetry trace edges, and CodeRabbit semantic PR review findings.

## Node Types
- `(:Symbol)`: Functions, methods, classes extracted via Tree-sitter.
  - Properties: `id` (e.g. `java:src/...#method(params)`), `file`, `qualified_name`, `kind`, `signature`, `is_exported`, `language`.
- `(:Route)`: Ingress API endpoint declarations (Spring annotations, FastAPI decorators).
  - Properties: `id` (e.g. `route:POST:/api/v1/payments`), `method`, `path`, `framework`, `handler_symbol_id`, `file`, `line`.
- `(:Service)`: Microservice boundary.
  - Properties: `id`, `repo`, `env`, `tier`.
- `(:PullRequest)`: GitHub change set.
  - Properties: `id`, `repo`, `base_sha`, `head_sha`, `author`, `status`.
- `(:ReviewFinding)`: Static or semantic analyzer findings (e.g. CodeRabbit).
  - Properties: `id`, `source` ("coderabbit"), `category`, `severity`, `title`, `impact_type`.
- `(:ConfigSetting)`: Configuration and infrastructure settings.
  - Properties: `id`, `key`, `file`, `file_type` ("yaml" | "env" | "tf").

## Edge Types
- `(s1:Symbol)-[:CALLS { resolution: "resolved"|"unresolved", reason: string }]->(s2:Symbol)`
- `(r:Route)-[:EXPOSES]->(s:Symbol)`
- `(s:Symbol)-[:INVOKES_RUNTIME { protocol, classification }]->(r:Route)`
- `(pr:PullRequest)-[:MODIFIES { lines_added, lines_deleted }]->(s:Symbol)`
- `(pr:PullRequest)-[:TOUCHES_CONFIG]->(c:ConfigSetting)`
- `(f:ReviewFinding)-[:FLAGS]->(s:Symbol)`
- `(svc:Service)-[:CONTAINS]->(s:Symbol)`

## Unresolved Edge Reason Codes
- `dynamic_interface_dispatch`: Interface with multiple or zero static implementations.
- `reflection_or_meta`: Java reflection or Python getattr/setattr.
- `third_party_boundary`: Call leaves the indexed repository boundaries.
- `unparsed_syntax`: Tree-sitter parse failure.
- `missing_definition`: Imported symbol definition not found in repository snapshot.
- `unresolved_decorator_route`: Route dynamically wrapped or decorated.

## Core Impact Cypher Query
```cypher
MATCH (pr:PullRequest { id: $pr_id })-[:MODIFIES]->(changed:Symbol)
OPTIONAL MATCH (finding:ReviewFinding)-[:FLAGS]->(changed)
MATCH path = (changed)<-[:CALLS*0..8]-(handler:Symbol)<-[:EXPOSES]-(route:Route)
MATCH (caller_service:Service)-[dep:INVOKES_RUNTIME]->(route)
RETURN 
  changed.qualified_name AS modified_symbol,
  finding.category AS coderabbit_finding,
  finding.severity AS finding_severity,
  route.method + " " + route.path AS affected_endpoint,
  caller_service.id AS impacted_downstream_service,
  dep.edge_classification AS dependency_tier,
  [node in nodes(path) | node.qualified_name] AS static_call_chain
ORDER BY finding.severity DESC, dep.edge_classification ASC
```
