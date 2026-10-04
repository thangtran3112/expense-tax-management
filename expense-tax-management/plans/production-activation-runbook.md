# Production Activation Runbook

Documentation only. This runbook was produced by read-only inspection of this
worktree (branch `feature/production-runbook`) at commit `83885e1`. No
production, VPS, GCP, Clerk, Cloudflare, GitHub-remote, or Secret Manager
command was executed to write it. Every command below is quoted or directly
derived from the cited source file; no flag, env var name, container name, or
Compose project name is invented. Secrets are referenced only by variable name
and file path; no secret value is shown anywhere in this document.

Status as of this commit (`plans/PLAN.md`, `plans/ROADMAP.md`):

- Runtime TypeScript Temporal migration: Tasks 1-6 and Task 7 Stage A merged;
  Task 7 Stage B source merged (`workflow-worker` ships idle in production
  Compose). Operator cutover (shared Temporal activation, release, `advance`,
  drain) and Stage C Python removal are **not executed**.
- Phase 3D-A/3D-B/3D-C merged; all inert in production
  (`MAILBOX_FEATURE_ENABLED` unset). **Not deployed.**
- VPS encrypted backup/restore tooling merged; Task 1 Terraform (bucket +
  identities) **never applied**; no live writer key or VPS install exists yet.

Execute phases strictly in order. Each phase's approval gate must be
explicitly granted by the owner before its mutating steps run.

---

## 1. Preconditions and Roles

| Access | Needed for |
|---|---|
| VPS SSH + sudo (root) | Phases 0, 1, 3, 4; `infrastructure/vps/bootstrap.sh` runs from an operator machine and pushes over SSH/SCP |
| GCP project `expense-tax-tobytran-2026` (Secret Manager Admin on secret `expense-tax-production-env`, Storage Admin for Task 1 apply) | Phases 0, 1, 4 |
| Clerk production dashboard (or `clerk-cli`) | Phase 4 Step 2 (three new machine identities) |
| Google Cloud Console OAuth client | Phase 4 Step 3 |
| GitHub repo admin (Actions UI: re-run jobs, `workflow_dispatch` for the Cloudflare workflow) | Phases 1, 3, 4 |
| `gh`/git push rights to `dev` and PR-merge rights (never direct push to `main`) | Phases 1, 3 |

**Never do:**

- Never commit directly to `dev` or `main`; `main` is production-only and is
  entered only through a merged `dev` → `main` PR (`AGENTS.md`).
- Never run `deploy/production/bootstrap-temporal-db.sh` or
  `bootstrap-mailbox-vault-db.sh` as part of a normal deploy — operator-only,
  by design (`AGENTS.md`, `infrastructure/README.md`).
- Never place a writer/reader GCS key, the `age` private recovery identity, or
  any `.env`/secret-bundle content in git, chat, or this document.
- Never run both Temporal servers (legacy `expense-tax-production` project and
  shared `family-temporal`) against the same databases at once
  (`infrastructure/README.md`).
- Never advance dispatch routing (Phase 2) before the Phase 1 health-check is
  green, and never start Stage C (Phase 3) before Phase 2's drain proof reads
  zero.
- Never set `MAILBOX_FEATURE_ENABLED=true` before the Phase 4 vault bootstrap,
  Clerk identities, and Google OAuth client all exist — `sync-production-secret.sh`
  will refuse (missing required shell/database keys) but do not attempt it blind.
- Never run `terraform apply` for `infrastructure/gcp/backup/` or
  `infrastructure/cloudflare/expense-tax/` without the owner watching the
  `plan` output first (both are explicitly operator/approval-gated in their
  own READMEs).

---

## 2. Phase 0 — Verified Backup Before Any Change

**Purpose:** Prove a restorable, encrypted copy of every database (including
`temporal`/`temporal_visibility` once they exist under the shared server) and
the receipt volume exists before Phase 1 touches Temporal.

**Prerequisites:** VPS SSH access; shared Postgres running (`family-app-postgres`,
confirmed container name per `infrastructure/vps/steps/30-postgres.sh:81`,
network `postgres_default`).

Choose one:

### Option A — Full backup-tooling activation (recommended before any later phase repeats)

