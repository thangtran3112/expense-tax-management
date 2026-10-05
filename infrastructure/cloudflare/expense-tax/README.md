# Expense Tax Cloudflare Tunnel

Terraform manages one remotely configured Cloudflare Tunnel and five public
hostnames. cloudflared runs on an already reachable Ubuntu VPS and exposes no
public ports; it connects outbound to Cloudflare.

This module is limited to free-tier Cloudflare Tunnel/DNS/proxy controls. paid WAF,
rate limiting, Workers, Cloud Armor, and paid Access/Zero Trust seats
require separate approval and must not be added here without an explicit cost
decision.

## Live status

- Terraform-managed Tunnel and five product CNAMEs are active.
- VPS `cloudflared` is healthy; all application origins remain loopback-only.
- Clerk DNS and DMARC records are imported into Terraform state.
- Production host routing, API health, signed webhook delivery, and authenticated smoke checks pass.

## Host routing

| Host | VPS origin |
|---|---|
| `expense.tobytran.dev` | `127.0.0.1:7301` (Capture primary) |
| `expense-api.tobytran.dev` | `127.0.0.1:8100` (API/webhook) |
| `expense-capture.tobytran.dev` | `127.0.0.1:7301` (Capture) |
| `expense-office.tobytran.dev` | `127.0.0.1:7302` (Office) |
| `expense-foundry.tobytran.dev` | `127.0.0.1:7303` (Foundry) |

Production Clerk uses `clerk.tobytran.dev`; `expense-clerk.tobytran.dev` was not
used. App and API hosts remain product-scoped (`expense.tobytran.dev`,
`expense-api.tobytran.dev`, and related hosts). Clerk records are DNS-only and
are managed separately from Tunnel records in `clerk_dns.tf`.

## Production Clerk DNS

| Host | CNAME target | Cloudflare mode |
|---|---|---|
| `clerk.tobytran.dev` | `frontend-api.clerk.services` | DNS-only |
| `accounts.tobytran.dev` | `accounts.clerk.services` | DNS-only |
| `clkmail.tobytran.dev` | `mail.isbd4mdbk2ld.clerk.services` | DNS-only |
| `clk._domainkey.tobytran.dev` | `dkim1.isbd4mdbk2ld.clerk.services` | DNS-only |
| `clk2._domainkey.tobytran.dev` | `dkim2.isbd4mdbk2ld.clerk.services` | DNS-only |
| `_dmarc.tobytran.dev` | `v=DMARC1; p=none; adkim=s; aspf=s` | TXT |

DMARC starts in monitoring mode (`p=none`) while Gmail reputation warms. SPF/DKIM
are Clerk-managed CNAMEs; move DMARC to `quarantine` or `reject` only after
reviewing aggregate reports.

Records already exist in Cloudflare. Import each record into its stable
Terraform address before planning or applying this module. Cloudflare imports
use `zone_id/record_id`; obtain each existing record ID from Cloudflare without
creating replacement records:

```bash
cd infrastructure/cloudflare/expense-tax
terraform import 'cloudflare_dns_record.clerk["frontend_api"]' "$CLOUDFLARE_ZONE_ID/$CLERK_FRONTEND_API_RECORD_ID"
terraform import 'cloudflare_dns_record.clerk["accounts"]' "$CLOUDFLARE_ZONE_ID/$CLERK_ACCOUNTS_RECORD_ID"
terraform import 'cloudflare_dns_record.clerk["mail"]' "$CLOUDFLARE_ZONE_ID/$CLERK_MAIL_RECORD_ID"
terraform import 'cloudflare_dns_record.clerk["dkim1"]' "$CLOUDFLARE_ZONE_ID/$CLERK_DKIM1_RECORD_ID"
terraform import 'cloudflare_dns_record.clerk["dkim2"]' "$CLOUDFLARE_ZONE_ID/$CLERK_DKIM2_RECORD_ID"
```

Do not use Tunnel CNAME targets for these records and do not set
`proxied = true`; Clerk validation requires DNS-only records.

## Cloudflare token

Use a narrowly scoped API token with:

- Account: **Cloudflare Tunnel Edit** for target account
- Zone: **DNS Edit** for `tobytran.dev`

