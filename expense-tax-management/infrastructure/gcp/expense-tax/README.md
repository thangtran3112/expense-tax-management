# Expense Tax GCP Project Bootstrap

`bootstrap.sh` creates and validates the Expense Tax production GCP project
(organization, billing, APIs) and the GitHub workload identity pool. It runs from
`expense-tax-management` and reuses existing resources, so it is safe to re-run.

## Fixed resources

- Project: `expense-tax-tobytran-2026` (organization `177410718350`)
- Billing account: `013C6D-EEE26E-EAA1A1`
- Workload identity pool: `expense-tax-github`. Its only provider, `cloudflare`,
  and the `expense-tax-cf-terraform` service account come from
  `bootstrap-cloudflare.sh`; the Cloudflare Terraform workflow uses them.
- Legacy secret `expense-tax-production-env`: disabled on 2026-10-05. Nothing
  reads it.

The GitHub deploy identity (provider `github`, service account
`expense-tax-github-deploy`) was removed on 2026-10-05. Production deploys no
longer authenticate to GCP; the VPS loads its env from Firestore `family-config`
(see `common/config/README.md`).

## Bootstrap

```bash
cd expense-tax-management
./infrastructure/gcp/expense-tax/bootstrap.sh
```

## Verification

```bash
pnpm check:cloudflare-infrastructure
```

These checks do not contact GCP.
