# ai-trading Cloudflare (Tunnel + Access)

Terraform for the ai-trading tunnel, its two DNS records, and the Cloudflare Access application that admits only the family's emails. State lives in `gs://tobytran-portfolio-tfstate` under prefix `cloudflare/ai-trading`. The expense tunnel is separate and untouched. The account-wide Zero Trust organization and one-time PIN login live in `infrastructure/cloudflare/zero-trust/`; this root reads the identity provider ID from there via `terraform_remote_state`.

| Hostname | Routes |
|---|---|
| `trading.tobytran.dev` | `^/u/tradingagents(/.*)?$` to `ta-terminal:7681`; `^/u/ai-hedge-fund(/.*)?$` to `ahf-terminal:7681`; everything else to `web:3000` |
| `vibe-trading.tobytran.dev` | `vibe-trading:8899` |

## Token policy

Use the single shared `CLOUDFLARE_AGENT_API_TOKEN` token described in `ai-trading/AGENTS.md`. It is the same token used by `expense-tax-management`; do not create another one. Permissions may only be broadened, never restricted. If a change needs a permission the token lacks, open the Cloudflare dashboard with the user and add it, then re-copy the value into `ai-trading-env-bundle` if Cloudflare rotates it.

The Cloudflare provider reads `CLOUDFLARE_API_TOKEN` from the environment; no Terraform variable holds the token.

## Apply order

1. `infrastructure/gcp/ai-trading` (GCP identities and the secret).
2. `infrastructure/cloudflare/zero-trust` (Zero Trust organization, one-time PIN).
3. `infrastructure/cloudflare/ai-trading` (this root) — reads `one_time_pin_idp_id` from step 2's state.

## Workflow

`.github/workflows/ai-trading-infra.yml` validates all three Terraform roots on pull requests to `dev`, and on push to `main` or manual dispatch plans (and, with `apply: true` on dispatch, applies) `cloudflare/zero-trust` then `cloudflare/ai-trading` in order, authenticated to GCP via the `ai-trading-terraform` workload identity pool.

No plan artifact is uploaded, because plan files contain variable values and this repository is public.

## Local apply

Install Terraform, or prefix each `terraform` command with `docker run --rm -it -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading -v ~/.config/gcloud:/root/.config/gcloud hashicorp/terraform:latest`.

```bash
cd infrastructure/cloudflare/ai-trading
python3 ../../secrets/env-bundle.py exec ai-trading cloudflare -- \
  terraform init -backend-config="bucket=tobytran-portfolio-tfstate"
python3 ../../secrets/env-bundle.py exec ai-trading cloudflare -- terraform plan -out=tfplan
python3 ../../secrets/env-bundle.py exec ai-trading cloudflare -- terraform apply -auto-approve tfplan
rm -f tfplan
```

`env-bundle.py exec` adds `CLOUDFLARE_API_TOKEN` and `TF_VAR_cloudflare_account_id`, `TF_VAR_access_allowed_emails` from the `[cloudflare]` section of `ai-trading-env-bundle` to the environment. Apply `infrastructure/cloudflare/zero-trust` first; this root's `terraform_remote_state` data source reads its `one_time_pin_idp_id` output.

After the first apply, fetch the tunnel token for local/manual use from the Cloudflare API (the deploy workflow does this automatically in `render-env.sh`):

```bash
TUNNEL_ID="$(terraform output -raw tunnel_id)"
curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$TF_VAR_cloudflare_account_id/cfd_tunnel/$TUNNEL_ID/token" \
  | jq -r '.result'
```
