# ---------- Runtime identity ----------
# What the Cloud Run service runs as: read its own secrets, write logs/metrics.

resource "google_service_account" "runtime" {
  account_id   = "${var.service_name}-run"
  display_name = "Ripple Cloud Run runtime"
  depends_on   = [google_project_service.apis]
}

resource "google_project_iam_member" "runtime_roles" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/cloudtrace.agent",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

# ---------- Deploy identity for GitHub Actions (no keys) ----------
# GitHub's OIDC token from deploy_repository@deploy_branch is exchanged for
# short-lived credentials of this service account via Workload Identity
# Federation. No JSON key ever leaves Google Cloud.

resource "google_service_account" "deployer" {
  account_id   = "${var.service_name}-deployer"
  display_name = "Ripple deployer (GitHub Actions)"
  depends_on   = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "${var.service_name}-github"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Only Ripple's own repository, only the deploy branch.
  attribute_condition = "assertion.repository == '${var.github_owner}/${var.deploy_repository}' && assertion.ref == 'refs/heads/${var.deploy_branch}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_owner}/${var.deploy_repository}"
}

# Push images to this one repository.
resource "google_artifact_registry_repository_iam_member" "deployer_push" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

# Deploy new revisions of this one service.
resource "google_cloud_run_v2_service_iam_member" "deployer_run" {
  count    = var.deploy_service ? 1 : 0
  location = google_cloud_run_v2_service.ripple[0].location
  name     = google_cloud_run_v2_service.ripple[0].name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

# A revision runs as the runtime service account, so the deployer must be able to act as it.
resource "google_service_account_iam_member" "deployer_act_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
