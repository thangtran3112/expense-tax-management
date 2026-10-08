# Task 5: Cloudflare Tunnel and Access (Terraform)

Part of [01-release-1-hub-plan.md](../01-release-1-hub-plan.md). Read its Global Constraints and Shared Interfaces first.

**Owned paths:** `infrastructure/cloudflare/ai-trading/**`, `.github/workflows/ai-trading-cloudflare.yml`. Do not touch `infrastructure/cloudflare/expense-tax/`. Do not run `git add`, `git commit`, or `git push`. Never run `terraform apply` or any command that authenticates to Cloudflare or GCP.

**Files:**
- Create: `infrastructure/cloudflare/ai-trading/main.tf`, `variables.tf`, `outputs.tf`, `bootstrap-wif.sh`, `README.md`, `.terraform.lock.hcl` (generated)
- Create: `.github/workflows/ai-trading-cloudflare.yml`

**Interfaces:**
- Consumes: service names and ports from Shared Interfaces; the state bucket `expense-tax-tobytran-2026-tfstate`; GCP project `expense-tax-tobytran-2026` with the workload identity pool `expense-tax-github`.
- Produces: outputs `tunnel_token` (sensitive), `access_application_aud`, `hub_url`, `vibe_trading_url`. GitHub environment `ai-trading-production` vars and secrets per Shared Interfaces.

Verified facts for Cloudflare provider 5.x (the repo locks 5.24.0):

- Ingress `path` is an unanchored RE2 regex, so anchor every path.
- Websockets need no extra setting.
- Access applications take multiple hostnames through `destinations`.
- The audience tag is the application's `aud` attribute.

Design rules:

- The expense workload identity provider only trusts `expense-tax-cloudflare.yml`, so this workflow gets its own identity (`bootstrap-wif.sh`).
- Plan files contain variable values and public-repo artifacts are downloadable, so this workflow never uploads a plan artifact.
- The API token variable is `ephemeral`, so it is stored neither in the plan nor in the state.

- [ ] **Step 1: Write `variables.tf`**

```hcl
variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID."
  sensitive   = true
}

variable "cloudflare_api_token" {
  type        = string
  description = "Cloudflare API token with Access, Tunnel, and DNS write permissions."
  sensitive   = true
  ephemeral   = true
}

variable "zone_name" {
  type        = string
  description = "Cloudflare-managed DNS zone name."
  default     = "tobytran.dev"
}

variable "hub_hostname" {
  type        = string
  description = "Trading Hub hostname (hub web app and browser terminals)."
  default     = "trading.tobytran.dev"
}

variable "vibe_trading_hostname" {
  type        = string
  description = "Vibe-Trading hostname."
  default     = "vibe-trading.tobytran.dev"
}

variable "access_allowed_emails" {
  type        = list(string)
  description = "Emails allowed through Cloudflare Access. Supplied from a GitHub secret; never committed."
  sensitive   = true

  validation {
    condition     = length(var.access_allowed_emails) > 0 && alltrue([for e in var.access_allowed_emails : can(regex("^[^@\\s]+@[^@\\s]+$", e))])
    error_message = "access_allowed_emails must be a non-empty list of email addresses."
  }
}
```

- [ ] **Step 2: Write `main.tf`**

```hcl
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

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

data "cloudflare_zone" "main" {
  filter = {
    name = var.zone_name
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

data "cloudflare_zero_trust_tunnel_cloudflared_token" "ai_trading" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.ai_trading.id
}

# --- Access -----------------------------------------------------------------

resource "cloudflare_zero_trust_access_identity_provider" "one_time_pin" {
  account_id = var.cloudflare_account_id
  name       = "One-time PIN"
  type       = "onetimepin"
  config     = {}
}

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
  allowed_idps              = [cloudflare_zero_trust_access_identity_provider.one_time_pin.id]
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
```

- [ ] **Step 3: Write `outputs.tf`**

```hcl
output "tunnel_token" {
  description = "Connector token; becomes TUNNEL_TOKEN in cloudflared.env."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.ai_trading.token
  sensitive   = true
}

output "access_application_aud" {
  description = "Cloudflare Access audience tag. Release 2's API verifies it."
  value       = cloudflare_zero_trust_access_application.ai_trading.aud
}

output "hub_url" {
  value = "https://${var.hub_hostname}"
}

output "vibe_trading_url" {
  value = "https://${var.vibe_trading_hostname}"
}
```

