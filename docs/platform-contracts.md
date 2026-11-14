# Platform V1 contract conventions

This document is the normative companion to `schemas/platform/v1/`. P0-A defines contracts only: it adds no runtime validator, route, persistence, deployment, or enforcement behavior.

## Identity and authority

Canonical IDs use `service://{domain}/{name}`, `repository://{namespace}/{repo}`, `component://{namespace}/{repo}/{component}`, and `deployment://{environment}/{unit}`. IDs are lowercase URI-like identifiers with no query or fragment. Service identity is global; environment belongs on deployment, observation, relationship, and snapshot records.

Only a reviewed registry creates a canonical service. Alias status is `declared`, `unresolved`, `conflicting`, `rejected`, or `validated`; only registry-reviewed `declared` and `validated` aliases resolve identity. Telemetry and provider labels create unresolved claims, never entities. `scope: demo` and `authority: demo_only` cannot be promoted by configuration.

A canonical service may have `tier: null`. Unknown tier remains unknown; it is never defaulted to Tier 3 or any other tier and can never support LOW classification.

## Versions and hashes

All contract documents carry a fixed `schema_version`. Registry, graph, policy, assessment, and decision records are immutable. SHA-256 values are lowercase 64-hex strings and use a `sha256:` prefix when embedded in a version URI.

Canonical JSON recursively sorts object keys, preserves array order, uses UTF-8, and emits no insignificant whitespace. Registry content hashing excludes only top-level `source_sha256`. Snapshot content hashing excludes only top-level `snapshot_id`, `graph_version`, `content_sha256`, and `created_at`; source observations remain in the hash input. Mutable active pointers are outside immutable contract documents. A declared semantic version with different canonical content is invalid.

- Registry: `registry://{namespace}/{name}@{semver}#sha256:{digest}`.
- Graph version: `sha256:{digest}`; `snapshot_id` is `snapshot://sha256:{digest}`. A snapshot freezes `nodes`, canonical directed `edges`, and bounded `evidence` metadata.
- Policy: `policy://{name}@{semver}#sha256:{digest}`.
- Assessment: `assessment://sha256:{digest}`; decision: `decision://sha256:{digest}`.

`content_sha256` hashes the bounded canonical document after omitting that document's `content_sha256` member. `request_context_sha256` hashes pinned evaluation time, normalized changes/signals, work and PR identity, configured limits, and controls. Replay identity hashes canonical repository ID, commit SHA, snapshot ID, registry version, policy version, and request-context hash.

## Dependency projection

Persist one edge from caller/producer/reader/writer to callee/channel/store. `CALLED_BY` is derived and is not stored. Relationship type is not behavior. Behavior binds `hard`, `soft`, or `unknown` to an operation, failure mode, environment, basis, and evidence. Async is not automatically soft.

Upstream paths are callers/consumers of a changed service. Downstream paths are dependencies it calls, publishes to, consumes from, reads from, writes to, or otherwise depends on. Empty arrays include `complete` or `partial` coverage; partial never means known absence.

A declaration with no trustworthy observation time keeps `observed_at: null`; the edge must be `declared` with `behavior.classification: unknown`, and matching evidence must also be `declared`. Such a snapshot is partial, preserves the unknown-time declaration, and cannot support LOW. Source-version capture times remain concrete UTC date-times.

## Immutable records and mutable projections

Registry versions, snapshots, frozen nodes/edges/evidence, assessments, shadow decisions, head observations, publication events, invalidations, rejections, and supersessions are insert-only. Expiry and current eligibility are read-time derivations.

Only active snapshot, current PR head, and active assessment pointers are mutable. They are rebuildable projections and are changed in short transactions after durable immutable writes. Publication failure preserves the last known good pointer. A newly accepted head invalidates old eligibility before replacement analysis.

## Analysis and policy states

`analysis_status` describes execution/evidence sufficiency: `complete`, `partial`, `insufficient_evidence`, or `failed`. `risk_classification` is independently `HIGH`, `MEDIUM`, `LOW`, or `UNKNOWN`. Known HIGH evidence can coexist with partial analysis. Missing commit or version identity is insufficient evidence. Unknown, conflicting, stale-required, unresolved, or truncated evidence can never produce LOW.

Shadow results are informational. HIGH, MEDIUM, UNKNOWN, SOX, missing controls, insufficient evidence, and truncation are `would_lock` and `ineligible`. LOW may be `eligible_for_bypass`, never authorized. V1 authorization is always `not_evaluated` with a null authorization ID.

## Finite hard maxima

Configuration may lower but never raise these limits:

| Boundary | Hard maximum |
|---|---:|
| HTTP request body | 256 KiB |
| Changed files | 100 |
| UTF-8 path length | 1,024 bytes |
| Traversal depth | 1 |
| Returned nodes | 250 |
| Edges per direction per changed service | 100 |
| Assessment wall time | 2 seconds |
| Retained evidence references | 256 KiB |
| Source references | 100 |
| History rows | 100 (default 20) |
| Serialized result | 1 MiB |

Malformed and oversized input creates no assessment. Traversal bound exhaustion returns a successful `partial`, `truncated` result with an unexplored frontier and cannot be LOW.

Stable errors are `413 REQUEST_TOO_LARGE`; `422 FILE_LIMIT_EXCEEDED`, `PATH_TOO_LONG`, `HISTORY_LIMIT_EXCEEDED`, `INVALID_REPOSITORY`, `INVALID_COMMIT_SHA`, `INVALID_EVALUATION_AT`; `409 HEAD_SUPERSEDED`, `SNAPSHOT_VERSION_CONFLICT`; `503 NO_VALIDATED_SNAPSHOT`; and `504 ASSESSMENT_TIME_LIMIT`.

## Migration and rollback boundary

Later Postgres migrations are additive and do not alter `ripple_services` or `ripple_edges`. Bounded canonical envelopes enable hash reconstruction; indexed rows enable reads. External I/O never occurs in a transaction. Migration versions are checksumed. Rollback disables platform mode and retains immutable audit data; automated application rollback never drops it.

## Security modes

Mode defaults to `off`. `demo` accepts only bundled demo fixtures and its allowlisted repository, with no arbitrary URL/source fetch or external write. `operational` fails closed until approved authentication, principals/roles, tenant and source scope, allowlists, durable storage, required webhook signatures, identifier/URL validation, SSRF controls, caps, redaction, audit, and observability exist. Secrets and raw provider payloads never enter contracts. Autonomous execution and enforcement remain off.

## Examples

The examples include complete LOW eligibility, partial known-HIGH, insufficient identity, and UNKNOWN policy outcomes. They are synthetic contract examples, not production evidence or authorization.
