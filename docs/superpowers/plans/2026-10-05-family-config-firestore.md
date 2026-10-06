# Family Config in Firestore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every family-app env value, config value, and key into one Firestore database. The laptop and the VPS load env from it at runtime through one shared CLI.

**Architecture:** Firestore database `family-config` lives in `tobytran-portfolio`. Reusable values sit in `shared/{group}`, and per-app env sets in `apps/{app}/profiles/{profile}`, as literals or references to shared values. `common/config/family_config.py` is a Python standard-library CLI that gets tokens from gcloud and runs commands with resolved env. Expense local scripts and the VPS deploy run under that CLI. The old Secret Manager builder, sync script, and the persisted VPS env file go away.

**Tech Stack:** Python 3.10+ stdlib (urllib, subprocess, unittest), gcloud, Firestore REST v1, Firebase Rules REST v1, bash, Node test runner, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-family-config-firestore-design.md`

## Global Constraints

- Project `tobytran-portfolio`, database `family-config`, Native mode, `northamerica-northeast1`, delete protection on, deny-all client rules.
- Reader `family-config-reader@tobytran-portfolio.iam.gserviceaccount.com`: `roles/datastore.viewer` with condition `resource.name == "projects/tobytran-portfolio/databases/family-config"` (title `family-config-only`).
- IDs: `^[a-z0-9][a-z0-9-]*$`. Names: `^[A-Za-z_][A-Za-z0-9_]*$`. References: `{ref: "shared/<group>", key?: NAME}`.
- On the laptop, gcloud always uses `--configuration=personal`. The active default configuration is a work account; never touch it.
- Never print, log, or commit values. Names, targets, and counts are fine.
- Smallest correct diff. Stage exact paths only. Never touch `ai-trading/` code, `expense-service/`, or `frontend/web/`.

## Review Focus

1. Ctrl-C while `pnpm with-env docker compose up` runs: the child gets exactly one SIGINT, and SIGTERM sent to the CLI reaches the child. Task 1 adds a SIGTERM test.
2. A profile that references a multi-line shared value (an SSH key) fails with a single-line error and prints no value. Task 1 adds a validation case.
3. A dotenv import with `=`, `#`, quotes, and `export`: values keep `=`, and inline comments go. Task 1 adds an import test.
4. A deploy that runs before the reader key exists stops at the CLI token step, before `deploy.sh`. Task 1 tests the missing credential file.
5. macOS has no `/dev/shm`, so temp files fall back to the system temp directory. Tests run on the macOS laptop and in Linux CI.

## File Map

| Path | Change |
|---|---|
| `common/config/family_config.py` | create: CLI |
| `common/config/test_family_config.py` | create: unittest suite with fake Firestore and fake gcloud |
| `common/config/README.md` | create: schema, CLI, provisioning, GitHub copies |
| `infrastructure/gcp/family-config/bootstrap.sh` | create: database, rules, reader account, binding |
| `infrastructure/gcp/family-config/install-reader-key.sh` | create: stream the reader key to the VPS, verify, delete older keys |
| `expense-tax-management/package.json` | wrap local scripts; add `with-env` and `check:centralized-env`; extend `ci:test`; drop the bundle test |
| `expense-tax-management/scripts/compose.sh` | `.env.example` default; never `.env` |
| `expense-tax-management/scripts/audit-credential-boundaries.mjs` | `.env.example` default |
| `expense-tax-management/.env.example` | placeholder header |
| `expense-tax-management/scripts/check-centralized-env.test.mjs` | create: static guards |
| `.github/workflows/expense-tax-ci.yml` | push path filter `common/config/**` |
| `.github/workflows/expense-tax-deploy.yml` | no WIF or bundle fetch; ship and run the CLI |
| `expense-tax-management/deploy/production/deploy.sh` | require `DEPLOY_ENV_FILE`; no persistence; `validate_required_values` |
| `expense-tax-management/deploy/production/health-check.sh` | require `PRODUCTION_ENV_FILE` |
| `expense-tax-management/test/integration/production-deployment-boundaries.test.ts` | new contract tests |
| `expense-tax-management/scripts/check-phase-1b-{workflow,infrastructure}.mjs`, `check-phase-1b-infrastructure.test.mjs`, `verify-phase-1b.mjs` | drop the sync and bundle checks; assert the new deploy path |
| `expense-tax-management/infrastructure/gcp/expense-tax/bootstrap.sh` | outputs to stdout |
| `expense-tax-management/infrastructure/gcp/expense-tax/sync-production-secret.sh`, `scripts/lib/production-secret-bundle{,.test}.mjs` | delete; drop the `.gitignore` un-ignore lines |
| `expense-tax-management/AGENTS.md`, `plans/production-activation-runbook.md`, `plans/sub-plans/local-clerk-development-bootstrap.md`, `plans/PLAN.md`, `infrastructure/gcp/expense-tax/README.md` | docs and rule |
| `ai-trading/plans/handoffs/2026-10-05-family-config.md` | create: handoff |