- [ ] **Step 4: Write `bootstrap-wif.sh`**

```bash
#!/usr/bin/env bash
# One-time operator step: creates the GitHub OIDC identity that
# .github/workflows/ai-trading-cloudflare.yml uses to reach the shared GCS state
# bucket. Mirrors expense-tax-management/infrastructure/gcp/expense-tax/bootstrap-cloudflare.sh.
set -euo pipefail
umask 077

PROJECT_ID="expense-tax-tobytran-2026"
BUCKET="expense-tax-tobytran-2026-tfstate"
SERVICE_ACCOUNT_ID="ai-trading-cf-terraform"
POOL_ID="expense-tax-github"
PROVIDER_ID="ai-trading-cloudflare"
REPOSITORY="thangtran3112/family-app"
ENVIRONMENT="ai-trading-production"
WORKFLOW_REF="${REPOSITORY}/.github/workflows/ai-trading-cloudflare.yml@refs/heads/main"
CONDITION="assertion.repository=='${REPOSITORY}' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='${WORKFLOW_REF}' && assertion.environment=='${ENVIRONMENT}'"
MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref,attribute.environment=assertion.environment"

command -v gcloud >/dev/null || { echo "gcloud is required" >&2; exit 1; }
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_ID}@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_ID" \
    --project="$PROJECT_ID" --display-name="ai-trading Cloudflare Terraform"
fi

if ! gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  echo "workload identity pool $POOL_ID is missing; run the expense bootstrap first" >&2
  exit 1
fi

if ! gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
    --display-name="ai-trading CF Terraform" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION"
else
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
PRINCIPAL_SET="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${REPOSITORY}"

gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" --role="roles/iam.workloadIdentityUser" --member="$PRINCIPAL_SET" >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" --role="roles/storage.objectAdmin" >/dev/null

echo "Set these vars in the GitHub environment ${ENVIRONMENT}:"
echo "  GCP_AI_TRADING_CF_WORKLOAD_IDENTITY_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
echo "  GCP_AI_TRADING_CF_SERVICE_ACCOUNT=${SERVICE_ACCOUNT_EMAIL}"
echo "  TF_STATE_BUCKET=${BUCKET}"
```

Then run `chmod +x infrastructure/cloudflare/ai-trading/bootstrap-wif.sh`.

- [ ] **Step 5: Write `README.md`**

````markdown
# ai-trading Cloudflare (Tunnel + Access)

Terraform for the ai-trading tunnel, its two DNS records, and the Cloudflare Access application that admits only the family's emails. State lives in `gs://expense-tax-tobytran-2026-tfstate` under prefix `cloudflare/ai-trading`. The expense tunnel is separate and untouched.

| Hostname | Routes |
|---|---|
| `trading.tobytran.dev` | `^/u/tradingagents(/.*)?$` to `ta-terminal:7681`; `^/u/ai-hedge-fund(/.*)?$` to `ahf-terminal:7681`; everything else to `web:3000` |
| `vibe-trading.tobytran.dev` | `vibe-trading:8899` |

## Token permissions

Create an API token with these permissions:

- `Access: Apps and Policies Write`
- `Access: Organizations, Identity Providers, and Groups Write`
- `Cloudflare Tunnel Write`
- `DNS Write` on zone `tobytran.dev`

Store it as the `AI_TRADING_CLOUDFLARE_API_TOKEN` secret in the `ai-trading-production` environment.

## Workflow

`.github/workflows/ai-trading-cloudflare.yml`:

- pull request: `fmt` and `validate`;
- push to `main`: plan;
- manual dispatch from `main` with `apply: true`: plan and apply in one job.

No plan artifact is uploaded, because plan files contain variable values and this repository is public.

## First apply (operator machine)

The first deploy needs the tunnel token before any `main` release, so apply once locally. Install Terraform, or prefix each `terraform` command with `docker run --rm -it -v "$PWD":/w -w /w -v ~/.config/gcloud:/root/.config/gcloud hashicorp/terraform:latest`.

