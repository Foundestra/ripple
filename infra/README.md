# Ripple on Google Cloud

How Ripple is hosted, how it connects to GitHub, and how to deploy it with one script. Everything here is Terraform (`infra/terraform`) plus two helper scripts; nothing is clicked together in the console.

```
                                   Google Cloud project
 GitHub                ┌───────────────────────────────────────────────────────────────────┐
 ┌──────────────────┐  │  Cloud Run service "ripple"  (min 1, max 1 instance, CPU always on)  │
 │ watched repo     │  │  ┌───────────────────────────┐   localhost   ┌───────────────────┐ │
 │ (OTel Demo fork) │  │  │ ripple  :8080 (ingress)    │──────────────▶│ otel-mock :9091   │ │
 │                  │  │  │  /webhook/github           │  PromQL +     │ (sidecar)         │ │
 │  PR opened ──────┼──┼─▶│  /  dashboard   /api/*     │  Jaeger APIs  │ simulated Astronomy│ │
 │                  │  │  │  risk gate + agents        │               │ Shop telemetry    │ │
 │  ◀── comment ────┼──┼──│                            │               └───────────────────┘ │
 │  ◀── check run ──┼──┼──│                            │──── HTTPS ───▶ Gemini API            │
 └──────────────────┘  │  └─────────────▲──────────────┘   (API key)    generativelanguage    │
 ┌──────────────────┐  │                │ env vars from                                       │
 │ ripple repo      │  │  Secret Manager: gemini-api-key · github-webhook-secret ·            │
 │ push to main ────┼──┼─▶ GitHub Actions ──(OIDC → Workload Identity Federation)──▶          │
 │                  │  │      builds image → Artifact Registry → rolls out Cloud Run          │
 └──────────────────┘  │  Cloud Monitoring uptime check on /api/status → email alert             │
                       └───────────────────────────────────────────────────────────────────┘
```

## 1. Hosting decisions

| What | Choice | Why |
|---|---|---|
| Compute | **Cloud Run** (one service, two containers) | Serverless HTTPS endpoint with a stable URL for the GitHub webhook; no cluster to run. |
| Agent model | **Gemini API** via an **API key** in Secret Manager (`gemini-2.5-flash` default, set `gemini_model`) | Terraform creates the key in the same project, restricted to `generativelanguage.googleapis.com` only. |
| Telemetry for the demo | **OTel mock sidecar** on `localhost:9091` | Serves the same Prometheus and Jaeger APIs as the real OpenTelemetry Demo, so Ripple runs its normal code path. Labelled **mock** in the dashboard and every PR comment. |
| CPU allocation | **Always on** (`cpu_idle = false`) | Ripple acknowledges the webhook with `202` and analyzes the PR *after* responding. With request-only CPU, Cloud Run would throttle that work. |
| Instances | **min 1, max 1** | Webhooks are answered without a cold start. The dashboard's analysis feed is in memory, so one instance keeps it consistent (raise `max_instances` after moving that state to a database). |
| Public access | `allUsers` → `roles/run.invoker` | GitHub must reach `/webhook/github`. Every webhook is authenticated by Ripple itself with an HMAC-SHA256 signature; unsigned or mis-signed requests get `401`. |
| Secrets | **Secret Manager**, mounted as env vars, `latest` version | Gemini key, webhook secret, GitHub App private key (or token). Only the runtime service account can read them. |
| Images | **Artifact Registry** (`<region>-docker.pkg.dev/<project>/ripple-images/ripple`) | Tagged with the git SHA; cleanup keeps the latest 15. |
| CI/CD | **GitHub Actions + Workload Identity Federation** | No JSON service-account keys anywhere. Only `<owner>/<ripple repo>` on the configured `deploy_branch` can obtain the deployer identity. |
| State | **GCS bucket** `<project>-ripple-tfstate` | Versioned, uniform access, public access prevented (it contains the generated secrets). |
| Monitoring | **Uptime check** on `/api/status` every 5 min, optional email alert | Know if the webhook endpoint is down before a demo. |

**The dashboard is public in this setup** (same service as the webhook). That's fine for a hackathon demo. For production, put the dashboard on a second Cloud Run service behind IAP and keep only the webhook public.

## 2. What happens when a PR is opened

