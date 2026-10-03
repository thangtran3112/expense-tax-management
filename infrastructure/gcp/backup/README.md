# Backup Bucket and Identities (Task 1)

Terraform for the dedicated GCS backup bucket and its two identities. Full
design: [`vps-backup-and-restore.md`](../../expense-tax-management/plans/sub-plans/vps-backup-and-restore.md) Task 1.

**This directory's Terraform is never applied by an agent.** Only
`terraform fmt -check`, `terraform init -backend=false`, `terraform
validate`, and `test-policy.sh` run automatically; `terraform plan`/`apply`
require a human operator with explicit approval, run from their own
machine with real GCP credentials.

## What this provisions

- One bucket (`google_storage_bucket.backup`): uniform bucket-level access,
  enforced public-access prevention, versioning, a **locked** 7-day
  retention policy, and two lifecycle rules (`daily/` expires at 30 days,
  `monthly/` at 365 days).
- A **writer** identity (`backup_writer`) with `roles/storage.objectCreator`
  on this bucket only -- it can create objects; it cannot read, replace,
  list, or delete them.
- A **freshness-monitor** identity (`backup_freshness_monitor`), entirely
  separate from the writer, authenticated via its own GitHub Actions
  OIDC/WIF provider (reusing the existing `expense-tax-github` pool from
  `expense-tax-management/infrastructure/gcp/expense-tax/bootstrap.sh`,
  but with its own attribute-condition-scoped provider -- that pool's
  existing `github` provider is hard-scoped to the deploy workflow and
  would reject this one's tokens). It holds a custom, list-only IAM role
  (`storage.objects.list` only -- explicitly **not**
  `storage.objects.get`), so it can check "does a recent object exist"
  without ever being able to read or download backup content.

## What this deliberately does NOT provision

- **No writer key.** `google_service_account_key` never appears in this
  module (enforced by `test-policy.sh`). The writer's private key is
  created once, by hand, and never touches Terraform state:

  ```bash
  gcloud iam service-accounts keys create /tmp/backup-writer-key.json \
    --iam-account=expense-tax-backup-writer@expense-tax-tobytran-2026.iam.gserviceaccount.com
  # Transfer the JSON content into the shared-infrastructure Secret Manager
  # bundle (see ARCHITECTURE.md "Secrets and OAuth Tokens"), then:
  shred -u /tmp/backup-writer-key.json   # or `rm -P` on macOS
  ```

  VPS bootstrap (Task 6) installs that bundle's key as a root-only,
  mode-0400 file -- it is never re-derived from Terraform.

- **No persistent VPS-side reader key.** Restore does not use a
  long-lived "reader" service account key kept anywhere. Instead, an
  operator temporarily grants their own restore identity object-level read
  access immediately before a restore drill, and revokes it immediately
  after:

  ```bash
  # Before restoring (operator's own gcloud user, or a short-lived SA):
  gcloud storage buckets add-iam-policy-binding gs://expense-tax-tobytran-2026-backups \
    --member="user:operator@example.com" --role="roles/storage.objectViewer" \
    --condition=None

  # restore.sh runs with that operator's ADC/credentials as
  # RESTORE_GOOGLE_APPLICATION_CREDENTIALS (see infrastructure/backup/README.md)

  # Immediately after:
  gcloud storage buckets remove-iam-policy-binding gs://expense-tax-tobytran-2026-backups \
    --member="user:operator@example.com" --role="roles/storage.objectViewer"
  ```

  This keeps "who can currently read backup content" at zero outside an
  active, deliberate restore window.

## Commands actually run (by this implementation, and by CI)

```bash
docker run --rm -v "$PWD:/work" -w /work hashicorp/terraform:1.9 fmt -check
docker run --rm -v "$PWD:/work" -w /work hashicorp/terraform:1.9 init -backend=false
docker run --rm -v "$PWD:/work" -w /work hashicorp/terraform:1.9 validate
bash test-policy.sh
```

`terraform` is not installed on every contributor machine; the pinned
`hashicorp/terraform:1.9` image is used instead of a global install, per
this repo's tooling policy.