```bash
cd infrastructure/cloudflare/ai-trading
gcloud auth application-default login
export TF_VAR_cloudflare_account_id=<account id>
export TF_VAR_cloudflare_api_token=<token>
export TF_VAR_access_allowed_emails='["first@example.com","second@example.com"]'
terraform init -backend-config="bucket=expense-tax-tobytran-2026-tfstate"
terraform apply
terraform output -raw tunnel_token
```

Put the token into `~/secure/ai-trading/cloudflared.env` as `TUNNEL_TOKEN=...`.

If the apply fails because a one-time PIN login method already exists, import it and apply again:

```bash
terraform import cloudflare_zero_trust_access_identity_provider.one_time_pin accounts/<account id>/<identity provider id>
```
````

- [ ] **Step 6: Write `.github/workflows/ai-trading-cloudflare.yml`**

```yaml
name: ai-trading-cloudflare

on:
  pull_request:
    branches: [dev]
    paths:
      - "infrastructure/cloudflare/ai-trading/**"
      - ".github/workflows/ai-trading-cloudflare.yml"
  push:
    branches: [main]
    paths:
      - "infrastructure/cloudflare/ai-trading/**"
      - ".github/workflows/ai-trading-cloudflare.yml"
  workflow_dispatch:
    inputs:
      apply:
        description: Plan and apply to production Cloudflare
        type: boolean
        default: false

concurrency:
  group: ai-trading-cloudflare-production
  cancel-in-progress: false

env:
  TF_IN_AUTOMATION: "true"
  TF_INPUT: "false"

defaults:
  run:
    shell: bash
    working-directory: infrastructure/cloudflare/ai-trading

jobs:
  validate:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - uses: hashicorp/setup-terraform@v3
      - run: terraform init -backend=false
      - run: terraform fmt -check -recursive
      - run: terraform validate

  plan-or-apply:
    if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: ai-trading-production
    permissions:
      contents: read
      id-token: write
    env:
      TF_VAR_cloudflare_account_id: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
      TF_VAR_cloudflare_api_token: ${{ secrets.AI_TRADING_CLOUDFLARE_API_TOKEN }}
      TF_VAR_access_allowed_emails: ${{ secrets.AI_TRADING_ACCESS_ALLOWED_EMAILS }}
    steps:
      - uses: actions/checkout@v7
      - name: Authenticate to Google Cloud
        uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: ${{ vars.GCP_AI_TRADING_CF_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ vars.GCP_AI_TRADING_CF_SERVICE_ACCOUNT }}
          create_credentials_file: true
          cleanup_credentials: true
      - uses: hashicorp/setup-terraform@v3
      - run: terraform init -backend-config="bucket=${{ vars.TF_STATE_BUCKET }}"
      - run: terraform fmt -check -recursive
      - run: terraform validate
      - run: terraform plan -out=tfplan
      - name: Apply the plan from this job
        if: github.event_name == 'workflow_dispatch' && inputs.apply
        run: terraform apply -auto-approve tfplan
      - name: Remove the plan file
        if: always()
        run: rm -f tfplan
```

- [ ] **Step 7: Generate the lock file and validate (Docker, no local Terraform install)**

```bash
cd infrastructure/cloudflare/ai-trading
docker run --rm -v "$PWD":/w -w /w hashicorp/terraform:latest init -backend=false
docker run --rm -v "$PWD":/w -w /w hashicorp/terraform:latest providers lock \
  -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64
docker run --rm -v "$PWD":/w -w /w hashicorp/terraform:latest fmt -check -recursive
docker run --rm -v "$PWD":/w -w /w hashicorp/terraform:latest validate
rm -rf .terraform
cd -
docker run --rm -v "$PWD":/mnt -w /mnt koalaman/shellcheck:stable infrastructure/cloudflare/ai-trading/bootstrap-wif.sh
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest .github/workflows/ai-trading-cloudflare.yml
```

Expected:

- `.terraform.lock.hcl` exists and pins a `cloudflare/cloudflare` 5.x version;
- `fmt` prints nothing;
- `Success! The configuration is valid.`;
- no shellcheck or actionlint findings.

If `validate` rejects an attribute, fix it against the provider documentation for the locked version and report the change.
