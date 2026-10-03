#!/usr/bin/env bash
# Creates the GCS bucket that holds Terraform state (once per project).
#   infra/scripts/bootstrap-state.sh <project_id> [region]
set -euo pipefail

PROJECT="${1:?usage: $0 <project_id> [region]}"
REGION="${2:-us-central1}"
BUCKET="${PROJECT}-ripple-tfstate"

if gcloud storage buckets describe "gs://${BUCKET}" --project "$PROJECT" >/dev/null 2>&1; then
  echo "State bucket gs://${BUCKET} already exists"
  exit 0
fi

gcloud storage buckets create "gs://${BUCKET}" \
  --project "$PROJECT" \
  --location "$REGION" \
  --uniform-bucket-level-access \
  --public-access-prevention
gcloud storage buckets update "gs://${BUCKET}" --versioning

echo "Created gs://${BUCKET} (versioned, uniform access, public access prevented)."
echo "It will hold secrets in Terraform state: grant access only to the people who deploy."
