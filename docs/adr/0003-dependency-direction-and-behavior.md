# ADR-0003: Dependency direction and behavior

- Status: Accepted
- Date: 2026-11-14

## Context

Provider graphs use inconsistent direction and often infer hard or soft behavior from protocol alone.

## Decision

Persist one canonical directed fact from caller, producer, reader, or writer to callee, channel, or store. Persist `CALLS`, `PUBLISHES_TO`, `CONSUMES_FROM`, `READS_FROM`, `WRITES_TO`, or `DEPENDS_ON`. `CALLED_BY` is a query-time inverse and is never a duplicate stored fact.

Relationship type is separate from scenario behavior. Behavior is `hard`, `soft`, or `unknown` and binds operation, environment, failure mode, basis, and evidence references. Validated failure, correctness, or required-SLO impact supports `hard`. Validated acceptable fallback supports `soft`. Protocol-only assumptions, including asynchronous delivery, remain `unknown`.

One-hop impact returns paths, not only sets. Upstream means direct callers or consumers of a changed service; downstream means direct callees, channels, stores, or other dependencies of it. Every result reports coverage and traversal bounds.

## Consequences

Inverse queries are deterministic and do not double-count facts. The same relationship can acquire different behavior for different operations or failure modes in later ontology versions. Required asynchronous delivery is not mislabeled soft.
