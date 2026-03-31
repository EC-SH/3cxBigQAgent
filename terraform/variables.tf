variable "project_id" {
  description = "The Google Cloud project ID."
  type        = string
}

variable "region" {
  description = "The Google Cloud region to deploy resources in."
  type        = string
  default     = "us-central1"
}

variable "frontend_image" {
  description = "Container image URI for the sentinel-frontend service."
  type        = string
}

variable "backend_image" {
  description = "Container image URI for the sentinel-backend service."
  type        = string
}

variable "google_api_key" {
  description = "Gemini API key for the backend agent."
  type        = string
  sensitive   = true
}

variable "iap_domain" {
  description = "The primary domain that has IAP access (e.g., engage.pro)."
  type        = string
}

variable "iap_users" {
  description = "A list of additional users who will have IAP access."
  type        = list(string)
  default     = []
}