---

### Task 1: CLI `common/config/family_config.py`

**Files:** create `common/config/test_family_config.py`, `common/config/family_config.py`, `common/config/README.md`.

**Interfaces (used by Tasks 2-4):**
- CLI commands exactly as in the spec: `run`, `render`, `get`, `keys`, `ls`, `set [--raw]`, `unset`, `link`, `import`, `describe`, `with-file`.
- Importable module functions used by the migration script: `Store()`, `Store.read_one(path) -> dict | None`, `parse_dotenv(text) -> dict[str, str]`, `parse_values(doc, label, refs_allowed) -> dict[str, str | tuple[str, str]]`, `validate_entry(kind, target, name, value)`, `write(store, label, path, changes: dict[str, dict | None], description: str | None = None)`, `ref_value(name, group, key) -> dict`, `resolve(store, targets) -> list[tuple[str, dict[str, str]]]`.

- [ ] **Step 1: Write the failing tests.**
  `test_family_config.py` runs the CLI as a subprocess (`sys.executable family_config.py ...`) against a threaded fake Firestore. The fake handles `POST documents:batchGet`, list `GET` with `showMissing`, and `PATCH` with `updateMask.fieldPaths` and `currentDocument.updateTime`/`exists` preconditions, and records every request. A fake `gcloud` on `PATH` logs `argv|CLOUDSDK_CONFIG|dir-present|CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` and prints `test-token`. Cases:
  - `run`:
    - resolves references, renamed references, and integer/boolean values;
    - later profiles beat earlier ones, and resolved values beat the parent env;
    - `--env-file-var` gives a `0600` file holding sorted `NAME=VALUE` lines, removed afterwards; the exit status (7) passes through;
    - SIGTERM sent to the CLI reaches the child (child exits 42).
  - `render`: dir `0700`, files `0600`; a duplicate profile name is rejected.
  - `get`, `keys`, `ls` output; `keys` and `ls` never print values.
  - Invalid documents exit 1 without printing the secret marker:
    - multi-line value; reserved `PATH`; a ref outside `shared/`;
    - a missing ref key; a ref to a multi-line shared value;
    - `doubleValue`; a bad name; an extra ref field.
  - `set`:
    - precondition `exists=false`, then `updateTime`; a no-op sends no PATCH;
    - `--raw` keeps the trailing newline;
    - multi-line profile values and `LD_*` names are rejected.
  - `unset`, `link` (rename, same name, missing key), and `import` (comments, `export`, quotes, `=`, inline comment, empty value; an unterminated quote writes nothing).
  - `describe` on `<app>`.
  - A concurrent change gives `changed concurrently`.
  - `with-file`: `{}` substitution, mode `0600`, removed afterwards.
  - Auth:
    - laptop: `--configuration=personal`, overridable, sends `x-goog-user-project`;
    - key file: override set, throwaway config present during the call and removed after, no quota header; a missing key file exits 1;
    - GitHub Actions: masks print before the value;
    - a gcloud failure is reported.
