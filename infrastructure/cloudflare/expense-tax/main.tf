terraform {
  required_version = ">= 1.8.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.8.2, < 6.0.0"
    }
  }

  backend "gcs" {
    prefix = "cloudflare/expense-tax"
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

data "cloudflare_zone" "expense_tax" {
  filter = {
    name = var.zone_name
  }
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "expense_tax" {
  account_id = var.cloudflare_account_id
  name       = "expense-tax"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "expense_tax" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.expense_tax.id

  config = {
    ingress = [
      {
        hostname = var.primary_hostname
        service  = "http://127.0.0.1:7301"
      },
      {
        hostname = var.api_hostname
        service  = "http://127.0.0.1:8100"
      },
      {
        hostname = var.capture_hostname
        service  = "http://127.0.0.1:7301"
      },
      {
        hostname = var.office_hostname
        service  = "http://127.0.0.1:7302"
      },
      {
        hostname = var.foundry_hostname
        path     = "/internal/v1/*"
        service  = "http://127.0.0.1:8200"
      },
      {
        hostname = var.foundry_hostname
        service  = "http://127.0.0.1:7303"
      },
      {
        hostname = var.mailbox_hostname
        path     = "/oauth/google/callback"
        service  = "http://127.0.0.1:8300"
      },
      {
        hostname = var.mailbox_hostname
        path     = "/oauth/google/begin"
        service  = "http://127.0.0.1:8300"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

locals {
  tunnel_hostnames = {
    primary = var.primary_hostname
    api     = var.api_hostname
    capture = var.capture_hostname
    office  = var.office_hostname
    foundry = var.foundry_hostname
    mailbox = var.mailbox_hostname
  }
}

resource "cloudflare_dns_record" "tunnel" {
  for_each = local.tunnel_hostnames

  zone_id = data.cloudflare_zone.expense_tax.id
  name    = each.value
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.expense_tax.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true
}

output "tunnel_id" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.expense_tax.id
  description = "Cloudflare Tunnel UUID used in the VPS cloudflared token and CNAME target."
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "expense_tax" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.expense_tax.id
}

output "tunnel_token" {
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.expense_tax.token
  description = "Sensitive cloudflared token; write to a local 0600 file without printing it."
  sensitive   = true
}
