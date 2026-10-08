# infrastructure/cloudflare/ai-trading/mirofish-variables.tf
# Variables used only by mirofish.tf, kept out of the shared variables.tf
# so both files can grow independently of each other and of the sibling
# hub-static-variables.tf. Staging-only for now (task-8 brief Steps 8-9):
# `mirofish_hostname` (the public mirofish.tobytran.dev hostname) is not
# defined here — it belongs to the later, separately approved activation
# task, once Steps 5-9 (Caddy auth proof, staging verification, direct-
# origin bypass check) all pass.

variable "mirofish_origin_hostname" {
  type        = string
  description = "MiroFish's tunnel-origin hostname. Unrouted by the mirofish-static Worker (no static-asset route targets it) but publicly resolvable (proxied CNAME to the ai-trading tunnel, see mirofish.tf) — the Caddy gateway's forward_auth is the authentication boundary, not network privacy."
  default     = "mirofish-origin.tobytran.dev"
}

variable "mirofish_staging_hostname" {
  type        = string
  description = "Staging hostname for the Worker-served MiroFish static UI, proven before mirofish.tobytran.dev is cut over."
  default     = "mirofish-static.tobytran.dev"
}

variable "mirofish_bucket_name" {
  type        = string
  description = "GCS bucket name from infrastructure/gcp/ai-trading's mirofish_bucket_name output. Passed explicitly rather than read via terraform_remote_state, to keep this file's blast radius independent of the GCP state's shape."
}
