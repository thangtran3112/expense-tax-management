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

**Files:**
- Modify: `expense-tax-management/deploy/production/docker-compose.yml`
- Modify: `expense-tax-management/deploy/production/deploy.sh`
- Modify: `expense-tax-management/deploy/production/health-check.sh`
- Modify: `expense-tax-management/services/app-api/src/config.ts`
- Modify: `expense-tax-management/services/app-api/src/temporal/client.ts`
- Modify: integration tests that spawn Python workers
- Delete: `expense-tax-management/services/ai-worker/`
- Delete: `expense-tax-management/common/python/expense-contracts/`
- Modify: Python CI/scripts and generated-contract checks

**Interfaces:**
- Produces: TypeScript-only runtime with App API client and independent worker.

- [ ] Inventory every production `default` namespace workflow, schedule, processing job, and dispatch-outbox row that targets the Python queue.
- [ ] In one App PostgreSQL transaction, advance a cutover generation and close old-queue dispatch. Every enqueue/outbox write must lock/check that generation in its own transaction so no old-queue job can cross the fence.
- [ ] Pause old schedules only after the transactional fence commits, then drain all old-generation outbox rows.
- [ ] Keep the Python worker running until every accepted old-queue workflow reaches a terminal state and no pending dispatch can create another; do not move open histories between SDKs or namespaces.
- [ ] Reconcile failed/stuck executions individually. Cancellation, termination, or replacement requires an operator-recorded recovery decision and idempotency proof.
- [ ] Immediately before stopping Python worker, take the dispatch-generation lock again and prove zero open old-queue workflows, zero pending old-generation dispatches, and zero active old schedules in the same fenced window.
- [ ] Deploy shared Temporal namespace plus TypeScript worker to a non-production environment.
- [ ] Run real App API -> Temporal -> TypeScript worker -> App callback smoke flows for OCR, forwarding, and enrichment.
- [ ] Recreate paused schedules in namespace `expense-tax` against queue `expense-tax-processing`, preserving schedule IDs/configuration but not old histories.
- [ ] Switch App API to namespace `expense-tax` and queue `expense-tax-processing` only after drain and smoke success.
- [ ] Deploy TypeScript worker, verify polling and workflow completion, then enable new schedules and dispatch.
- [ ] Remove Python image, package, generated contracts, uv locks, Ruff/Pytest CI, and Python subprocess integration paths.
- [ ] Run full contracts, services, frontends, worker, PostgreSQL integration, Compose, image, and production-boundary suites.
- [ ] Record image tags and rollback procedure; request separate approval before production deployment.

## Completion Evidence

- No runtime or CI dependency on Python, Pydantic, uv, Ruff, or Pytest.
- App API starts all existing workflow types on `expense-tax-processing`.
- TypeScript worker completes every real integration path.
- Temporal server runs from shared infrastructure and Expense owns no server config.
- Production preflight proves no Python replay dependency.
- Rollback can restore prior app/worker images and namespace configuration.
