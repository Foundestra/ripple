# Optional: let Terraform configure the GitHub side too (manage_github = true,
# GITHUB_TOKEN with admin rights on both repositories in the environment).

# Token mode only: the webhook lives on the watched repository. In app mode the
# webhook belongs to the GitHub App instead (see infra/github/create-app.mjs).
resource "github_repository_webhook" "ripple" {
  count      = var.manage_github && var.github_auth_mode == "token" ? 1 : 0
  repository = var.watched_repository
  events     = ["pull_request"]
  active     = true

  configuration {
    url          = local.webhook_url
    content_type = "json"
    secret       = random_password.webhook_secret.result
    insecure_ssl = false
  }
}

# Values the deploy workflow (.github/workflows/deploy.yml) reads as `vars.*`.
locals {
  actions_variables = {
    GCP_PROJECT_ID   = var.project_id
    GCP_REGION       = var.region
    GCP_WIF_PROVIDER = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOYER_SA  = google_service_account.deployer.email
    GCP_IMAGE_REPO   = "${var.region}-docker.pkg.dev/${var.project_id}/${local.repo_id}/${var.service_name}"
    GCP_RUN_SERVICE  = var.service_name
  }
}

resource "github_actions_variable" "deploy" {
  for_each      = var.manage_github ? local.actions_variables : {}
  repository    = var.deploy_repository
  variable_name = each.key
  value         = each.value
}