| # | Where | Command / action |
|---|---|---|
| 0A.1 | local (operator, real GCP creds) | Fill `infrastructure/gcp/backup/terraform.tfvars` (gitignored) per `infrastructure/gcp/backup/README.md`: `project_id`, `bucket_name`, `github_repository`, `wif_pool_id`. Run `terraform plan`, review, then `terraform apply` (operator only — this doc does not run it). |
| 0A.2 | local | Create the writer key once, outside Terraform state: `gcloud iam service-accounts keys create /tmp/backup-writer-key.json --iam-account=expense-tax-backup-writer@expense-tax-tobytran-2026.iam.gserviceaccount.com`, transfer its content into the shared-infrastructure Secret Manager bundle, then `shred -u /tmp/backup-writer-key.json` (`infrastructure/gcp/backup/README.md`). |
| 0A.3 | VPS (via operator machine) | `infrastructure/vps/bootstrap.sh --host <VPS_HOST> --ssh-user <USER> --ssh-key <PATH> --app apps/expense-tax-management.conf --only backup --backup-gcs-uri <gs://... from Task 1 output> --backup-host-id <id> --age-recipient <age1... public recipient> --receipt-volume expense-tax-production_expense_tax_production_storage --backup-writer-key-file <local path> --backup-image <pinned digest>` (`infrastructure/vps/bootstrap.sh` usage text, lines 36-63). Installs the `family-app-backup.timer` (every 12h, `Persistent=true`) and enables it immediately. |
| 0A.4 | VPS | Verify: `systemctl list-timers family-app-backup.timer`; after the first run, `bash infrastructure/backup/check-backup-freshness.sh` (or wait for `.github/workflows/family-backup-freshness.yml`, which stays skipped — 0 Actions minutes — until repo variable `GCP_BACKUP_BUCKET` is set). |

### Option B — Minimum one-off verified encrypted dump (no GCP mutation; do this today even if Option A is deferred)

Uses the same pinned backup image's binaries (`pg_dump 17`, `age`) and the
exact same env-var contract `infrastructure/backup/backup.sh` already
defines, stopped **before** the GCS-upload step (`BACKUP_MANIFEST_ONLY=1`),
with a throwaway `age` keypair and a placeholder bucket URI that is never
contacted:

