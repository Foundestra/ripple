# ADR-0005: Idempotency and time

- Status: Accepted
- Date: 2026-11-14

## Context

Retries and wall-clock reads can otherwise create different decisions for the same change.

## Decision

Every request pins `evaluation_at`. The replay key is the SHA-256 of canonical repository ID, commit SHA, snapshot ID, registry version, policy version, and request-context SHA-256. The request-context hash includes evaluation time, normalized changes and signals, work/PR identity, limits, and control observations.

Retries reuse the original context and stored result; they never generate a new evaluation time. `valid_until` is the earliest evidence expiry, policy TTL, registry boundary, or snapshot boundary. Expired results remain immutable and auditable, but read projections report expiration and require a new explicitly timed assessment.

An accepted authoritative new head appends its observation, changes the current-head projection, clears the old active-assessment projection, and appends invalidation in one short transaction before reanalysis. Older out-of-order observations cannot reactivate eligibility.

## Consequences

Duplicate requests converge on one assessment. Time-dependent eligibility is explicit and reproducible. Failed replacement analysis cannot restore an old head's eligibility.
