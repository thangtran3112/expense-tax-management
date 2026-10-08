# Cloudflare Zero Trust (account-wide)

Terraform for an account-wide Zero Trust organization and one-time PIN login, **deferred** for ai-trading Release 1. The ai-trading tunnel/Worker root no longer depends on this root; Caddy/Clerk enforces authentication. No resources from this root were recorded in Terraform state after the failed 2026-10-07 apply. Keep this code for a separately approved future Access initiative.

State: bucket `tobytran-portfolio-tfstate`, prefix `cloudflare/zero-trust`.

## Token policy

Use the single shared `shared/cloudflare` `CLOUDFLARE_API_TOKEN` described in `ai-trading/AGENTS.md`. Never create a narrower token for this root. If Cloudflare refuses a call because the token lacks a permission, broaden it in the dashboard with the user; never restrict it.

## Organization resource: create vs. adopt

`cloudflare_zero_trust_organization` is an account-wide singleton. In provider `cloudflare/cloudflare` 5.26.0, its Create and Update actions both call `ZeroTrust.Organizations.Update` (PUT); `terraform destroy` removes it from state but does not disable Access. An attempted first apply returned HTTP 403 for the organization update and "Access is not enabled" for the PIN provider. Cloudflare's current setup requires dashboard onboarding with payment details even on the Free plan, then a token with `Access: Organizations, Identity Providers, and Groups Write`. Manual activation would be a new exception to ai-trading's IaC-only rule: do **not** retry, enable Access in the dashboard, or broaden the shared token without a separate owner-approved plan.

## Apply order

Not in the Release 1 apply order. `infrastructure/cloudflare/ai-trading` needs only GCP identities/static buckets and its own Firestore profile.

## Future-only local apply (not for Release 1)

```bash
cd infrastructure/cloudflare/zero-trust
CLI=../../../common/config/family_config.py
$CLI run ai-trading/cloudflare -- \
  terraform init -backend-config="bucket=tobytran-portfolio-tfstate"
$CLI run ai-trading/cloudflare -- terraform plan -out=tfplan
$CLI run ai-trading/cloudflare -- terraform apply -auto-approve tfplan
rm -f tfplan
```

`family_config.py run` adds `CLOUDFLARE_API_TOKEN` and `TF_VAR_cloudflare_account_id` from the `ai-trading/cloudflare` Firestore profile to the environment; the provider reads `CLOUDFLARE_API_TOKEN` directly, so no Terraform variable holds the token.