- [ ] **Step 2: Run** `python3 -m unittest discover -s common/config -p 'test_*.py'` from the repo root. Expected: errors, because `family_config.py` is missing.
- [ ] **Step 3: Implement** `family_config.py` with the spec semantics:
  - `Store` gets one gcloud token lazily and does batchGet reads, list, and PATCH with a precondition.
  - Strict parsing (`parse_values`, `parse_ref`); `resolve` uses two batchGets.
  - Writes compute minimal masks, apply the precondition, and verify by reading back.
  - `run_child` ignores SIGINT in the parent after the fork and forwards SIGTERM and SIGHUP.
  - Private temp files go under `/dev/shm` when possible.
  - GitHub Actions masks.
  - Messages never include values.
- [ ] **Step 4: Run** the same command. Expected: all tests pass.
- [ ] **Step 5:** Write `README.md` (schema, addressing, commands, auth modes, safety, provisioning scripts, GitHub copy refresh, examples), then commit: `feat(config): add family-config Firestore CLI`.

### Task 2: Provisioning scripts

**Files:** create `infrastructure/gcp/family-config/bootstrap.sh` and `install-reader-key.sh`; extend `common/config/test_family_config.py`.

- [ ] **Step 1:** Add `ProvisioningScriptTest`:
  - `bash -n` passes for both scripts;
  - `bootstrap.sh` contains `LOCATION="northamerica-northeast1"`, `--delete-protection`, `--type=firestore-native`, `allow read, write: if false;`, `roles/datastore.viewer`, the database condition, and `family-config-only`;
  - `install-reader-key.sh` contains `keys create /dev/stdout` and `/etc/family-app/config-reader.json`, and runs `keys expense-tax-management/production` before `service-accounts keys delete`.

  Run the tests. Expected: they fail.
- [ ] **Step 2: Implement.**
  - `bootstrap.sh`:
    - uses `g() { gcloud --configuration=... --project=... "$@"; }`;
    - enables the three APIs; describes the database, else creates it;
    - releases the Rules through REST with the token piped to `curl --config -` (create the ruleset; PATCH the existing release `cloud.firestore/<db>` or POST a new one; skip if the source is identical);
    - creates the service account if missing; runs `projects add-iam-policy-binding --condition=...`.
  - `install-reader-key.sh`:
    - re-execs itself under `with-file shared/vps VPS_OPERATOR_SSH_PRIVATE_KEY`;
    - reads host, port, user, and known_hosts through the CLI;
    - lists the old user-managed keys, then streams `keys create /dev/stdout` over SSH into an atomic root `0600` install;
    - copies the CLI to a temp VPS directory and runs `keys expense-tax-management/production` under sudo with the key;
    - deletes the old keys only after that succeeds.
- [ ] **Step 3:** Run the tests. Expected: they pass. Commit: `feat(infra): add family-config provisioning scripts`.

### Task 3: Provision Firestore (operator)

- [ ] Run `infrastructure/gcp/family-config/bootstrap.sh`.
- [ ] Verify:
  - `gcloud firestore databases describe --database=family-config --project=tobytran-portfolio --configuration=personal --format='value(locationId,type,deleteProtectionState)'` shows `northamerica-northeast1 FIRESTORE_NATIVE DELETE_PROTECTION_ENABLED`;
  - the rules release exists;
  - `projects get-iam-policy` shows the conditional binding;
  - `common/config/family_config.py ls` exits 0 with empty output.

### Task 4: Migrate values (operator, one-off script outside the repo)

