# Ripple

**A PR review orchestrator that tells you what a change can break *before* it merges, not after it pages someone.**

Code review only sees the diff. Ripple reads the system the diff lands in:

- who calls the changed service, how critically, and how far a failure travels (from real OpenTelemetry traces)
- whether a change like this caused an outage before (incident and RCA recall)
- whether the diff actually does what its Jira ticket says

It classifies every PR as **LOW**, **MEDIUM** or **HIGH** risk and posts one comment a human can act on in 30 seconds. Low-risk PRs get a quiet approve-to-proceed; high-risk PRs get the blast radius, matching incidents, the ticket check, suggested reviewers, and the checks to run. Ripple advises; a human always makes the merge call.

```
                    ┌──────────── 3 signal families, fetched in parallel ────────────┐
 GitHub webhook ──▶ │ Planning: Jira ticket  │ Code: tier + N-hop graph │ Build: diff risk + incidents │
                    └────────────────────────────────┬───────────────────────────────┘
                                                     ▼
                                              Risk gate (LOW / MEDIUM / HIGH)
                                   LOW ──▶ short comment, no agents
                         MEDIUM / HIGH ──▶ agents it needs: blast radius · incidents · intent · reviewers · checks · narrator
                                                     ▼
                                   One PR comment + advisory check (never blocks)
```

## Quick start (offline, 1 minute)

```bash
npm install
npm run demo          # http://localhost:4000
```

That runs everything on the seeded graph snapshot, catalog, tickets and incidents: no Docker, no keys, no network.

For the **full demo on a laptop**, run `npm run demo:full`. It starts Ripple's **OTel mock**, a simulated Astronomy Shop served through the real Prometheus and Jaeger APIs. Ripple records real failure experiments against it (flagd flag flips) and then refreshes the graph every 5s, so you can break `payment` live and watch the edges turn red. Everything from the mock is labelled *mock*, never *live*. **Start with [docs/JUMPSTART.md](docs/JUMPSTART.md)**: it walks every level, from offline to real GitHub PRs to the real OpenTelemetry Demo. The dashboard is a presenter deck that follows the demo script: press `→` to advance and `1` `2` `3` to open the demo PRs. See [docs/DEMO.md](docs/DEMO.md) for the run of show and [docs/Ripple-pitch.pptx](docs/Ripple-pitch.pptx) for the pitch deck (19 slides with speaker notes).

From the terminal:

```bash
node src/cli.js analyze --all              # verdict table for the three demo PRs
node src/cli.js analyze --fixture pr3      # the full HIGH-risk comment, as posted on GitHub
node src/cli.js analyze --patch my.patch --title "PAY-142: ..."
node src/cli.js graph                      # current edges, hard/soft, and why
```

```
┌─────┬─────────────────────────────────────────────────┬──────────┬─────────┬───────┐
│ pr  │ title                                           │ expected │ verdict │ score │
├─────┼─────────────────────────────────────────────────┼──────────┼─────────┼───────┤
│ pr1 │ Spring sale ad copy (AD-31)                     │ low      │ low     │ 0     │
│ pr2 │ Return up to 10 stable recommendations (REC-88) │ medium   │ medium  │ 6     │
│ pr3 │ PAY-142: currency code on charge response       │ high     │ high    │ 14    │
└─────┴─────────────────────────────────────────────────┴──────────┴─────────┴───────┘
```

## The three demo PRs

