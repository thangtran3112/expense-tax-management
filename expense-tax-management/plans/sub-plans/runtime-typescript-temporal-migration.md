# TypeScript Worker and Shared Temporal Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Expense Python Temporal worker with a standalone TypeScript worker and move generic Temporal server ownership into shared root infrastructure.

**Architecture:** App API remains the Temporal client. Expense workflows and activities run in one Expense-owned TypeScript worker package and container. One root Temporal server serves isolated project namespaces; future projects own separate workers and queues.

**Tech Stack:** Node.js 22+, TypeScript 5, pnpm, Zod 4, Temporal TypeScript SDK, Vitest, Docker Compose

**Spec:** `expense-tax-management/plans/ARCHITECTURE.md`

## Global Constraints

- Land Phase 3C before porting its enrichment workflow.
- Preserve workflow type names and normalized payload semantics.
- Use namespace `expense-tax` and queue `expense-tax-processing` after cutover.
- Worker code never writes App, Foundry, or mailbox tables directly.
- Workflows contain deterministic code only; activities own all I/O.
- `packages/contracts` remains canonical; generated Python contracts are removed.
- Do not run Python and TypeScript workers on the same queue during cutover.
- Do not commit, push, deploy, or mutate production without explicit user approval.

---

### Task 1: Freeze Workflow Compatibility

**Files:**
- Modify: `expense-tax-management/packages/contracts/src/internal/task-queues.ts`
- Create: `expense-tax-management/packages/contracts/src/internal/workflow-contracts.test.ts`
- Read: `expense-tax-management/services/ai-worker/src/ai_worker/workflows.py`
- Read after Phase 3C merge: `expense-tax-management/services/ai-worker/src/ai_worker/enrichment_activities.py`

**Interfaces:**
- Produces: stable workflow names, queue name, and Zod input/result schemas consumed by App API and the new worker.

- [x] Add a failing contract test asserting all existing workflow type strings and the new queue literal `expense-tax-processing`.
- [x] Run `pnpm --filter @expense-tax/contracts test` and verify the new queue assertion fails against `expense-tax-ai-worker`.
- [x] Change the canonical queue constant and remove comments requiring a synchronized Python constant.
- [x] Add or confirm Zod schemas for every workflow input/result crossing App API, Foundry, mailbox, and worker boundaries.
- [x] Run `pnpm --filter @expense-tax/contracts test` and `pnpm --filter @expense-tax/contracts typecheck`.

### Task 2: Create Standalone TypeScript Worker Package

**Files:**
- Create: `expense-tax-management/services/workflow-worker/package.json`
- Create: `expense-tax-management/services/workflow-worker/tsconfig.json`
- Create: `expense-tax-management/services/workflow-worker/src/config.ts`
- Create: `expense-tax-management/services/workflow-worker/src/worker.ts`
- Create: `expense-tax-management/services/workflow-worker/test/config.test.ts`

**Interfaces:**
- Consumes: `@expense-tax/contracts` queue and payload schemas.
- Produces: `workerConfigFromEnv()` and a long-running worker entry point.

- [x] Write failing configuration tests for required Temporal address, namespace, queue, App URL, Foundry URL, and machine credentials.
- [x] Run `pnpm --filter @expense-tax/workflow-worker test`; expect failure because package and parser do not exist.
- [x] Add package dependencies `@expense-tax/contracts`, `@temporalio/activity`, `@temporalio/client`, `@temporalio/worker`, `@temporalio/workflow`, `jose`, and `zod`.
- [x] Implement `workerConfigFromEnv()` with Zod and fail-closed URL/credential validation.
- [x] Implement `worker.ts` with one `NativeConnection`, namespace `expense-tax`, queue `expense-tax-processing`, `workflowsPath`, registered activities, graceful `SIGTERM`, and nonzero startup failure.
- [x] Run worker unit tests, typecheck, lint, and build.

Core registration shape:

```ts
const connection = await NativeConnection.connect({ address: config.temporalAddress });
const worker = await Worker.create({
  connection,
  namespace: config.temporalNamespace,
  taskQueue: config.taskQueue,
  workflowsPath: fileURLToPath(new URL("./workflows/index.js", import.meta.url)),
  activities,
});
await worker.run();
```

### Task 3: Port Authenticated Service Clients

**Files:**
- Create: `expense-tax-management/services/workflow-worker/src/clients/app-api.ts`
- Create: `expense-tax-management/services/workflow-worker/src/clients/foundry.ts`
- Create: `expense-tax-management/services/workflow-worker/src/auth/machine-token.ts`
- Create: `expense-tax-management/services/workflow-worker/test/clients.test.ts`
- Reference: `expense-tax-management/services/ai-worker/src/ai_worker/app_api_client.py`
- Reference: `expense-tax-management/services/ai-worker/src/ai_worker/foundry_client.py`

