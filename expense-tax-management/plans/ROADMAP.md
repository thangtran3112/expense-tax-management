# Infrastructure and Deployment Roadmap

> **Status:** Private production deployment live. Backup/restore tooling is implemented and proven against disposable local Docker infrastructure (see "Backup and Restore -- Observed Results" below); it has not yet been applied to or run against the live VPS/GCP. Provider migration remains unimplemented.
> **Last updated:** 2026-10-03
> **Companion:** See [PLAN.md](PLAN.md) for feature order and active implementation plans.

## Current Production Topology

```text
Internet
  -> Cloudflare free-tier DNS/Tunnel
  -> cloudflared on OVH VPS
  -> loopback-only application origins
       - Capture Web
       - Office Web
       - Foundry Web
       - App API
       - Foundry Service

VPS private runtime
  - PostgreSQL 17 + pgvector
  - Temporal
  - Python AI worker
  - six immutable application images deployed by GitHub Actions

GCP
  - Secret Manager production environment bundle
  - GitHub OIDC/WIF identities
  - Cloudflare Terraform state bucket
```

## Completed Infrastructure

- VPS SSH hardening, UFW policy, Docker, and reusable bootstrap scripts.
- Private production Compose deployment under `expense-tax-management/deploy/production/`.
- GitHub Actions immutable-image build, migration, health check, rollback, and deployment workflow.
- Cloudflare Tunnel with explicit product host/path routing and no public VPS application ports.
- Clerk DNS, SPF/DKIM, DMARC monitoring, signed webhook delivery, and authenticated smoke verification.
- Application-origin body limits, bounded process-local rate limits, security headers, and fail-closed route policy.
- Protected `dev` development branch; production deployment remains restricted to successful `main` CI.

## Current Sources of Truth

| Concern | Path |
|---|---|
| Production deployment workflow | `.github/workflows/expense-tax-deploy.yml` |
| Production Compose and scripts | `expense-tax-management/deploy/production/` |
| Cloudflare Tunnel/DNS Terraform | `infrastructure/cloudflare/expense-tax/` |
| VPS base provisioning | `infrastructure/vps/` |
| Local shared services | `infrastructure/docker-compose.common.yml` |
| App-local development overlay | `expense-tax-management/docker-compose.yml` |

`infrastructure/docker-compose.common.yml`, its Nginx gateway, `expense-service/`, and `frontend/web/` are local/transitional surfaces. They are not the current production edge or canonical application services.

## Remaining Infrastructure Work

| Work | Status | Trigger/owner |
|---|---|---|
| Automated PostgreSQL backup to GCS | Built; proven locally (see below). Task 1 Terraform never applied; no live writer key/VPS install yet | Operator: apply Task 1, create writer key, `bootstrap.sh --only backup` |
| Restore verification and recovery drill | Built; proven locally (see below) against disposable PostgreSQL + real `age` encryption. Never run against real GCS/VPS/Cloudflare | Operator: first live monthly drill after the above |
| Production GCS receipt-storage adapter and credentials | Not built; local storage adapter only | Separate storage/infrastructure plan |
| VPS provider migration runbook automation | Partial base bootstrap only | Required before OVH term ends in Feb 2027 |
| Shared-cluster `30-postgres.sh` live proof | Designed, not run on current box | Fresh VPS or second family app |
| Phase 3D mailbox broker Cloud Run project | Planned | Phase 3D-A after Phase 3C |
| Gmail OAuth production verification | Planned with Phase 3D | Start during mailbox implementation; external review may take weeks |
| Search/graph production infrastructure | Deferred | Replan with Phases 6 and 9 |
| Cloud Run deployment for web frontends | Not current architecture | Separate migration/cost decision only |

## Cost and Security Policy

