# infrastructure/cloudflare/ai-trading/mirofish.tf
# Dedicated Worker + DNS for mirofish.tobytran.dev, independent of the hub's
# own Worker (hub-static.tf). Serves MiroFish's unmodified static Vue build
# (01e) with Vue history-mode fallback; see the Worker's own unit tests
# (workers/mirofish-static.test.js) for route decisions, status codes, and
# header behavior.
#
# Resource attribute names below were verified empirically against the
# pinned provider (cloudflare/cloudflare v5.26.0, confirmed via
# `terraform providers schema -json`, same check hub-static.tf already
# recorded) rather than assumed from the task-8 brief's draft:
# cloudflare_workers_script takes `script_name` (not `name`) plus
# `content`/`main_module` for a module-syntax Worker, and
# cloudflare_workers_route's `script` is the script_name string (not an
# `.id` reference). The brief's draft also used `templatefile()` to bake
# the bucket name into the script source; this instead uses `bindings`
# (plain_text env vars), matching hub-router's existing pattern so the
# Worker script itself has no Terraform-templated placeholders.
#
# Staging only: this file provisions `mirofish_staging_hostname` (Worker-
# routed) and `mirofish_origin_hostname`. It does not provision the public
# `mirofish.tobytran.dev` DNS/Worker route — that is a later, separately
# approved activation task, after task-8 brief Steps 5-9 (Caddy auth proof,
# staging verification, direct-origin bypass check) all pass.
#
# `mirofish_origin_hostname` is unrouted BY THE WORKER only (no
# `cloudflare_workers_route` below names it) — it is NOT network-private.
# Its DNS record below is a proxied, publicly resolvable CNAME to the same
# tunnel, so anyone who learns this hostname can reach it directly. The
# actual authentication boundary is the Caddy "gateway" service
# (ai-trading/deploy/production/Caddyfile's `handle /api/*` block): it
# forward_auths every request against `auth:8181`'s HMAC cookie check
# before reverse-proxying to `mirofish:5001`, regardless of which hostname
# the request arrived on. This mirrors hub-static.tf's own corrected
# `hub_origin` comment (fix round 1's P1 finding there) — same mistake,
# same fix, written once so it isn't silently reintroduced here.
#
# main.tf's shared tunnel ingress now has the one line that makes this
# hostname reachable at all (`hostname = mirofish_origin_hostname, service
# = "http://gateway:8080"`, immediately before the trailing 404 catch-all,
# after the sibling `trading-origin` entry) — added only after this task's
# local real-Caddy `/api/*` forward_auth integration test passed (A7's
# authenticated gateway + B5's `/api/*` route, both local-only; no live
# Cloudflare apply). Public `mirofish.tobytran.dev`/`mirofish-static`
# Worker routes and the existing public hub/Vibe-Trading routes are
# untouched by this.

resource "cloudflare_dns_record" "mirofish_staging" {
  zone_id = data.cloudflare_zone.main.id
  name    = var.mirofish_staging_hostname
  type    = "A"
  content = "192.0.2.1" # TEST-NET-1 (RFC 5737): never dialed, the Worker route below intercepts every request first
  ttl     = 1
  proxied = true
  comment = "ai-trading mirofish static staging (Worker-routed)"
}

resource "cloudflare_dns_record" "mirofish_origin" {
  zone_id = data.cloudflare_zone.main.id
  name    = var.mirofish_origin_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.ai_trading.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true
  comment = "ai-trading mirofish (unrouted by Worker but public/authenticated; no static Worker route; Caddy gateway enforces auth, not network privacy)"
}

resource "cloudflare_workers_script" "mirofish_static" {
  account_id  = var.cloudflare_account_id
  script_name = "ai-trading-mirofish-static"
  content     = file("${path.module}/workers/mirofish-static.js")
  main_module = "mirofish-static.js"

  bindings = [
    { type = "plain_text", name = "STATIC_BUCKET", text = var.mirofish_bucket_name },
    { type = "plain_text", name = "ORIGIN_HOSTNAME", text = var.mirofish_origin_hostname },
  ]
}

resource "cloudflare_workers_route" "mirofish_static_staging" {
  zone_id = data.cloudflare_zone.main.id
  pattern = "${var.mirofish_staging_hostname}/*"
  script  = cloudflare_workers_script.mirofish_static.script_name
}
