# ai-trading GCP Identity

Terraform for the two GitHub OIDC / workload identity setups the workflows
assume: `ai-trading-deploy` (used by `.github/workflows/ai-trading-deploy.yml`)
and `ai-trading-terraform` (used by `.github/workflows/ai-trading-infra.yml`).
State lives in `gs://tobytran-portfolio-tfstate` under prefix
`gcp/ai-trading`.

Every ai-trading secret and environment value now lives in the shared
Firestore `family-config` database (`common/config/README.md`,
`ai-trading/AGENTS.md`), read through `common/config/family_config.py`. This
root still declares the superseded Secret Manager bundle
(`google_secret_manager_secret.env_bundle`, secret id `ai-trading-env-bundle`,
one retained version) and its two IAM bindings below — **not deleted** —
until an operator explicitly approves cleanup; no current code reads it.

| Resource | Purpose |
|---|---|
| `google_secret_manager_secret.env_bundle` | `ai-trading-env-bundle`, labels `app=ai-trading`, `versioning=single`. |
| `google_iam_workload_identity_pool.deploy` + provider `github` | Trusts `ai-trading-deploy.yml` on `refs/heads/main`, environment `ai-trading-production`. |
| `google_iam_workload_identity_pool.terraform` + provider `github` | Trusts `ai-trading-infra.yml` on `refs/heads/main`, environment `ai-trading-production`. |
| `google_service_account.deploy` | `roles/secretmanager.secretAccessor` on `ai-trading-env-bundle` (retained, unused by current code); deploy SSH key comes from Firestore `shared/vps`, not the expense-tax secret. |
| `google_service_account.terraform` | `roles/secretmanager.secretAccessor` on `ai-trading-env-bundle` (retained, unused by current code); `roles/storage.objectAdmin` on the state bucket. |
| `google_project_iam_member.deploy_family_config_viewer` / `terraform_family_config_viewer` | Additive: `roles/datastore.viewer` (project-wide, read-only) on both service accounts, so CI can read the shared Firestore `family-config` database instead of the bundle above. Declared in this same root's Terraform, applied by the same full-root `terraform apply` as every other resource here (see "First apply" below) — no separate or targeted apply. Until an operator reviews and applies it, `.github/workflows/ai-trading-{deploy,infra}.yml`'s Firestore reads fail with a permission error. |

Each provider's `attribute_condition` requires the exact repository
(`thangtran3112/family-app`), `refs/heads/main`, the exact `workflow_ref`
(`<repo>/.github/workflows/<file>@refs/heads/main`), and environment
`ai-trading-production` -- the same shape as
`expense-tax-management/infrastructure/gcp/expense-tax/bootstrap-cloudflare.sh`.

## Apply order

This is the first root applied (see the plan's Task 12): the Cloudflare
roots and the deploy/infra workflows depend on the identities it creates
(not the Secret Manager secret — current code reads Firestore `family-config`
instead; see the intro above).

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

This one full-root apply also adds the two `roles/datastore.viewer` grants;
there is no separate apply for them. If this root was applied before the
static buckets were added, expect both viewer grants **and** the bucket/uploader
resources in the plan. Review all changes before applying; the retained Secret
Manager resource and its existing bindings must not be replaced or destroyed.
Apply before any push to
`main` that would trigger `ai-trading-deploy.yml`/`ai-trading-infra.yml` —
their Firestore reads fail with a permission error until these grants are
applied. No CI job applies this root automatically; it is always this
operator-machine step.

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

Create the `ai-trading/cloudflare` and `ai-trading/deploy` profiles in
Firestore `family-config` (see `common/config/README.md`). Most of their
values are references to already-shared groups, not new literals — e.g.
`common/config/family_config.py link ai-trading/cloudflare
CLOUDFLARE_API_TOKEN shared/cloudflare` points at the one shared token
instead of copying it. Reserve `set <target> <NAME>` (reading the value from
stdin) for values that really are app-specific literals, such as
`ai-trading/cloudflare`'s `TF_VAR_access_allowed_emails`. Do this before
applying `infrastructure/cloudflare/zero-trust` and
`infrastructure/cloudflare/ai-trading`, which read `CLOUDFLARE_API_TOKEN`
through `common/config/family_config.py run ai-trading/cloudflare --`.
`roles/datastore.viewer` for `ai-trading-deploy` and `ai-trading-terraform`
(the additive resources in the table above) is granted by the "First apply"
step above, not by anything here — those two service accounts cannot read
Firestore until that root is applied; the Secret Manager secret and its two
IAM bindings stay declared and untouched by any of this, either way.
