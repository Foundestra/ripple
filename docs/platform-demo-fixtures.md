# Platform demo fixtures

These fixtures are reviewed, synthetic inputs for the service dependency platform contracts. They describe the existing Astronomy Shop demo only. They are not production identity, live telemetry, deployment authorization, or evidence that an external integration is available.

## Files

- `data/platform/demo/registry.yaml` maps the existing catalog services to canonical service and repository-aware component IDs. Catalog and seeded-graph names are declared aliases. OTel names remain unresolved telemetry claims, and unavailable Kubernetes, deployment, Datadog, and PagerDuty identities remain explicit unknowns.
- `data/platform/demo/graph-source.json` preserves each raw seeded `from`/`to` observation and the catalog's manual edge. `canonical_direction` records the normalized direction. In particular, seeded `kafka -> consumer` delivery observations normalize to `consumer -> kafka` `CONSUMES_FROM` facts. Seeded rates and protocols do not validate failure behavior, so every behavior classification is `unknown`.
- `data/platform/demo/policy-cases.json` provides deterministic HIGH, MEDIUM, UNKNOWN, and LOW expectations plus missing-control, stale-evidence, truncated-traversal, unknown-tier, and missing-commit cases. Only the complete case with authoritative passing required tests is LOW and bypass-eligible.
- `data/platform/demo/fixture-lineage/pr3.json` traces PAY-142 / PR 103 to seeded Jira, patch, catalog, graph, incident, policy, and fixed synthetic commit identity sources. Missing agent, Garden, Datadog, runbook, PagerDuty, contract-test, deployment, and production-verification evidence stays missing or unknown.
- `policy/platform-shadow-v1.yaml` defines deterministic shadow-only precedence. It never grants deploy authorization.

## Canonical hashes

Each fixture's `source_sha256` is SHA-256 over UTF-8 canonical JSON. Canonicalization recursively sorts object keys, preserves array order, and excludes only the top-level `source_sha256` and generated publication timestamp fields (`published_at`, `publication_timestamp`, and `publication_timestamps`) when present. Semantic evaluation times and source observation times remain part of the hash.

The semantic `version` and canonical content hash are separate fields. A consumer composes the immutable version reference as `{id}@{version}#sha256:{source_sha256}`. Changing content without changing the declared semantic version must fail publication review rather than silently replacing that version.

## Graph source shape

Graph source edges use raw fixture aliases in `from` and `to`, an explicit `relationship_type`, `canonical_direction`, source provenance, `observed_at`, evidence references, and evidence-qualified `behavior`. The document-level `source_version` binds the source fixture and capture time. A platform adapter resolves only reviewed `declared` or `validated` registry aliases; an unmapped endpoint becomes an unresolved observation and never creates a canonical service.

The source is intentionally `validated_partial`: an empty downstream result means no edge exists in this bounded seeded source, not that the service is known to have no downstream dependencies.
