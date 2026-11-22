# ADR-0001: Canonical identity and demo authority

- Status: Accepted
- Date: 2026-11-14

## Context

Ripple's existing fixtures identify services by local names. Those names are not sufficient across repositories, environments, or providers, and telemetry labels must not create authoritative platform entities.

## Decision

Platform V1 uses these canonical forms:

- `service://{domain}/{name}`
- `repository://{namespace}/{repo}`
- `component://{namespace}/{repo}/{component}`
- `deployment://{environment}/{unit}`

Service identity is global. Environment scopes deployments, observations, and dependency behavior, not service identity. Only a reviewed registry may create canonical services. Provider strings are aliases or unresolved claims until a reviewed `declared` or `validated` mapping resolves them. Conflicting, rejected, and unresolved aliases remain visible.

The initial Astronomy Shop registry has `scope: demo` and demo-only authority. Configuration, telemetry, or successful validation cannot promote it to production authority. A production registry requires a separate review and publication.

Path resolution is repository-aware and records the component and service candidates, resolution reason, registry version, descriptive confidence, fallback use, and warnings. Numerical confidence never grants authority.

## Consequences

Unmapped provider names remain unknown rather than creating services. Polyrepos, monorepos, shared components, generated files, documentation, moves, deletes, and repository fallback can be represented without changing canonical identity. Existing bare-name catalog behavior remains legacy-only.
