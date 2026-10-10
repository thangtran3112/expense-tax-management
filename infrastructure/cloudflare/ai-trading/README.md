# ai-trading Cloudflare (Tunnel + staging Workers)

Terraform for the ai-trading tunnel, staging Workers, and DNS. Caddy/Clerk protects every VPS upstream route; Cloudflare Access is deferred for Release 1. This root does not read or apply `infrastructure/cloudflare/zero-trust/`, which remains for a separate future decision. State lives in `gs://tobytran-portfolio-tfstate` under prefix `cloudflare/ai-trading`. The expense tunnel is separate and untouched.

| Hostname | Routes |
|---|---|
| `trading-hub.tobytran.dev` | The hub: `ai-trading-hub-router` Worker serves the static export from GCS and proxies `/u/*` and `/__auth/*` to `trading-origin.tobytran.dev` (tunnel → Caddy `gateway:8080`) (01l) |
| `tradingagents.tobytran.dev`, `ai-hedge-fund.tobytran.dev` | Whole hostname to Caddy `gateway:8080`, whose host block checks the Clerk-backed cookie and serves the terminal at `/` (01l) |
| `trading.tobytran.dev` | Interim hub host until Desk Phase 4: `/u/*` and `/__auth/*` to Caddy `gateway:8080`; static hub paths to `web:3000` |
| `vibe-trading.tobytran.dev` | Caddy `gateway:8080` checks the Clerk-backed cookie, then proxies all paths to `vibe-trading:8899`; Vibe's own API key remains required. |

## Token policy

Use the single shared `shared/cloudflare` `CLOUDFLARE_API_TOKEN` described in `ai-trading/AGENTS.md`. It is the same token used by `expense-tax-management`; do not create another one. Permissions may only be broadened, never restricted. If a change needs a permission the token lacks, open the Cloudflare dashboard with the user and add it, then update `shared/cloudflare`'s stored value in Firestore if Cloudflare rotates it (`printf '%s' "$NEW_VALUE" | common/config/family_config.py set shared/cloudflare CLOUDFLARE_API_TOKEN`).

The Cloudflare provider reads `CLOUDFLARE_API_TOKEN` from the environment; no Terraform variable holds the token.

## Apply order

1. `infrastructure/gcp/ai-trading` (identities and static buckets).
2. `infrastructure/cloudflare/ai-trading` (this root). Do not apply `zero-trust` for Release 1.

## Workflow

`.github/workflows/ai-trading-infra.yml` validates all three Terraform roots on pull requests to `dev`, but on push to `main` or manual dispatch plans (and, with `apply: true`, applies) **only** `cloudflare/ai-trading`, authenticated to GCP via the `ai-trading-terraform` workload identity pool.

No plan artifact is uploaded, because plan files contain variable values and this repository is public.

## Local apply

Install Terraform, or run it in Docker with the repo mounted. For Docker, get `GOOGLE_OAUTH_ACCESS_TOKEN` from `CLOUDSDK_ACTIVE_CONFIG_NAME=personal gcloud auth print-access-token` and pass it with `-e`; pass the Cloudflare token and `TF_VAR_*` values from `family_config.py run` with `-e` as well. Never mount the default gcloud configuration (the work account).

```bash
cd infrastructure/cloudflare/ai-trading
CLI=../../../common/config/family_config.py
$CLI run ai-trading/cloudflare -- \
  terraform init -backend-config="bucket=tobytran-portfolio-tfstate"
$CLI run ai-trading/cloudflare -- terraform plan -out=tfplan
$CLI run ai-trading/cloudflare -- terraform apply -auto-approve tfplan
rm -f tfplan
```

`family_config.py run` adds `CLOUDFLARE_API_TOKEN`, `TF_VAR_cloudflare_account_id`, `TF_VAR_zone_name`, and `TF_VAR_mirofish_bucket_name` from the `ai-trading/cloudflare` Firestore profile. No Access IDP or allowed-email variable is required by this root.

After the first apply, fetch the tunnel token for local/manual use from the Cloudflare API (the deploy workflow does this automatically in `render-env.sh`):

```bash
cd infrastructure/cloudflare/ai-trading
TUNNEL_ID="$(terraform output -raw tunnel_id)"
export TUNNEL_ID
../../../common/config/family_config.py run ai-trading/cloudflare -- bash -c '
  curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$TF_VAR_cloudflare_account_id/cfd_tunnel/$TUNNEL_ID/token" \
    | jq -r ".result"
'
```
