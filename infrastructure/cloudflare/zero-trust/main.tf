terraform {
  required_version = ">= 1.10.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.8.2, < 6.0.0"
    }
  }

  backend "gcs" {
    prefix = "cloudflare/zero-trust"
  }
}

provider "cloudflare" {}

# --- Zero Trust organization -------------------------------------------------
#
# Account-wide singleton. The underlying Cloudflare API is an idempotent PUT
# (accounts/{account_id}/access/organizations): the provider's Create and
# Update actions both call ZeroTrust.Organizations.Update, and Delete is a
# no-op (see Task 10 report for the schema evidence). Applying this resource
# enables Access on the account the first time there is no organization yet,
# and otherwise updates the existing one in place.
resource "cloudflare_zero_trust_organization" "this" {
  account_id       = var.cloudflare_account_id
  name             = var.team_name
  auth_domain      = "${var.team_name}.cloudflareaccess.com"
  session_duration = "720h"
}

# --- One-time PIN login (moved from infrastructure/cloudflare/ai-trading) ---

resource "cloudflare_zero_trust_access_identity_provider" "one_time_pin" {
  account_id = var.cloudflare_account_id
  name       = "One-time PIN"
  type       = "onetimepin"
  config     = {}
}
