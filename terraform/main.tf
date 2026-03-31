provider "google" {
  project = var.project_id
  region  = var.region
}

# Fetch current project details to get the project number
data "google_project" "project" {}

# ── APIs ───────────────────────────────────────────────────────

resource "google_project_service" "run_api" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iap_api" {
  service            = "iap.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "cloudbuild_api" {
  service            = "cloudbuild.googleapis.com"
  disable_on_destroy = false
}

# ── Artifact Registry ──────────────────────────────────────────

resource "google_artifact_registry_repository" "repo" {
  location      = var.region
  repository_id = "sentinel-repo"
  format        = "DOCKER"
  description   = "Container images for sentinel frontend and backend"

  depends_on = [google_project_service.cloudbuild_api]
}

# ── Service Account ────────────────────────────────────────────

resource "google_service_account" "frontend_sa" {
  account_id   = "frontend-sa"
  display_name = "Sentinel Frontend Service Account"
}

# ── Backend Service ────────────────────────────────────────────
# Internal-only ingress — topologically unreachable from the public internet.
# No IAP. Relies on IAM (roles/run.invoker) for service-to-service auth.

resource "google_cloud_run_v2_service" "sentinel_backend" {
  name     = "sentinel-backend"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    containers {
      image = var.backend_image

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }

      env {
        name  = "GOOGLE_API_KEY"
        value = var.google_api_key
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }

  depends_on = [google_project_service.run_api]
}

# ── Frontend Service ───────────────────────────────────────────
# Public ingress with IAP enabled. Runs as frontend-sa so it can
# fetch OIDC identity tokens to invoke the backend.

resource "google_cloud_run_v2_service" "sentinel_frontend" {
  name     = "sentinel-frontend"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.frontend_sa.email

    containers {
      image = var.frontend_image

      env {
        name  = "BACKEND_URL"
        value = google_cloud_run_v2_service.sentinel_backend.uri
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }
    }

    annotations = {
      "run.googleapis.com/iap-enabled" = "true"
    }
  }

  depends_on = [google_project_service.run_api]
}

# ── IAM Bindings ───────────────────────────────────────────────

# frontend-sa can invoke the backend
resource "google_cloud_run_v2_service_iam_member" "backend_invoker" {
  project  = google_cloud_run_v2_service.sentinel_backend.project
  location = google_cloud_run_v2_service.sentinel_backend.location
  name     = google_cloud_run_v2_service.sentinel_backend.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.frontend_sa.email}"
}

# IAP service agent can invoke the frontend (required for direct IAP on Cloud Run)
resource "google_cloud_run_v2_service_iam_member" "iap_invoker" {
  project  = google_cloud_run_v2_service.sentinel_frontend.project
  location = google_cloud_run_v2_service.sentinel_frontend.location
  name     = google_cloud_run_v2_service.sentinel_frontend.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-iap.iam.gserviceaccount.com"

  depends_on = [google_project_service.iap_api]
}

# Primary domain access through IAP
resource "google_iap_web_iam_member" "domain_access" {
  project = data.google_project.project.project_id
  role    = "roles/iap.httpsResourceAccessor"
  member  = "domain:${var.iap_domain}"

  depends_on = [google_project_service.iap_api]
}

# Additional designated users through IAP
resource "google_iap_web_iam_member" "user_access" {
  for_each = toset(var.iap_users)
  project  = data.google_project.project.project_id
  role     = "roles/iap.httpsResourceAccessor"
  member   = "user:${each.key}"

  depends_on = [google_project_service.iap_api]
}