- [ ] Write `/var/folders/_1/050mzm_167bd175pmv0rfhz40000gn/T/opencode/migrate_family_config.py`. It imports `family_config` and reads these sources:
  - `.env`, `.keys/ovh/.env`, and `.keys/ovh/postgres-vps.env`, through `parse_dotenv`;
  - the production secret, through `gcloud secrets versions access`;
  - the bootstrap JSON;
  - the GitHub production variables, through `gh variable list --json name,value`;
  - the SSH key files, raw;
  - the known_hosts lines, through `ssh-keygen -F '[host]:port'`.

  It writes the spec's Data Migration table with `validate_entry` and `write`, the references with `ref_value`, and the app descriptions. Then it verifies:
  - per document, the literal names equal the source names, and every SHA-256 matches;
  - every profile resolves;
  - the frontend `.env.local` values equal `local`.

  It prints names and counts only.
- [ ] Run it. Expected output: `verified`. Delete the script.

### Task 5: Expense laptop wiring

**Files:** create `expense-tax-management/scripts/check-centralized-env.test.mjs`. Modify `package.json`, `scripts/compose.sh`, `scripts/audit-credential-boundaries.mjs`, `.env.example`, and `.github/workflows/expense-tax-ci.yml`.

- [ ] **Step 1:** Write `check-centralized-env.test.mjs` (node:test). It asserts:
  - `compose.sh` defaults to `.env.example` and never matches `/\/\.env["}]/`;
  - `compose:up`, `compose:down`, `dev:app-api`, `dev:foundry`, `db:migrate:app`, `db:migrate:foundry`, and `smoke:local-worker` start with `../common/config/family_config.py run expense-tax-management/local -- `;
  - `with-env` equals `../common/config/family_config.py run expense-tax-management/local --`;
  - `ci:test` runs `python3 -m unittest discover -s ../common/config -p 'test_*.py'` and `pnpm check:centralized-env`;
  - no file under `scripts/`, `deploy/`, `services/*/src`, or `infrastructure/gcp/expense-tax` mentions `.keys/` or `postgres-vps.env` (this test file excluded);
  - `AGENTS.md` has `## Env and Secrets` with Firestore `family-config` and `common/config/family_config.py`;
  - the CI push paths include `"common/config/**"`.

  Run `node --test scripts/check-centralized-env.test.mjs`. Expected: it fails.
- [ ] **Step 2: Implement.**
  - `compose.sh`: `ENV_FILE="${EXPENSE_TAX_ENV_FILE:-$PROJECT_DIR/.env.example}"`, keeping the "does not exist" failure.
  - Audit script: `.env.example` default, and drop the `existsSync` import.
  - `.env.example`: header comment (placeholders only; real values come from `pnpm with-env`).
  - `package.json`:
    - add the wrap prefix, `with-env`, and `check:centralized-env`;
    - extend `ci:test`;
    - remove `scripts/lib/production-secret-bundle.test.mjs` from `check:temporal-infrastructure`.
  - CI workflow: add the path entry.
- [ ] **Step 3:** Run `node --test scripts/check-centralized-env.test.mjs` (after Task 7 adds the AGENTS rule). Expected: it passes. Commit: `feat(expense): load local env from family config`.

### Task 6: Expense VPS deploy path and legacy removal

**Files:**
- Modify:
  - `.github/workflows/expense-tax-deploy.yml`;
  - `deploy/production/deploy.sh`, `deploy/production/health-check.sh`;
  - `test/integration/production-deployment-boundaries.test.ts`;
  - `scripts/check-phase-1b-workflow.mjs`, `scripts/check-phase-1b-infrastructure.mjs`, `scripts/check-phase-1b-infrastructure.test.mjs`, `scripts/verify-phase-1b.mjs`;
  - `infrastructure/gcp/expense-tax/bootstrap.sh`, `.gitignore`.
- Delete: `infrastructure/gcp/expense-tax/sync-production-secret.sh`, `scripts/lib/production-secret-bundle.mjs`, `scripts/lib/production-secret-bundle.test.mjs`.

