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
| `restore.sh` | Operator-run restore onto an empty destination. Ships in the same pinned image as `backup.sh` (same `pg_restore`/`age`/`gcloud`), invoked with `--entrypoint restore.sh`. |
| `test-backup.sh` | **Fast, Docker-free.** Wired into `pnpm ci:test` via `check:vps-backup-infrastructure`. |
| `test-backup-docker.sh` | **Slow, Docker.** Full dump→encrypt→upload→decrypt round trip against a disposable PostgreSQL 17 + fake-GCS. Not wired into CI. Run manually (below). |
| `test-restore.sh` | **Slow, Docker.** End-to-end seeded-source → empty-destination restore proof (full backup + one ordered daily delta). Not wired into CI. Run manually (below). |
| `family-app-backup.service` / `.timer` / `family-app-backup-retry.service` | Task 6 systemd units. Installed by `infrastructure/vps/steps/40-backup.sh` (opt-in `bootstrap.sh --only backup`). |
| `check-backup-freshness.sh` | Local health command: fails when the latest successful backup is ≥24h old. Fast, Docker-free; wired into CI via `check:vps-backup-infrastructure`. |
| `test-systemd-units.sh` | Fast, Docker-free static checks on the three unit files above (timer cadence, runtime deadlines, retry bounds, read-only/tmpfs run contract, no literal secrets). Wired into CI. |
| `test-check-backup-freshness.sh` | Fast, Docker-free checks for `check-backup-freshness.sh`. Wired into CI. |

See also [`../vps/README.md`](../vps/README.md) "Backup (opt-in)" for how
`40-backup.sh` installs these units onto a real VPS, and
[`../../.github/workflows/family-backup-freshness.yml`](../../.github/workflows/family-backup-freshness.yml)
for the hourly off-host staleness check (18h warn / 22h page / 24h RPO
breach), which authenticates as Task 1's separate, list-only
freshness-monitor identity -- never the VPS writer, and never able to read
backup content.

## `restore.sh` environment contract

```text
PGHOST / PGPORT / PGUSER / PGPASSWORD_FILE   Destination (empty/disposable) cluster admin connection
RESTORE_AGE_IDENTITY_FILE                     Private age identity FILE PATH -- never a default location, never key content in an env var
RESTORE_GOOGLE_APPLICATION_CREDENTIALS        Operator's temporary, read-capable GCS credentials
RESTORE_OBJECT_URI                            gs://bucket/.../*.tar.age -- the monthly FULL set to restore
RESTORE_WORK_DIR                              Fresh (must not already contain files), mode-0700 scratch directory
RECEIPT_RESTORE_DIR                           Destination receipt volume directory

RESTORE_DAILY_OBJECT_URIS     Optional comma list of daily delta object URIs, in order, applied after the full
RESTORE_EXPECTED_GENERATION   Optional: pin the full object's expected GCS generation (defense against a stale/wrong URI)
RESTORE_CONFIRM_DESTRUCTIVE   Must be exactly "yes-destroy-existing-data" to proceed if the destination already holds
                               any non-template database or any receipt file
```

Refuses to run against a non-empty destination without the destructive
confirmation flag; decrypts only with an explicitly supplied identity file;
validates every checksum (via the same `manifest.schema.json` contract
`backup.sh` writes against) before touching destination state; and ends
with a machine-readable `{"status":"restored", databases:[...], ...}`
report after independently re-verifying every restored database's row
count and every restored receipt's checksum.

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
- **The single-flight `flock` lives inside `backup.sh` itself, not in the
  systemd unit.** A unit-level lock could not see (and therefore could not
  reject) a concurrent manual `docker run ... backup.sh` invocation
  outside systemd; `acquire_single_flight_lock()` operates on a file
  inside the persistent, shared `$BACKUP_STATE_DIR`, so it works
  identically regardless of what started the container. Cost if wrong: a
  redundant systemd-level lock would still need to exist anyway to cover
  the non-systemd invocation path, so it would be pure duplication, not an
  additional safety margin.
- **`flock` contention is skipped (not faked) on non-Linux dev machines.**
  `flock(1)` is util-linux; it is not present on stock macOS. Production
  and CI (GitHub Actions `ubuntu-latest`) are both Linux, where it is
  always present — verified directly against the pinned backup image and a
  stock `debian:bookworm-slim` container during this implementation. Cost
  if wrong: a lock regression would surface only in CI/Docker, never
  silently on a contributor's Mac.
