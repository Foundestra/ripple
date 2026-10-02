# Demo guide: 5-minute slot

Setup for every level (offline, OTel mock, real GitHub, real OpenTelemetry Demo) is in [JUMPSTART.md](JUMPSTART.md). This page is the show itself.

The dashboard (`npm run demo`, http://localhost:4000) is the deck. Each section is one beat of the run of show.

| Key | Action |
|---|---|
| `→` / `Space` / `PgDn` | next section |
| `←` / `PgUp` | previous section |
| `1` `2` `3` | jump to the PRs and run PR 1 / 2 / 3 |
| `R` | replay the failure experiment (on that section) |
| `T` | light/dark theme (use light on washed-out projectors) |

## Run of show

| Time | Section | What we show | What we say |
|---|---|---|---|
| 0:00 | **Title** | Title slide | "Most outages start as a PR someone approved. The reviewer just couldn't see what it touched." |
| 0:30 | **Dependency map** | Live graph. Click `payment`: checkout, frontend and frontend-proxy light up as *breaks*. With `demo:full`, flip `paymentFailure` from the second terminal and the edges turn red within 5s; turn it off again | "This map isn't drawn by hand. It's rebuilt from traffic every few seconds. Watch what happens when payment breaks." |
| 1:00 | **Failure experiment** | The chart replays: payment fails, checkout errors spike with it. Flip to `adFailure`: frontend stays flat | "That's how we know checkout-to-payment is a hard edge. We broke it on purpose." |
| 1:40 | **Three PRs → `1`** | Ad copy tweak. Agents are struck through and a green LOW comment lands | "Low risk. No extra reviewers, no delay. Most PRs should feel like this." |
| 2:10 | **`2`** | Recommendation change. MEDIUM, all chains *degrade*, INC-1877 | "Frontend depends on this, but degrades gracefully. Ripple says so instead of crying wolf." |
| 2:50 | **`3`** | Payment contract. HIGH. Walk the comment top to bottom: verdict → blast radius (checkout ⇒ payment, **breaks**) → INC-2031 → PAY-142 mismatch → reviewers → checks | "It removes a field checkout reads. Checkout is a hard edge, we've had this exact outage, and the ticket said additive only." |
| 4:10 | **Live vs seeded** | The table (it reflects what's actually connected right now) | Real stack: "Graph and failures are real. Jira and incidents are seeded behind swappable adapters." OTel mock: "The graph and failure experiments run through the real Prometheus and Jaeger APIs against a simulated shop; pointing them at production is a URL change." |
| 4:40 | **Close** | Closing line + comparison | "Ripple gives every PR the judgment of your most senior engineer." |

If you're live on GitHub, open the real PRs in the browser at 1:40 / 2:10 / 2:50 instead of pressing `1` `2` `3`. The comment lands on the PR, and the dashboard's **Live from GitHub** feed shows it too.

## Prep checklist

- [ ] OpenTelemetry Demo running with `deploy/otelcol-config-extras.yml` for **at least an hour** before presenting (header chip shows `graph: live · prometheus`)
- [ ] `ripple experiment` run for `paymentFailure` and `adFailure` (the Live vs seeded table flips "Hard vs. soft" to **Live**)
- [ ] Failure experiment also recorded as a 30-second screen clip; don't risk the flag flip live
- [ ] `node src/cli.js graph snapshot` after the demo has traffic, so the offline fallback is your real graph
- [ ] `scripts/create-demo-prs.sh <fork>` run; the three branches exist; each PR pre-run once to warm caches
- [ ] Webhook reachable (tunnel up, `RIPPLE_PUBLIC_URL` set) and one test delivery shows 202 in GitHub's webhook log
- [ ] **Backup:** `npm run demo` works with no network at all. Record a full video of the demo too, in case the laptop or projector fails
- [ ] One person drives, one person narrates

## Fallbacks

| If this fails… | …do this |
|---|---|
| Demo stack / Prometheus down | Ripple falls back to Jaeger, then to the snapshot automatically. The chip turns amber; keep going. |
| Webhook or network | Press `1` `2` `3`. The same analysis runs locally on the same patches. |
| LLM key / quota | Nothing changes visibly. Agents are deterministic by default; the LLM only adds an assessment line. |

## Judge Q&A

| Question | Answer |
|---|---|
| How is this different from existing AI code review tools? | They see the diff. We see who depends on the code, how critically, and what broke last time. |
| What if a service isn't instrumented? | It's invisible to traces, so owners can assert edges in the catalog (`manual_edges`; see `accounting → postgresql`). Static analysis is next on the roadmap. |
| Won't it flag everything as risky? | Low-risk PRs skip the agents entirely. Soft edges warn; only hard edges on critical tiers escalate, and HIGH is capped at MEDIUM without a way to actually break something. |
| How fresh is the graph? | Rebuilt from recent traffic every 60s (configurable); each edge carries when it was last seen (hover an edge). |
| Does it block merges? | No. The check is `success`/`neutral`, never `failure`. It advises and routes reviewers; a human always decides. |
| How does it scale to thousands of services? | Graph queries are bounded to a few hops (a recursive CTE in Postgres), and signals are fetched in parallel per PR. A full analysis takes single-digit milliseconds after the fetches. |
| Is the scoring a black box? | No. Every point is itemised in the comment's "Why" table, and the thresholds are printed. |
| What's real vs. fake? | Say it plainly: graph, hard/soft classification, and PR analysis are real; tiers, tickets and incidents are seeded behind adapters with the same interface as the real integrations. |
