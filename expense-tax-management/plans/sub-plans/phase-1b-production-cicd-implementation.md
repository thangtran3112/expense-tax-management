# Phase 1B Production CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status:** Complete. Retained because production deployment boundary tests read the Task 8 operator-only requirement. Do not execute this plan; current phase status lives in `../PLAN.md`.

**Goal:** Publish immutable application images after green CI, synchronize one retained GCP secret version, and deploy private application containers to the live VPS against its existing PostgreSQL instance.

**Architecture:** GitHub-hosted runners build six SHA-tagged GHCR images, authenticate to GCP through repository-restricted OIDC Workload Identity Federation, fetch one production dotenv bundle, and deploy over a dedicated SSH identity. Production Compose attaches database clients to existing external network `postgres_default`, keeps every application endpoint on VPS loopback, migrates before restart, and restores the previous image tag if health checks fail.

**Tech Stack:** GitHub Actions, Docker Buildx, GHCR, Docker Compose v2, GCP Secret Manager, GCP IAM/WIF, Bash, Node.js 24, Vitest, PostgreSQL 17, Temporal.

**Current status:** `../PLAN.md` and `../ROADMAP.md`

## Global Constraints

- GCP project ID: `expense-tax-tobytran-2026`; organization: `177410718350`; billing account: `013C6D-EEE26E-EAA1A1`.
- Keep exactly one non-destroyed `expense-tax-production-env` secret version after every successful synchronization.
- Never print, commit, or upload raw secret values as workflow artifacts.
- Never copy the PostgreSQL superuser credential into GCP or GitHub.
- Deploy App API, Foundry Service, AI worker, Temporal, Capture Web, Office Web, and Foundry Web to VPS; do not deploy legacy FastAPI or legacy Web.
- Do not create, replace, or expose the existing `expense-tax-postgres` container or its volume.
- Bind App API, Foundry, and all web clients to `127.0.0.1`; expose no Temporal port.
- Do not change UFW, DNS, TLS, Nginx, public routing, or identity-provider configuration in Phase 1B.
- Use GCP Functions by preference for future Lambda-like work; ask before Cloud Run placement; provision no GCP VM.
- Preserve unrelated `plans/mockups/**` worktree changes and stage exact paths only.
- Produce one final Phase 1B implementation commit after source verification;
  track runtime deployment state in GitHub Actions and the VPS SHA file. The
  controller, not this task, creates that final source commit after review.

---

### Task 1: Test Production Secret Bundle Semantics

**Files:**
- Create: `scripts/lib/production-secret-bundle.mjs`
- Create: `scripts/lib/production-secret-bundle.test.mjs`

**Interfaces:**
- Consumes: plain environment maps from `~/.zshrc`, `.keys/ovh/postgres-vps.env`, and an optional current Secret Manager payload.
- Produces: `buildProductionBundle({ shellEnv, databaseEnv, currentEnv, randomBytes }): string` and `activeVersionIds(versions): string[]`.

- [ ] **Step 1: Write failing bundle tests**

Cover required-key rejection without including values in errors, URL hostname conversion from `127.0.0.1:15432` to `postgres:5432`, preservation of generated signing keys from current payload, first-run generation of 32-byte hexadecimal keys, deterministic dotenv ordering, newline rejection, and filtering enabled/disabled versions while excluding destroyed versions.

```javascript
it("rewrites database URLs and preserves generated keys", () => {
  const bundle = buildProductionBundle({
    shellEnv: { OPENAI_API_KEY: "openai", OPENROUTER_API_KEY: "openrouter" },
    databaseEnv: databaseFixture,
    currentEnv: { STORAGE_URL_SIGNING_KEY: "a".repeat(64) },
    randomBytes: () => Buffer.alloc(32, 7),
  });
  expect(bundle).toContain("@postgres:5432/expense_tax_db");
  expect(bundle).toContain(`STORAGE_URL_SIGNING_KEY=${"a".repeat(64)}`);
  expect(bundle).not.toContain("127.0.0.1:15432");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm exec vitest run scripts/lib/production-secret-bundle.test.mjs`

Expected: FAIL because `production-secret-bundle.mjs` does not exist.

- [ ] **Step 3: Implement pure bundle builder**

