# ADR-0008: Additive compatibility

- Status: Accepted
- Date: 2026-11-14

## Context

Ripple's current demo routes, dashboard payloads, graph JSON, comments, statuses, and risk display must remain usable while platform contracts evolve.

## Decision

Platform contracts use explicit `ripple.*.v1` schema versions and additive `/api/platform/v1/*` routes. P0 adds no runtime wiring. Later platform routing is isolated and disabled by default. Existing `/api/*` behavior, upstream graph methods, public UI, comments, statuses, workflows, and deployment settings remain unchanged.

Legacy risk can appear only under a clearly labeled display-only compatibility field with `authority: none`; it is not renamed or reused as a shadow decision. V1 APIs do not remove existing fields or reinterpret legacy data as authoritative evidence.

## Consequences

Consumers can adopt platform contracts incrementally and roll them back without changing the current demo. Any future breaking contract requires a new version and migration analysis.
