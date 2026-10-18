#!/usr/bin/env bash
# End-to-end deploy of Ripple to Google Cloud (Cloud Run + Secret Manager + Gemini).
#
#   cp infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars   # edit it
#   infra/scripts/deploy.sh
#
# Safe to re-run: every step is idempotent. Phases:
#   1. state bucket + terraform init
#   2. terraform apply with deploy_service=false  (APIs, registry, secrets, IAM, Gemini key, WIF)
#   3. build the first image with Cloud Build
#   4. check the GitHub credentials are in Secret Manager (stops with instructions if not)
#   5. terraform apply  (Cloud Run service, public webhook, uptime check)
#   6. smoke test
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TF_DIR="$ROOT/infra/terraform"
cd "$TF_DIR"

need() { command -v "$1" >/dev/null || { echo "✖ $1 is required"; exit 1; }; }
need gcloud
need terraform
need curl
need python3
[[ -f terraform.tfvars ]] || { echo "✖ copy terraform.tfvars.example to terraform.tfvars and fill it in"; exit 1; }

PROJECT=$(sed -nE 's/^project_id[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' terraform.tfvars)
REGION=$(sed -nE 's/^region[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' terraform.tfvars)
REGION="${REGION:-us-central1}"
[[ -n "$PROJECT" ]] || { echo "✖ project_id missing in terraform.tfvars"; exit 1; }
echo "▶ project=$PROJECT region=$REGION"

# 1. State
"$ROOT/infra/scripts/bootstrap-state.sh" "$PROJECT" "$REGION"
terraform init -input=false -backend-config="bucket=${PROJECT}-ripple-tfstate" >/dev/null
echo "✔ terraform initialised"

# 2. Foundations
TF_RESOURCES=$(terraform state list)
if [[ "$TF_RESOURCES" == *'google_cloud_run_v2_service.ripple[0]'* ]]; then
  # Refresh outputs from the current variables without changing live resources.
  terraform apply -refresh-only -input=false -auto-approve
  echo "✔ existing Cloud Run service detected; preserving it during foundations"
else
  terraform apply -input=false -auto-approve -var deploy_service=false
fi
IMAGE=$(terraform output -raw bootstrap_image)
MODE=$(terraform output -raw github_auth_mode)
APP_ID=$(terraform output -raw github_app_id)
SECRET_APP_KEY=$(terraform output -json secret_ids | python3 -c 'import sys,json;print(json.load(sys.stdin)["github_app_private_key"])')
SECRET_TOKEN=$(terraform output -json secret_ids | python3 -c 'import sys,json;print(json.load(sys.stdin)["github_token"])')
echo "✔ foundations applied"

# 3. First image (later images come from GitHub Actions)
if gcloud artifacts docker images describe "$IMAGE" --project "$PROJECT" >/dev/null 2>&1; then
  echo "✔ image $IMAGE already exists"
else
  echo "▶ building $IMAGE with Cloud Build"
  gcloud builds submit "$ROOT" --project "$PROJECT" --region "$REGION" --tag "$IMAGE"
fi

# 4. Secrets must have a value before Cloud Run can reference them
has_version() { [[ "$(gcloud secrets versions describe latest --secret "$1" --project "$PROJECT" --format='value(state)' 2>/dev/null)" == ENABLED ]]; }
SECRET_GEMINI=$(terraform output -json secret_ids | python3 -c 'import sys,json;print(json.load(sys.stdin)["gemini_api_key"])')
if ! has_version "$SECRET_GEMINI"; then
  cat <<EOF

⏸  Gemini API key missing (create_gemini_api_key = false). Create a key in Google AI Studio, then:

    printf %s "\$GEMINI_API_KEY" | gcloud secrets versions add $SECRET_GEMINI --project $PROJECT --data-file=-

Then run this script again.
EOF
  exit 2
fi
echo "✔ Gemini API key present"
WEBHOOK_URL=$(terraform output -raw webhook_url)
APP_SETUP=$(terraform output -json github_app_setup)
APP_OWNER=$(printf '%s' "$APP_SETUP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["owner"])')
SECRET_PREFIX=$(printf '%s' "$APP_SETUP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["secret_prefix"])')
REPO_URL=$(printf '%s' "$APP_SETUP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["repository_url"])')
if [[ "$MODE" == "app" ]]; then
  if ! has_version "$SECRET_APP_KEY" || [[ -z "$APP_ID" ]]; then
    cat <<EOF

⏸  GitHub App not set up yet. Create it (opens GitHub in your browser, stores the key in Secret Manager):

    node infra/github/create-app.mjs --owner "$APP_OWNER" --repo-url "$REPO_URL" --secret-prefix "$SECRET_PREFIX" --webhook-url "$WEBHOOK_URL" --project "$PROJECT"

    Add --org if "$APP_OWNER" is a GitHub organization.

Then put the printed App ID into terraform.tfvars as github_app_id, install the App on the
repository Ripple should review, and run this script again.
EOF
    exit 2
  fi
else
  if ! has_version "$SECRET_TOKEN"; then
    cat <<EOF

⏸  GitHub token missing. Add a fine-grained token (Pull requests, Issues, Commit statuses: write; Contents: read):

    printf %s "\$GITHUB_TOKEN" | gcloud secrets versions add $SECRET_TOKEN --project $PROJECT --data-file=-

Then run this script again.
EOF
    exit 2
  fi
fi
echo "✔ GitHub credentials present ($MODE mode)"

# 5. Service
terraform apply -input=false -auto-approve
URL=$(terraform output -raw service_url)

# 6. Smoke test
echo "▶ waiting for $URL/api/status"
HEALTH_OK=false
for _ in $(seq 1 30); do
  if curl --connect-timeout 5 --max-time 10 -fsS "$URL/api/status" >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 5
done
[[ "$HEALTH_OK" == true ]] || { echo "✖ service did not become healthy at $URL/api/status"; exit 1; }
curl --connect-timeout 5 --max-time 10 -fsS "$URL/api/status" | python3 -c 'import sys,json;s=json.load(sys.stdin);print("  graph:",s["graph"]["source"],"(mock)" if s["graph"].get("mock") else "","| llm:",s["llm"],"| github:",s["github"]["mode"])'

cat <<EOF

✔ Ripple is live
  Dashboard:   $URL
  Webhook:     $WEBHOOK_URL
  Next:        open a PR on the watched repository; Ripple comments within seconds.
  CI deploys:  set the GitHub Actions variables from 'terraform output github_actions_variables'
               on the Ripple repository (or set manage_github = true).
EOF