- [ ] **Step 1:** Update the boundary tests.
  - Replace "requires regular root-owned 0600 dotenv files before and after install". The new test asserts:
    - `validate_env_file "$COMPOSE_ENV_FILE"`, `COMPOSE_ENV_FILE="${DEPLOY_ENV_FILE:-}"`, and `DEPLOY_ENV_FILE is required` are present;
    - `/etc/expense-tax-management/production.env`, `env_backup`, and `install -o root -g root -m 0600` are absent;
    - `health-check.sh` requires `PRODUCTION_ENV_FILE:?`.
  - Add a behavioral test that runs the extracted `die` and `validate_required_values`:
    - the base env passes;
    - a missing `OPENAI_API_KEY` fails;
    - a non-hex `STORAGE_URL_SIGNING_KEY` fails;
    - the full mailbox env passes;
    - an issuer mismatch fails;
    - mailbox enabled with keys missing fails.
  - Add a workflow test:
    - absent: `google-github-actions/auth`, `id-token: write`, `gcloud secrets`, `expense-tax-production.env`;
    - present: the CLI install line and the `FAMILY_CONFIG_CREDENTIALS=... family_config.py run expense-tax-management/production --env-file-var DEPLOY_ENV_FILE -- .../deploy.sh` line.
  - Replace the `.keys` bootstrap test: no `.keys/` in `bootstrap.sh`, and `.gitignore` keeps `.keys/*`.

  Run `pnpm exec vitest run test/integration/production-deployment-boundaries.test.ts`. Expected: it fails.