Parse dotenv without executing input. Require `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, four runtime/migrator database URLs, and preserve or generate `STORAGE_URL_SIGNING_KEY`, `INBOUND_WEBHOOK_SIGNING_KEY`, `INBOUND_ROUTING_TOKEN_SECRET`, and `TEMPORAL_DB_PASSWORD`. Serialize values only after rejecting CR/LF/NUL bytes. Error messages name missing keys but never values.

- [ ] **Step 4: Run focused tests**

Run: `pnpm exec vitest run scripts/lib/production-secret-bundle.test.mjs`

Expected: all bundle tests PASS.

### Task 2: Add Reproducible GCP Bootstrap and Secret Synchronization

**Files:**
- Create: `infrastructure/gcp/expense-tax/bootstrap.sh`
- Create: `infrastructure/gcp/expense-tax/sync-production-secret.sh`
- Create: `infrastructure/gcp/expense-tax/README.md`
- Create: `scripts/check-phase-1b-infrastructure.mjs`

**Interfaces:**
- Consumes: active `gcloud` account, local shell key names, local database env path, repository identity `thangtran3112/family-app`.
- Produces: GCP project, billing link, enabled APIs, service account `expense-tax-github-deploy`, WIF pool/provider, one secret, and machine-readable provider/service-account outputs.

- [ ] **Step 1: Extend static verifier with failing GCP assertions**

Require exact project/secret IDs, WIF repository condition, no service-account key creation command, no secret payload on command lines, and an older-version destruction loop.

```javascript
assertIncludes(bootstrap, "assertion.repository=='thangtran3112/family-app'");
assertExcludes(bootstrap, "service-accounts keys create");
assertIncludes(sync, "secrets versions destroy");
```

- [ ] **Step 2: Run verifier and verify failure**

Run: `node scripts/check-phase-1b-infrastructure.mjs`

Expected: FAIL because GCP scripts do not exist.

- [ ] **Step 3: Implement idempotent GCP bootstrap**

Use `gcloud projects create`, billing link, `services enable`, `iam service-accounts create`, workload identity pool/provider creation, service-account `roles/iam.workloadIdentityUser` binding restricted to repository principal set, secret creation, and secret-level accessor binding. Existing resources report no-op success.

- [ ] **Step 4: Implement secret synchronization**

Run a non-interactive zsh that loads `~/.zshrc`, export only required API-key variables into the builder process, parse `.keys/ovh/postgres-vps.env` without executing it, fetch current payload into a mode-0600 temporary file when present, build a replacement payload, add it with `--data-file`, verify access by SHA-256 without printing content, and destroy every older enabled/disabled version. Trap cleanup for every temporary file.

- [ ] **Step 5: Run static and focused tests**

Run: `node scripts/check-phase-1b-infrastructure.mjs`

Run: `pnpm exec vitest run scripts/lib/production-secret-bundle.test.mjs`

Expected: all checks PASS.

### Task 3: Define Private Production Runtime and Rollback

**Files:**
- Create: `deploy/production/docker-compose.yml`
- Create: `deploy/production/deploy.sh`
- Create: `deploy/production/health-check.sh`
- Create: `deploy/production/bootstrap-temporal-db.sh`
- Create: `test/integration/production-deployment-boundaries.test.ts`

**Interfaces:**
- Consumes: `IMAGE_TAG`, root-owned production env file, external Docker network `postgres_default`, existing PostgreSQL container alias `postgres`.
- Produces: private healthy runtime under Compose project `expense-tax-production`, state file `/opt/expense-tax-management/app/deployed-image-tag`, and non-zero failures with rollback attempts.

- [ ] **Step 1: Write failing production-boundary tests**

Parse Compose YAML and scripts. Assert exactly six GHCR application images use `${IMAGE_TAG}`, no build sections, no PostgreSQL service/volume, external `postgres_default`, loopback-only host bindings, no Temporal host port, migrations precede service update, rollback uses prior tag, and legacy services are absent.

```typescript
expect(compose.services.postgres).toBeUndefined();
expect(compose.networks.database.external.name).toBe("postgres_default");
expect(compose.services["app-api"].ports).toEqual(["127.0.0.1:8100:8100"]);
```

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm exec vitest run test/integration/production-deployment-boundaries.test.ts`

Expected: FAIL because production deployment files do not exist.

- [ ] **Step 3: Implement production Compose**

