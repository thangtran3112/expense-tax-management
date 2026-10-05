# Expense Tax GCP Bootstrap

The bootstrap script provisions the GCP identity that GitHub Actions uses for Expense
Tax. It runs from `expense-tax-management`, never creates service-account keys, and
never puts secret payloads in command arguments or logs.

## Fixed resources

- Project: `expense-tax-tobytran-2026`
- Billing account: `013C6D-EEE26E-EAA1A1`
- GitHub repository condition: `thangtran3112/family-app`
- Deploy service account: `expense-tax-github-deploy`
- WIF pool/provider: `expense-tax-github/github`
- Legacy secret: `expense-tax-production-env`. The last deploy path that reads it is
  the one on `main` before the family-config release. It is disabled after that
  release ships.

## Bootstrap

Prerequisites: authenticated `gcloud`, billing access, Node.js 22+, and a local
checkout. Existing resources are reported as no-op and reused.

```bash
cd expense-tax-management
gcloud auth list
./infrastructure/gcp/expense-tax/bootstrap.sh > /tmp/expense-tax-bootstrap-outputs.json
```

Bootstrap prints machine-readable identity metadata to stdout (or to the file
named by its first argument). The metadata contains no secret payload and belongs
in Firestore `family-config` (`expense-tax-management/ops`), not in the
repository. Existing WIF provider metadata and project placement/billing are
validated for exact issuer, attribute mapping, repository condition,
organization, and billing account; drift aborts bootstrap. Service-account
impersonation uses the official repository attribute `principalSet` binding.
Provider admission further restricts tokens to `main`, the deploy or Cloudflare
workflow, and the `production` environment.

## Production env

Production env lives in Firestore `family-config`, profile
`expense-tax-management/production` (project `tobytran-portfolio`). The VPS
loads it at deploy time through `common/config/family_config.py`. See
`common/config/README.md`.

## Verification

```bash
node scripts/check-phase-1b-infrastructure.mjs
```

These checks do not contact GCP, read local secret files, or print secret values.
