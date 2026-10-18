# Ripple jumpstart: from zero to a full demo

This guide takes you from a fresh laptop to the complete Ripple demo, step by step. Pick the level you need; each one builds on the previous.

| Level | What you get | Needs | Time |
|---|---|---|---|
| **1. Offline** | Dashboard + the three demo PRs on seeded data | Node 20+ | 2 min |
| **2. Full demo with the OTel mock** *(recommended for the hackathon)* | Graph rebuilt every 5s from simulated OpenTelemetry traffic, real failure experiments, a failure you trigger live on stage | Node 20+ | 5 min |
| **3. Real GitHub PRs** | Ripple's comment and status land on real PRs | + GitHub account, token | 15 min |
| **4. Real OpenTelemetry Demo** | The real Astronomy Shop (≈15 services in Docker) feeding Ripple | + Docker, 8 GB RAM free | 45 min + 1 h of traffic |

```
              Level 2 (laptop)                                  Level 4 (Docker)
 ┌──────────────────────────────────┐            ┌────────────────────────────────────┐
 │ Ripple OTel mock  :9091          │            │ OpenTelemetry Demo                 │
 │  · simulated Astronomy Shop      │            │  · 15 real services + load gen     │
 │  · Prometheus API (servicegraph) │  same      │  · Collector servicegraph → Prom.  │
 │  · Jaeger dependencies API       │◀─ APIs ──▶ │  · Jaeger                          │
 │  · flagd flag file               │            │  · flagd                           │
 └──────────────┬───────────────────┘            └────────────────┬───────────────────┘
                └───────────────────────┬─────────────────────────┘
                                        ▼
                         Ripple :4000 (dashboard, API, webhook) ──▶ GitHub PR comment + status
```

---

## 0. Prerequisites

| Tool | Level | Check |
|---|---|---|
| Node.js 20 or newer | all | `node -v` |
| git | all | `git --version` |
| A GitHub account and a personal access token | 3+ | see step 3.2 |
| GitHub CLI `gh` *(optional, opens PRs for you)* | 3+ | `gh --version` |
| Docker with Compose v2, ≥ 8 GB RAM for Docker | 4 | `docker compose version` |
| A Gemini API key *(optional)* | any | adds model-written judgement to the agents |

## 1. Get the code and check it works

```bash
git clone "https://github.com/<your-github-owner>/ripple.git"
cd ripple
git checkout claude/hackathon-product-pitch-v40oqj     # until it's merged
npm install
npm test
```

