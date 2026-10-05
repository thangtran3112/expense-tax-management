# Runtime TypeScript Temporal Migration Handoff

## Purpose

Continue the Expense Tax runtime migration from the legacy Python Temporal
worker to a TypeScript worker. Work continues on `dev` from the latest
`origin/dev` commit containing this handoff.

Authoritative plan:

`expense-tax-management/plans/sub-plans/runtime-typescript-temporal-migration.md`

This file records execution state and approved decisions. The authoritative
plan remains the source of truth for scope and acceptance criteria.

## Repository State

- Repository: `https://github.com/thangtran3112/family-app.git`
- Branch: `dev`
- Package root: `expense-tax-management/`
- Completed migration tasks: 1, 2, and 3
- Next task: Task 4, Port Workflows and Activities
- Task 4 design: approved, not implemented
- Deployment or production mutation performed: none
- Python worker removal performed: none

For a fresh clone on the new machine:

```bash
git clone https://github.com/thangtran3112/family-app.git
cd family-app
git switch dev
cd expense-tax-management
pnpm install --frozen-lockfile
```

For USB transfer, copy the real repository root, including hidden files:

`/Users/toby.tran/personal/family-app`

Do not copy only `.worktrees/dev`; its `.git` file points back to the real
repository and is not independently portable. The real repository contains
the local `dev` branch, Git object database, uncommitted local planning work,
and ignored `expense-tax-management/.env` file.

After copying the real repository to the new machine, preserve the dirty main
checkout and create a separate development worktree:

```bash
cd family-app
git worktree prune
git worktree add ../family-app-dev dev
cp expense-tax-management/.env ../family-app-dev/expense-tax-management/.env
cd ../family-app-dev/expense-tax-management
pnpm install --frozen-lockfile
```

The `.env` file is intentionally ignored and is not available from GitHub.
Copy it only through the trusted USB transfer; never commit it.

Ignored-file audit found this one local environment file:

- `expense-tax-management/.env`

It currently contains `TEMPORAL_HOST` and `TEMPORAL_NAMESPACE`, but not the
new worker-specific keys below. Provision real local values before Task 5 runs
the TypeScript worker; do not invent or commit credentials:

- `AI_WORKER_TASK_QUEUE`
- `APP_API_BASE_URL`
- `FOUNDRY_BASE_URL`
- `CLERK_ISSUER_URL`
- `CLERK_JWKS_URL`
- `CLERK_APP_SERVICE_AUDIENCE`
- `CLERK_APP_MACHINE_SECRET_KEY`
- `CLERK_APP_SERVICE_SUBJECT`
- `CLERK_FOUNDRY_SERVICE_AUDIENCE`
- `CLERK_FOUNDRY_MACHINE_SECRET_KEY`
- `CLERK_FOUNDRY_SERVICE_SUBJECT`

## Frozen Decisions

- Temporal namespace: `expense-tax`
- TypeScript worker task queue: `expense-tax-processing`
- Legacy Python worker task queue remains `expense-tax-ai-worker` until cutover.
- Never run Python and TypeScript workers on the same task queue.
- Workflow names remain exactly:
  - `FoundationEchoWorkflow`
  - `OcrReceiptWorkflow`
  - `ForwardedReceiptWorkflow`
  - `ExpenseEnrichmentWorkflow`
- Every workflow accepts strict `JobReferenceV1` and returns `void`.
- Breaking transitional compatibility is acceptable because the system is not
  in active use.
- Root CI script integration is deferred to Task 5.
- TypeScript Temporal dependencies are pinned exactly to `1.23.0`.
- `@swc/core` is explicitly allowed in `pnpm-workspace.yaml`.
- No commit, push, deploy, or production mutation should occur implicitly in a
  future session. Verify and state intent first.

## Completed Work

### Task 1: Freeze Contracts and Task Queue

- Changed canonical TypeScript queue to `expense-tax-processing`.
- Added and exported `WorkflowTypeSchema`, `WorkflowType`,
  `WorkflowResultSchema`, and `WorkflowResult`.
- Restricted `JobReferenceV1Schema.workflowType` to the four frozen workflow
  names.
- Updated fixture, generated JSON Schema, and generated Python contracts.
- Narrowed App API workflow inputs to `WorkflowType`.
- Added runtime parsing for persisted job references.
- Restricted OCR override to OCR and forwarded-receipt workflows.
- Documented intentional Python queue divergence.

Key files:

