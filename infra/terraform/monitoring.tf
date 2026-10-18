resource "google_monitoring_uptime_check_config" "healthz" {
  count        = var.deploy_service ? 1 : 0
  display_name = "${var.service_name} /api/status"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = "/api/status"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = trimprefix(local.service_url, "https://")
    }
  }

  depends_on = [google_project_service.apis, google_cloud_run_v2_service_iam_member.public_invoker]
}

resource "google_monitoring_notification_channel" "email" {
  count        = var.alert_email != "" ? 1 : 0
  display_name = "Ripple alerts"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

resource "google_monitoring_alert_policy" "down" {
  count        = var.deploy_service && var.alert_email != "" ? 1 : 0
  display_name = "${var.service_name} is down"
  combiner     = "OR"

  conditions {
    display_name = "Uptime check failing"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.healthz[0].uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email[0].id]
}