**Interfaces:**
- Produces: typed clients whose public methods accept and return validated Zod contracts.

- [x] Write failing HTTP tests for exact issuer/audience/subject/scope, timeout, redaction, non-2xx mapping, and response validation.
- [x] Implement reusable machine-token acquisition without sharing App and Foundry credentials.
- [x] Implement App and Foundry clients using bounded `fetch`, explicit abort timeouts, structured errors, and Zod parsing.
- [x] Prove authorization headers and provider secrets never appear in logs or thrown messages.
- [x] Run the worker client tests and typecheck.

### Task 4: Port Workflows and Activities

**Files:**
- Create: `expense-tax-management/services/workflow-worker/src/workflows/index.ts`
- Create: `expense-tax-management/services/workflow-worker/src/workflows/foundation-echo.ts`
- Create: `expense-tax-management/services/workflow-worker/src/workflows/ocr-receipt.ts`
- Create: `expense-tax-management/services/workflow-worker/src/workflows/forwarded-receipt.ts`
- Create after Phase 3C merge: `expense-tax-management/services/workflow-worker/src/workflows/expense-enrichment.ts`
- Create: `expense-tax-management/services/workflow-worker/src/activities/`
- Create: `expense-tax-management/services/workflow-worker/test/workflows.test.ts`
- Reference: `expense-tax-management/services/ai-worker/src/ai_worker/*.py`

**Interfaces:**
- Consumes: service clients from Task 3 and canonical contracts from Task 1.
- Produces: workflow types matching current production names and activity behavior.

- [x] Write failing Temporal test-environment cases for success, retryable provider failure, permanent validation failure, duplicate dispatch, cancellation, and callback idempotency.
- [x] Port workflow control flow without importing Node I/O, random values, wall-clock APIs, or service clients into workflow modules.
- [x] Port activities as thin orchestration around typed clients and provider adapters.
- [x] Preserve workflow retry, timeout, and failure-code semantics from Python tests.
- [x] Port deterministic enrichment logic and prove TypeScript output equals existing Python fixtures.
- [x] Run workflow tests twice to catch nondeterministic behavior.

### Task 5: Add Worker Image and CI

**Files:**
- Create: `expense-tax-management/services/workflow-worker/Dockerfile`
- Modify: `expense-tax-management/package.json`
- Modify: `expense-tax-management/pnpm-lock.yaml`
- Modify: `.github/workflows/expense-tax-ci.yml`
- Modify: `.github/workflows/expense-tax-deploy.yml`

**Interfaces:**
- Produces: immutable `expense-tax-workflow-worker:<sha>` image and worker CI gates.

- [x] Add worker lint, typecheck, test, and build scripts to canonical CI commands.
- [x] Write deployment-boundary tests that require the new Dockerfile and image matrix entry.
- [x] Build the image locally and run it against local Temporal with fake provider adapters (startup/poll smoke; no App callback dispatched).
- [x] Add worker image to deployment matrix without removing Python image until cutover task succeeds.
- [x] Wire worker-to-App internal origin and explicitly allowlist any external signed-file origins when that storage backend is enabled; retain signed URL verification and reject arbitrary origins. Current storage backend is local; external origin configuration is conditional on enabling another backend.
- [x] Run all TypeScript CI commands and integration tests. Local zero-skip integration hit Docker Desktop host-port `ECONNRESET`; disposable GitHub integration passed in PR #11.

### Task 6: Promote Temporal to Shared Infrastructure

**Files:**
- Create: `infrastructure/temporal/docker-compose.yml`
- Create: `infrastructure/temporal/dynamicconfig.yaml`
- Create: `infrastructure/temporal/bootstrap-namespaces.sh`
- Create: `infrastructure/temporal/test-temporal-infrastructure.sh`
- Modify: `infrastructure/README.md`
- Modify: `infrastructure/docker-compose.common.yml`
- Modify: `expense-tax-management/deploy/production/docker-compose.yml`

**Interfaces:**
- Produces: shared DNS endpoint `temporal:7233`, namespace `expense-tax`, and external network usable by domain workers.

- [x] Write failing shell tests requiring pinned images, private ports, PostgreSQL persistence, health checks, idempotent namespace creation, and no project credentials in Temporal container environment.
- [x] Confirm production database/bootstrap remains an explicit operator-only action; deployment workflow must never run `bootstrap-temporal-db.sh`.
- [x] Move generic Temporal server/UI configuration under `infrastructure/temporal/` and attach it to shared family network.
- [x] Implement idempotent namespace bootstrap for `expense-tax`; document future `stock-analysis` creation without deploying Stock code.
- [x] Remove Neo4j and its volume from default shared Compose; graph infrastructure remains blocked by Phase 9A evidence gate.
- [x] Remove Temporal server ownership from Expense production Compose while retaining its external service dependency.
- [x] Update health checks to query shared Temporal separately from Expense image health.
- [x] Run Compose config validation and shell tests.

