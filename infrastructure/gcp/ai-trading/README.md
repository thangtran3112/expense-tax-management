# ai-trading GCP Identity

Terraform for ai-trading's Secret Manager bundle (`ai-trading-env-bundle`)
and the two GitHub OIDC / workload identity setups the workflows assume:
`ai-trading-deploy` (used by `.github/workflows/ai-trading-deploy.yml`) and
`ai-trading-terraform` (used by `.github/workflows/ai-trading-infra.yml`).
State lives in `gs://tobytran-portfolio-tfstate` under prefix
`gcp/ai-trading`.

| Resource | Purpose |
|---|---|
| `google_secret_manager_secret.env_bundle` | `ai-trading-env-bundle`, labels `app=ai-trading`, `versioning=single`. |
| `google_iam_workload_identity_pool.deploy` + provider `github` | Trusts `ai-trading-deploy.yml` on `refs/heads/main`, environment `ai-trading-production`. |
| `google_iam_workload_identity_pool.terraform` + provider `github` | Trusts `ai-trading-infra.yml` on `refs/heads/main`, environment `ai-trading-production`. |
| `google_service_account.deploy` | `roles/secretmanager.secretAccessor` on `ai-trading-env-bundle` and on `expense-tax-env-files` (the reused OVH SSH key). |
| `google_service_account.terraform` | `roles/secretmanager.secretAccessor` on `ai-trading-env-bundle`; `roles/storage.objectAdmin` on the state bucket. |

Each provider's `attribute_condition` requires the exact repository
(`thangtran3112/family-app`), `refs/heads/main`, the exact `workflow_ref`
(`<repo>/.github/workflows/<file>@refs/heads/main`), and environment
`ai-trading-production` -- the same shape as
`expense-tax-management/infrastructure/gcp/expense-tax/bootstrap-cloudflare.sh`.

## Apply order

This is the first root applied (see the plan's Task 12): the Cloudflare
roots and the deploy/infra workflows depend on the secret and identities it
creates.

## First apply (operator machine)

```bash
cd infrastructure/gcp/ai-trading
CLOUDSDK_ACTIVE_CONFIG_NAME=personal gcloud auth application-default print-access-token \
  >/dev/null 2>&1 || true  # confirms ADC status; does not need to succeed

terraform init -backend-config="bucket=tobytran-portfolio-tfstate"
terraform plan -out=tfplan
terraform apply tfplan
rm -f tfplan
```

With no Application Default Credentials configured, pass an access token
explicitly for both the provider and the backend:

```bash
export GOOGLE_OAUTH_ACCESS_TOKEN="$(CLOUDSDK_ACTIVE_CONFIG_NAME=personal gcloud auth print-access-token)"
terraform init -backend-config="bucket=tobytran-portfolio-tfstate"
terraform plan -out=tfplan
terraform apply tfplan
rm -f tfplan
```

`GOOGLE_OAUTH_ACCESS_TOKEN` is read by both the `google` provider and the
`gcs` backend; no Terraform variable or file ever holds a credential.

## After applying

Pull the first bundle, fill in `[deploy]` and `[cloudflare]`, then `push`
(see `infrastructure/secrets/README.md`) before applying
`infrastructure/cloudflare/zero-trust` and
`infrastructure/cloudflare/ai-trading`, which read `CLOUDFLARE_API_TOKEN`
through `env-bundle.py exec`.
