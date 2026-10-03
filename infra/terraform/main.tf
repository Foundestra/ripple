data "google_project" "this" {
  project_id = var.project_id
}

locals {
  repo_id = "${var.service_name}-images"
  image   = "${var.region}-docker.pkg.dev/${var.project_id}/${local.repo_id}/${var.service_name}:${var.image_tag}"

  # Cloud Run's deterministic URL, known before the service exists so it can be
  # passed to the service itself (status "Details" links) and to GitHub.
  service_url = "https://${var.service_name}-${data.google_project.this.number}.${var.region}.run.app"
  webhook_url = "${local.service_url}/webhook/github"
}

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "apikeys.googleapis.com",
    "generativelanguage.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "images" {
  repository_id = local.repo_id
  location      = var.region
  format        = "DOCKER"
  description   = "Ripple container images"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 15
    }
  }

  depends_on = [google_project_service.apis]
}
