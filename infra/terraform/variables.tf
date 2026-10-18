variable "project_id" {
  description = "GCP project that hosts Ripple. Billing must be enabled."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run and Artifact Registry."
  type        = string
  default     = "us-central1"
}

variable "service_name" {
  description = "Cloud Run service name. Also prefixes secrets and service accounts."
  type        = string
  default     = "ripple"
}

variable "deploy_service" {
  description = "Phase gate. false = create everything except the Cloud Run service (used before the first image exists and the GitHub secrets are filled in)."
  type        = bool
  default     = true
}

variable "image_tag" {
  description = "Image tag in Artifact Registry for the first deploy. After that, GitHub Actions deploys new images and Terraform leaves the image alone."
  type        = string
  default     = "bootstrap"
}

# ---------- Gemini (the main agent) ----------

variable "gemini_model" {
  description = "Gemini model used by Ripple's agents."
  type        = string
  default     = "gemini-2.5-flash"
}

variable "create_gemini_api_key" {
  description = "true = Terraform creates a Gemini API key restricted to the Gemini API (generativelanguage.googleapis.com) and stores it in Secret Manager. false = you add an AI Studio key to the secret yourself (keeps the key out of Terraform state)."
  type        = bool
  default     = true
}

# ---------- GitHub integration ----------

variable "github_auth_mode" {
  description = "\"app\" (recommended: PR comment + Checks API, per-installation tokens) or \"token\" (personal access token: PR comment + commit status)."
  type        = string
  default     = "app"

  validation {
    condition     = contains(["app", "token"], var.github_auth_mode)
    error_message = "github_auth_mode must be \"app\" or \"token\"."
  }
}

variable "github_app_id" {
  description = "Numeric GitHub App ID (app mode). Printed by infra/github/create-app.mjs. Leave empty in phase 1."
  type        = string
  default     = ""
}

variable "github_owner" {
  description = "GitHub user or organization that owns the repositories below."
  type        = string
}

variable "watched_repository" {
  description = "Repository whose PRs Ripple reviews (name only, e.g. opentelemetry-demo). Used for the repository webhook in token mode."
  type        = string
}

variable "deploy_repository" {
  description = "Repository that holds Ripple's own code (name only, e.g. ripple). Its GitHub Actions deploy to Cloud Run through Workload Identity Federation."
  type        = string
}

variable "deploy_branch" {
  description = "Default branch of deploy_repository allowed to deploy. Set this explicitly to match GitHub."
  type        = string
}

variable "manage_github" {
  description = "true = Terraform also configures GitHub (repository webhook in token mode, Actions variables for the deploy workflow). Needs GITHUB_TOKEN with admin rights on both repositories."
  type        = bool
  default     = false
}

variable "request_reviewers" {
  description = "Let Ripple request reviews from its suggested reviewers. Only enable once the service catalog lists real GitHub usernames."
  type        = bool
  default     = false
}

# ---------- Runtime ----------

variable "graph_source" {
  description = "auto = Prometheus -> Jaeger -> seeded snapshot. With the bundled OTel mock sidecar, auto resolves to the mock."
  type        = string
  default     = "auto"
}

variable "prometheus_url" {
  description = "PromQL endpoint for the dependency graph. Defaults to the OTel mock sidecar in the same Cloud Run instance."
  type        = string
  default     = "http://localhost:9091"
}

variable "jaeger_url" {
  description = "Jaeger query base URL (fallback graph source)."
  type        = string
  default     = "http://localhost:9091/jaeger/ui"
}

variable "min_instances" {
  description = "Keep one instance warm so webhooks are answered immediately and the in-memory analysis feed survives between PRs."
  type        = number
  default     = 1
}

variable "max_instances" {
  description = "Ripple keeps its analysis feed in memory, so more than one instance splits the dashboard feed. Raise only after moving that state to a database."
  type        = number
  default     = 1
}

variable "alert_email" {
  description = "Email for the uptime alert on /api/status. Empty = no alerting."
  type        = string
  default     = ""
}