You should see `# pass 19`, `# fail 0` and `# skipped 1`. The skipped test needs a Postgres URL; see [Optional: Postgres](#optional-postgres-graph-store).

Sanity-check the analysis from the terminal:

```bash
node src/cli.js analyze --all
```

```
│ pr1 │ Spring sale ad copy (AD-31)                     │ low    │ low    │ 0  │
│ pr2 │ Return up to 10 stable recommendations (REC-88) │ medium │ medium │ 6  │
│ pr3 │ PAY-142: currency code on charge response       │ high   │ high   │ 14 │
```

---

## Level 1: Offline demo (2 minutes)

```bash
npm run demo
```

Open **http://localhost:4000**. Everything runs on seeded data: the graph snapshot, the catalog, tickets, incidents, and *sample* experiment recordings. There's no network and nothing to configure, so this is also your **backup if anything fails on stage**.

Keys: `→`/`Space` next section · `←` back · `1` `2` `3` run a demo PR · `R` replay the experiment · `T` theme.

---

## Level 2: Full demo with the OTel mock (recommended)

### What the OTel mock is

`src/mock/otelMock.js` is a simulated OpenTelemetry Demo (the Astronomy Shop) that serves the **same HTTP APIs Ripple reads from the real stack**:

| API | Endpoint on the mock | Used by |
|---|---|---|
| Prometheus query API | `GET /api/v1/query?query=…` (the PromQL subset Ripple sends) | graph source, experiment runner |
| Prometheus build info | `GET /api/v1/status/buildinfo` → `application: ripple-otel-mock` | lets Ripple label data as **mock** |
| Jaeger dependencies | `GET /jaeger/ui/api/dependencies` | fallback graph source |
| flagd | the JSON flag file `data/runtime/flagd.json`, in the OpenTelemetry Demo's own format | failure injection |
| Control plane *(mock only)* | `GET /flags`, `POST /flags/<flag>?variant=<v>`, `GET /` (live error rates) | flipping flags live on stage |

Ripple has **no special code path** for the mock. It talks to it exactly as it talks to a real Prometheus and Jaeger. The one difference is honesty: the mock identifies itself, so the dashboard header, the "Live vs seeded" table, the experiment notes and every PR comment footer say **mock**, never **live**.

#### The mock data

| Data | File | What's in it |
|---|---|---|
| Traffic | `data/graph-snapshot.json` | 21 caller → callee edges of the Astronomy Shop with calls/min (e.g. `frontend → product-catalog` 655/min, `checkout → payment` 41/min), protocol (gRPC, HTTP, Kafka, Redis) |
| Flags | `data/mock/demo.flagd.json` | 8 flags copied from the OpenTelemetry Demo: `paymentFailure`, `paymentUnreachable`, `adFailure`, `cartFailure`, `productCatalogFailure`, `recommendationCacheFailure`, `kafkaQueueProblems`, `emailMemoryLeak` |
| Ground truth | `data/mock/scenario.json` | How failures propagate: sync calls propagate fully (hard), Kafka doesn't (soft), and `frontend → ad`, `frontend → recommendation`, `checkout → email` are absorbed by fallbacks (soft). What each flag breaks, and how badly |

**Ripple never reads `scenario.json`.** It has to *discover* hard vs soft edges by running failure experiments against the mock, the same way it would against production. That's the point of the demo.

How the simulation computes errors: each service fails some fraction of its own requests (base 0.2% plus any active fault). A caller's error rate also includes its callees' errors, weighted by how often it calls them and how strongly the edge propagates. So with `paymentFailure` at 100%, checkout fails ~97% of orders, but frontend's *overall* error rate only rises to ~4%, because only checkout-page traffic touches payment. That's realistic, and it's why Ripple measures **propagation** (the share of failed calls that turned into failed caller requests) rather than raw error rates.

### 2.1 Start everything with one command

```bash
npm run demo:full
```

```
✔ OTel mock on http://localhost:9091 (flag file: data/runtime/flagd.json)
… recording paymentFailure against the mock (≈40s)
  checkout → payment: HARD (97% propagated)
  frontend → checkout: HARD (99% propagated)
… recording adFailure against the mock (≈40s)
  frontend → ad: SOFT (0% propagated)
✔ Ripple on http://localhost:4000  (graph: prometheus, mock)
```

What just happened:

1. The mock started on `:9091` and copied the flag file to `data/runtime/flagd.json` (git-ignored).
2. Ripple recorded two **failure experiments**. For each one it measured a baseline, flipped the flag in the flag file, sampled Prometheus every 2s, restored the flag, and computed a verdict per edge. The results are in `data/runtime/experiments/*.json`.
3. Ripple started pointed at the mock (`PROMETHEUS_URL=http://localhost:9091`, overriding `.env`) with a 5-second graph refresh. If the mock dies mid-demo, Ripple falls back to the snapshot on its own.

The first run takes about 90 seconds; later runs reuse the recordings. Use `npm run demo:full -- --record` to re-record, or `-- --skip-experiments` to skip them.

### 2.2 Check that it's wired up

```bash
curl -s localhost:4000/api/status | jq '.graph.source, .graph.mock, .experiments'
# "prometheus"  true  [ {flag: "adFailure", origin: "recorded", environment: "mock"}, … ]
curl -s localhost:9091/ | jq '.activeFaults, .serviceErrorRates.checkout'
# {}  0.0021
```

In the dashboard, the header chip reads **graph: mock OTel · prometheus API**, the experiment chart says *Recorded … against Ripple's OTel mock*, and the "Live vs seeded" table shows **Mock** for the graph and experiments.

### 2.3 The live failure moment

With the dashboard on **Dependency map**, run in a second terminal:

```bash
curl -X POST "localhost:9091/flags/paymentFailure?variant=100%25"
```

Within about 5 seconds the `checkout → payment` and `frontend → checkout` edges turn red and pulse, and the subtitle says *2 edges failing right now*. Click `payment` to show its blast radius. Then turn it off:

```bash
curl -X POST "localhost:9091/flags/paymentFailure?variant=off"
```

![Failing edges on the dependency map](images/graph-failing.png)

Other flags to try: `adFailure` (`variant=on`, frontend → ad turns red but frontend stays healthy: a soft edge), `cartFailure` (`variant=50%25`), `productCatalogFailure` (`variant=on`). Variants are listed by `curl localhost:9091/flags`.

### 2.4 Record experiments by hand (optional)

This is the same thing `demo:full` does, but visible, and good for explaining the method:

```bash
npm run mock:otel                                   # terminal 1
PROMETHEUS_URL=http://localhost:9091 RIPPLE_GRAPH_SOURCE=prometheus \
  node src/cli.js experiment --flag paymentFailure --target payment \
  --baseline 20 --duration 30 --recovery 15 --step 2  # terminal 2
```

Against the mock, `--flagd-file` defaults to `data/runtime/flagd.json`. A running Ripple server picks up new recordings within one graph refresh and replays the chart.

![Failure experiment against the mock](images/experiment.png)

### 2.5 Change the scenario (optional)

Edit `data/mock/scenario.json` and restart the mock. For example, set `"frontend->recommendation": 1.0` to pretend the frontend fallback is broken. Re-record with `npm run demo:full -- --record`, and Ripple will discover a **hard** edge there.

---

## Level 3: Real GitHub PRs

Ripple fetches the PR's diff from GitHub, analyzes it, and posts **one comment** (updated on every push) plus an **advisory status**. It never blocks a merge.

### 3.1 Fork the demo repo

Fork **https://github.com/open-telemetry/opentelemetry-demo** to your account, then clone it next to Ripple:

```bash
cd ..
git clone https://github.com/<you>/opentelemetry-demo.git
cd ripple
```

### 3.2 Create a token

GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → *Generate new token*:

- Repository access: **Only select repositories** → your `opentelemetry-demo` fork
- Permissions:
  - **Pull requests: Read and write** (read PR files, post the comment)
  - **Commit statuses: Read and write** (post the verdict status)
  - **Contents: Read**
  - **Issues: Read and write** (PR comments go through the issues API)

### 3.3 Configure Ripple

```bash
cp .env.example .env
```

Set at least:

```ini
GITHUB_TOKEN=github_pat_…
GITHUB_WEBHOOK_SECRET=pick-any-long-random-string
```

### 3.4 Push the three demo branches

```bash
scripts/create-demo-prs.sh ../opentelemetry-demo          # pushes ripple-demo/pr1..pr3
scripts/create-demo-prs.sh ../opentelemetry-demo --open   # …and opens the PRs with gh
```

Without `gh`, open the three PRs in the GitHub UI from the branches `ripple-demo/pr1-ad-copy`, `ripple-demo/pr2-recommendation-response` and `ripple-demo/pr3-payment-contract`. Keep the branch names and titles: the ticket keys (`AD-31`, `REC-88`, `PAY-142`) come from them.

### 3.5 Deliver the PRs to Ripple: pick one option

Start Ripple first (`npm run demo:full`, or `npm start` for level 4).

**Option A: no tunnel (simplest, works on any network).** Replay the PR as a signed webhook from your laptop:

```bash
npm run webhook:replay -- --repo <you>/opentelemetry-demo --pr 1
# Delivered <you>/opentelemetry-demo#1 "Spring sale ad copy (AD-31)" -> …: HTTP 202 {"accepted":true}
```

Ripple fetches the PR, analyzes it, and posts the comment on GitHub within a few seconds. The dashboard's **Live from GitHub** feed shows it too.

**Option B: a real webhook (fully automatic on every push).**

1. Expose Ripple: `cloudflared tunnel --url http://localhost:4000` (or `ngrok http 4000`). Copy the https URL.
2. Put it in `.env` as `RIPPLE_PUBLIC_URL=https://….trycloudflare.com` (it becomes the status's "Details" link) and restart Ripple.
3. In the fork: Settings → Webhooks → *Add webhook*:
   - Payload URL: `https://….trycloudflare.com/webhook/github`
   - Content type: `application/json`
   - Secret: your `GITHUB_WEBHOOK_SECRET`
   - Events: *Let me select individual events* → **Pull requests**
4. GitHub sends a `ping`; *Recent Deliveries* should show **200**. Reopen a PR, or push to it, to trigger an analysis (**202**).

### 3.6 What you should see

| PR | Comment | Status |
|---|---|---|
| #1 Spring sale ad copy | 🟢 LOW, one line, no agents | `success`: "LOW risk: Copy-only change…" |
| #2 Return up to 10 recommendations | 🟡 MEDIUM, soft-edge blast radius, INC-1877, checks | `success`, description starts with MEDIUM |
| #3 PAY-142 currency code | 🔴 HIGH, checkout ⇒ payment **breaks**, INC-2031, PAY-142 mismatch, reviewers, checks | `success`, description starts with HIGH |

The status is always `success` with a token: Ripple advises, it never blocks. With a GitHub App (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_PATH`) it posts a **check run** instead: `success` for LOW, `neutral` for MEDIUM/HIGH.

![The HIGH-risk comment](images/comment-pr3.png)

*Suggested reviewers are the fictional owners from `data/catalog.yaml`. Leave `RIPPLE_REQUEST_REVIEWERS=false`, or replace them with real GitHub usernames first.*

---

## Level 4: The real OpenTelemetry Demo (Docker)

### 4.1 Add the servicegraph connector and start the demo

```bash
cp ripple/deploy/otelcol-config-extras.yml opentelemetry-demo/src/otel-collector/otelcol-config-extras.yml
cd opentelemetry-demo
make start            # or: docker compose up --force-recreate --remove-orphans --detach
```

The overlay is validated against the demo's own collector configs with `otelcol-contrib validate` (v0.160.0). If your demo version differs, see the comment at the top of the overlay file.

Check it, once it has had a few minutes of traffic:

| URL | Expect |
|---|---|
| http://localhost:8080 | the Astronomy Shop |
| http://localhost:8080/jaeger/ui | Jaeger with traces |
| `curl -s 'localhost:9090/api/v1/query?query=traces_service_graph_request_total' \| jq '.data.result \| length'` | a number > 0 |

**Let it run for at least an hour before you present**, so the graph has traffic on every edge.

### 4.2 Point Ripple at it

```ini
# .env
RIPPLE_GRAPH_SOURCE=auto          # Prometheus → Jaeger → snapshot
PROMETHEUS_URL=http://localhost:9090
JAEGER_URL=http://localhost:8080/jaeger/ui
RIPPLE_GRAPH_REFRESH_SEC=30
```

```bash
npm start
```

The header chip turns green: **graph: live · prometheus**.

### 4.3 Record real failure experiments

```bash
node src/cli.js experiment --flag paymentFailure --target payment \
  --flagd-file ../opentelemetry-demo/src/flagd/demo.flagd.json
node src/cli.js experiment --flag adFailure --variant on --target ad \
  --flagd-file ../opentelemetry-demo/src/flagd/demo.flagd.json
```

Each takes about 3 minutes (60s baseline, 60s injected, 60s recovery). flagd watches the file, so the flip takes effect within seconds, and the runner always restores the file afterwards. Recordings go to `data/runtime/experiments/` and are labelled **live**. To ship them with the repo:

```bash
cp data/runtime/experiments/*.json data/experiments/
```

Also screen-record one experiment as a 30-second clip; don't risk the flag flip live on stage.

### 4.4 Save your real graph as the offline fallback

```bash
node src/cli.js graph snapshot          # writes data/graph-snapshot.json from the live graph
```

### 4.5 Run Ripple next to the demo in Docker (optional)

```bash
docker compose up --build    # Ripple + Postgres, joined to the opentelemetry-demo network
```

---

## Optional extras

### Gemini (or Anthropic) for the agents

```ini
GEMINI_API_KEY=…            # model defaults to gemini-2.5-flash
```

The intent verifier adds a one-line model assessment, and the narrator rewrites the verdict headline. Everything else stays deterministic, and any model error or timeout falls back silently.

### Optional: Postgres graph store

```ini
RIPPLE_GRAPH_STORE=postgres
DATABASE_URL=postgres://ripple:ripple@localhost:5432/ripple
```

Ripple then mirrors the graph into Postgres and answers blast-radius queries with a recursive CTE. To check it matches the in-memory graph: `RIPPLE_TEST_DATABASE_URL=$DATABASE_URL npm test`.

---

## Rehearsal: the run of show with exact actions

The full script, timings and judge Q&A are in [DEMO.md](DEMO.md). The actions:

| Time | Dashboard | You do |
|---|---|---|
| 0:00 | Title | — |
| 0:30 | Dependency map | Click `payment`. *(Level 2/4)* run the `paymentFailure` curl; edges turn red; turn it off |
| 1:00 | Failure experiment | Press `R` to replay; switch to `adFailure` to show a soft edge |
| 1:40 | Three PRs | Press `1` (or open PR #1 on GitHub / `webhook:replay --pr 1`) |
| 2:10 | | Press `2` |
| 2:50 | | Press `3`; walk the comment top to bottom |
| 4:10 | Live vs seeded | Read the table; it reflects what's connected right now |
| 4:40 | Close | — |

### Pre-show checklist

```bash
npm test                                      # all green
npm run demo:full -- --record                 # fresh recordings (level 2)
curl -s localhost:4000/api/status | jq .graph # source + mock flag as expected
curl -s localhost:9091/ | jq .activeFaults    # {} — no flag left on!
```

- [ ] Browser zoom at 100%, dashboard full-screen, theme chosen (`T`; light for washed-out projectors)
- [ ] Second terminal ready with the two `curl` flag commands
- [ ] Level 3: the three PRs open in browser tabs, comments already posted once (pre-run warms everything)
- [ ] Backup: `npm run demo` in a spare terminal; a recorded video of the whole demo

### Reset between runs

```bash
curl -X POST "localhost:9091/flags/paymentFailure?variant=off"   # any flag you left on
rm -rf data/runtime                                               # forget recordings + flag file (re-record next start)
```

On GitHub, Ripple updates its existing comment in place, so re-running a PR doesn't spam it.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Header chip amber: *snapshot (live unreachable)* | Ripple can't reach Prometheus/Jaeger | Check `PROMETHEUS_URL`; `curl $PROMETHEUS_URL/api/v1/query?query=up`. Hover the chip to see each source's error |
| `No traces_service_graph_request_total series` | servicegraph connector not active, or no traffic yet | Level 4: confirm the overlay file was copied *before* `make start`; wait a few minutes |
| `EADDRINUSE :4000` / `:9091` | something else on the port | `PORT=4001 npm run demo:full` / `OTEL_MOCK_PORT=9092 npm run demo:full` |
| Experiment says `Recorded 0 verdicts` | Calls to the target never started failing | Check the flag name and variant (`curl localhost:9091/flags`); real demo: check `--flagd-file` points at `src/flagd/demo.flagd.json` |
| Graph edges don't turn red | graph refresh interval | `demo:full` refreshes every 5s (`RIPPLE_FULL_DEMO_REFRESH_SEC`); with `npm start` set `RIPPLE_GRAPH_REFRESH_SEC=5` |
| Webhook delivery shows **401** | secret mismatch | Same `GITHUB_WEBHOOK_SECRET` in `.env` and the GitHub webhook |
| Webhook **503** | no GitHub credentials | Set `GITHUB_TOKEN` and restart |
| **202** but no comment | token can't write | Token needs Pull requests + Issues + Commit statuses write on the fork; Ripple's terminal shows the GitHub error |
| A PR is LOW/MEDIUM when you expected HIGH | title lost its ticket key, or a different diff | Keep the fixture titles (`PAY-142: …`); compare with `node src/cli.js analyze --fixture pr3` |

## Reference

| Command | What it does |
|---|---|
| `npm run demo` | Offline dashboard on seeded data |
| `npm run demo:full` | OTel mock + experiments + Ripple (level 2) |
| `npm run mock:otel` | Just the OTel mock on `:9091` |
| `npm start` | Ripple with settings from `.env` |
| `npm run webhook:replay -- --repo o/r --pr N` | Deliver a real PR to local Ripple as a signed webhook |
| `node src/cli.js analyze --fixture pr3` / `--all` / `--patch f.patch` | Analyze from the terminal |
| `node src/cli.js graph [snapshot]` | Show the graph / save it as the offline fallback |
| `node src/cli.js experiment --flag F --target S [--variant V] [--flagd-file P]` | Record a failure experiment |
| `scripts/create-demo-prs.sh <fork> [--open]` | Push (and open) the three demo PRs |
| `npm test` | Test suite |

All settings are documented in [`.env.example`](../.env.example).
