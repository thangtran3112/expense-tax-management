terraform {
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.8.2, < 6.0.0"
    }
  }

  backend "gcs" {
    prefix = "cloudflare/ai-trading"
  }
}

provider "cloudflare" {}

data "cloudflare_zone" "main" {
  filter = {
    name = var.zone_name
  }
}

# Identity provider ID from the account-wide Zero Trust root.
data "terraform_remote_state" "zero_trust" {
  backend = "gcs"

  config = {
    bucket = var.state_bucket
    prefix = "cloudflare/zero-trust"
  }
}

# --- Tunnel -----------------------------------------------------------------

resource "cloudflare_zero_trust_tunnel_cloudflared" "ai_trading" {
  account_id = var.cloudflare_account_id
  name       = "ai-trading"
  config_src = "cloudflare"
}

# Services are Docker Compose service names: cloudflared runs inside the stack.
# Paths are unanchored RE2 regexes, so anchor them.
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "ai_trading" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.ai_trading.id

  config = {
    ingress = [
      {
        # Public hostname's dynamic paths are routed to the Caddy "gateway"
        # service (ai-trading/deploy/production/Caddyfile), not directly to
        # the terminals. Routing straight to ta-terminal/ahf-terminal here
        # would trust the client-supplied `Cf-Access-Authenticated-User-Email`
        # header (ttyd's own `--auth-header` trust boundary), which is fully
        # spoofable and -- since Cloudflare Access has never enabled
        # successfully for this account -- would leave both terminals
        # unauthenticated on the public internet. gateway:8080 is the sole
        # enforcement point: it strips any inbound identity header and only
        # forwards a request once `auth:8181`'s HMAC-cookie check verifies
        # it (ai-trading/deploy/ci/smoke-test.sh's `smoke_gateway` proves
        # this against a real Caddy + a real ttyd). Fixed in response to
        # fix-round-1 reviewer P0: the prior direct-to-terminal routes below
        # were a live, unauthenticated bypass of the Caddy/HMAC gate.
        hostname = var.hub_hostname
        path     = "^/u/tradingagents(/.*)?$"
        service  = "http://gateway:8080"
      },
      {
        hostname = var.hub_hostname
        path     = "^/u/ai-hedge-fund(/.*)?$"
        service  = "http://gateway:8080"
      },
      {
        # The frontend's same-origin `POST /__auth/session` /
        # `GET /__auth/check` calls (ai-trading/auth, Task 6/8) must reach
        # `auth:8181` through the gateway even while `hub_hostname` is still
        # tunneled directly (pre-Task-11 Worker cutover) -- otherwise they
        # fall through to the `web:3000` static-server catch-all below and
        # 404. Fixed in response to fix-round-1 reviewer P0: this ingress
        # entry did not exist before.
        hostname = var.hub_hostname
        path     = "^/__auth/.*$"
        service  = "http://gateway:8080"
      },
      {
        hostname = var.hub_hostname
        service  = "http://web:3000"
      },
      {
        # Vibe's whole hostname goes through the same Clerk-verified Caddy
        # gateway. Its own API key remains an additional upstream check.
        hostname = var.vibe_trading_hostname
        service  = "http://gateway:8080"
      },
      {
        # hub-static-variables.tf's hub_origin_hostname: unrouted BY THE
        # WORKER (no cloudflare_workers_route names it, so the Worker never
        # intercepts it with a static asset) and no Cloudflare Access
        # destination names it either -- but it is NOT network-private.
        # Its DNS record (hub-static.tf's cloudflare_dns_record.hub_origin)
        # is a proxied, publicly resolvable CNAME to this same tunnel, so
        # anyone on the internet who learns this hostname can reach it
        # directly (fix-round-1 reviewer P1: corrected from an earlier,
        # inaccurate "private"/"reached only by the tunnel" description).
        # The actual authentication boundary is the Caddy "gateway" service
        # (ai-trading/deploy/production/Caddyfile): it strips any inbound
        # identity header and forward_auths every /u/* and /__auth/* request
        # against `auth:8181`'s HMAC cookie check regardless of which
        # hostname the request arrived on. Added here only after this
        # task's local real-Caddy forward_auth integration test passed
        # (progress.md Ruling: "Add private trading-origin ingress only
        # after A7's authenticated gateway test, before A10's staging
        # probe" -- "private" in that ruling's own wording means
        # "not yet linked from the public hostname", not "network-isolated";
        # see this comment for the corrected, precise claim). The public
        # hub_hostname routes above are a second, independent path to the
        # same gateway; Task 11 (separately operator-gated) removes them
        # once the Worker/GCS static path is cut over, leaving this origin
        # hostname as the only way dynamic paths reach the gateway.
        hostname = var.hub_origin_hostname
        service  = "http://gateway:8080"
      },
      {
        # mirofish-variables.tf's mirofish_origin_hostname: unrouted BY THE
        # WORKER (no cloudflare_workers_route in mirofish.tf names it) but,
        # like hub_origin_hostname just above, it is NOT network-private —
        # its DNS record (mirofish.tf's cloudflare_dns_record.mirofish_origin)
        # is a proxied, publicly resolvable CNAME to this same tunnel, so
        # anyone who learns this hostname can reach it directly. The actual
        # authentication boundary is this same Caddy "gateway" service
        # (ai-trading/deploy/production/Caddyfile's `handle /api/*` block):
        # it strips any inbound identity header and forward_auths every
        # /api/* request against `auth:8181`'s HMAC cookie check before
        # reverse-proxying to `mirofish:5001` — Flask is never reachable
        # directly, from this ingress or any other. Added here only after
        # this task's local real-Caddy `/api/*` forward_auth integration
        # test passed (A7's authenticated gateway + B5's `/api/*` route,
        # both local-only; no live Cloudflare apply). mirofish-static.js's
        # own `/__auth/check` gate (workers/mirofish-static.js) is a second,
        # independent check that only applies once a Worker route exists
        # for the staging/public hostnames' HTML paths; this ingress line
        # is what makes mirofish-origin.tobytran.dev's /api/* reachable at
        # all, gated the same way hub_origin's /u/* and /__auth/* are
        # gated above. Public mirofish.tobytran.dev/mirofish-static Worker
        # routes remain unprovisioned; the existing public hub/Vibe-Trading
        # routes above are unchanged by this entry.
        hostname = var.mirofish_origin_hostname
        service  = "http://gateway:8080"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

locals {
  tunnel_hostnames = {
    hub          = var.hub_hostname
    vibe_trading = var.vibe_trading_hostname
  }
}

resource "cloudflare_dns_record" "tunnel" {
  for_each = local.tunnel_hostnames

  zone_id = data.cloudflare_zone.main.id
  name    = each.value
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.ai_trading.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true
  comment = "ai-trading tunnel (${each.key})"
}

# --- Access -----------------------------------------------------------------

resource "cloudflare_zero_trust_access_policy" "family" {
  account_id       = var.cloudflare_account_id
  name             = "ai-trading family"
  decision         = "allow"
  session_duration = "720h"
  include          = [for email in var.access_allowed_emails : { email = { email = email } }]
}

resource "cloudflare_zero_trust_access_application" "ai_trading" {
  account_id                = var.cloudflare_account_id
  name                      = "ai-trading"
  type                      = "self_hosted"
  session_duration          = "720h"
  allowed_idps              = [data.terraform_remote_state.zero_trust.outputs.one_time_pin_idp_id]
  auto_redirect_to_identity = true
  app_launcher_visible      = false

  destinations = [
    { type = "public", uri = var.hub_hostname },
    { type = "public", uri = var.vibe_trading_hostname },
  ]

  policies = [
    { id = cloudflare_zero_trust_access_policy.family.id, precedence = 1 },
  ]
}