1. GitHub sends `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`, `edited`) to `https://ripple-<project-number>.<region>.run.app/webhook/github`, signed with the webhook secret.
2. Ripple verifies `X-Hub-Signature-256`, answers **202** within milliseconds, and queues the PR (one at a time per PR, so rapid pushes don't race).
3. **App mode:** Ripple signs a JWT with the App private key (RS256, 9-minute expiry), exchanges it at `POST /app/installations/{id}/access_tokens` for an installation token (cached until expiry), and uses that token for everything below.
4. It reads the PR files (`GET /pulls/{n}/files`) and CI state (commit statuses + check runs), then runs the analysis:
   - signals: Jira, the dependency graph (from the mock sidecar), and change risk and incidents;
   - the risk gate;
   - the agents, with Gemini for the medium and high risk PRs.
5. It **creates or updates one comment** on the PR, finding its own comment by a hidden marker, so pushes don't add new comments.
6. It posts a **check run "Ripple risk review"**: `success` for LOW and `neutral` for MEDIUM/HIGH, with the verdict as the title and a **Details** link to the analysis on the dashboard. In token mode, it posts a commit status `ripple/risk` instead.
7. Optionally (`request_reviewers = true`), it requests reviews from the suggested owners.

Ripple **never fails a check**, so it can't block a merge. If you make "Ripple risk review" a required check in branch protection, it only enforces that Ripple *ran*; `neutral` counts as passing.

## 3. GitHub integration

### GitHub App (recommended)

| Permission | Level | Used for |
|---|---|---|
| Pull requests | Read & write | Read PR metadata and files; request reviewers |
| Issues | Read & write | Create/update the PR comment (PR comments use the issues API) |
| Checks | Read & write | Post the "Ripple risk review" check run |
| Contents | Read | Diff context |
| Metadata | Read | Required by GitHub |
| **Events** | `pull_request` | Triggers the analysis |

Why an App rather than a personal token: an App acts as **"Ripple PR Risk [bot]"** instead of a person, and its tokens are per installation and expire after one hour. It can post **check runs** with a Details link, whereas a token can only post a commit status. Each organization installs it on exactly the repositories it chooses.

**Creating it:** `infra/github/create-app.mjs` uses GitHub's [App manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):

```bash
node infra/github/create-app.mjs --owner <user-or-org> [--org] \
  --webhook-url "$(terraform -chdir=infra/terraform output -raw webhook_url)" \
  --project <gcp-project>
```

1. Open `http://localhost:3456` and click **Create GitHub App**. This posts `infra/github/app-manifest.json`, with the webhook URL filled in, to GitHub.
2. Confirm the name on GitHub. GitHub redirects back with a one-time code.
3. The script exchanges the code (`POST /app-manifests/{code}/conversions`) for the **App ID, private key and webhook secret**. It adds the key and secret to Secret Manager and keeps a copy in `infra/github/.app/` (git-ignored).
4. Install the App on the watched repository (the script prints the link), and put the App ID in `terraform.tfvars`.

### Personal access token (fallback)

Set `github_auth_mode = "token"`, then create a fine-grained token on the watched repository with:
- **Pull requests:** read and write
- **Issues:** read and write
- **Commit statuses:** read and write
- **Contents:** read

Store it with:

```bash
printf %s "$TOKEN" | gcloud secrets versions add ripple-github-token --data-file=-
```

With `manage_github = true`, Terraform also creates the repository webhook (pointing at the service URL, using the generated secret). Otherwise, add it by hand in the repository's Settings → Webhooks:
- **Payload URL:** the `webhook_url` output
- **Content type:** JSON
- **Secret:** `terraform output -raw webhook_secret`
- **Events:** Pull requests

### Deploying from GitHub (CI/CD)

`.github/workflows/deploy.yml` tests pushes and deploys the repository default branch:
1. `npm test`.
2. Authenticate to Google Cloud with **OIDC → Workload Identity Federation** (`google-github-actions/auth`).
3. `docker build` and push `…/ripple:<sha>`.
4. `gcloud run services update ripple --container ripple --image … --container otel-mock --image …`.
5. Run an `/api/status` smoke test.

It reads repository **variables**: `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `GCP_IMAGE_REPO`, `GCP_RUN_SERVICE`. Terraform outputs them as `github_actions_variables` and sets them for you with `manage_github = true`.

The deployer identity can only push to the one Artifact Registry repository, deploy the one Cloud Run service, and act as Ripple's runtime service account. Terraform ignores image changes on the service, so CI rollouts and `terraform apply` don't fight each other.

`.github/workflows/infra.yml` runs `terraform fmt -check` and `terraform validate`, and parses the shell scripts, on every PR that touches `infra/`.

## 4. Deploy, step by step

**Prerequisites:**
- A GCP project with billing enabled.
- `gcloud`, logged in (`gcloud auth login && gcloud auth application-default login`).
- Terraform ≥ 1.6, Node 20+, Python 3, curl, and sufficient deployment permissions on the project.

```bash
cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars   # set project_id, github_owner, repos
infra/scripts/deploy.sh
```

The script is idempotent; re-run it after each pause.

| Step | What it does | You do |
|---|---|---|
| 1 | Creates the state bucket and runs `terraform init` | — |
| 2 | `terraform apply -var deploy_service=false`: APIs, Artifact Registry, secrets, the **Gemini API key**, service accounts, Workload Identity Federation | — |
| 3 | `gcloud builds submit` builds the first image `…/ripple:bootstrap` | — |
| 4 | Checks that the secrets have values. **Pauses** with instructions if the GitHub App or token is missing | Run `create-app.mjs`, install the App, set `github_app_id`, re-run |
| 5 | `terraform apply`: Cloud Run service, public invoker, uptime check | — |
| 6 | Smoke test: `/api/status` (graph = mock, llm = gemini, github = app) | Open a PR on the watched repo |

Then, for push-to-deploy, set the Actions variables on the Ripple repo, or re-apply with `manage_github = true` and `GITHUB_TOKEN` exported. The deploy workflow only deploys the default branch of `deploy_repository`; set `deploy_branch` in Terraform to that same branch.

## 5. Operating it

| Task | Command |
|---|---|
| Logs | `gcloud run services logs read ripple --region <region> --limit 100` |
| Redeliver a webhook | GitHub → App settings → Advanced → Recent deliveries → Redeliver |
| Rotate the webhook secret | Add a new version to `ripple-github-webhook-secret`, update it in the App settings, then roll a new revision so `latest` is re-read: `gcloud run services update ripple --region <region> --update-labels rotated=$(date +%s)` |
| Rotate the Gemini key | `terraform apply -replace=google_apikeys_key.gemini[0]` |
| Pause between demos | `min_instances = 0` (the first webhook then waits for a cold start, ~2–5 s) |
| Tear down | `terraform destroy` (the Workload Identity pool ID is reserved for 30 days afterwards) |

**Rough cost:** 1.5 always-on vCPU (1 for Ripple, 0.5 for the mock sidecar) plus 768 MiB is on the order of **$70–80 a month** at list price. Setting `min_instances = 0` between demos brings it close to zero. Gemini usage is one or two calls per medium or high risk PR. Check current prices in the Google Cloud pricing calculator.

## 6. From the mock to the real OpenTelemetry Demo

The mock exists so the hosted demo is self-contained. The production path:
- Run the OpenTelemetry Demo (or your own services) on **GKE Autopilot** with the servicegraph connector (`deploy/otelcol-config-extras.yml`).
- Export metrics to **Google Cloud Managed Service for Prometheus**.
- Point `prometheus_url` at the PromQL endpoint, then remove the sidecar.

**Gap to close first:** Managed Prometheus's query API needs a Google OAuth bearer token, and Ripple's Prometheus adapter doesn't send one yet. It's a small change: fetch a token from the Cloud Run metadata server and grant the runtime service account `roles/monitoring.viewer`.

## 7. What was verified, and what wasn't

Verified in the development container:
- `terraform validate` passes (google provider 7.46.1, github 6.13.0, random 3.9.1).
- `terraform fmt -check`, `shellcheck`, and `actionlint` are clean.
- `create-app.mjs` ran against a fake GitHub API: the state check, the code exchange, and both secrets written via a stubbed `gcloud`.
- **The Cloud Run topology end to end**, run locally:
  - Ripple on `:8080` with exactly the environment variables Terraform sets, and the mock as a separate sidecar process on `:9091`.
  - GitHub App authentication: the JWT signature was verified by a fake GitHub, which then issued an installation token.
  - A signed webhook got **202**; a bad signature got **401**.
  - The HIGH comment and the neutral "Ripple risk review" check were posted, with a Details link to the run.app URL.
  - The Gemini API was called (a deliberately invalid key returned `400 API key not valid`, and Ripple fell back cleanly).

Not verified, because there were no GCP credentials or Docker daemon in the container:
- `terraform plan` / `apply` against a real project.
- The Cloud Build image build.
- Cloud Run's handling of the two-container service.
- The deploy workflow's run in GitHub Actions.
- Creating a real GitHub App.

Expect the first `apply` to surface project-specific issues, such as org policies that block `allUsers` invokers or API key creation.

## Credential and configuration hygiene

Set `github_owner`, repository names, and `deploy_branch` explicitly in the ignored
`terraform.tfvars`. Match `deploy_branch` to the deploy repository's default branch;
the GitHub Actions workflow discovers that branch from the event metadata.

When creating an organization-owned App, pass `--org`. For a renamed deploy
repository, pass `--repo-url https://github.com/<owner>/<repository>`; pass
`--secret-prefix` when using a custom Terraform `service_name`. Private Apps can
only be installed in the account that owns them, so the watched repository must
belong to that account.

Local `.env` files, private keys, generated GitHub credentials, Terraform variable
files, and state must stay out of Git and build uploads. The example files contain
placeholders only; fake credentials in tests are test data. Cloud Build excludes
the entire `infra/` directory. Generated Gemini keys and webhook secrets remain in
Terraform state, so restrict access to the remote state bucket.

Cloud Run reserves some public paths ending in `z`. Public uptime and deployment
checks use `/api/status`; internal startup and liveness probes use `/healthz`.
