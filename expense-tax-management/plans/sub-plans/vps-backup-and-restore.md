# VPS Backup and Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce encrypted daily PostgreSQL and receipt backups in GCS and prove restoration onto a disposable VPS within the recovery target.

**Architecture:** A VPS one-shot backup container dumps every non-template database plus PostgreSQL globals, captures immutable receipt files, validates checksums, encrypts with an `age` public recipient, and uploads unique objects with a creator-only GCS identity. Restore uses an operator-held read identity and private `age` key that never reside on the running VPS.

**Tech Stack:** Bash, PostgreSQL 17 client tools, Docker, `age`, GCP Cloud Storage, Terraform, SHA-256

**Spec:** `expense-tax-management/plans/ARCHITECTURE.md`

## Global Constraints

- RPO is at most 24 hours; target RTO is under two hours after drills pass.
- Include all family PostgreSQL databases, globals, receipt files, and deployment manifest.
- Never upload plaintext backup data, environment files, provider keys, or private recovery keys.
- VPS GCS identity can create objects only; it cannot read, replace, or delete them.
- Use unique immutable object names and GCS lifecycle expiration.
- Database dumps precede receipt capture.
- Physical receipt deletion waits beyond backup retention.
- Do not apply Terraform, create credentials, or access production without explicit user approval.

---

### Task 1: Provision Backup Bucket and Identities

**Files:**
- Create: `infrastructure/gcp/backup/main.tf`
- Create: `infrastructure/gcp/backup/variables.tf`
- Create: `infrastructure/gcp/backup/outputs.tf`
- Create: `infrastructure/gcp/backup/README.md`
- Create: `infrastructure/gcp/backup/test-policy.sh`

**Interfaces:**
- Produces: bucket name, writer service account email, read-only freshness-monitor identity, daily/monthly retention policy, and operator restore procedure.

- [ ] Write failing policy checks requiring uniform bucket access, public-access prevention, versioning, seven-day retention lock, `daily/` expiration after 30 days, and `monthly/` expiration after 365 days.
- [ ] Add Terraform for one dedicated backup bucket in the selected US GCP location.
- [ ] Add a writer service account with `roles/storage.objectCreator` on this bucket only.
- [ ] Add a separate GitHub OIDC/WIF freshness-monitor identity with condition-limited object metadata read; never grant read to the VPS writer.
- [ ] Do not create or store a writer key in Terraform state; document explicit operator key creation and Secret Manager transfer.
- [ ] Document restore through an operator identity with temporary object-view access rather than a persistent VPS reader key.
- [ ] Run `terraform fmt -check`, `terraform validate`, and policy tests without applying.

### Task 2: Build Backup Container and Configuration Contract

**Files:**
- Create: `infrastructure/backup/Dockerfile`
- Create: `infrastructure/backup/backup.sh`
- Create: `infrastructure/backup/lib.sh`
- Create: `infrastructure/backup/test-backup.sh`
- Create: `infrastructure/backup/README.md`

**Interfaces:**
- Consumes: PostgreSQL admin connection, receipt volume, `AGE_RECIPIENT`, bucket URI, host ID, and writer credential file.
- Produces: encrypted immutable backup set plus local success marker.

- [x] Write failing tests for missing variables, unsafe bucket URI, invalid age recipient, unavailable PostgreSQL, read-write receipt mount, and plaintext leakage. (fast: test-backup.sh Part B; read-only receipt mount + plaintext-never-on-disk proven via Docker in test-backup-docker.sh/test-backup.sh Part E)
- [x] Build a pinned image containing PostgreSQL 17 client tools, `age`, GCloud storage CLI, `jq`, `tar`, and checksum tools. (Dockerfile, pinned by digest; smoke-tested: pg_dump 17.11, age 1.2.1, gcloud, jq, flock all present)
- [x] Make container root filesystem read-only; mount `/staging` as size-bounded `tmpfs` and keep only status plus encrypted partials on persistent state. (documented run contract in README + deploy/production/docker-compose.yml backup profile, Task 6; verified via docker run --read-only --tmpfs in both Docker test scripts)
- [x] Mount receipt storage read-only and writer credential file mode `0400`. (run contract; exercised read-only in both Docker test scripts)
- [x] Reject secrets passed on command lines or printed by tracing. (PGPASSWORD_FILE/GOOGLE_APPLICATION_CREDENTIALS are paths, never CLI values; no `set -x`; die()/emit_status never echo secret values -- asserted in tests)
- [x] Run shell syntax, ShellCheck, and container configuration tests. (koalaman/shellcheck:stable clean on lib.sh/backup.sh/test-backup.sh/test-backup-docker.sh/restore.sh/test-restore.sh; Dockerfile built and smoke-tested)

