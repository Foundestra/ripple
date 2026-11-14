# ADR-0002: Immutable versions and publication

- Status: Accepted
- Date: 2026-11-14

## Context

Impact decisions must be reproducible even when registries, graphs, policies, and evidence change. Partial source coverage must not be mistaken for known absence.

## Decision

Registry versions, graph snapshots, policy bundles, assessments, decisions, and event facts are immutable and content-addressed. Canonical SHA-256 hashes exclude publication timestamps and mutable active pointers but include normalized identities, source versions, observations, and evidence references. A declared semantic version with changed content is invalid.

Publication validates a complete bounded candidate, durably inserts the immutable document and append-only publication fact, then changes the active pointer in one ordered transaction. In-memory state changes only after commit. Refresh is single-flight; a later candidate cannot overtake an earlier one. Failure preserves the last-known-good pointer.

A snapshot can be `validated_partial` only when included facts are internally consistent and coverage, errors, limits, truncation, and unknowns are explicit. Empty partial results never assert absence.

Supersession and invalidation append facts; they do not edit immutable rows. Only documented active snapshot, current PR head, and active assessment projections are mutable and rebuildable.

## Consequences

Historical results remain hash-verifiable and reconstructable. Publication needs durable storage before activation. Partial data can be useful, but it cannot silently become complete evidence or a LOW decision.
