# ADR-0007: Demo and operational security modes

- Status: Accepted
- Date: 2026-11-14

## Context

The existing public demo does not provide the authentication, authorization, or durable ingestion boundary required for operational platform data.

## Decision

Platform mode defaults to `off`. `demo` mode accepts only bundled fixtures and bounded records for an allowlisted demo repository, uses an explicit demo-fixture principal, and rejects arbitrary repositories, URLs, refreshes, external writes, and privileged tools. It does not expose the platform through the current public deployment by default.

`operational` mode fails closed unless an approved authentication provider, principal/role mapping, repository/environment/source allowlists, tenant isolation, durable store, signed webhook configuration, source authorization, rate/result caps, redaction/audit, and SSRF-safe outbound rules are present. There is no permissive fallback. Credentials and provider payloads never enter graph or assessment envelopes.

Autonomous execution, protection changes, deploy authorization, and enforcement remain off. The deterministic policy never depends on an LLM. Production sources are not enabled merely because credentials exist.

## Consequences

The first contracts can be exercised safely with synthetic demo authority but make no production-readiness claim. A production pilot requires separate security and release approval.