All three are real patches against [open-telemetry/opentelemetry-demo](https://github.com/open-telemetry/opentelemetry-demo) (`fixtures/prs/*/diff.patch`, generated at `6a89fab`).

| PR | Change | Verdict | Why |
|---|---|---|---|
| 1 | Copy tweak in the `ad` service (tier 3, leaf) | **LOW**: quiet approve, no agents | String-literal-only change; `frontend` → `ad` is a soft edge |
| 2 | `ListRecommendations` returns 10 sorted results instead of 5 random | **MEDIUM**: soft-edge warning | Frontend calls it but has a fallback; INC-1877 was exactly this kind of silent degradation |
| 3 | `ChargeResponse.transaction_id` removed from the payment contract (tier 1) | **HIGH**: full review | `checkout` hard-depends on `payment` (verified by failure injection), INC-2031 matches, and PAY-142 asked for an additive change |

## How it works

### Signals

| Family | What Ripple reads | Implementation |
|---|---|---|
| **Planning** | Linked Jira ticket (key from title, branch or body) | `src/core/intent.js`: scope vs ticket components; breaking changes the ticket never mentions; "additive only" tickets that aren't. Optional LLM assessment on top. |
| **Code** | Service tier, direct dependents, N-hop chain, hard vs. soft edges | `src/core/graph.js` (in memory) or `src/adapters/postgresGraphStore.js` (recursive CTE in Postgres). |
| **Build** | Contract files, migrations, diff size, CI, past incidents and RCAs | `src/core/changeRisk.js` diffs `.proto` fields (removed / renamed / renumbered / retyped) and attributes shared proto changes to the owning service; `src/adapters/incidents.js` recalls similar incidents (TF-IDF, service names excluded so "same service" alone isn't similarity). |

### Hard vs. soft edges

1. **Protocol default.** Synchronous HTTP/gRPC/SQL calls on the request path start **hard**; Kafka and cache calls start **soft**.
2. **Failure experiments.** `ripple experiment` flips a flagd flag (e.g. `paymentFailure`), samples Prometheus before, during and after, and restores the flag. If the callee's errors rise *and the caller's rise with it*, the edge is **hard**. If the caller stays flat, it's **soft** (it degrades gracefully).
3. **Owner overrides** in `data/catalog.yaml` win both ways (e.g. `cart → valkey-cart` is a cache call but it's the system of record, so it's hard).

### Risk gate

Deterministic and itemised: every point shows up in the comment's "Why" table.

| Factor | Points |
|---|---|
| Tier of changed service | tier 1 +3, tier 2 +1 |
| Breaking contract change / additive contract change | +3 / +1 |
| API handler changed (no contract change) | +2 |
| Interface change with hard-edge callers (+1 more if any are tier 1) | +3 |
| Interface change with soft-edge callers only | +1 |
| Migrations · diff > 400 / > 1000 lines · CI failing | +2 · +1 / +2 · +2 |
| Past incident match / related | +2 / +1 |
| Ticket mismatch / partial / missing | +2 / +1 / +1 |

MEDIUM ≥ 3, HIGH ≥ 7. **Don't cry wolf:** HIGH additionally requires a way to actually break something (an interface change with hard tier-1 callers, a breaking change, or a migration); otherwise it's capped at MEDIUM. Docs-only PRs are LOW.

### Agents

LOW PRs skip them. MEDIUM/HIGH run the ones their signals need, in parallel (`src/core/agents.js`):

- **Blast radius mapper**: affected services, chains, and why each edge is hard/soft
- **Incident historian**: matching incidents, RCA, and what to watch for
- **Intent verifier**: diff vs ticket (plus an LLM assessment if configured)
- **Reviewer router**: owners of hard-dependent callers within 2 hops, plus a co-owner of the changed service (never the author); soft-edge owners are cc'd
- **Checks planner**: concrete pre-merge steps (proto breaking check, consumer-first deploy, `make run-telemetry-tests`, incident follow-ups)
- **Narrator** (LLM only): rewrites the one-line verdict

Agents are deterministic by default. With `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`), the intent verifier and narrator add model-written judgement. Every LLM call has a timeout and falls back silently.

## Running it live against the OpenTelemetry Demo

1. **Start the demo with the servicegraph connector**

   ```bash
   git clone https://github.com/<you>/opentelemetry-demo && cd opentelemetry-demo
   cp /path/to/ripple/deploy/otelcol-config-extras.yml src/otel-collector/otelcol-config-extras.yml
   make start      # UI on :8080, Prometheus on :9090, Jaeger at :8080/jaeger/ui
   ```

   The overlay is validated with `otelcol-contrib validate` (v0.160.0, the demo's pinned version) on top of the demo's own config layers. Let it run for an hour so the graph has traffic.

2. **Start Ripple** (`npm start`). With `RIPPLE_GRAPH_SOURCE=auto` it reads Prometheus servicegraph metrics, falls back to Jaeger's dependencies API, and falls back again to the snapshot. The header chip shows which is live. `node src/cli.js graph snapshot` saves the live graph as the new offline fallback.

   Or run Ripple plus Postgres next to the demo: `docker compose up --build` (joins the `opentelemetry-demo` network and stores the graph in Postgres).

3. **Record the failure experiments**

   ```bash
   node src/cli.js experiment --flag paymentFailure --target payment \
     --flagd-file ../opentelemetry-demo/src/flagd/demo.flagd.json
   node src/cli.js experiment --flag adFailure --variant on --target ad \
     --flagd-file ../opentelemetry-demo/src/flagd/demo.flagd.json
   ```

   Results go to `data/runtime/experiments/` (git-ignored), override the bundled sample recordings in `data/experiments/` flag by flag, and drive edge classification and the replay chart within one graph refresh. Copy them into `data/experiments/` to ship them.

   The runner judges an edge by **propagation**, not raw error rates: the share of failed calls to the callee that became failed requests of the caller (≥ 40% → hard). A busy caller like `frontend` serves far more than checkout traffic, so its overall error rate barely moves even though every checkout failure reaches the user.

4. **Connect GitHub**
   - Create a webhook on your fork: payload URL `https://<ripple-host>/webhook/github`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, event **Pull requests**.
   - Auth: `GITHUB_TOKEN` (comment + commit status) or a GitHub App via `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_PATH` (comment + Checks API). The App needs Pull requests, Issues and Checks write, and Contents and Commit statuses read.
   - Push the demo branches: `scripts/create-demo-prs.sh /path/to/your/fork` (add `--open` to open the PRs with `gh`).
   - For a local server, expose it with any tunnel (e.g. `cloudflared tunnel --url http://localhost:4000`) and set `RIPPLE_PUBLIC_URL`.

   Ripple keeps one comment per PR and updates it on every push. With a GitHub App it also posts a check run (`success` for LOW, `neutral` for MEDIUM/HIGH); with a token, a `success` commit status whose description carries the verdict. Either way it never blocks a merge.

## What's live vs. seeded

| Signal | Status | Source |
|---|---|---|
| Dependency edges and chains | Live | OTel traces (Collector servicegraph → Prometheus, or Jaeger) |
| Hard vs. soft classification | Live | flagd failure injection + trace correlation (`ripple experiment`) |
| *(with `npm run demo:full`)* graph + experiments | Mock | Ripple's OTel mock: same APIs, simulated traffic; labelled **Mock** everywhere |
| Change risk and CI | Live | Real PRs via GitHub webhook |
| Service tier and owners | Seeded | `data/catalog.yaml` |
| Jira tickets | Seeded | `data/jira/tickets.json` (real Jira adapter: `RIPPLE_PLANNING_SOURCE=jira`) |
| Incidents and RCAs | Seeded | `data/incidents/incidents.json`, several written from failures triggered on purpose |

Every seeded source sits behind an adapter with the same interface a real integration uses. The bundled experiment recordings are marked `origin: "sample"` until you record real ones, and the dashboard says so.

## Configuration

See [`.env.example`](.env.example). Nothing is required for the offline demo.

## Tests

```bash
npm test                                             # 20 tests (1 needs Postgres): diff/proto parsing, graph, risk gate,
                                                     # webhook -> comment against a fake GitHub,
                                                     # Prometheus/Jaeger sources, experiment runner
RIPPLE_TEST_DATABASE_URL=postgres://... npm test     # + Postgres CTE parity with the in-memory graph
```

## Layout

```
src/
  server.js               HTTP: dashboard, API, SSE events, GitHub webhook
  cli.js                  analyze / graph / experiment
  core/                   orchestrator, diff + change risk, graph, intent, risk gate, agents, comment
  adapters/               catalog, graph sources (Prometheus/Jaeger/snapshot), Postgres store,
                          planning (seeded/Jira), incidents, LLM (Gemini/Anthropic/none), fixtures
  experiments/runner.js   flagd failure injection + propagation verdicts
  mock/otelMock.js        OTel mock: simulated Astronomy Shop behind Prometheus/Jaeger APIs
  github/client.js        App/token auth, PR files, comment upsert, Checks/status
public/                   presenter dashboard (no build step)
data/                     catalog, graph snapshot, experiments, Jira tickets, incidents
fixtures/prs/             the three demo PRs (real OTel Demo patches)
deploy/                   OTel Collector servicegraph overlay
scripts/                  full-demo.js, replay-webhook.js, create-demo-prs.sh
```

## Roadmap

- **Next:** real Jira and incident-tool adapters; static analysis to catch dependencies with no traffic yet.
- **Then:** a learning loop, where post-merge incidents feed back to tune the risk weights.
- **Later:** deploy-time gating, so a high-risk change can require a canary or a deploy lock.