Required environment contract:

```text
PGHOST
PGPORT
PGUSER
PGPASSWORD_FILE
BACKUP_GCS_URI
BACKUP_HOST_ID
AGE_RECIPIENT
RECEIPT_STORAGE_DIR
BACKUP_STATE_DIR
BACKUP_CIPHERTEXT_DIR
GOOGLE_APPLICATION_CREDENTIALS
```

### Task 3: Dump and Validate PostgreSQL

**Files:**
- Modify: `infrastructure/backup/backup.sh`
- Modify: `infrastructure/backup/test-backup.sh`

**Interfaces:**
- Produces: `globals.sql`, one custom-format dump per non-template database, and database inventory in `manifest.json`.

- [x] Start disposable PostgreSQL with representative App, Foundry, Temporal, visibility, and mailbox databases. (test-backup-docker.sh: expense_app, expense_foundry, temporal, temporal_visibility, mailbox_broker on a disposable pgvector/pgvector:pg17 container)
- [x] Write failing tests requiring every database and globals dump in the manifest. (test-backup-docker.sh asserts all 5 in database-inventory.json)
- [x] Implement `pg_dumpall --globals-only` and discover databases from `pg_database` while excluding templates. (also excludes the admin-only `postgres` catalog db -- see README Ruling)
- [x] Dump each database with `pg_dump --format=custom --no-owner --no-acl`.
- [x] Validate every dump using `pg_restore --list`; abort before upload on any failure. (re-validated post-hoc with a fresh pg_restore --list in test-backup-docker.sh too)
- [x] Record PostgreSQL version, database names, byte sizes, and SHA-256 checksums.
- [x] Prove a failed dump leaves the prior success marker unchanged. (forced bad-role failure in test-backup-docker.sh; marker byte-identical before/after)

### Task 4: Capture Receipt Files and Deployment Metadata

**Files:**
- Modify: `infrastructure/backup/backup.sh`
- Create: `infrastructure/backup/manifest.schema.json`
- Modify: `infrastructure/backup/test-backup.sh`

**Interfaces:**
- Consumes: confirmed immutable receipt volume and local last-success marker.
- Produces: monthly full receipt archive or daily incremental archive plus image/schema manifest.

- [x] Write failing tests for first-run full backup, first day of month full backup, daily delta, unchanged receipts, and files arriving before, at, and after a frozen run cutoff. (fast: test-backup.sh Part C boundary logic; real: test-backup-docker.sh Task 4 section, all 5 scenarios against real seeded receipt files)
- [x] Create a full receipt archive when no marker exists and on the first successful backup of each month. (determine_mode(); new-calendar-month scenario proven in test-backup-docker.sh)
- [x] Freeze `current_cutoff` immediately after database dumps. Otherwise archive immutable files with server-controlled modification time `> last_successful_cutoff` and `<= current_cutoff`; files arriving later belong to the next run. (select_receipt_files(); boundary scenario with a future-mtime receipt proven in test-backup-docker.sh)
- [x] Record archive mode, parent full-backup ID, receipt paths, checksums, deployed image tags, schema migration versions, and Compose checksum. (build_manifest(); BACKUP_IMAGE_TAGS/BACKUP_MIGRATION_VERSIONS/BACKUP_COMPOSE_FILE env, optional with a null-when-unset fallback for the last)
- [x] Validate manifest against `manifest.schema.json` and verify every archived path/checksum before encryption. (validate_manifest(); hand-checked, not ajv -- see README Ruling; tamper test proves rejection)
- [x] Advance marker exactly to `current_cutoff` only after encrypted upload succeeds; never advance to wall-clock completion time or maximum observed file timestamp. (advance_marker() is only ever called after upload_backup_set() returns successfully)

