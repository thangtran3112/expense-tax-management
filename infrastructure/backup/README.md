# VPS Backup and Restore

Encrypted daily PostgreSQL + receipt-volume backups to GCS, and the tooling to
restore them onto a disposable host. Full design and task list:
[`vps-backup-and-restore.md`](../../expense-tax-management/plans/sub-plans/vps-backup-and-restore.md).
Architecture context: [`ARCHITECTURE.md`](../../expense-tax-management/plans/ARCHITECTURE.md)
("Backup and Recovery", "Secrets and OAuth Tokens").

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Pinned (by digest) one-shot backup image: PostgreSQL 17 client tools, `age`, `gcloud`/`gsutil`, `jq`, `tar`, `sha256sum`, `flock`. |
| `lib.sh` | Shared validation/logging/status-JSON/locking helpers. Sourced only. |
| `backup.sh` | Entrypoint: preflight → dump → receipt capture → manifest → encrypt → upload. |
| `manifest.schema.json` | Documented contract for `manifest.json` (hand-checked by `backup.sh`/tests; see Ruling below). |
| `restore.sh` | Operator-run restore onto an empty destination. |
| `test-backup.sh` | **Fast, Docker-free.** Wired into `pnpm ci:test` via `check:vps-backup-infrastructure`. |
| `test-backup-docker.sh` | **Slow, Docker.** Full dump→encrypt→upload→decrypt round trip against a disposable PostgreSQL 17 + fake-GCS. Not wired into CI. Run manually (below). |
| `test-restore.sh` | **Slow, Docker.** End-to-end seeded-source → empty-destination restore proof. Not wired into CI. Run manually (below). |

## Environment contract

```text
PGHOST                         PostgreSQL host (the shared cluster's container/service name)
PGPORT                         PostgreSQL port
PGUSER                         Admin role used for pg_dumpall/pg_dump/pg_restore --list
PGPASSWORD_FILE                Path to a mode-0400 file holding the admin password
BACKUP_GCS_URI                 gs://bucket[/prefix] — validated, no path traversal, lowercase bucket
BACKUP_HOST_ID                 Stable identifier embedded in object names and status
AGE_RECIPIENT                  age1... public recipient; the matching private key never runs on the VPS
RECEIPT_STORAGE_DIR            Read-only mount of the receipt volume
BACKUP_STATE_DIR               Persistent small volume: last-success marker + single-flight lock
BACKUP_CIPHERTEXT_DIR          Persistent small volume: ciphertext partials/finals only, never plaintext
GOOGLE_APPLICATION_CREDENTIALS Path to the writer service account key (object-creator only)
```

Optional:

```text
BACKUP_STAGING_DIR             Plaintext staging root, must be tmpfs at run time (default /staging)
BACKUP_IMAGE_TAGS              Comma list recorded in manifest.json (e.g. "app-api=sha-abc,...")
BACKUP_MIGRATION_VERSIONS      Comma list recorded in manifest.json (e.g. "app=0042,foundry=0017")
BACKUP_COMPOSE_FILE            Path checksummed into manifest.json; omitted field if unset
BACKUP_PREFLIGHT_ONLY          Test hook: stop after preflight checks, used only by test-backup.sh
```

## Container run contract (Task 2)

The container's root filesystem is mounted `--read-only`. `/staging` (or
`$BACKUP_STAGING_DIR`) is a size-bounded `tmpfs` — the only place plaintext
dumps, receipt archives, or manifests are ever written. `RECEIPT_STORAGE_DIR`
is mounted read-only. `PGPASSWORD_FILE` and `GOOGLE_APPLICATION_CREDENTIALS`
are mounted mode `0400`. See `deploy/production/docker-compose.yml`'s
`backup` profile for the exact `docker compose run` shape used in production.

## Running the tests

```bash
# Fast, no Docker, no real age/gcloud/postgres (same as CI):
bash infrastructure/backup/test-backup.sh

# Slow, Docker: disposable PostgreSQL 17 + fake-GCS directory + real age round trip.
bash infrastructure/backup/test-backup-docker.sh

# Slow, Docker: full backup -> restore proof onto an empty destination.
bash infrastructure/backup/test-restore.sh

# ShellCheck (pinned image, no local install):
docker run --rm -v "$PWD/infrastructure/backup:/mnt:ro" koalaman/shellcheck:stable \
  /mnt/lib.sh /mnt/backup.sh /mnt/test-backup.sh /mnt/restore.sh /mnt/test-restore.sh
```

## Rulings

- **Paths are relative to the monorepo root `infrastructure/`, not
  `expense-tax-management/infrastructure/`.** `infrastructure/README.md`
  already states shared Temporal and VPS bootstrap live at the monorepo
  root, and backup must cover every database in the one shared cluster
  (App, Foundry, Temporal, visibility, future projects) — a
  per-application `infrastructure/` directory cannot express that. Cost if
  wrong: a second, app-scoped backup tree that cannot reach the other
  apps' databases.
- **No `ajv`/JSON-Schema-library dependency was added.** `manifest.schema.json`
  is the documented contract; `backup.sh`/tests hand-check the required
  keys, types, and enums it describes. `ajv` is only reachable today as an
  undeclared transitive dependency of other tooling, and depending on a
  transitive package's hoisting is itself a latent breakage. Cost if wrong:
  a manifest shape drifts from the schema file without a hard failure —
  mitigated by `manifest.schema.json` staying hand-readable and the
  hand-checks covering every field it declares.
- **A run's receipt mode doubles as its upload retention tier.** `full`
  receipt backups (complete, self-sufficient snapshots) upload under
  `monthly/YYYY/MM/` (365-day retention, Task 1); `daily` deltas (which
  depend on the full backup they diff against) upload under
  `daily/YYYY/MM/DD/` (30-day retention). This reuses one classification
  instead of introducing a second, independent one. Cost if wrong: a daily
  delta could outlive the full backup it depends on; both prefixes'
  lifecycle rules live in the same Task 1 Terraform and can be re-tuned
  together.
- **`flock` contention is skipped (not faked) on non-Linux dev machines.**
  `flock(1)` is util-linux; it is not present on stock macOS. Production
  and CI (GitHub Actions `ubuntu-latest`) are both Linux, where it is
  always present — verified directly against the pinned backup image and a
  stock `debian:bookworm-slim` container during this implementation. Cost
  if wrong: a lock regression would surface only in CI/Docker, never
  silently on a contributor's Mac.
