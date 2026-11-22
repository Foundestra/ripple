# ADR-0004: Deterministic shadow policy

- Status: Accepted
- Date: 2026-11-14

## Context

The legacy demo score is useful for display but is not an authorization or safety policy.

## Decision

Platform V1 uses a pure, versioned policy independent of the legacy risk gate. Identical immutable input and policy versions produce identical output. Precedence is:

1. `HIGH` for a known direct Tier 1, Tier 1 scenario-hard consumer, destructive/security change, mandatory contract or migration, or conflicting required identity/tier/dependency evidence.
2. `MEDIUM` for a direct Tier 2, Tier 1 scenario-soft consumer, unavailable/stale important non-identity evidence, or multi-consumer shared component, absent a HIGH trigger.
3. `UNKNOWN` for unresolved required identity, tier, direction/behavior, commit or version binding, controls, or traversal frontier, absent a known HIGH trigger.
4. `LOW` only for authoritatively Tier 3/4 direct services, no critical hard consumer, authoritative required tests passed, no security/migration/compliance signal, fresh complete required evidence, and untruncated traversal.

`HIGH`, `MEDIUM`, `UNKNOWN`, SOX, missing controls, insufficient evidence, and truncation produce `would_lock` and `ineligible`. Only a current LOW result can be `eligible_for_bypass`, which is informational and is never deploy authorization. Authorization remains `not_evaluated` in V1.

## Consequences

Known HIGH evidence retains HIGH even when the overall analysis is partial. Unknown evidence never yields LOW. Legacy risk may be returned only as display-only compatibility data with no authority and is not a policy input.