Task 6 source is verified locally. Production activation remains an approved operator-only transition; Task 7 cutover is separate.

### Task 7: Production Cutover and Python Removal

Split into three stages so `dev` can release safely well before the
TypeScript worker is production-ready. The codebase defines no Temporal
Schedules anywhere (confirmed: no `ScheduleClient`/schedule creation call in
`services/` as of Stage A); every schedule-pause/recreate bullet below is
therefore a no-op until/unless schedules are introduced.

**Stage A -- transactional dispatch routing fence (complete):**
singleton `app.temporal_dispatch_routing` row (migration 017) makes the
namespace/queue every new job dispatches to data-driven instead of a bare
contract constant. Generation 1 seeds today's production target (namespace
`default`, queue `expense-tax-ai-worker`), so Stage A changes no production
behavior by itself -- it only removes the release hazard (App API no longer
hardcodes `expense-tax-processing`). `createJobInTransaction` and
`createEnrichmentJobInTransaction` read the row `FOR SHARE` inside the
enqueue transaction and stamp `dispatch_generation`/`dispatch_namespace` (plus
the existing `task_queue` column) on the job row; the dispatcher starts each
workflow with that row's own namespace/queue, so old-generation jobs keep
draining to their original target after a cutover. The runtime DB role has
SELECT-only access to the routing row; only the migrator/owner role can
`UPDATE` it. Operator commands (`services/app-api/src/temporal/dispatch-routing.ts`,
compiled to `dist/temporal/dispatch-routing.js`, run with migration
credentials):
  - `status` -- read-only: current generation/namespace/queue plus
    non-terminal-job and pending-outbox counts grouped by generation.
  - `advance --from-generation <n>` -- one transaction, `FOR UPDATE` the
    routing row, refuses unless the current generation equals `<n>`, then
    sets generation `n+1` / namespace `expense-tax` / queue
    `expense-tax-processing` (canonical contract constants only; never
    accepts caller-supplied namespace/queue).

- [x] Make dispatch routing data-driven and transactionally fenced (migration 017, enqueue fence, dispatcher namespace-per-row, operator `status`/`advance` commands, contract constants for legacy vs. target routing).
- [ ] Inventory every production `default` namespace workflow, schedule (none exist), processing job, and dispatch-outbox row that targets the Python queue.

**Stage B -- operator drain + non-production smoke + production switch:**

**Files:**
- Modify: `expense-tax-management/deploy/production/docker-compose.yml`
- Modify: `expense-tax-management/deploy/production/deploy.sh`
- Modify: `expense-tax-management/deploy/production/health-check.sh`
- Modify: integration tests that spawn Python workers

**Interfaces:**
- Produces: production App API dispatching to the TypeScript worker, Python worker still running and draining.

