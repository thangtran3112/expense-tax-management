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
        hostname = var.hub_hostname
        path     = "^/u/tradingagents(/.*)?$"
        service  = "http://ta-terminal:7681"
      },
      {
        hostname = var.hub_hostname
        path     = "^/u/ai-hedge-fund(/.*)?$"
        service  = "http://ahf-terminal:7681"
      },
      {
        hostname = var.hub_hostname
        service  = "http://web:3000"
      },
      {
        hostname = var.vibe_trading_hostname
        service  = "http://vibe-trading:8899"
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