Define App API, Foundry Service, migration jobs, AI worker, Temporal auto-setup, and three Next.js clients. Use immutable `ghcr.io/thangtran3112/family-app/expense-tax-<component>:${IMAGE_TAG}` images, health checks, restart policies, resource limits, named app storage, private default network, and external database network only where database access is required.

- [ ] **Step 4: Implement Temporal database bootstrap**

Accept `POSTGRES_SUPERUSER_PASSWORD` and `TEMPORAL_DB_PASSWORD` through environment only. Execute idempotent SQL inside `expense-tax-postgres` to create/alter role `expense_temporal` and create owned databases `temporal` and `temporal_visibility`. Never interpolate passwords into logged command arguments; send SQL over stdin with `ON_ERROR_STOP=1`.

- [ ] **Step 5: Implement deploy and health scripts**

Validate full hexadecimal SHA tags. Atomically install incoming env, record previous SHA, pull images, run both migration jobs, update services, and invoke health checks through loopback. On failure, restore previous SHA when present and rerun Compose. Use `docker compose config --quiet` before mutation.

- [ ] **Step 6: Run production-boundary tests**

Run: `pnpm exec vitest run test/integration/production-deployment-boundaries.test.ts`

Expected: all production-boundary tests PASS.

### Task 4: Add Build-and-Deploy GitHub Actions Workflow

**Files:**
- Create: `.github/workflows/expense-tax-deploy.yml`
- Create: `scripts/check-phase-1b-workflow.mjs`
- Modify: `scripts/check-ci-workflow.mjs`

**Interfaces:**
- Consumes: completed `Expense Tax CI` workflow on `main`, GitHub production environment variables/secrets, GCP OIDC, GHCR.
- Produces: six immutable GHCR images and one serialized VPS deployment.

- [ ] **Step 1: Write failing workflow checker**

Assert `workflow_run` exact-name dependency, successful-main-SHA condition, no pull-request deploy path, least job permissions, six image definitions, no mutable `latest` tag, production environment, concurrency, GCP OIDC auth, Secret Manager access through a file, SSH known-host verification, migration/deploy script transfer, and temporary-file cleanup.

- [ ] **Step 2: Run checker and verify failure**

Run: `node scripts/check-phase-1b-workflow.mjs`

Expected: FAIL because deployment workflow does not exist.

- [ ] **Step 3: Implement image build job**

Checkout `github.event.workflow_run.head_sha`, use Buildx with registry cache, authenticate using `GITHUB_TOKEN`, and build/push the six Dockerfiles in a matrix under full-SHA tags. Grant only `contents: read` and `packages: write`.

- [ ] **Step 4: Implement deploy job**

Require successful `main` CI, `needs: build`, GitHub environment `production`, and deployment concurrency. Grant `contents: read`, `packages: read`, and `id-token: write`. Authenticate through WIF, fetch secret payload to a mode-0600 file, install dedicated SSH key and pinned known-host entry, transfer Compose/deploy/health scripts and env, use short-lived `GITHUB_TOKEN` for remote GHCR pull, run deployment, log out remotely, and clean runner temporary files with `if: always()`. Task 8 remains an explicit operator-only step and is not transferred by this workflow.

- [ ] **Step 5: Run workflow and infrastructure checkers**

Run: `node scripts/check-phase-1b-workflow.mjs`

Run: `node scripts/check-ci-workflow.mjs`

Expected: both PASS; Phase 1A CI remains unchanged and green.

### Task 5: Add Aggregate Verification and Update Durable Docs

**Status:** Tasks 1-9 complete. Initial verified deployment: SHA `a6c402a`,
Expense Tax Deploy run `34421864322`. Verified hardening deployment: SHA
`e679fa0`, Expense Tax Deploy run `34424329193`. These are historical evidence
at time of record, not self-referential current-SHA claims. Authoritative current
state is VPS `/opt/expense-tax-management/app/deployed-image-tag` plus the
latest successful `Expense Tax Deploy` workflow. Hardening verification covers
strict provider-conditioned WIF `principalSet` trust for the exact repository,
`refs/heads/main`, deploy workflow ref, and `production` environment; AI worker
health; and ephemeral credential cleanup. No GCP, GitHub, GHCR, SSH, or VPS
operation belongs in this offline source gate. Task 10 decisions remain pending.