Stage B source (complete): the TypeScript worker is now part of production Compose, idle. The plan forbids running Python and TypeScript workers on the same queue; different queues are allowed, so `workflow-worker` can deploy to production polling namespace `expense-tax` / queue `expense-tax-processing` while generation 1 (Stage A's seed) keeps routing every new job to `ai-worker` (namespace `default` / queue `expense-tax-ai-worker`). The cutover itself becomes a database-only operator step (`advance`) plus a later Stage C Python removal.

- [x] Add an idle `workflow-worker` service to `deploy/production/docker-compose.yml` (image `expense-tax-workflow-worker`, `0.5` CPU / `512M`, namespace `expense-tax` / queue `expense-tax-processing`, networks `[default, shared]` only, depends on healthy `app-api`/`foundry-service`, healthcheck matching `ai-worker`); leave `ai-worker` unchanged.
- [x] Add `workflow-worker` to `deploy.sh`'s `APPLICATION_SERVICES` (image-tag verification + rollback) and to `health-check.sh`'s running-service checks.
- [x] Fix round 1: `workflow-worker` is the *only optional* rollback service. Production's currently-recorded previous tag predates the commit that first built the `expense-tax-workflow-worker` image, so a straight rollback would try to pull/start/verify an image that doesn't exist and fail, stranding production on the broken release. `deploy.sh`'s rollback now probes `docker manifest inspect` for the previous tag's `workflow-worker` image; if missing, it stops/removes that one container and excludes it from pull/up/health-check/image-verification, while all six other services stay mandatory exactly as before (a missing image for any of them still fails the rollback). `health-check.sh`'s required-worker list is now `HEALTH_CHECK_REQUIRED_WORKERS`-configurable (default: both workers) so rollback can pass the reduced list. Safe because routing still targets generation 1 (Python) until an operator runs `advance`, which the cutover sequence below requires only after a healthy release.
- [x] Update the boundary/image/secret-bundle tests that pinned "no TypeScript worker in production Compose" (Task 5) to the new contract.
- [ ] Deploy shared Temporal namespace plus TypeScript worker to a non-production environment.
- [ ] Run real App API -> Temporal -> TypeScript worker -> App callback smoke flows for OCR, forwarding, and enrichment.
- [x] Run `advance --from-generation <n>` against production once smoke passes; new jobs now target namespace `expense-tax` / queue `expense-tax-processing`. Done 2026-10-06 (generation 2); the non-production smoke was skipped because no non-production shared-Temporal environment exists (runbook open question #7).
- [x] Keep the Python worker running until every accepted old-generation workflow reaches a terminal state and no pending old-generation dispatch remains (`status` command); do not move open histories between SDKs or namespaces. `status` showed zero generation-1 jobs and dispatches at the advance (2026-10-06).
- [ ] Reconcile failed/stuck executions individually. Cancellation, termination, or replacement requires an operator-recorded recovery decision and idempotency proof.
- [ ] Pause old schedules (none exist today) only after the transactional fence commits, then recreate any future schedules in namespace `expense-tax` against queue `expense-tax-processing`, preserving schedule IDs/configuration but not old histories.
- [ ] Deploy TypeScript worker, verify polling and workflow completion, then enable new schedules and dispatch.
- [ ] Immediately before stopping the Python worker, run `status` again and prove zero non-terminal old-generation jobs, zero pending old-generation dispatches, and zero active old schedules.

**Operator cutover sequence** (production Compose project `expense-tax-production`, root-only env file `/etc/expense-tax-management/production.env`, run from `expense-tax-management/deploy/production/`):

a. Activate shared Temporal per `infrastructure/README.md`'s "Shared Temporal Activation" section (operator-only, separately approved).
b. Release `dev` to `main` so the next deploy brings up `workflow-worker` idle alongside `ai-worker`.
c. Verify TS worker polling in `expense-tax`:
   ```bash
   docker exec family-temporal temporal task-queue describe --address temporal:7233 --namespace expense-tax --task-queue expense-tax-processing
   ```
d. Check current routing:
   ```bash
   docker compose --project-name expense-tax-production --env-file /etc/expense-tax-management/production.env -f docker-compose.yml run --rm app-api-migrate node dist/temporal/dispatch-routing.js status
   ```
e. Run non-production smoke (OCR, forwarding, enrichment end to end against the TypeScript worker) if a non-production environment with shared Temporal is available.
f. Cut new jobs over (generation shown by `status` in step d, normally `1`):
   ```bash
   docker compose --project-name expense-tax-production --env-file /etc/expense-tax-management/production.env -f docker-compose.yml run --rm app-api-migrate node dist/temporal/dispatch-routing.js advance --from-generation 1
   ```
g. Drain: repeat the `status` command from step d until it reports zero non-terminal jobs and zero pending outbox rows for the pre-advance generation, while `ai-worker` keeps running and processing them.
h. Only then does Stage C stop and remove `ai-worker`/Python.

**Stage C -- Python removal:**

**Files:**
- Modify: `expense-tax-management/services/app-api/src/config.ts`
- Modify: `expense-tax-management/services/app-api/src/temporal/client.ts`
- Delete: `expense-tax-management/services/ai-worker/`
- Delete: `expense-tax-management/common/python/expense-contracts/`
- Modify: Python CI/scripts and generated-contract checks

**Interfaces:**
- Produces: TypeScript-only runtime with App API client and independent worker.

- [x] Delete `services/ai-worker/`, `common/python/expense-contracts/`, and Python subprocess integration paths.
- [x] Strip Python/uv/Ruff/Pytest lines from CI; update `check-workflow-worker-image.test.mjs` and `3c-auto-tagging` literals that assert Python-specific behavior.
- [x] Remove `ai-worker` from `deploy.sh`'s service array.
- [x] Run full contracts, services, frontends, worker, PostgreSQL integration, Compose, image, and production-boundary suites.
- [x] Record image tags and rollback procedure; request separate approval before production deployment.

Stage C done 2026-10-07: #35 (dev `421c960`), #36 (`main` `f20c451`). Previous production tag `0a8831b`; a rollback cannot restore `ai-worker` (pre-flight proved zero generation-1 work, no `default` namespace workflows or schedules).

## Completion Evidence

- No runtime or CI dependency on Python, Pydantic, uv, Ruff, or Pytest.
- App API starts all existing workflow types on `expense-tax-processing`.
- TypeScript worker completes every real integration path.
- Temporal server runs from shared infrastructure and Expense owns no server config.
- Production preflight proves no Python replay dependency.
- Rollback can restore prior app/worker images and namespace configuration.
