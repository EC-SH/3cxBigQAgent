output "frontend_url" {
  description = "The URL of the sentinel-frontend Cloud Run service (behind IAP)."
  value       = google_cloud_run_v2_service.sentinel_frontend.uri
}

output "backend_url" {
  description = "The URL of the sentinel-backend Cloud Run service (internal-only)."
  value       = google_cloud_run_v2_service.sentinel_backend.uri
}