- `packages/contracts/src/internal/task-queues.ts`
- `packages/contracts/src/internal/job-reference-v1.ts`
- `packages/contracts/test/workflow-contracts.test.ts`
- `packages/contracts/fixtures/job-reference-v1.json`
- `services/app-api/src/domain/processing-jobs.ts`
- `services/app-api/src/temporal/client.ts`
- `services/app-api/src/domain/ocr.ts`
- `services/ai-worker/src/ai_worker/constants.py`

### Task 2: TypeScript Worker Scaffold

- Created private package `@expense-tax/workflow-worker`.
- Added strict Zod environment parsing.
- Added fixed namespace and queue validation.
- Added HTTP(S) service-origin validation and HTTPS Clerk validation.
- Added machine ID, secret format, and placeholder rejection.
- Added one `NativeConnection`, worker creation, signal shutdown, 30-second
  grace period, connection cleanup, and redacted startup failure.
- Added exact Temporal `1.23.0` dependencies and JOSE JWT dependency.
- Worker currently points to `src/workflows/index.ts`, which Task 4 must create.
  It must not be run before Task 4 is complete.

Key files:

- `services/workflow-worker/package.json`
- `services/workflow-worker/src/config.ts`
- `services/workflow-worker/src/worker.ts`
- `services/workflow-worker/test/config.test.ts`
- `services/workflow-worker/test/worker.test.ts`

### Task 3: Authenticated Service Clients

- Added reusable Clerk machine-token provider with token caching and
  single-flight refresh.
- Added RS256 signature verification through Clerk JWKS.
- Enforced exact issuer, subject, audience, scope set, expiry, not-before, and
  token ID claims.
- Added a shared acquisition deadline across token endpoint fetch, body read,
  JWKS fetch, and verification.
- Disabled token-endpoint redirects and bounded response cleanup.
- Distinguished rejected credentials, invalid tokens, provider outages, and
  timeouts without exposing credentials or provider bodies.
- Added typed App API and Foundry clients with strict Zod parsing.
- Isolated token scopes:
  - App jobs: `jobs:write files:read`
  - App enrichment input: `jobs:enrichment-input`
  - App enrichment result: `jobs:enrichment-result`
  - Foundry routes: `routes:read`
  - Foundry reservations: `reservations:write`
- Added full-request deadlines, structured status mappings, disabled
  redirects, bounded response cleanup, and redacted errors.
- Added signed-download origin allowlisting. The App API origin is allowed by
  default; external object-storage origins must be supplied explicitly.
- Added SSRF rejection for unallowlisted signed URLs.
- `CLERK_JWKS_URL` is now required. Deployment wiring belongs in a later
  infrastructure/configuration task before worker startup.

Key files:

- `services/workflow-worker/src/auth/machine-token.ts`
- `services/workflow-worker/src/clients/app-api.ts`
- `services/workflow-worker/src/clients/foundry.ts`
- `services/workflow-worker/test/clients.test.ts`

Latest focused Task 3 verification before handoff creation:

- Worker tests: 75 passed
- Worker typecheck: passed
- Worker lint: passed
- Worker build: passed
- Final independent review: no findings

## Task 4 Approved Design

Use a faithful direct port, not a generalized workflow framework.

- Export four exact named workflow functions.
- Implement `ForwardedReceiptWorkflow` through a shared deterministic OCR
  function, not a child workflow. A child workflow would change history and
  failure semantics.
- Keep workflow modules deterministic: only Temporal workflow APIs,
  `proxyActivities`, branching, and `ApplicationFailure`.
- Do not import Node I/O, service clients, random values, wall-clock APIs, or
  provider SDKs into workflow modules.
- Build an activity factory that injects App API client, Foundry client, and
  OCR provider adapter.
- Preserve Python activity order, expected-version chaining, fixed
  idempotency keys, failure types, and sanitized messages.
- Preserve activity timeouts:
  - Standard HTTP activities: 30 seconds
  - Download and extraction: 60 seconds
- Preserve retries:
  - HTTP activities: maximum 5 attempts
  - Extraction and release: maximum 2 attempts
- Preserve quota conflict mapping to typed `QUOTA_BLOCKED` failure.
- On extraction failure, attempt reservation release before failed callback.
- Submit OCR success before deduplication callback.
- Deduplication failure must never mutate an already-succeeded job to FAILED.
- Keep enrichment GET, evaluate, and POST in one retried process activity so
  retries re-read current input.
- Port pure enrichment evaluator exactly: rule order, eligibility, thresholds,
  tie handling, suggestion order, confidence, and evidence hashes.
- Add `@temporalio/testing@1.23.0` for TypeScript Temporal tests.
- Test success, retryable provider failure, permanent validation failure,
  duplicate workflow start, cancellation, callback idempotency, forwarded
  delegation, and Python enrichment fixture parity.
