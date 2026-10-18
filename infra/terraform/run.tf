# One Cloud Run service, two containers sharing the instance's network:
#
#   ripple     ingress container (port 8080): dashboard, API, GitHub webhook
#   otel-mock  sidecar (localhost:9091): simulated Astronomy Shop behind the
#              Prometheus + Jaeger APIs, so the hosted demo has a dependency
#              graph without running the 15-service OpenTelemetry Demo
#
# CPU stays allocated between requests (cpu_idle = false): Ripple answers the
# webhook with 202 first and analyzes the PR afterwards, which needs CPU after
# the response has been sent. It also keeps the graph refresh timer running.

resource "google_cloud_run_v2_service" "ripple" {
  count               = var.deploy_service ? 1 : 0
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account                  = google_service_account.runtime.email
    max_instance_request_concurrency = 40
    timeout                          = "60s"

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      name       = "ripple"
      image      = local.image
      depends_on = ["otel-mock"]

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      # Gemini is the agent model; the key comes from Secret Manager.
      env {
        name  = "RIPPLE_LLM"
        value = "gemini"
      }
      env {
        name  = "GEMINI_MODEL"
        value = var.gemini_model
      }
      env {
        name = "GEMINI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.gemini_api_key.secret_id
            version = "latest"
          }
        }
      }

      # GitHub
      env {
        name = "GITHUB_WEBHOOK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.webhook_secret.secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = var.github_auth_mode == "app" ? [1] : []
        content {
          name  = "GITHUB_APP_ID"
          value = var.github_app_id
        }
      }
      env {
        name = var.github_auth_mode == "app" ? "GITHUB_APP_PRIVATE_KEY" : "GITHUB_TOKEN"
        value_source {
          secret_key_ref {
            secret  = var.github_auth_mode == "app" ? google_secret_manager_secret.github_app_private_key.secret_id : google_secret_manager_secret.github_token.secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "RIPPLE_PUBLIC_URL"
        value = local.service_url
      }
      env {
        name  = "RIPPLE_REQUEST_REVIEWERS"
        value = tostring(var.request_reviewers)
      }

      # Dependency graph
      env {
        name  = "RIPPLE_GRAPH_SOURCE"
        value = var.graph_source
      }
      env {
        name  = "PROMETHEUS_URL"
        value = var.prometheus_url
      }
      env {
        name  = "JAEGER_URL"
        value = var.jaeger_url
      }
      env {
        name  = "RIPPLE_GRAPH_REFRESH_SEC"
        value = "15"
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
        initial_delay_seconds = 1
        period_seconds        = 3
        failure_threshold     = 20
        timeout_seconds       = 2
      }

      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 30
        failure_threshold = 3
        timeout_seconds   = 3
      }
    }

    containers {
      name    = "otel-mock"
      image   = local.image
      command = ["node"]
      args    = ["src/mock/otelMock.js"]

      resources {
        limits = {
          cpu    = "0.5"
          memory = "256Mi"
        }
        cpu_idle = false
      }

      env {
        name  = "OTEL_MOCK_PORT"
        value = "9091"
      }
      env {
        # /tmp is writable (in-memory) on Cloud Run; the image itself is read-only for the node user.
        name  = "OTEL_MOCK_FLAGD_FILE"
        value = "/tmp/flagd.json"
      }

      startup_probe {
        tcp_socket {
          port = 9091
        }
        period_seconds    = 2
        failure_threshold = 15
        timeout_seconds   = 1
      }
    }
  }

  lifecycle {
    # GitHub Actions rolls out new images (gcloud run services update); Terraform
    # owns everything else about the service.
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[1].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.runtime_access,
    google_secret_manager_secret_version.webhook_secret,
  ]
}

# The GitHub webhook must be reachable from the internet. Requests are
# authenticated by Ripple itself (HMAC-SHA256 signature with the webhook secret).
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  count    = var.deploy_service ? 1 : 0
  location = google_cloud_run_v2_service.ripple[0].location
  name     = google_cloud_run_v2_service.ripple[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
