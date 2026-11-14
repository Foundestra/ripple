# Platform V1 demo assessment

The platform assessment API is additive and disabled by default. Existing `/api/*`, dashboard, webhook, and advisory output remain unchanged.

## Modes and durability

- `RIPPLE_PLATFORM_MODE=off` is the default and registers no platform routes.
- `RIPPLE_PLATFORM_MODE=demo` permits only bundled demo fixtures and `repository://demo/opentelemetry-demo`. It requires `DATABASE_URL`; runtime assessments and active pointers are never stored only in process memory.
- `operational` fails closed. V1 does not provide a production authentication provider, source authorization, signed durable ingestion, or deploy authorization.

Start the isolated demo with a Postgres database and request the bundled PAY-142 assessment:

```sh
RIPPLE_PLATFORM_MODE=demo DATABASE_URL=postgres://... npm start
curl -sS -X POST http://localhost:4000/api/platform/v1/impact \
  -H 'content-type: application/json' \
  --data '{"fixture_id":"pr3"}'
```

The result is pinned to the synthetic demo commit, registry, immutable graph snapshot, policy version, and explicit `evaluation_at`. PAY-142 is `HIGH` and `partial`, with `would_lock`, `ineligible`, and authorization `not_evaluated`. Missing contract and human-review controls remain visible. No GitHub, Jira, Garden, Datadog, PagerDuty, deployment, protection, or other external write occurs.

Persisted reads do not refresh evidence:

- `GET /api/platform/v1/impacts/{assessment_id}`
- `GET /api/platform/v1/work-items/{work_item_id}/impact?limit=20`
- `GET /api/platform/v1/repositories/demo/opentelemetry-demo/pull-requests/103/impact?limit=20`

`commit_sha` selects exact history. `limit` defaults to 20 and cannot exceed 100. Expiry and changed-head invalidation are derived at read time; immutable assessment and decision rows are not edited.

## Limits and rollback

The API enforces a 256 KiB request cap, 100 files, 1,024-byte paths, one-hop traversal, 250 nodes, 100 edges per direction per changed service, two seconds, 256 KiB evidence, 100 references/history rows, and a 1 MiB result. Configuration may lower but not raise hard maxima.

Rollback sets `RIPPLE_PLATFORM_MODE=off`. Additive immutable audit tables remain in place; only documented active projections are rebuildable. This demo is synthetic contract evidence, not production validation or deploy authorization.