**Files:**
- Create: `scripts/verify-phase-1b.mjs`
- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `plans/PLAN.md`
- Modify: `plans/sub-plans/phase-1b-production-cicd-implementation.md`

**Interfaces:**
- Consumes: focused tests/checkers and existing `verify:phase-1a` source gates.
- Produces: `pnpm verify:phase-1b` and accurate deployment status/gates.

- [x] **Step 1: Implement aggregate verifier**

Run bundle tests, GCP static checker, production-boundary tests, deploy-workflow checker, Phase 1A workflow checker, TypeScript/Python quality gates, and Docker Compose production config with inert test environment values. Do not contact GCP or VPS from source verification.

- [x] **Step 2: Update durable state**

Document GCP project/secret names, one-version destruction policy, compute-placement policy, external PostgreSQL network, live deployment paths, and remaining identity/DNS/storage/provider decisions. Record initial deployment `a6c402a` / run `34421864322`, hardening deployment `e679fa0` / run `34424329193`, and verified runtime/security gates without claiming either is current. Treat VPS `/opt/expense-tax-management/app/deployed-image-tag` and the latest successful `Expense Tax Deploy` workflow as authoritative current state. Keep Task 10 decisions pending.

- [x] **Step 3: Run source verification**

Run: `pnpm verify:phase-1b`

Expected: all required checks PASS with zero skipped source gates.

- [ ] **Step 4: Commit exact Phase 1B source scope**

Controller owns final commit after review; this task intentionally does not
stage or commit.

Stage only Phase 1B files, inspect cached diff, then commit:

```bash
git commit -m "feat(1b): add production CI/CD"
```

### Task 6: Provision GCP Project, WIF, and Single-Version Bundle

**Status: Complete.** Project, billing, APIs, WIF, service account, and one
non-destroyed production secret version verified. Hardening verification records
strict provider-conditioned `principalSet` trust restricted to the exact
repository, `refs/heads/main`, deploy workflow ref, and `production` environment.

**Files:**
- Runtime state only; no secret values written into repository.

**Interfaces:**
- Consumes: scripts from Task 2, authenticated `gcloud`, local API keys, local VPS database env.
- Produces: isolated project, WIF/service account, and one verified production secret version.

- [x] **Step 1: Create and activate named GCP configuration**

Create configuration `expense-tax`, set account `thangtran3112@gmail.com`, set project `expense-tax-tobytran-2026`, and verify active project/account.

- [x] **Step 2: Run GCP bootstrap**

Run `infrastructure/gcp/expense-tax/bootstrap.sh`. Verify project parent, billing, enabled APIs, WIF condition, service-account IAM, and secret-level IAM.

- [x] **Step 3: Synchronize production bundle**

Run `infrastructure/gcp/expense-tax/sync-production-secret.sh`. Verify output reports key names and hashes only, never values.

- [x] **Step 4: Verify one-version invariant**

List secret versions and assert exactly one is enabled with every older version destroyed. Access latest into a temporary file, validate required key names, then remove the file.

### Task 7: Provision Dedicated Deployment Identity and GitHub Environment

**Status: Complete.** Dedicated SSH identity and GitHub `production`
environment metadata verified without exposing secret values.

**Files:**
- Runtime state: local gitignored key under `.keys/ovh/`, VPS authorized key, GitHub production environment secrets/variables.

**Interfaces:**
- Consumes: GitHub CLI authentication and VPS operator SSH access.
- Produces: dedicated CI SSH identity and workflow configuration without reusing personal key.

- [x] **Step 1: Generate dedicated Ed25519 key**

Generate `.keys/ovh/github-actions-expense-tax` with no passphrase, mode 0600, comment `github-actions-expense-tax`. Print fingerprint only.

- [x] **Step 2: Install public key on VPS**

Append idempotently to `ubuntu` authorized keys over personal operator SSH, preserve mode 0600, and verify a fresh connection using dedicated key.

- [x] **Step 3: Configure GitHub production environment**

Create environment `production`. Set `VPS_DEPLOY_SSH_KEY` and `VPS_DEPLOY_KNOWN_HOSTS` as environment secrets. Set environment variables for host `158.69.202.250`, port `2222`, user `ubuntu`, project ID, WIF provider resource name, and service-account email. Never display secret values.

- [x] **Step 4: Verify metadata only**

