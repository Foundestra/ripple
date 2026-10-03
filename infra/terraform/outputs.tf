output "service_url" {
  description = "Dashboard (and API) URL."
  value       = local.service_url
}

output "webhook_url" {
  description = "Payload URL for the GitHub App or repository webhook."
  value       = local.webhook_url
}

output "image_repository" {
  description = "Push images here (tag = git SHA)."
  value       = local.actions_variables.GCP_IMAGE_REPO
}

output "bootstrap_image" {
  description = "Image the first deploy expects (build it between phase 1 and phase 2)."
  value       = local.image
}

output "github_actions_variables" {
  description = "Set these as repository variables on the Ripple repo if manage_github = false."
  value       = local.actions_variables
}

output "webhook_secret" {
  description = "Webhook secret (token mode: paste into the repository webhook). In app mode GitHub generates its own and create-app.mjs stores it."
  value       = random_password.webhook_secret.result
  sensitive   = true
}

output "secret_ids" {
  description = "Secret Manager secrets Ripple reads."
  value = {
    gemini_api_key         = google_secret_manager_secret.gemini_api_key.secret_id
    webhook_secret         = google_secret_manager_secret.webhook_secret.secret_id
    github_app_private_key = google_secret_manager_secret.github_app_private_key.secret_id
    github_token           = google_secret_manager_secret.github_token.secret_id
  }
}

output "github_auth_mode" {
  value = var.github_auth_mode
}

output "github_app_id" {
  value = var.github_app_id
}
