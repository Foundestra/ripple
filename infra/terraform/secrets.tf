# ---------- Gemini API key ----------
# An API key for the Gemini API (generativelanguage.googleapis.com), restricted
# to that API only, created in this project and stored in Secret Manager.

resource "google_apikeys_key" "gemini" {
  count        = var.create_gemini_api_key ? 1 : 0
  name         = "${var.service_name}-gemini"
  display_name = "Ripple Gemini API key"

  restrictions {
    api_targets {
      service = "generativelanguage.googleapis.com"
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "gemini_api_key" {
  secret_id = "${var.service_name}-gemini-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "gemini_api_key" {
  count       = var.create_gemini_api_key ? 1 : 0
  secret      = google_secret_manager_secret.gemini_api_key.id
  secret_data = google_apikeys_key.gemini[0].key_string
}

# ---------- GitHub webhook secret ----------
# Generated here. In app mode, create-app.mjs replaces it with the secret
# GitHub generates for the App (a newer version; Cloud Run reads "latest").

resource "random_password" "webhook_secret" {
  length  = 40
  special = false
}

resource "google_secret_manager_secret" "webhook_secret" {
  secret_id = "${var.service_name}-github-webhook-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "webhook_secret" {
  secret      = google_secret_manager_secret.webhook_secret.id
  secret_data = random_password.webhook_secret.result
}

# ---------- GitHub credentials ----------
# Containers only. Values are added outside Terraform so they never land in
# state: create-app.mjs uploads the App private key; for token mode run
#   printf %s "$TOKEN" | gcloud secrets versions add ripple-github-token --data-file=-

resource "google_secret_manager_secret" "github_app_private_key" {
  secret_id = "${var.service_name}-github-app-private-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "github_token" {
  secret_id = "${var.service_name}-github-token"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# ---------- Runtime access ----------

locals {
  runtime_secrets = merge(
    {
      gemini  = google_secret_manager_secret.gemini_api_key.id
      webhook = google_secret_manager_secret.webhook_secret.id
    },
    var.github_auth_mode == "app" ? { github = google_secret_manager_secret.github_app_private_key.id } : { github = google_secret_manager_secret.github_token.id },
  )
}

resource "google_secret_manager_secret_iam_member" "runtime_access" {
  for_each  = local.runtime_secrets
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}