- Keep VPS stateful/orchestration services always-on; no always-on GCP compute.
- Scale-to-zero Cloud Run is allowed only when an approved phase requires it; Phase 3D broker uses `min-instances=0`.
- Cloudflare use stays on free Tunnel/DNS/proxy controls. Paid WAF, distributed rate limiting, Workers, Access, or Cloud Armor requires explicit cost approval.
- Production secrets stay in Secret Manager. Exactly one non-destroyed environment-bundle version remains after rotation.
- PostgreSQL superuser credentials never enter GitHub or GCP.
- VPS origins stay loopback-only. Cloudflare Tunnel is the public ingress path.
- No production mutation, Terraform apply, GCP/Clerk write, workflow dispatch, push, PR creation, or merge without immediate explicit confirmation.

## Backup and Restore -- Observed Results (2026-10-03)

Full design: [`vps-backup-and-restore.md`](sub-plans/vps-backup-and-restore.md).
Tasks 2-7 implemented and locally verified; Task 1 (Terraform) offline-validated
only; Task 6/8's live-VPS and real-Cloudflare steps remain operator-only.
Observed, not planned:

- **Dump (Task 3):** against a disposable PostgreSQL 17 container seeded
  with 5 representative databases (app, foundry, temporal,
  temporal_visibility, mailbox), `pg_dumpall --globals-only` +
  `pg_dump --format=custom` for each, each re-validated with a fresh
  `pg_restore --list`. A forced mid-dump failure (invalid role) left a
  pre-seeded success marker byte-identical.
- **Receipts and manifest (Task 4):** against real seeded receipt files,
  observed correct behavior for first-run full (2 files), same-month
  daily delta (exactly the 1 new file, correct parent-id chaining),
  unchanged-window (0 files, still a valid archive), new-calendar-month
  full (re-archives all 3 files), and a future-mtime receipt correctly
  deferred to the next run.
- **Encrypt and upload (Task 5):** a temporary `age` identity generated
  with real `age-keygen`; the full pipeline run end to end against a
  directory-backed fake GCS transport enforcing the real
  creation-only-upload precondition; the uploaded ciphertext decrypted
  with the matching private identity and every manifest-referenced
  checksum (globals, each database dump, the receipts archive) verified
  against the decrypted bytes.
- **Restore (Task 7):** a 5-database seeded SOURCE backed up (full + one
  daily delta), restored onto a completely empty DESTINATION PostgreSQL
  17 + empty receipt directory. Observed: restore refuses a non-empty
  destination without explicit confirmation; after restoring, all 5
  databases report the correct row count; both the full and daily
  receipt files are present with correct bytes; the final
  `{"status":"restored",...}` report matches every restored database.
- **Recovery drill orchestration (Task 8):** `recovery-drill.sh` proven,
  with fake deploy/health-check/smoke-test commands standing in for real
  product infrastructure, in four scenarios: full pass; a failing
  health-check fails the drill; exceeding the RTO deadline fails the
  drill even when every individual step passed; a
  restored-vs-supported schema-migration-version mismatch is reported
  and migrations are skipped without itself failing the drill.
- **Not yet observed (operator-only, out of this pass's scope):** Task 1's
  Terraform applied against real GCP; a real writer service-account key
  created and placed in Secret Manager; `bootstrap.sh --only backup` run
  against the live VPS; a monthly drill against the real bucket/VPS; any
  Cloudflare cutover simulation or rollback; real authenticated product
  smoke tests. Proven RPO/RTO numbers above come from disposable local
  infrastructure, not the live system.

## VPS Provider Switch

OVH availability ends in February 2027. Before migration:

1. Implement and test backup/restore against disposable infrastructure.
2. Select replacement provider and provision reachable Ubuntu host manually.
3. Run `infrastructure/vps/bootstrap.sh` through the provider-specific first-access bridge.
4. Restore PostgreSQL and validate role/schema ownership.
5. Deploy current immutable images with production Compose.
6. Install Cloudflare Tunnel connector and switch ingress only after health checks pass.
7. Monitor for 24 hours before decommissioning old host.

Target cutover remains under two hours after backup/restore automation is proven. Current scripts alone do not meet that target yet.
