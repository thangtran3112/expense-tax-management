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
