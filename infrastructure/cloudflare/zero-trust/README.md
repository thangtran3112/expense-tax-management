# Cloudflare Zero Trust (account-wide)

Terraform for the account-wide Zero Trust organization and the one-time PIN login method. Shared by `ai-trading` and (going forward) any other app on this Cloudflare account. The expense-tax tunnel, DNS, and Access application stay in `infrastructure/cloudflare/expense-tax/`; the ai-trading tunnel, DNS, and Access application stay in `infrastructure/cloudflare/ai-trading/`, which reads `one_time_pin_idp_id` from this root's state.

State: bucket `tobytran-portfolio-tfstate`, prefix `cloudflare/zero-trust`.

## Token policy

Use the single shared `CLOUDFLARE_AGENT_API_TOKEN` token described in `ai-trading/AGENTS.md`. Never create a narrower token for this root. If Cloudflare refuses a call because the token lacks a permission, broaden it in the dashboard with the user; never restrict it.

## Organization resource: create vs. adopt

`cloudflare_zero_trust_organization` is an account-wide singleton. In provider `cloudflare/cloudflare` 5.26.0 (the version `terraform init` locks under the `>= 5.8.2, < 6.0.0` constraint), the resource's `Create` and `Update` actions both call the same `ZeroTrust.Organizations.Update` API method (a PUT to `accounts/{account_id}/access/organizations`); `Delete` is a no-op that only drops Terraform state. There is no separate "create new organization" call. This means:

- If the account has no Zero Trust organization yet (Access not enabled), `terraform apply` enables it with this config.
- If one already exists, `terraform apply` adopts and updates it in place; nothing needs to be imported first.
- `terraform destroy` removes the resource from state only; it does not disable Access on the account.

As of this plan, the Cloudflare account has Access not enabled yet (the API returns "Access is not enabled"), so the first apply here is expected to be the account's first enablement.

## Apply order

Apply this root before `infrastructure/cloudflare/ai-trading`; the ai-trading root reads `one_time_pin_idp_id` from this root's state via `terraform_remote_state`.

## Local apply

```bash
cd infrastructure/cloudflare/zero-trust
python3 ../../secrets/env-bundle.py exec ai-trading cloudflare -- \
  terraform init -backend-config="bucket=tobytran-portfolio-tfstate"
python3 ../../secrets/env-bundle.py exec ai-trading cloudflare -- terraform plan -out=tfplan
python3 ../../secrets/env-bundle.py exec ai-trading cloudflare -- terraform apply -auto-approve tfplan
rm -f tfplan
```

`env-bundle.py exec` adds `CLOUDFLARE_API_TOKEN` and `TF_VAR_cloudflare_account_id` from the `[cloudflare]` section of `ai-trading-env-bundle` to the environment; the provider reads `CLOUDFLARE_API_TOKEN` directly, so no Terraform variable holds the token.