| # | Where | Command |
|---|---|---|
| 0B.1 | VPS | `age-keygen -o /root/activation-dryrun-key.txt` → note the printed `Public key: age1...`. |
| 0B.2 | VPS (repo copied via scp, or `git clone` if available) | `docker build -f infrastructure/backup/Dockerfile -t family-app-backup:activation-dryrun infrastructure/backup` |
| 0B.3 | VPS | Extract the shared-cluster superuser password exactly as `infrastructure/vps/steps/40-backup.sh` does: `pg_superuser_password=$(grep -E '^POSTGRES_SUPERUSER_PASSWORD=' /opt/family-app/postgres/.env | tail -1 | cut -d= -f2-); umask 077; printf '%s' "$pg_superuser_password" > /root/activation-dryrun-pgpassword; chmod 0400 /root/activation-dryrun-pgpassword` |
| 0B.4 | VPS | `mkdir -p /root/activation-dryrun/{state,ciphertext,staging-copy}` |
| 0B.5 | VPS | Run the dump+manifest stage only (stops before encrypt/upload — `backup.sh`'s `BACKUP_MANIFEST_ONLY=1` hook, lines "if `BACKUP_MANIFEST_ONLY`... return 0" with `BACKUP_DUMP_ONLY_COPY_TO` honored on that path too): <br>`docker run --rm --read-only --tmpfs /staging:size=1g,mode=1700 --network postgres_default -e PGHOST=postgres -e PGPORT=5432 -e PGUSER=postgres -e PGPASSWORD_FILE=/run/secrets/pgpassword -e BACKUP_GCS_URI=gs://activation-dry-run-placeholder -e BACKUP_HOST_ID=expense-tax-vps-activation -e AGE_RECIPIENT=<age1... from 0B.1> -e RECEIPT_STORAGE_DIR=/receipts -e BACKUP_STATE_DIR=/state -e BACKUP_CIPHERTEXT_DIR=/ciphertext -e GOOGLE_APPLICATION_CREDENTIALS=/dev/null -e BACKUP_MANIFEST_ONLY=1 -e BACKUP_DUMP_ONLY_COPY_TO=/copy -v /root/activation-dryrun-pgpassword:/run/secrets/pgpassword:ro -v /root/activation-dryrun/state:/state -v /root/activation-dryrun/ciphertext:/ciphertext -v /root/activation-dryrun/staging-copy:/copy -v expense-tax-production_expense_tax_production_storage:/receipts:ro family-app-backup:activation-dryrun` |
| 0B.6 | VPS | Confirm `/root/activation-dryrun/staging-copy/database-inventory.json` lists every non-template database (expects at least `expense_app`, `foundry`, `postgres`; `temporal`/`temporal_visibility` only after Phase 1) and `/root/activation-dryrun/staging-copy/manifest.json` exists. |
| 0B.7 | VPS | Encrypt by hand, same construction as `encrypt_archive()` in `backup.sh`: `tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf - -C /root/activation-dryrun/staging-copy manifest.json globals.sql dumps receipts.tar | age -r <age1... from 0B.1> -o /root/activation-$(date -u +%Y%m%dT%H%M%SZ).tar.age` |
| 0B.8 | operator machine | `scp` both the `.tar.age` file and `/root/activation-dryrun-key.txt` off the VPS. **Verify by decrypting**: `age -d -i activation-dryrun-key.txt -o /tmp/verify.tar activation-*.tar.age && tar -tf /tmp/verify.tar` — must list `manifest.json`, `globals.sql`, `dumps/*.dump`, `receipts.tar`. |
| 0B.9 | VPS | `shred -u /root/activation-dryrun-key.txt /root/activation-dryrun-pgpassword; rm -rf /root/activation-dryrun /root/activation-*.tar.age` |

**Verification:** step 0B.8's decrypt+list succeeding is the proof. Keep the
off-VPS `.tar.age` + key until Phase 1 completes.

**Rollback:** nothing was mutated; this phase is read-only against Postgres.

**Approval gate:** none required to run Option B (read-only). Option A's
`terraform apply` and writer-key creation: **STOP — owner approval required**
(real GCP mutation).

**Estimated downtime:** none.

---

## 3. Phase 1 — Shared Temporal Activation + First `dev` → `main` Release

**Purpose:** Move App API/the TypeScript worker onto the shared Temporal
server before the dispatch-routing cutover, in the order that fails closed
with zero production impact if anything is wrong.

**Why this order:** `deploy/production/deploy.sh` (as merged on `dev`) now
calls `require_shared_temporal()` unconditionally before touching any
container, and that check — along with `load_env_file`'s `is_known_key`
rejection of any stray `TEMPORAL_DB_PASSWORD` line — runs **before** the
script's `ERR` rollback trap is installed. Merging to `main` first is
therefore safe: the resulting deploy is expected to fail at this preflight
(either reason), with the old release completely untouched, proving the new
images build correctly before any legacy Temporal container is stopped. This
matches `plans/sub-plans/runtime-typescript-temporal-migration.md`'s own
"Operator cutover sequence" (steps a-h), reordered so the irreversible step
(stopping legacy Temporal) happens right before the fix, not hours before it.

| # | Where | Step |
|---|---|---|
| 1.1 | GitHub (PR) | Merge `dev` → `main` (required check green, current with `dev`). Triggers `Expense Tax CI` then `Expense Tax Deploy` (`workflow_run` on CI success, `head_branch == 'main'`). |
| 1.2 | GitHub Actions UI | Confirm: `build` job succeeds (8 images pushed, incl. `expense-tax-workflow-worker`, `expense-tax-mailbox-broker`); `deploy` job **fails** at `require_shared_temporal` or `is_known_key`. Confirm via VPS `docker ps`/`curl` that the previous release's containers are still running unchanged — `deploy.sh` dies before any `compose pull`/`up`/env-file swap. |
| 1.3 | — | **STOP: owner approval required.** Next step stops legacy Temporal; downtime begins here. |
| 1.4 | VPS | Preserve rollback material per `infrastructure/README.md` §"Shared Temporal Activation" step 1: record the last known-good image tag (`/opt/expense-tax-management/app/deployed-image-tag`), copy the current `docker-compose.yml`/`deploy.sh`/`/etc/expense-tax-management/production.env` into a root-only recovery directory. Keep `temporal`/`temporal_visibility` databases and role `expense_temporal` as-is. |
| 1.5 | VPS | Create `family_shared` network once; stage `infrastructure/temporal/{docker-compose.yml,dynamicconfig.yaml,bootstrap-namespaces.sh}` into `/opt/family-app/temporal/`; create root-only mode-`0600` `/etc/family-app/temporal.env` with **only** `TEMPORAL_DB_PASSWORD` set to the **existing** `expense_temporal` role password (kept in the separate shared-infrastructure secret bundle — never the Expense bundle, never newly generated). |
| 1.6 | VPS | Stop the legacy Temporal container. Verify empty: `docker ps --quiet --filter "label=com.docker.compose.project=expense-tax-production" --filter label=com.docker.compose.service=temporal`. |
| 1.7 | VPS | `sudo docker compose --project-name family-temporal --env-file /etc/family-app/temporal.env -f /opt/family-app/temporal/docker-compose.yml up -d --wait` then `sudo bash /opt/family-app/temporal/bootstrap-namespaces.sh` then `sudo docker exec family-temporal temporal operator namespace describe --address temporal:7233 --namespace default` (verifies Python's `default` histories are intact; namespace bootstrap creates `expense-tax` once). |
| 1.8 | operator machine | Rotate the Expense secret bundle: `DATABASE_ENV_PATH=.keys/ovh/postgres-vps.env infrastructure/gcp/expense-tax/sync-production-secret.sh` (`MAILBOX_FEATURE_ENABLED` left unset — do not enable mailbox yet). Publishes a clean bundle under the current `scripts/lib/production-secret-bundle.mjs` key set, which contains no `TEMPORAL_DB_PASSWORD` key at all; enforces the one-non-destroyed-version postcondition automatically. |
| 1.9 | GitHub Actions UI | Re-run the Step 1.2 failed workflow run's `deploy` job ("Re-run failed jobs"). It re-fetches the rotated bundle, passes `require_shared_temporal`, runs `app-api-migrate`/`foundry-service-migrate` (migrations `017`-`021` apply: `temporal_dispatch_routing`, `mailbox_connections`, `mailbox_discovery`, `mailbox_ingestion`, `expense_source_connected_mailbox`), starts all 8 services including idle `workflow-worker`, then `health-check.sh` (now also polls `family-temporal` cluster/`expense-tax` namespace health). |
| 1.10 | VPS | Verify TS worker polling: `docker exec family-temporal temporal task-queue describe --address temporal:7233 --namespace expense-tax --task-queue expense-tax-processing`. |
| 1.11 | VPS | Verify routing generation: `docker compose --project-name expense-tax-production --env-file /etc/expense-tax-management/production.env -f docker-compose.yml run --rm app-api-migrate node dist/temporal/dispatch-routing.js status` → expect `generation: 1`, `namespace: "default"`, `taskQueue: "expense-tax-ai-worker"` (unchanged — Stage A is a no-op until `advance`). |

**Rollback:** see Rollback Matrix #1 (shared Temporal failure) and #2 (release
deploy failure — `deploy.sh`'s own `ERR` trap handles this automatically once
past step 1.9's state-mutation point).

**Approval gate:** granted at 1.3; nothing after it is reversible by a simple
revert commit.

**Estimated downtime:** ~10-20 minutes, from stopping legacy Temporal (1.6)
through health-check passing (1.9). Capture/Office/Foundry web and the APIs
restart in seconds each (health-checked); Temporal-backed background
processing (OCR, enrichment, forwarded-receipt) is paused for the whole
window while legacy Temporal is down and the new release completes.

---

## 4. Phase 2 — TypeScript Worker Verification, Advance, Drain

**Purpose:** Cut new job dispatch over to the TypeScript worker while Python
drains its own backlog, with no container restart.

| # | Where | Step |
|---|---|---|
| 2.1 | (optional) | Non-production smoke (OCR, forwarding, enrichment end-to-end against the TS worker) if a non-production shared-Temporal environment exists — **open question #7**, none is defined in this repo today. |
| 2.2 | VPS | Re-run the Phase 1.11 `status` command immediately before advancing. |
| 2.3 | — | **STOP: owner approval required.** Advancing redirects every *new* job to the TypeScript worker; existing jobs keep draining on `ai-worker`. |
| 2.4 | VPS | `docker compose --project-name expense-tax-production --env-file /etc/expense-tax-management/production.env -f docker-compose.yml run --rm app-api-migrate node dist/temporal/dispatch-routing.js advance --from-generation 1` → generation becomes `2`, namespace `expense-tax`, queue `expense-tax-processing` (`src/temporal/dispatch-routing.ts`: `advanceDispatchRouting`, one transaction, exclusive advisory lock, refuses unless current generation equals `1`). |
| 2.5 | VPS | Repeat the `status` command (2.2) until `nonTerminalJobsByGeneration` and `pendingOutboxRowsByGeneration` both show `0` for generation `1`, while `ai-worker` keeps running and processing them. No active Temporal Schedules exist in this codebase today (confirmed: no `ScheduleClient` call in `services/`), so the sub-plan's "pause old schedules" step is a no-op. |

**Rollback:** see Rollback Matrix #3 — `advance` has no reverse command.

**Approval gate:** granted at 2.3.

**Estimated downtime:** none — database-transaction only, no container restart.

---

## 5. Phase 3 — Stage C Python Removal

**Purpose:** Delete the Python worker once drain is proven zero.

**Prerequisites:** Phase 2's drain proof reads zero. Before implementing,
note two gaps not listed in `runtime-typescript-temporal-migration.md`'s own
Stage C Files list, found by reading the actual scripts:

- `deploy/production/health-check.sh`'s required-worker default is
  `${HEALTH_CHECK_REQUIRED_WORKERS:-ai-worker workflow-worker}`. Once
  `ai-worker` is removed from `APPLICATION_SERVICES` and the Compose file,
  this default will wait forever for a service that no longer exists. The
  Stage C PR must also change this default (or have `deploy.sh` pass
  `HEALTH_CHECK_REQUIRED_WORKERS=workflow-worker` explicitly).
- Rollback after a Stage C deploy restores only the services still defined
  in the *new* (Python-free) `docker-compose.yml`/`deploy.sh` at the previous
  image tag — it cannot bring back `ai-worker` even transiently. This is
  safe only because Phase 2 already proved zero Python-side work remains;
  confirm that proof is still current (no new generation-1 jobs could have
  been created, since routing already points elsewhere) before approving.

| # | Where | Step |
|---|---|---|
| 3.1 | — | **STOP: owner approval required** — point of no return for the Python worker. Per the sub-plan's own Completion Evidence: "request separate approval before production deployment." |
| 3.2 | local → GitHub PR | Implement the Stage C checklist on a feature branch: delete `services/ai-worker/`, `common/python/expense-contracts/`; strip Python/uv/Ruff/Pytest from CI; remove `ai-worker` from `deploy.sh`'s `APPLICATION_SERVICES`; fix `health-check.sh`'s required-worker default (see Prerequisites above); update `check-workflow-worker-image.test.mjs`/3C literals. Run full contracts/services/frontends/worker/PostgreSQL/Compose/image/production-boundary suites. PR to `dev`, merge. |
| 3.3 | GitHub (PR) | Release `dev` → `main` (second release of this runbook). `require_shared_temporal` already satisfied from Phase 1 — no Temporal swap this time. |
| 3.4 | GitHub Actions UI | Verify `deploy` job green; `health-check.sh` now reports only `workflow-worker` as the required worker. |

**Rollback:** see Rollback Matrix #2 variant noted above (no Python restore).

**Approval gate:** granted at 3.1.

**Estimated downtime:** standard deploy window, ~2-5 minutes (image swap +
health-check only; no Temporal swap, no new migrations listed in Stage C).

---

## 6. Phase 4 — Connected Mailbox (3D) Activation

**Precise requirement finding (code-verified, corrects any assumption that
`advance`/drain gates this phase):** mailbox workflows
(`MailboxScanWorkflow`, `MailboxOcrReceiptWorkflow`,
`MailboxMaterializeWorkflow`, `MailboxScheduledScanTriggerWorkflow`) are
dispatched **directly** against
`TARGET_TEMPORAL_NAMESPACE`/`AI_WORKER_TASK_QUEUE` (`expense-tax` /
`expense-tax-processing`), **bypassing `app.temporal_dispatch_routing`'s
generation fence entirely** — by design, "never will have" a Python
implementation
(`packages/contracts/src/internal/task-queues.ts` lines 26-77;
`services/app-api/src/domain/mailbox-ingestion.ts` lines 480-555). Mailbox
activation therefore requires **Phase 1 complete (shared Temporal + a healthy
`workflow-worker`)** but does **not** require Phase 2's `advance` or drain,
and does not depend on Phase 3 at all.

**Prerequisites / known gaps to resolve before Step 6 below:**

- `.github/workflows/expense-tax-deploy.yml`'s "Transfer production runtime"
  step only `scp`s `docker-compose.yml`, `deploy.sh`, `health-check.sh`, and
  the env file to `/tmp/expense-tax-deploy/` — **it never transfers
  `docker-compose.mailbox.yml`**. `deploy.sh` resolves
  `MAILBOX_COMPOSE_FILE="$SCRIPT_DIR/docker-compose.mailbox.yml"` relative to
  its own installed location (`/opt/expense-tax-management/app/`). Before any
  deploy with `MAILBOX_FEATURE_ENABLED=true` can succeed, an operator must
  manually place that file at
  `/opt/expense-tax-management/app/docker-compose.mailbox.yml` (e.g. one
  `scp` from the release commit) and **keep it in sync on every subsequent
  release** until the workflow is fixed to transfer it automatically
  (recommended follow-up, not performed here).
- `sync-production-secret.sh` does not yet contain the four
  exact-value lock lines for `CLERK_MAILBOX_SERVICE_AUDIENCE` /
  `CLERK_MAILBOX_APP_API_SUBJECT` / `CLERK_MAILBOX_WORKER_SUBJECT` /
  `CLERK_MAILBOX_BROKER_SUBJECT` (only required-presence checks exist today)
  — per `docs/superpowers/plans/2026-09-12-phase-3d-a-mailbox-broker.md`
  Task 5 Step 7, those lines are added *after* Step 2 below creates the real
  Clerk machine IDs. This is a source change (a follow-up commit), not just a
  config step; until it lands, correctness depends on operator discipline
  rather than a hard-coded ID check.

| # | Where | Step |
|---|---|---|
| 1 | VPS | **Vault bootstrap** (operator-only, never part of normal deploy): `POSTGRES_CONTAINER=family-app-postgres POSTGRES_SUPERUSER_PASSWORD=<shared cluster password> MAILBOX_VAULT_MIGRATOR_DB_PASSWORD=<new> MAILBOX_VAULT_RUNTIME_DB_PASSWORD=<new> deploy/production/bootstrap-mailbox-vault-db.sh`. **Note the default `POSTGRES_CONTAINER` in this script is `expense-tax-postgres`, not the real shared-cluster container `family-app-postgres` — always pass it explicitly** (confirm with `docker ps` first). Creates database `mailbox_vault`, roles `mailbox_vault_migrator` (DDL) and `mailbox_vault_runtime` (DML-only). |
| 2 | Clerk dashboard (production instance) | **Clerk mailbox identities** — create three machine identities: `app-api-mailbox`, `workflow-worker-mailbox`, `mailbox-broker-app`. Record each machine secret key and the exact subject strings (`workflow-worker-mailbox` is the required exact value for `CLERK_MAILBOX_WORKER_SUBJECT` per `services/mailbox-broker/README.md`). Then add the four lock lines described in Prerequisites above. |
| 3 | Google Cloud Console | **Google OAuth client** — scope exactly `https://www.googleapis.com/auth/gmail.readonly` (`plans/PLAN.md` Remaining-Phase Constraints). Redirect URI derived from Cloudflare config (Step 5 below): `https://expense-mailbox.tobytran.dev/oauth/google/callback` (`services/mailbox-broker/src/routes/oauth.ts`, `infrastructure/cloudflare/expense-tax/main.tf` line 65). Record client ID/secret into the operator's `~/.zshrc`-sourced shell environment that `sync-production-secret.sh` reads. |
| 4 | operator machine | **Secret bundle with `MAILBOX_FEATURE_ENABLED=true`**: set `MAILBOX_FEATURE_ENABLED=true` plus every required shell/database/Clerk-runtime key in the operator shell (`infrastructure/gcp/expense-tax/sync-production-secret.sh`'s inline required-variable checks), ensure `.keys/ovh/postgres-vps.env` (or the real `$DATABASE_ENV_PATH`) also carries `MAILBOX_BROKER_DATABASE_URL`/`MAILBOX_BROKER_MIGRATION_DATABASE_URL` pointing at the roles from Step 1, then run `infrastructure/gcp/expense-tax/sync-production-secret.sh`. |
| 5 | GitHub Actions UI (`workflow_dispatch`, `apply: true`) | **Cloudflare Terraform apply** — `.github/workflows/expense-tax-cloudflare.yml`'s `apply` job (production environment), after reviewing its `plan` artifact, creates the `expense-mailbox.tobytran.dev` DNS record and the `/oauth/google/callback` → `http://127.0.0.1:8300` Tunnel ingress rule (`infrastructure/cloudflare/expense-tax/main.tf`). |
| 6 | — | **STOP: owner approval required** before the deploy that flips the flag live. |
| 7 | GitHub Actions UI | Re-run the latest successful "Expense Tax Deploy" run ("Re-run all jobs") — `deploy.sh` re-fetches the now-mailbox-enabled bundle, overlays `docker-compose.mailbox.yml` (now present per Prerequisites), runs `mailbox-broker-migrate`, starts `mailbox-broker` + the mailbox-augmented `app-api`/`workflow-worker` env, and `health-check.sh` additionally polls `http://127.0.0.1:8300/health/live`. |
| 8 | VPS | **3D-B schedule reconcile** (one-time; safe to repeat): `docker compose --project-name expense-tax-production --env-file /etc/expense-tax-management/production.env -f docker-compose.yml run --rm -e MAILBOX_FEATURE_ENABLED=true -e TEMPORAL_HOST=temporal:7233 -e TEMPORAL_NAMESPACE=expense-tax app-api-migrate node dist/temporal/mailbox-schedule-reconcile.js reconcile` (`services/app-api/src/temporal/mailbox-schedule-reconcile.ts` — the `app-api-migrate` service's own environment carries neither `MAILBOX_FEATURE_ENABLED` nor `TEMPORAL_HOST`/`TEMPORAL_NAMESPACE`, so all three must be passed on this one-off `run` invocation). Creates the daily `02:00` Temporal Schedule for every existing active/scan-enabled connection. |
| 9 | — | **Before enabling for real tenants:** run the Gmail test-account end-to-end verification (`test/e2e/connected-mailbox.e2e.test.ts`, operator-gated, never run in CI) against the production-shaped VPS stack, per `plans/PLAN.md` 3D-C Operator Activation item 3. |

**Rollback:** see Rollback Matrix #4.

**Approval gate:** granted at step 6.

**Estimated downtime:** one standard deploy window, ~5-10 minutes (no
Temporal swap).

---

## 7. Phase 5 — Restore Drill

**Purpose:** Prove the Phase 0 backup (or, if Option A was taken, the first
live scheduled backup) actually restores, onto disposable infrastructure —
never production routing.

| # | Where | Step |
|---|---|---|
| 5.1 | operator machine, real GCS read access | Temporarily grant: `gcloud storage buckets add-iam-policy-binding gs://<backup bucket> --member="user:<operator>" --role="roles/storage.objectViewer" --condition=None` (`infrastructure/gcp/backup/README.md`). |
| 5.2 | disposable host (local Docker or a throwaway VPS — never production) | Run `infrastructure/backup/restore.sh` (`--entrypoint restore.sh` on the same pinned image) with the documented env contract: `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD_FILE` (destination, empty cluster), `RESTORE_AGE_IDENTITY_FILE` (private key, never on the VPS), `RESTORE_GOOGLE_APPLICATION_CREDENTIALS` (the operator's temporary grant from 5.1), `RESTORE_OBJECT_URI` (the monthly full set), `RESTORE_WORK_DIR` (fresh, empty, mode `0700`), `RECEIPT_RESTORE_DIR`, optionally `RESTORE_DAILY_OBJECT_URIS` (ordered comma list). Refuses a non-empty destination without `RESTORE_CONFIRM_DESTRUCTIVE=yes-destroy-existing-data`. |
| 5.3 | disposable host | Or run the full orchestrator: `infrastructure/backup/recovery-drill.sh` with the same restore env vars plus `RECOVERY_REPORT_FILE`, `RECOVERY_SUPPORTED_MIGRATION_VERSIONS`, and optionally `RECOVERY_MIGRATE_CMD`/`RECOVERY_DEPLOY_CMD`/`RECOVERY_HEALTH_CHECK_CMD`/`RECOVERY_SMOKE_TEST_CMD`/`RECOVERY_POSTGRES_CONTAINER=family-app-postgres`. Fails if total elapsed time exceeds the 2-hour RTO (`RECOVERY_DEADLINE_SECONDS`, default `7200`). |
| 5.4 | operator machine | Revoke the temporary grant immediately after: `gcloud storage buckets remove-iam-policy-binding gs://<backup bucket> --member="user:<operator>" --role="roles/storage.objectViewer"`. |
| 5.5 | — | Review the JSON report: every restored database's row count, every receipt checksum, `migration_versions_match`, `rto_breached: false`. |

**Rollback:** none needed — entirely disposable infrastructure.

**Approval gate:** none for the drill itself; **STOP — owner approval
required** only for the quarterly full rehearsal that includes a real
Cloudflare cutover simulation (explicitly operator-only, not attempted by any
tooling in this repo).

**Estimated downtime:** none (production untouched).

---

## 8. Rollback Matrix

| # | Failure point | Rollback |
|---|---|---|
| 1 | Shared Temporal activation fails (Phase 1, steps 1.4-1.7) | Stop the shared server first. Restore the saved Expense Compose file, `deploy.sh`, env file, and prior image tag (1.4's recovery directory); restart the old Temporal service against the **same preserved** `temporal`/`temporal_visibility` databases. Verify `default` namespace histories and Python worker polling before resuming dispatch. Never start the legacy server until the shared server is stopped (`infrastructure/README.md`). Application image rollback alone cannot recover a failed shared Temporal server — this manual sequence is required. |
| 2 | Release deploy fails after state mutation (Phase 1 step 1.9, or Phase 3 step 3.3/3.4) | `deploy.sh`'s own `ERR` trap runs automatically: restores the prior env file, restores `IMAGE_TAG` to the previous recorded tag, treats `workflow-worker`/`mailbox-broker` as optional-image services (probes `docker manifest inspect`; drops them from the rollback set only if genuinely missing for that tag), re-runs `health-check.sh` with the reduced required-worker list, and verifies running images match the restored tag. **Caveat for Phase 3:** once Stage C's new `docker-compose.yml`/`deploy.sh` are installed on disk, an automatic rollback operates over that same Python-free service set — it cannot restore `ai-worker` even transiently (acceptable only because Phase 2's drain proof is required before Phase 3 starts). |
| 3 | `advance` regretted (Phase 2) | No reverse command exists (`dispatch-routing.ts` only implements `status`/`advance`). Manual, migration-credentialed SQL is required: `UPDATE app.temporal_dispatch_routing SET generation = generation + 1, temporal_namespace = 'default', task_queue = 'expense-tax-ai-worker', updated_at = now() WHERE singleton = true AND generation = <current>;` — only meaningful **before** Stage C (Phase 3) removes `ai-worker`, and only affects *new* enqueues; jobs already stamped with the post-`advance` target keep that target. Treat as high-risk, operator-typed SQL, not a provided tool. |
| 4 | Mailbox activation fails (Phase 4) | Set `MAILBOX_FEATURE_ENABLED=false` in the operator shell, re-run `sync-production-secret.sh`, then re-run the deploy job. `deploy.sh` drops `mailbox-broker` from `APPLICATION_SERVICES` and the base `docker-compose.yml` needs none of the mailbox env/vault DB/Clerk identities — no destructive cleanup of the (now simply unused) vault database or Clerk identities is required. |

---

## 9. Post-Activation Updates

| Document | Update |
|---|---|
| `expense-tax-management/AGENTS.md` | "Current Production" bullet: replace the Task 7 Stage A/B description with the completed cutover state (generation, Python-removed) once Phases 1-3 land. |
| `expense-tax-management/plans/PLAN.md` | Status line, Handoff section, and the 3D-A/3D-B/3D-C Operator Activation checklists (mark each completed step). |
| `expense-tax-management/plans/ROADMAP.md` | "Remaining Infrastructure Work" table and "Backup and Restore — Observed Results" section: replace "proven locally only" language with real VPS/GCS/live-drill results once Phases 0 and 5 run for real. |
| `expense-tax-management/plans/sub-plans/runtime-typescript-temporal-migration.md` | Check off the remaining Task 7 Stage B/Stage C boxes as each is actually observed. |
| `infrastructure/gcp/expense-tax/sync-production-secret.sh` | Add the four Clerk-mailbox exact-value lock lines once the real machine IDs exist (Phase 4 Step 2) — a source commit, not just a config change. |
| `infrastructure/README.md` | Note the activation date under "Shared Temporal Activation" once complete. |
| `.github/workflows/expense-tax-deploy.yml` | Recommended follow-up (not done here): transfer `docker-compose.mailbox.yml` automatically, so Phase 4's manual-placement gap doesn't recur on every future release. |

---

## 10. Open Questions (not determinable from this repository)

1. Real VPS SSH host/port/user, and the GitHub repository variables the
   workflows reference (`VPS_HOST`, `VPS_PORT`, `VPS_USER`,
   `GCP_PROJECT_ID`, `GCP_SECRET_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER`,
   `GCP_DEPLOY_SERVICE_ACCOUNT`, `GCP_BACKUP_BUCKET`,
   `GCP_BACKUP_FRESHNESS_WIF_PROVIDER`/`_SERVICE_ACCOUNT`,
   `CLOUDFLARE_ACCOUNT_ID`, `TF_STATE_BUCKET`,
   `GCP_CLOUDFLARE_WORKLOAD_IDENTITY_PROVIDER`/`_SERVICE_ACCOUNT`) — none are
   stored in this repository.
2. Whether the GitHub Environment named `production` (used by both deploy
   jobs and the Cloudflare apply job) has required reviewers configured —
   that may already be the mechanical form of this runbook's approval gates,
   but repo environment settings are not visible from a local worktree.
3. `infrastructure/gcp/backup/terraform.tfvars` real values (gitignored,
   untracked) — the README's example (`expense-tax-tobytran-2026-backups`)
   may or may not be what the owner intends to apply.
4. The live Secret Manager bundle's exact current key set (not inspectable
   here) — specifically whether it still carries a stale `TEMPORAL_DB_PASSWORD`
   line from before this PR. Phase 1 step 1.8 resolves this regardless of
   which preflight reason step 1.2 actually hits.
5. Whether a non-production environment with shared Temporal exists anywhere
   for Phase 2's optional smoke step — none is defined in this repository.
6. Real Clerk machine-identity IDs and Google OAuth client ID/secret (Phase 4
   steps 2-3) must be created live; no repository command produces them.