Provide token through `TF_VAR_cloudflare_api_token` or CI environment secret.
Never put token in `.tfvars`, command arguments, logs, or committed files.

## State bootstrap and Terraform

State bucket name is deterministic: `expense-tax-tobytran-2026-tfstate`.
Bootstrap requires authenticated gcloud, verifies the exact bucket name appears
in a project-scoped listing for `expense-tax-tobytran-2026` before any IAM
mutation, and grants existing
dedicated `expense-tax-cf-terraform` service account object admin. The
application deploy service account has no access to this bucket. For a fresh
environment, run
`expense-tax-management/infrastructure/gcp/expense-tax/bootstrap-cloudflare.sh`
to create the dedicated service account and exact Cloudflare workflow WIF
provider. Existing production bootstrap is complete. Re-running these commands
mutates GCP and requires explicit operator approval.

Configure these GitHub production environment variables from bootstrap output:

- `GCP_CLOUDFLARE_WORKLOAD_IDENTITY_PROVIDER`: dedicated Cloudflare WIF provider
- `GCP_CLOUDFLARE_SERVICE_ACCOUNT`: `expense-tax-cf-terraform@expense-tax-tobytran-2026.iam.gserviceaccount.com`

Bucket versioning is enabled. Lifecycle policy deletes noncurrent state object
versions after exactly 30 days; current versions are retained indefinitely.
Terraform state contains the sensitive tunnel token, so do not disable this
policy or place state in another backend without equivalent retention controls.

```bash
cd /Users/toby.tran/personal/family-app
gcloud auth application-default login
./infrastructure/cloudflare/expense-tax/bootstrap-state.sh

cd infrastructure/cloudflare/expense-tax
terraform init \
  -backend-config="bucket=expense-tax-tobytran-2026-tfstate"
terraform fmt -check
terraform validate
terraform plan \
  -var="cloudflare_account_id=${CLOUDFLARE_ACCOUNT_ID}" \
  -var="cloudflare_api_token=${CLOUDFLARE_API_TOKEN}"
terraform apply \
  -var="cloudflare_account_id=${CLOUDFLARE_ACCOUNT_ID}" \
  -var="cloudflare_api_token=${CLOUDFLARE_API_TOKEN}"
```

For local validation without backend or Cloudflare access:

```bash
terraform init -backend=false
terraform fmt -check -recursive .
terraform validate
bash test-clerk-dns.sh
```

Use a restrictive umask before exporting the token, then do not print the file:

```bash
umask 077
mkdir -p ~/.config/cloudflared
terraform output -raw tunnel_token > ~/.config/cloudflared/expense-tax.token
chmod 600 ~/.config/cloudflared/expense-tax.token
```

Terraform state contains sensitive tunnel material and must stay in GCS.

## VPS token installation

From repository root, with local token file mode `0600`:

```bash
./infrastructure/vps/bootstrap-cloudflared.sh \
  --host 158.69.202.250 \
  --user ubuntu \
  --key ~/.ssh/id_ed25519_personal \
  --ssh-port 2222 \
  --known-hosts-file ~/.ssh/expense-tax-known-hosts \
  --tunnel-token-file ~/.config/cloudflared/expense-tax.token
```

The script installs or upgrades cloudflared from Cloudflare's official apt
repository when missing or older than `2025.4.0`, writes
`/etc/cloudflared/expense-tax-tunnel.token` with mode `0600` through stdin,
installs a token-file systemd unit, enables/restarts it, and verifies active
status. It never prints token content. Keep VPS firewall inbound policy closed
for application ports; Tunnel traffic is outbound.

## Migration to a new VPS

1. Provision reachable Ubuntu VPS and complete existing `infrastructure/vps/bootstrap.sh` SSH/Docker/Postgres steps.
2. Apply this Terraform module only if Tunnel hostnames or ingress need changes; the remotely managed Tunnel identity remains in Cloudflare state.
3. Export sensitive `tunnel_token` directly to a local `0600` file without printing it.
4. Provide a pinned known-hosts file with mode `0600`, run
   `bootstrap-cloudflared.sh` against new host, and verify systemd active status.
5. Verify all five HTTPS hostnames and API/webhook health checks.
6. Stop and remove cloudflared service from old VPS after new VPS is healthy; do not rotate DNS because CNAMEs target Tunnel UUID, not VPS IP.