- Run workflow tests twice to detect nondeterminism.

Python parity references:

- `services/ai-worker/src/ai_worker/workflows.py`
- `services/ai-worker/src/ai_worker/activities.py`
- `services/ai-worker/src/ai_worker/ocr_activities.py`
- `services/ai-worker/src/ai_worker/enrichment_activities.py`
- `services/ai-worker/src/ai_worker/enrichment.py`
- `services/ai-worker/src/ai_worker/providers/fake_ocr.py`
- `services/ai-worker/tests/test_workflows.py`
- `services/ai-worker/tests/test_ocr_workflow.py`
- `services/ai-worker/tests/test_ocr_activities.py`
- `services/ai-worker/tests/test_enrichment.py`

## Task 4 Parity Checklist

- Preserve `FoundationEchoWorkflow`: mark RUNNING, then submit echo result,
  chaining returned versions; 30-second activities; no explicit retry policy.
- Preserve OCR activity order:
  1. Load OCR input.
  2. Download and validate receipt bytes.
  3. Resolve Foundry route.
  4. Reserve quota.
  5. Mark provider call started.
  6. Run extraction.
  7. Record accepted outcome.
  8. Submit extraction success.
  9. Record deduplication evidence.
- Preserve forwarded-receipt behavior as standard OCR delegation.
- Preserve fixed OCR idempotency keys, including
  `<jobId>:ocr:reserve:v1`, result keys, and `<jobId>:ocr:dedup:v1`.
- Preserve enrichment keys:
  - `<jobId>:enrichment:status:running`
  - `<jobId>:enrichment:result:v1`
  - `<jobId>:enrichment:status:failed`
- Preserve five transient enrichment attempts and one attempt for permanent
  non-408/non-429 4xx failures.
- Preserve enrichment failure callback before rethrowing Temporal failure.
- Preserve stale/skipped results with empty suggestions.
- Add no new cancellation cleanup semantics beyond Python behavior; test that
  cancellation stops current work and schedules no later callbacks.

## Remaining Plan

Complete Tasks 4 through 7 in the authoritative plan:

1. Port workflows and activities.
2. Add worker image and CI.
3. Promote Temporal to shared infrastructure.
4. Deploy TypeScript worker dark.
5. Cut over dispatch.
6. Remove Python worker and clean up.
7. Complete final verification and rollback evidence.

Do not remove the Python worker image during Task 5. Keep it available until
the cutover task has succeeded and rollback evidence exists.

## TDD and Verification

Task 4 implementation must use red-green-refactor:

1. Add one failing workflow or parity test.
2. Run it and confirm expected failure.
3. Add minimum production code.
4. Run focused test to green.
5. Repeat.
6. Run complete worker tests twice.
7. Run typecheck, lint, and build.
8. Request independent review before marking Task 4 complete.

Expected worker commands:

```bash
pnpm --filter @expense-tax/workflow-worker test
pnpm --filter @expense-tax/workflow-worker test
pnpm --filter @expense-tax/workflow-worker typecheck
pnpm --filter @expense-tax/workflow-worker lint
pnpm --filter @expense-tax/workflow-worker build
```

Task 1 verification commands remain useful after contract changes:

```bash
pnpm --filter @expense-tax/contracts test
pnpm --filter @expense-tax/contracts typecheck
pnpm --filter @expense-tax/contracts lint
pnpm --filter @expense-tax/contracts build
pnpm --filter @expense-tax/contracts check-generated
pnpm --filter @expense-tax/app-api test
pnpm --filter @expense-tax/app-api typecheck
pnpm --filter @expense-tax/app-api lint
```

Run Python contract and worker tests whenever generated Python contracts,
legacy constants, or parity logic changes.

## Known Notes

- `services/workflow-worker/src/worker.ts` still passes `activities: {}`.
  Task 4 must replace this with real injected activities.
- TypeScript Temporal test environment is not installed yet.
- No `.codegraph/` index exists for this checkout. Use normal repository search
  or initialize codegraph explicitly on the new machine if desired.
- App API has a pre-existing local enrichment transport schema matching the
  canonical contract. Task 3 client validates against canonical schemas; avoid
  unrelated schema refactoring during Task 4.
- Generated worker `dist/` output is ignored and must not be committed.
- Keep errors structured and sanitized. Never include authorization headers,
  machine secrets, JWTs, signed URLs, provider bodies, or raw provider errors
  in thrown messages or logs.

## Completion Definition

Migration is complete only when all seven tasks in the authoritative plan are
checked, CI is green, TypeScript dispatch is active, rollback evidence exists,
and Python worker removal has been verified. Task 3 completion alone is not a
runtime cutover.