### Task 5: Encrypt and Upload Immutable Backup Set

**Files:**
- Modify: `infrastructure/backup/backup.sh`
- Modify: `infrastructure/backup/test-backup.sh`

**Interfaces:**
- Produces: `daily/YYYY/MM/DD/<timestamp>-<host>-<sha>.tar.age` or matching `monthly/` object.

- [x] Write failing tests proving plaintext filenames, SQL, receipt bytes, and credentials never reach upload fixtures or logs. (encrypt_archive streams plaintext tar->age with no intermediate plaintext file; real age round trip in test-backup-docker.sh proves decrypt is required to see any of it)
- [x] Stage dumps and receipt metadata only in a size-bounded container `tmpfs`; fail before writing plaintext to a persistent volume. (BACKUP_STAGING_DIR under container `--tmpfs /staging:size=...` in both Docker test scripts and the production run contract)
- [x] Stream the deterministic archive through `age -r "$AGE_RECIPIENT"` into a ciphertext-only `*.partial.age` file on persistent staging.
- [x] Remove ciphertext partials on failure and at startup; rename atomically only after encryption and checksum validation. Container exit, host crash, or power loss must leave no persistent plaintext. (remove_ciphertext_partials(); widened to match any leftover *.age, not just *.partial.age -- see README/commit Ruling)
- [x] Upload with a unique object name and object-creation precondition so replacement fails. (`gcloud storage cp --if-generation-match=0`; collision-rejection proven in test-backup.sh Part E)
- [x] Record object URI, generation, encrypted size, and manifest digest in root-owned local status file. (merged into state/last-success.json, which doubles as both marker and status record)
- [x] Emit machine-readable success/failure status without secret values. (emit_status(); success on the main() happy path, failure from die() on every exit)
- [x] Run a test using a temporary age identity and fake GCS transport, then decrypt and compare every checksum. (test-backup-docker.sh Task 5 section: real age-keygen identity, full pipeline, directory-backed fake GCS, decrypt, every manifest-referenced checksum verified)

### Task 6: Schedule Daily Backup and Alert on Staleness

**Files:**
- Create: `infrastructure/backup/family-app-backup.service`
- Create: `infrastructure/backup/family-app-backup.timer`
- Create: `infrastructure/backup/family-app-backup-retry.service`
- Create: `infrastructure/backup/check-backup-freshness.sh`
- Create: `.github/workflows/family-backup-freshness.yml`
- Modify: `infrastructure/vps/bootstrap.sh`
- Modify: `infrastructure/vps/README.md`
- Modify: production Compose to expose one-shot backup profile and read-only volumes

**Interfaces:**
- Produces: at least two attempts per day, startup catch-up after downtime, and local plus off-host failure/staleness signals.

- [ ] Write failing tests requiring bounded randomized delay, persistent timer catch-up, single-flight lock, two-hour runtime deadline, hourly failure retry, and a maximum 24-hour successful-backup age.
- [ ] Configure timer at least every 12 hours with `Persistent=true` and no more than 15 minutes randomized delay so one failed run still leaves recovery margin.
- [ ] Enforce a two-hour service runtime limit; timeout is failure, kills the container, and preserves no plaintext.
- [ ] Retry hourly at most four times within a six-hour systemd start-limit window, then stop retries and page. The normal 12-hour timer remains independent.
- [ ] Use `flock` to reject concurrent backup runs.
- [ ] Install root-only writer credential, password file, public age recipient, and state directory through VPS bootstrap.
- [ ] Add local health command that fails when latest successful upload reaches 24 hours old.
- [ ] Add hourly GitHub Actions freshness check using the separate read-only WIF identity; warn at 18 hours, page at 22 hours, and declare RPO breach at 24 hours without exposing object content.
- [ ] Verify service logs contain no PostgreSQL password, GCP key, environment bundle, or receipt content.

