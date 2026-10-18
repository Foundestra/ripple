# Remote state in a GCS bucket. The bucket is created once by
# infra/scripts/bootstrap-state.sh (versioned, uniform access, public access
# prevention) and passed at init time:
#
#   terraform init -backend-config="bucket=<project>-ripple-tfstate"
#
# The state holds the generated webhook secret and, if create_gemini_api_key is
# true, the Gemini API key string. Restrict the bucket to the people who deploy.
terraform {
  backend "gcs" {
    prefix = "ripple"
  }
}
