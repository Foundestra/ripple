# Immutable demo snapshot foundation

This module is an additive foundation. It does not register HTTP routes or change the current dashboard, analyzer, deployment, or telemetry ingestion.

## Authority and identity

The adapter reads only the bundled, hash-verified Astronomy Shop manifest and graph source. It resolves seeded names through reviewed aliases. An unresolved or conflicting alias cannot create a service. The snapshot includes catalog services even when no edge touches the service.

The registry binds its semantic version to canonical content. Changing content under the same registry ID and semantic version fails publication. Canonical JSON sorts object keys and preserves array order. Publication timestamps do not change snapshot identity. Source observations and source versions do change snapshot identity.

Graph facts use caller/producer/reader/writer to dependency direction. Kafka delivery observations are normalized to consumer-to-channel `CONSUMES_FROM` facts. Inverse query direction does not create a second fact. Protocol does not validate failure behavior. The initial adapter emits only `unknown` behavior and `validated_partial` snapshots.

## Publication and durability

`SnapshotPublisher` queues candidate construction, validation, storage, and publication. It exposes a new in-memory pointer only after storage commits. A validation or storage failure preserves the previous pointer. Identical content returns the original stored snapshot, including its original publication metadata.

`PostgresSnapshotStore` stores the bounded canonical document, indexed nodes and edges, evidence, publication events, and the active projection in one transaction. A per-environment transaction lock serializes publication across processes. Publication generations come from immutable events, not the active projection. The active projection can be rebuilt without changing historical facts.

Postgres triggers reject updates and deletes on immutable platform fact tables. Only the active projection is mutable. The checksum migration runner applies additive migrations under a transaction lock and rejects changed historical migration files. It does not run a destructive down migration.

`MemorySnapshotStore` is an explicitly process-local test double. It is not operational persistence.

## Query limits

Queries return one-hop upstream and downstream paths with canonical nodes, edges, behavior, tier, owner, source references, and coverage. Empty output from this partial fixture does not mean known absence.

Hard limits are depth 1, 250 returned nodes, 100 edges per direction per changed service, 2 seconds, 256 KiB retained evidence, and 100 source references. A query can lower these limits but cannot increase them. Reaching a limit sets `truncated`, records the reason, and exposes the unexplored frontier. Unknown freshness remains unknown.

## Verification

Run foundation tests with an isolated Postgres database:

```bash
RIPPLE_PLATFORM_TEST_DATABASE_URL=postgres://localhost/ripple_demo_test \
  node --test test/platform/snapshot.test.js test/platform/postgres-snapshot.test.js
```

The database test creates and removes a unique test schema. Never point this variable at a production database. Without the variable, the Postgres-specific test is skipped.

Rollback disables the later platform wiring and retains immutable audit data. Do not delete audit rows as part of application rollback. This foundation does not enable enforcement, external writes, production identity, or deployment authorization.