### Task 7: Implement Restore Tooling

**Files:**
- Create: `infrastructure/backup/restore.sh`
- Create: `infrastructure/backup/test-restore.sh`
- Modify: `infrastructure/backup/README.md`

**Interfaces:**
- Consumes: operator GCS access, selected encrypted backup set, and private age identity.
- Produces: restored globals, databases, receipt volume, and exact deployment manifest.

- [x] Write failing end-to-end test from seeded source PostgreSQL and receipts to empty destination. (test-restore.sh: seeded 5-database SOURCE + 2 receipts -> real backup.sh full+daily -> empty DESTINATION -> real restore.sh)
- [x] Download selected set into a new mode-`0700` directory and validate object generation/digest. (RESTORE_WORK_DIR must not already contain files; download_and_verify_object() independently re-derives generation/md5 from GCS metadata and compares against the downloaded bytes)
- [x] Decrypt with an explicitly provided private key file; never read recovery identity from normal production environment. (RESTORE_AGE_IDENTITY_FILE is a required file path; no default location, no env var carrying key content)
- [x] Validate manifest and every checksum before changing destination state. (decrypt_and_extract() runs validate_manifest_shape() + per-file/per-receipt-archive checksum checks before any psql/pg_restore call)
- [x] Restore globals with reviewed role-conflict handling, create databases, then use `pg_restore --clean --if-exists --no-owner` under operator control. (restore_globals(): ON_ERROR_STOP=0, tolerates only "already exists" conflicts -- see restore.sh Ruling comment)
- [x] Restore latest monthly receipt full archive followed by ordered daily deltas through selected database backup date. (restore_receipts_from_set() called once for the full, once per RESTORE_DAILY_OBJECT_URIS entry in order; each delta's parent_full_backup_id is checked against the full's run_id)
- [x] Compare row counts, migration versions, receipt checksums, and Temporal namespace data. (restore_verify(): per-database live-row counts via pg_stat_user_tables, proven in test-restore.sh against representative temporal/temporal_visibility databases too; receipt checksums re-verified against the live restored files. Migration versions are carried through into the restored manifest.json [schema_migration_versions] for Task 8 to compare against each image's supported version before running migrations, per that task's own checkbox -- restore.sh itself does not run migration tooling. Real Temporal namespace-level verification [not just the backing database's row counts] needs an actual Temporal server and is Task 8's "verify ... shared Temporal" step)
- [x] Refuse restore onto nonempty destination unless operator supplies explicit destructive confirmation flag. (check_destination_empty_or_confirmed(); proven in test-restore.sh against a destination with one leftover database)

### Task 8: Prove Recovery and Document Operations

**Files:**
- Create: `infrastructure/backup/recovery-drill.sh`
- Modify: `expense-tax-management/deploy/production/health-check.sh`
- Modify: `expense-tax-management/plans/ROADMAP.md`
- Modify: `infrastructure/backup/README.md`

**Interfaces:**
- Produces: timestamped recovery report with RPO, RTO, checks, and exact image versions.

- [ ] Run monthly restore against disposable local/remote infrastructure with no production routing.
- [ ] Run migrations only after comparing restored and image-supported schema versions.
- [ ] Deploy recorded immutable images and verify PostgreSQL, shared Temporal, workers, APIs, and receipt retrieval.
- [ ] Run authenticated product smoke tests before any Cloudflare cutover.
- [ ] Record elapsed restore time and fail the drill when it exceeds two hours.
- [ ] Perform quarterly full rehearsal including Cloudflare cutover simulation and rollback.
- [ ] Update ROADMAP only with observed results, never planned success.

## Completion Evidence

- Latest successful backup is younger than 24 hours; normal schedule attempts every 12 hours.
- GCS writer cannot read, overwrite, or delete objects.
- No private age key or plaintext data exists on GCS or persistent staging.
- All databases and referenced receipt files restore onto an empty host.
- Monthly drill reports verified checksums and authenticated smoke success.
- Proven RPO is at most 24 hours and proven RTO is under two hours.
