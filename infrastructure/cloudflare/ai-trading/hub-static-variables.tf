# infrastructure/cloudflare/ai-trading/hub-static-variables.tf
# Variables used only by hub-static.tf, kept out of the shared variables.tf
# so both files can grow independently of each other and of the sibling
# mirofish-variables.tf (01i).

variable "hub_static_hostname" {
  type        = string
  description = "Staging hostname for the Worker-served static hub, proven before trading.tobytran.dev is cut over (Task 10)."
  default     = "trading-static.tobytran.dev"
}

variable "hub_origin_hostname" {
  type        = string
  description = "Unrouted tunnel-origin hostname for the hub's dynamic paths (/u/*, /__auth/*, /__control/*). No Worker route; reached only via the tunnel, by the Caddy gateway."
  default     = "trading-origin.tobytran.dev"
}

variable "hub_static_bucket_name" {
  type        = string
  description = "GCS bucket name from infrastructure/gcp/ai-trading's hub_bucket_name output."
  default     = "tobytran-ai-trading-hub"
}