Use GitHub API/CLI to list environment variable and secret names, and confirm expected names exist without retrieving values.

### Task 8: Bootstrap Temporal Databases on Live VPS (operator-only)

**Status: Complete.** Idempotent bootstrap ran twice; least-privilege role and
database ownership verified. Script remains operator-only.

**Files:**
- Runtime state only in existing PostgreSQL cluster.

**Interfaces:**
- Consumes: local VPS-only PostgreSQL superuser password and GCP bundle's Temporal password without exposing either.
- Produces: `expense_temporal` role and owned `temporal`/`temporal_visibility` databases.

- [x] **Step 1: Capture pre-change metadata**

Task 8 remains outside normal workflow deployment. The operator must run the
bootstrap explicitly before first application deployment; no GitHub Actions step
transfers or installs `bootstrap-temporal-db.sh`.

Over SSH, list database/role names and current PostgreSQL container health. Do not query user rows or print passwords.

- [x] **Step 2: Run idempotent bootstrap**

Fetch only `TEMPORAL_DB_PASSWORD` from Secret Manager into a protected temporary file, source VPS superuser password locally, and pipe both to `bootstrap-temporal-db.sh`. Run twice; second run must report no destructive change.

- [x] **Step 3: Verify ownership and isolation**

Confirm both databases exist, are owned by `expense_temporal`, and the role can connect without superuser, createdb, createrole, replication, or bypass-RLS attributes.

### Task 9: Push Source, Observe CI, and Perform First Deployment

**Status: Complete.** Initial verified deployment was SHA `a6c402a` / run
`34421864322`; hardening deployment was SHA `e679fa0` / run `34424329193`.
Runtime state remains authoritative only from the VPS deployed-image marker and
latest successful `Expense Tax Deploy` workflow. Hardening verification covered
seven healthy/running services, AI worker health, strict WIF trust, and
ephemeral credential cleanup.

**Files:**
- GitHub/VPS runtime state.

**Interfaces:**
- Consumes: Phase 1B commit, configured GitHub environment, GCP bundle, live VPS.
- Produces: green CI/deploy run and private healthy containers at exact SHA.

- [x] **Step 1: Push Phase 1B commit to `main`**

Confirm staged/unstaged scope excludes legacy mockups, push `HEAD:main`, and update local `main` pointer.

- [x] **Step 2: Watch Phase 1A and deployment workflows**

Watch both Actions runs to completion. On failure, inspect failed logs and captured diagnostics, fix source, rerun verification, commit a focused correction, and push again.

- [x] **Step 3: Verify live private runtime**

Over dedicated SSH, verify exact image SHA, seven service health states, loopback listeners only, external database-network attachment, successful migration versions app 012/foundry 004, and no listener on public 80/443.

- [x] **Step 4: Verify secret hygiene**

Confirm one non-destroyed secret version, root-owned mode-0600 VPS env, no GCP service-account keys, no secret values in Actions logs/artifacts, and remote GHCR logout.

- [x] **Step 5: Report deployment status**

Report historical deployment evidence separately from current state. Confirm
current SHA from `/opt/expense-tax-management/app/deployed-image-tag` and current
run from the latest successful `Expense Tax Deploy` workflow; do not infer either
from this plan. Confirm repository source, local `main`, and `origin/main` match;
leave unrelated mockup work untouched.

### Task 10: Stop at Next Product Decisions

**Files:**
- No implementation until each decision is answered.

**Interfaces:**
- Consumes: healthy private deployment.
- Produces: explicit decisions for subsequent specs.

- [ ] **Step 1: Ask identity-provider decision**

Present concrete tenant/platform identity options and request one selection before enabling authentication or public traffic.

- [ ] **Step 2: Ask public-hostname/gateway decision**

After identity selection, request hostnames and gateway/TLS preference before DNS, Nginx/Traefik, or port exposure changes.

- [ ] **Step 3: Ask storage placement decision**

Before first real receipt, request VPS-local versus GCS object storage selection.

- [ ] **Step 4: Ask provider activation decision**

Before real paid OCR/AI traffic, request OpenAI/OpenRouter adapter choice and monthly/request spending limits.

- [ ] **Step 5: Ask compute placement per eligible service**

For each future Lambda-like or non-time-sensitive service, recommend GCP Functions, VPS, or Cloud Run using approved policy and wait for case-specific approval.
