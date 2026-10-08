# infrastructure/cloudflare/ai-trading/hub-static.tf
# Worker + DNS for the hub's static export, independent of MiroFish's own
# Worker (01i's mirofish.tf). No business logic, LLM calls, or persistent
# state here — see Review Focus #4 and the Worker's own unit tests
# (worker/hub-router.test.js).
#
# Resource attribute names below were verified empirically against the
# pinned provider (cloudflare/cloudflare v5.26.0, confirmed via
# `terraform providers schema -json`) rather than assumed from the plan
# draft: cloudflare_workers_script takes `script_name` (not `name`) plus
# `content`/`main_module` for a module-syntax Worker, and
# cloudflare_workers_route's `script` is the script_name string (not an
# `.id` reference).
#
# The hub_origin_hostname ingress line on the shared tunnel config (main.tf)
# is Task 7's responsibility, not this file's -- it was added there once
# Task 7's own local real-Caddy forward_auth integration test passed
# (progress.md's A7/A10 ruling). (Corrected in fix round 1: this comment
# previously, incorrectly, attributed that line to Task 11, which only
# removes the *public* hub_hostname routes to the same gateway once the
# Worker/GCS static path is cut over -- a separate, later, operator-gated
# change, not this hostname's own ingress line.)

resource "cloudflare_dns_record" "hub_static_staging" {
  zone_id = data.cloudflare_zone.main.id
  name    = var.hub_static_hostname
  type    = "A"
  content = "192.0.2.1" # TEST-NET-1 (RFC 5737): never dialed, the Worker route below intercepts every request first
  ttl     = 1
  proxied = true
  comment = "ai-trading hub static staging (Worker-routed)"
}

resource "cloudflare_dns_record" "hub_origin" {
  zone_id = data.cloudflare_zone.main.id
  name    = var.hub_origin_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.ai_trading.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true
  comment = "ai-trading hub origin (public; Caddy gateway enforces auth)"
}

resource "cloudflare_workers_script" "hub_router" {
  account_id  = var.cloudflare_account_id
  script_name = "ai-trading-hub-router"
  content     = file("${path.module}/worker/hub-router.js")
  main_module = "hub-router.js"

  bindings = [
    { type = "plain_text", name = "STATIC_BUCKET", text = var.hub_static_bucket_name },
    { type = "plain_text", name = "ORIGIN_HOSTNAME", text = var.hub_origin_hostname },
  ]
}

resource "cloudflare_workers_route" "hub_static" {
  zone_id = data.cloudflare_zone.main.id
  pattern = "${var.hub_static_hostname}/*"
  script  = cloudflare_workers_script.hub_router.script_name
}