- [ ] **Step 2: Implement.**
  - `deploy.sh`:
    - drop `TARGET_ENV_FILE`/`INCOMING_ENV_FILE`; `COMPOSE_ENV_FILE="${DEPLOY_ENV_FILE:-}"`; die if empty after the `IMAGE_TAG` check;
    - add `validate_required_values` (the spec's list, 64-hex checks, mailbox invariants), called after `validate_auth_values`;
    - remove the backup, install, and restore blocks;
    - give the final `health-check.sh` call `PRODUCTION_ENV_FILE="$COMPOSE_ENV_FILE"`;
    - update the mailbox comment that mentioned the bundle builder.
  - `health-check.sh`: `COMPOSE_ENV_FILE="${PRODUCTION_ENV_FILE:?PRODUCTION_ENV_FILE is required}"`.
  - Workflow:
    - remove `id-token`, the auth, setup-gcloud, and fetch steps;
    - scp `expense-tax-management/../common/config/family_config.py` (path `common/config/family_config.py`) instead of the env file, and drop its chmod;
    - in the remote command, install the CLI with mode `0755` and run the deploy through it;
    - drop the `expense-tax-production.env` cleanup entries.
  - `bootstrap.sh`: `OUTPUT_FILE="${1:-/dev/stdout}"`; guard `mkdir`/`chmod` when writing to stdout; send the status line to stderr.
  - Delete the sync script and the bundle builder files, and remove the `.gitignore` lines 22-23.
  - Phase 1B checks:
    - drop the `sync` reads and asserts and the `.keys` path assert;
    - README asserts expect `family-config` and the legacy `expense-tax-production-env` mention;
    - the workflow check expects the CLI deploy and no WIF;
    - delete the sync-behavior tests and the fixture path in `check-phase-1b-infrastructure.test.mjs`;
    - drop the "Production secret bundle tests" run in `verify-phase-1b.mjs`.
- [ ] **Step 3:** Run the boundary tests, `pnpm exec vitest run services/mailbox-broker/test/deploy-script.test.ts`, `node scripts/check-phase-1b-workflow.mjs`, `node scripts/check-ci-workflow.mjs`, and `bash -n` on the changed scripts. Expected: all pass. Commit: `feat(expense): deploy production env from family config`.

### Task 7: Docs and rule

- [ ] `AGENTS.md`:
  - add the spec's `## Env and Secrets` section after `## Boundaries`;
  - replace Infrastructure Policy line 76 with "Production GCP owns the Cloudflare Terraform WIF and state; family config lives in Firestore `family-config` (`tobytran-portfolio`); Phase 3D mailbox broker runs as a VPS container; no new GCP compute.";
  - delete line 77.
- [ ] Runbook (`plans/production-activation-runbook.md`):
  - the roles table gets `tobytran-portfolio` (Firestore owner);
  - define an `etm_compose` helper and use it in steps 1.11, 2.4, and Phase 4 step 8;
  - step 1.8 becomes "verify the reader key and production profile";
  - steps 1.9 and Phase 4 step 7 say the deploy loads the profile from Firestore;
  - the mailbox prerequisites and Phase 4 steps 3 and 4 use `family_config.py set expense-tax-management/production …`;
  - Rollback #2 drops "restores the prior env file"; Rollback #4 uses `set … MAILBOX_FEATURE_ENABLED`;
  - remove the post-activation sync-script row; Open Question 4 is resolved;
  - the credential rotation section says to update `shared/cloudflare` first, then refresh the GitHub copy.
- [ ] `plans/sub-plans/local-clerk-development-bootstrap.md`: in lines 23, 27, and 35, replace the `.env`/`.env.local` instructions with `family_config.py set expense-tax-management/local …` and `pnpm with-env …`.
- [ ] `infrastructure/gcp/expense-tax/README.md`: replace "Secret synchronization" with a "Production env" section pointing to `common/config/README.md`; `expense-tax-production-env` is legacy until the cutover release.
- [ ] `plans/PLAN.md` status line: add one family config sentence.
- [ ] Commit: `docs: record family-config env rule and procedures`.

### Task 8: ai-trading handoff

- [ ] Create `ai-trading/plans/handoffs/2026-10-05-family-config.md`, following the spec's "ai-trading Handoff" section. Cover:
  - the store and schema; the CLI and auth;
  - what exists under `shared/*` and `apps/ai-trading/profiles/{deploy,cloudflare}`;
  - a command mapping from `env-bundle.py`;
  - the Terraform cleanup for `ai-trading-env-bundle` and the deleted `expense-tax-env-files`;
  - the VPS deploy pattern with `/etc/family-app/config-reader.json`;
  - the app-secret profiles to create, the AGENTS.md sections to rewrite, and the CI path note.
- [ ] Commit: `docs(ai-trading): hand off family-config migration`.

### Task 9: Verify and ship

- [ ] Run:
  - `python3 -m unittest discover -s common/config -p 'test_*.py'`;
  - from `expense-tax-management/`: `pnpm check:centralized-env`, `pnpm check:temporal-infrastructure`, `pnpm check:cloudflare-infrastructure`, `node scripts/check-ci-workflow.mjs`, `pnpm exec vitest run test/integration/compose-boundaries.test.ts services/mailbox-broker/test/deploy-script.test.ts`;
  - `pnpm with-env ./scripts/compose.sh config --quiet`;
  - `pnpm with-env node -e "process.exit(process.env.CLERK_SECRET_KEY ? 0 : 1)"`.
- [ ] Push `feature/toby`, open a single PR to `dev`, wait for the required check, and squash-merge. Then reset `feature/toby` onto `origin/dev`.

### Task 10: Gated operations (after merge)

- [ ] With owner confirmation: run `infrastructure/gcp/family-config/install-reader-key.sh`.
- [ ] With owner confirmation: delete the Secret Manager secrets `expense-tax-env-bundle` and `expense-tax-env-files`.
- [ ] Move `expense-tax-management/.env`, `frontend/*/.env.local`, and `.keys/` to `~/.Trash/family-config-migration-<timestamp>/`.
- [ ] The owner releases `dev` to `main`. Afterwards, with owner confirmation: remove the VPS `production.env` and disable `expense-tax-production-env`. The owner deletes the four GitHub variables and the deploy WIF.
