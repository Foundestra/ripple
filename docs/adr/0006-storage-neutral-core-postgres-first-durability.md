# ADR-0006: Storage-neutral core and Postgres-first durability

- Status: Accepted
- Date: 2026-11-14

## Context

Ripple has a mutable Postgres compatibility mirror but no durable platform snapshot or assessment model.

## Decision

Pure contract, identity, traversal, and policy code consumes provider-neutral objects through a narrow store interface. Postgres is the first durable implementation. Additive migrations create immutable registry, snapshot, node, edge, evidence, assessment, decision, and event tables plus explicitly mutable active-pointer projections. Existing `ripple_*` tables are neither changed nor reinterpreted.

Canonical bounded JSON envelopes are retained for exact reconstruction; indexed rows support queries. Raw provider payloads, secrets, customer data, and incident discussion are not stored. External I/O never occurs inside database transactions. Duplicate replay uses a unique key. Migrations are checksumed, and application rollback disables platform mode while retaining audit history.

RDF, OWL, SHACL, SPARQL, and a new graph database require a later approved ADR backed by scale evidence.

## Consequences

The core remains testable without Postgres while production-like durability has a clear path. Projections may be rebuilt from immutable records. Rollback does not erase audit evidence.
