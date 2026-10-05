# Phase 3C Auto-Tagging and Categorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Ready; not started. Execute before any Phase 3D plan from a fresh `feature/*` worktree based on current `origin/dev`.

**Goal:** Add deterministic rule tagging and review-only historical enrichment for Personal and Business expenses, delivered through a separate durable Temporal workflow with scope-safe App API ownership and Office review.

**Architecture:** App API creates ready expenses and enrichment jobs/outbox rows in the same PostgreSQL transaction for manual, OCR, and forwarded-email paths. Temporal history stores only `JobReferenceV1`; the Python worker fetches minimized, job-bound input, evaluates pure rules/history, and submits a versioned result. App API recomputes and validates all output, auto-applies rule tags, stores pending historical suggestions, and exposes scope-authorized tag/suggestion APIs to Office Web.

**Tech Stack:** TypeScript Fastify/Kysely/Zod, PostgreSQL migrations/triggers, generated OpenAPI/JSON Schema/TypeScript/Python contracts, Python Temporal/httpx/Pydantic, Next.js Office Web, Vitest, Pytest, disposable PostgreSQL integration tests.

**Spec:** `docs/superpowers/specs/2026-09-12-phase-3c-auto-tagging-design.md`

## Global Constraints

- App API remains sole owner and writer of customer data; Python has no App or Foundry database credentials.
- No live LLM, embedding, paid provider, Foundry catalog operation, provider route, quota, prompt, or model call is added.
- Rules auto-apply only deterministic rule tags; historical tag, spending-category, and tax-category candidates remain pending until user acceptance.
- Spending-category automation never mutates an expense automatically.
- Business tax automation emits only an active tax-category ID; it never supplies deductible percentage, filing treatment, or reviewed status.
- Enrichment is a separate follow-up workflow; failure changes only enrichment job state and never expense/OCR/forwarded/dedup state.
- Every table, query, callback, suggestion, tag association, and job is constrained to one tenant and exactly one Personal profile or Business scope.
- Worker input/result contains no raw OCR text, receipt bytes, tenant/profile/business selectors, or tax details outside the bounded candidate/history facts required by the contract.
- Manual decisions outrank accepted historical decisions, which outrank rules; removed/manual decisions cannot be overwritten by automation.
- Permanent canonical operation keys and database uniqueness remain authoritative after generic HTTP idempotency records expire.
- A valid enrichment callback always completes its job with `SUCCEEDED` and result `outcome: "applied" | "stale" | "skipped"`; `FAILED` is reserved for actual inference/callback errors.
- `tagId` query parameters use server-side AND semantics and cursor filter hashes preserve filters across pages.
- Existing transitional `expense-service`, `frontend/web`, and other non-canonical transitional surfaces remain unchanged.
- Office supports both Personal and Business explicit scopes; Capture may display refreshed applied tags but remains outside tag management/review.

---

## Exact File Map

**Create:**

- `expense-tax-management/services/app-api/src/database/migrations/016_expense_enrichment.ts` - tags, applied tags, append-only category decisions, suggestions, permanent operation keys, constraints, indexes, backfill.
- `expense-tax-management/packages/contracts/src/enrichment.ts` - public tag/suggestion/list/resolve/rerun contracts.
- `expense-tax-management/packages/contracts/src/internal/expense-enrichment-input-v1.ts` - minimized worker input contract.
- `expense-tax-management/packages/contracts/src/internal/expense-enrichment-result-v1.ts` - worker result contract.
- `expense-tax-management/services/app-api/src/domain/tags.ts` - tenant tag CRUD/merge and scope association operations.
- `expense-tax-management/services/app-api/src/domain/enrichment.ts` - input projection, deterministic validation/application, suggestion resolution, re-run.
- `expense-tax-management/services/app-api/src/domain/spending-categories.ts` - category archival invalidation for pending suggestions.
- `expense-tax-management/services/app-api/src/routes/tags.ts` - tenant tag endpoints and scope expense-tag endpoints.
- `expense-tax-management/services/app-api/src/routes/enrichment.ts` - scope suggestion list/resolve/re-run endpoints.
- `expense-tax-management/services/app-api/test/tags.test.ts` - route/domain unit coverage.
- `expense-tax-management/services/app-api/test/enrichment.test.ts` - rules/application/security unit coverage.
- `expense-tax-management/services/app-api/test/spending-categories.test.ts` - category archival invalidation coverage.
- `expense-tax-management/services/app-api/test/tax.test.ts` - tax profile/taxonomy/treatment invalidation coverage.
- `expense-tax-management/services/app-api/test/database-enrichment.test.ts` - PostgreSQL constraint and trigger coverage.
- `expense-tax-management/packages/contracts/test/enrichment.test.ts` - public contract schema coverage.
- `expense-tax-management/packages/contracts/test/enrichment-contracts.test.ts` - worker input/result security coverage.
- `expense-tax-management/services/ai-worker/src/ai_worker/enrichment.py` - pure rule/history evaluator and Temporal activities.
- `expense-tax-management/services/ai-worker/tests/test_enrichment.py` - deterministic evaluator/activity tests.
- `expense-tax-management/test/integration/app-domain-3c-auto-tagging.test.ts` - real PostgreSQL migration, transaction, scope, replay, merge, and stale-state coverage.
- `expense-tax-management/test/integration/zero-skip-regression.test.ts` - explicit Phase 3C regression that fails on unexpected skipped tests.

**Modify:**

- `expense-tax-management/packages/contracts/src/index.ts` - export new contracts.
- `expense-tax-management/packages/contracts/src/processing-jobs.ts` - add `EXPENSE_ENRICHMENT_WORKFLOW_TYPE`, `EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION`, and enrichment job result fields.
- `expense-tax-management/services/app-api/src/database/types.ts` - add Kysely table interfaces and `AppDatabase` entries.
- `expense-tax-management/services/app-api/src/domain/expenses.ts` - create enrichment job in manual transaction, append category decisions, add active tag projection and server tag filters, invalidate pending suggestions on manual edits.
- `expense-tax-management/services/app-api/src/domain/processing-jobs.ts` - add `createEnrichmentJobInTransaction`, job-bound input/result handling, stale/failed outcomes, permanent result operation key.
- `expense-tax-management/services/app-api/src/domain/ocr.ts` - ensure `applyOcrExtraction` creates exactly one enrichment job after ready expense materialization in same transaction.
- `expense-tax-management/services/app-api/src/domain/inbound-email.ts` - preserve forwarded materialization transaction boundary and invoke shared enrichment job helper through OCR materialization.
- `expense-tax-management/services/app-api/src/domain/tax.ts` - bind full tax snapshot/version checks and invalidate pending tax suggestions after profile/treatment changes.
- `expense-tax-management/services/app-api/src/domain/spending-categories.ts` - supersede pending category suggestions when category is archived.
- `expense-tax-management/services/app-api/src/routes/expenses.ts` - expose repeated `tagId` query values and return tag chips in list/detail responses through canonical contracts.
- `expense-tax-management/services/app-api/src/routes/jobs.ts` - register worker input/result routes with exact M2M subject and route scopes.
- `expense-tax-management/services/app-api/src/config.ts` - load exact enrichment worker subject/audience/scope environment values.
- `expense-tax-management/services/app-api/src/app.ts` - construct/register tag and enrichment domains/routes.
- `expense-tax-management/services/app-api/src/pagination/cursor.ts` - include tag filter values in canonical ledger filter hash.
- `expense-tax-management/services/app-api/test/expenses.test.ts` - assert tag query forwarding and manual edit invalidation.
- `expense-tax-management/services/app-api/test/ocr.test.ts` - assert enrichment follows OCR/forwarded materialization.
- `expense-tax-management/services/app-api/test/jobs.test.ts` - assert worker binding, version transitions, stale result, permanent replay, and callback authorization.
- `expense-tax-management/services/app-api/test/tax.test.ts` - assert profile/taxonomy/category/treatment version invalidation.
- `expense-tax-management/services/ai-worker/src/ai_worker/app_api_client.py` - add generated enrichment input/result/status methods with current M2M auth.
- `expense-tax-management/services/ai-worker/src/ai_worker/config.py` - load enrichment route scopes while preserving current M2M subject/audience/files scope.
- `expense-tax-management/services/ai-worker/src/ai_worker/workflows.py` - add `ExpenseEnrichmentWorkflow` using opaque reference and bounded retries.
- `expense-tax-management/services/ai-worker/src/ai_worker/run_worker.py` - register workflow and activities.
- `expense-tax-management/services/ai-worker/tests/test_service_clients.py` - callback payload/auth/retry tests.
- `expense-tax-management/services/ai-worker/tests/test_config.py` - exact enrichment subject/audience/scope environment tests.
- `expense-tax-management/services/ai-worker/tests/test_workflows.py` - workflow history and activity-order tests.
- `expense-tax-management/frontend/office-web/src/lib/session.ts` - replace Business-only session with discriminated Personal/Business scope.
- `expense-tax-management/frontend/office-web/src/lib/api.ts` - generated clients for tags, suggestions, reruns, filtered cursor ledger, and tax acceptance.
- `expense-tax-management/frontend/office-web/src/lib/page-data.ts` - scope-aware loaders and cursor/filter preservation.
- `expense-tax-management/frontend/office-web/src/app/(office)/expenses/page.tsx` - active chips, AND tag filters, server pagination, and review status.
- `expense-tax-management/frontend/office-web/src/app/(office)/settings/page.tsx` - tag create/rename/archive/unarchive/merge UI.
- `expense-tax-management/frontend/office-web/src/app/(office)/layout.tsx` - pass selected explicit scope into Office pages.
- `expense-tax-management/frontend/office-web/src/components/office-shell.tsx` - Personal/Business scope selector and tag settings navigation.
- `expense-tax-management/frontend/office-web/src/lib/api.test.ts` - request semantics and stale/conflict tests.
- `expense-tax-management/frontend/office-web/src/lib/page-data.test.ts` - cursor/filter persistence tests.
- `expense-tax-management/frontend/office-web/src/lib/enrichment.test.ts` - review-state and acceptance payload tests.
- `expense-tax-management/frontend/office-web/src/lib/fixtures.ts` - fixtures for tags/suggestions/scopes.
- `expense-tax-management/frontend/office-web/src/app/(office)/dashboard/page.tsx` - scope-aware dashboard consumer.
- `expense-tax-management/frontend/office-web/src/app/(office)/businesses/page.tsx` - scope selection/business consumer.
- `expense-tax-management/frontend/office-web/src/app/(office)/projects/page.tsx` - scope-aware project consumer.
- `expense-tax-management/frontend/office-web/src/app/(office)/tax/page.tsx` - Business tax consumer with explicit Business scope.
- `expense-tax-management/frontend/office-web/src/app/(office)/exports/page.tsx` - Business export consumer with explicit Business scope.
- `expense-tax-management/frontend/office-web/src/app/(office)/forwarding/page.tsx` - scope-aware forwarding consumer.
- `expense-tax-management/frontend/office-web/src/app/(office)/duplicates/page.tsx` - scope-aware duplicate review consumer.
- `expense-tax-management/frontend/office-web/src/app/login/page.tsx` - selected-scope initialization consumer.
- `expense-tax-management/frontend/office-web/src/app/page.tsx` - root redirect/session consumer.
- `expense-tax-management/frontend/office-web/src/components/office-data.tsx` - scope/session loading boundary.
- `expense-tax-management/frontend/office-web/src/lib/fixtures.test.ts` - Personal/Business fixture coverage.
- `expense-tax-management/frontend/office-web/src/lib/clerk.test.ts` - scope authorization coverage.
- `expense-tax-management/frontend/office-web/src/app/styles.css` - accessible chips, evidence panel, conflict/loading/empty states.
- `expense-tax-management/packages/contracts/generated/openapi/app-api.openapi.json` - generated API schema.
- `expense-tax-management/packages/contracts/generated/json-schema/*.schema.json` - generated internal/public schemas.
- `expense-tax-management/packages/contracts/generated/typescript/app-api.paths.ts` - generated TypeScript client paths.
- `expense-tax-management/common/python/expense-contracts/src/expense_contracts/generated/*` - generated Python Pydantic models.

**Do not modify:** any path under `expense-tax-management/expense-service`, `expense-tax-management/frontend/web`, or Foundry catalog/provider implementation files.

## Cross-Task Interfaces

- `Scope = { kind: "personal"; profileId: string } | { kind: "business"; businessId: string }` is used by App domains, routes, integration fixtures, and Office session.
- `createEnrichmentJobInTransaction(transaction, binding)` accepts `{ tenantId, scope, expenseId, expectedExpenseVersion, requestedByUserId, requestId }` and returns `ProcessingJob`; it writes `workflowType: "ExpenseEnrichmentWorkflow"`, `allowedResultSchemaVersion: "expense-enrichment-v1"`, AI worker queue, target expense/version, and one pending dispatch outbox row.
- `ExpenseEnrichmentInputV1` contains `{ schemaVersion: 1, jobId, expenseId, expenseVersion, normalizedMerchant, incurredOn, spendingCategoryId, rulesVersion, eligibleTagKeys, eligibleSpendingCategoryIds, eligibleTaxSnapshot, history }`; `history` contains only bounded aggregate facts and `eligibleTaxSnapshot` is either null for Personal or `{ businessTaxProfileId, businessTaxProfileVersion, taxonomyVersionId, taxYear, activeTaxCategoryIds }` for Business.
- `ExpenseEnrichmentInputResponseV1` is `{ outcome: "evaluate"; input: ExpenseEnrichmentInputV1 } | { outcome: "stale" | "skipped" }`. Input route never mutates job state. Worker branches on response: evaluate normally, or submit a no-mutation result carrying returned terminal outcome.
- `ExpenseEnrichmentResultV1` contains `{ schemaVersion: 1, rulesVersion, outcome: "applied" | "stale" | "skipped", ruleTagKeys, suggestions }`; each suggestion has `{ kind, candidateId, source: "historical", confidence, evidence, evidenceHash }` and never deductible percentage/review status. `stale` and `skipped` are successful no-mutation outcomes.
- `getEnrichmentInput({ jobId, actorServicePrincipal, requestId })` returns `ExpenseEnrichmentInputResponseV1`, resolves all target/scope/candidates from job row, and lets worker stop evaluation for stale/skipped targets without guessing; worker cannot choose target selectors.
- `submitEnrichmentResult({ jobId, expectedJobVersion, result, idempotencyKey, actorServicePrincipal, requestId })` rechecks job/workflow/scope/expense version, recomputes rule output, applies rule tags and pending suggestions transactionally, and completes the job `SUCCEEDED` with `outcome: "applied" | "stale" | "skipped"`.
- `ExpenseEnrichmentResultV1` uses `outcome: "applied"` when mutations were committed, `"stale"` when expense version changed, and `"skipped"` when target was archived or already terminal; both non-applied outcomes make no customer mutations. Only transport/inference failure invokes `FAILED`.
- Bounded tax input may contain only opaque profile/taxonomy/category UUIDs, profile version, taxonomy tax year, and active category ID list: `{ businessTaxProfileId, businessTaxProfileVersion, taxonomyVersionId, taxYear, activeTaxCategoryIds }`. Tax suggestion rows retain that complete snapshot and resolution compares every value plus expense/category versions. Raw tax descriptions, receipt text, deductible percentages, filing treatment, review status, amounts, and other financial treatment values are prohibited from worker input/result.
- Worker routes use current Clerk M2M subject `CLERK_APP_SERVICE_SUBJECT=ai-worker-app-machine`, audience `CLERK_APP_SERVICE_AUDIENCE`, and configured scopes `CLERK_APP_ENRICHMENT_INPUT_SCOPE=jobs:enrichment-input` and `CLERK_APP_ENRICHMENT_RESULT_SCOPE=jobs:enrichment-result`; existing `CachedM2MTokenProvider` remains in use and requests these scopes alongside `files:read` where OCR still needs it.
- `resolveSuggestion({ actorUserId, tenantId, scope, expenseId, suggestionId, expectedSuggestionVersion, expectedExpenseVersion, requestId, idempotencyKey, taxAcceptance? })` accepts only pending suggestions and returns typed accepted/rejected/superseded state.
- `fetchLedger(session, getToken, organizationId, query)` sends repeated `tagId` parameters and preserves `cursor`, `sort`, `direction`, and all filters.

## Implementation Tasks

### Task 1: Lock Existing Boundaries and Test Harness

**Files:**
- Modify: `expense-tax-management/services/app-api/test/expenses.test.ts`
- Modify: `expense-tax-management/services/app-api/test/jobs.test.ts`
- Create: `expense-tax-management/test/integration/app-domain-3c-auto-tagging.test.ts`
- Create: `expense-tax-management/test/integration/zero-skip-regression.test.ts`
- Modify: `expense-tax-management/package.json` - add the named `test:integration:3c` command.

**Interfaces:**
- Consumes current `buildApp`, `ExpenseDomain`, `ProcessingJobsDomain`, `runMigrations`, and integration environment variables.
- Produces fixed test factories and a no-skip assertion used by every later task.

- [ ] **Step 1: Add failing contract-boundary tests.**

Keep App API unit tests mock-only: assert route/domain delegation and error mapping with mocked `ExpenseDomain` and `ProcessingJobsDomain`. Put the real database assertion in newly created `test/integration/app-domain-3c-auto-tagging.test.ts`; it initializes Kysely against the disposable PostgreSQL runtime URL, runs migrations, creates one Personal scope, calls `createExpenseDomain(database).createPersonal(...)`, then asserts exactly one `ExpenseEnrichmentWorkflow` row targets the returned expense and exactly one outbox row targets that job. This must fail before implementation because `insertExpenseInTransaction` currently creates no enrichment job.

- [ ] **Step 2: Define executable integration command and prerequisite failure before running red tests.**

Add this exact root `package.json` script under `expense-tax-management`:

```json
"test:integration:3c": "mkdir -p test-results && rm -f test-results/phase-3c.json && PHASE_3C_INTEGRATION=1 pnpm exec vitest run test/integration/app-domain-3c-auto-tagging.test.ts test/integration/zero-skip-regression.test.ts --reporter=json --outputFile=test-results/phase-3c.json && node -e 'const fs=require(\"fs\"); const root=JSON.parse(fs.readFileSync(\"test-results/phase-3c.json\",\"utf8\")); const bad=[]; const walk=(v,p=\"root\")=>{if(Array.isArray(v))v.forEach((x,i)=>walk(x,p+\"[\"+i+\"]\")); else if(v&&typeof v===\"object\"){if(v.status===\"skipped\"||v.status===\"pending\")bad.push(p); Object.entries(v).forEach(([k,x])=>walk(x,p+\".\"+k));}}; walk(root); if(bad.length){console.error(JSON.stringify({skippedOrPending:bad})); process.exit(1)}'"
```

At integration `beforeAll`, when `PHASE_3C_INTEGRATION=1`, throw `Error("Phase 3C PostgreSQL prerequisites unavailable")` if Docker is unavailable or the PostgreSQL service is not running. Never use `describe.skipIf` in either Phase 3C file. The JSON inspection is the second enforcement layer and fails on any skipped/pending result.

`zero-skip-regression.test.ts` contains this executable guard:

```ts
it("runs only through the required Phase 3C integration command", () => {
  expect(process.env.PHASE_3C_INTEGRATION).toBe("1");
});
```

- [ ] **Step 3: Run red tests.**

Run: `pnpm --filter @expense-tax/app-api test -- test/expenses.test.ts test/jobs.test.ts && pnpm test:integration:3c`

Expected: App unit tests pass; initialized PostgreSQL integration test fails on missing enrichment job/outbox assertion, and JSON inspection reports no skipped/pending tests.

- [ ] **Step 4: Add shared fixtures without changing production behavior.**

Create deterministic UUIDs for one tenant, two Personal profiles, two Businesses, one user, one active taxonomy/profile/category, and expenses at versions 1 and 2. Keep fixture builders in test files so later tests cannot accidentally cross scopes.

- [ ] **Step 5: Run focused tests and commit.**

Run: `pnpm --filter @expense-tax/app-api test -- test/expenses.test.ts test/jobs.test.ts`

Expected: existing unit tests PASS; the real integration red test remains until Task 4 wires the job.

```bash
git add services/app-api/test/expenses.test.ts services/app-api/test/jobs.test.ts test/integration/app-domain-3c-auto-tagging.test.ts test/integration/zero-skip-regression.test.ts package.json
git commit -m "test(3c): lock enrichment boundaries"
```

### Task 2: PostgreSQL Enrichment Schema and Kysely Types

**Files:**
- Create: `expense-tax-management/services/app-api/src/database/migrations/016_expense_enrichment.ts`
- Modify: `expense-tax-management/services/app-api/src/database/types.ts`
- Create: `expense-tax-management/services/app-api/test/database-enrichment.test.ts`
- Create: `expense-tax-management/packages/contracts/src/enrichment.ts`
- Modify: `expense-tax-management/packages/contracts/src/index.ts`

**Interfaces:**
- Produces tables `app.tags`, `app.expense_tags`, `app.expense_spending_category_decisions`, `app.expense_enrichment_suggestions`, and permanent `app.enrichment_operation_keys`.
- Produces `Tag`, `ExpenseTag`, `ExpenseSpendingCategoryDecision`, `ExpenseEnrichmentSuggestion`, and list/resolve contract schemas.

- [ ] **Step 1: Write failing schema tests.**

Assert migration-created constraints: tag key uniqueness across active/archived, exact scope XOR, composite tenant FKs, source/status/confidence/version bounds, candidate-kind XOR, Business-only tax tuple, immutable terminal suggestions, unique active evidence hash, and permanent operation-key payload conflict. Tax suggestions must persist `business_tax_profile_id`, `business_tax_profile_version`, `taxonomy_version_id`, `tax_year`, `tax_category_definition_id`, and `expense_version` as one validation snapshot; worker-facing `activeTaxCategoryIds` contains only bounded active category IDs.

- [ ] **Step 2: Run migration tests red.**

Run: `pnpm exec vitest run services/app-api/test/database-enrichment.test.ts`

Expected: FAIL because migration 016 and table interfaces are absent.

- [ ] **Step 3: Implement migration 016.**

Create tables with the same composite-FK/trigger style as migration 015. Backfill every existing non-null `expenses.spending_category_id` into `expense_spending_category_decisions` with `source = 'manual_baseline'`, actor `created_by_user_id`, and current expense version. Tax suggestion rows include the complete profile/taxonomy/year/category/expense version snapshot and composite validation FKs. Add indexes for scope/merchant/history, active tag lookup, pending suggestion lookup, and permanent operation lookup.

Use trigger guards for parent scope immutability and suggestion terminal immutability. Use `app.enrichment_operation_keys` with `tenant_id`, `job_id`, `expense_id`, `kind`, nullable `candidate_id`, `evidence_hash`, `operation_key`, `payload_hash`, `response_json`, and `created_at`. Require composite foreign keys for tenant/job/expense, unique `(tenant_id, operation_key)`, and unique `(tenant_id, job_id, expense_id, kind, candidate_id, evidence_hash, operation_key)`. Identical replay returns stored `response_json`; a key with any different binding or payload hash raises conflict permanently.

- [ ] **Step 4: Add strict Zod schemas.**

Implement exact enums and XOR objects, for example:

```ts
export const ScopeSchema = z.union([
  z.strictObject({ kind: z.literal("personal"), profileId: z.uuid() }),
  z.strictObject({ kind: z.literal("business"), businessId: z.uuid() }),
]);
export const EnrichmentSuggestionKindSchema = z.enum(["tag", "spending_category", "tax_category"]);
export const EnrichmentSuggestionStatusSchema = z.enum(["pending", "accepted", "rejected", "superseded"]);
```

Candidate references must be strict and kind-specific; evidence is bounded JSON with canonical hash, not receipt text.

- [ ] **Step 5: Run migration/contract tests and generated checks.**

Run: `pnpm exec vitest run services/app-api/test/database-enrichment.test.ts packages/contracts/test/enrichment.test.ts`

Expected: PASS after migration and schemas exist. Run: `pnpm contracts:generate && pnpm contracts:check`; expected clean generated output.

```bash
git add services/app-api/src/database/migrations/016_expense_enrichment.ts services/app-api/src/database/types.ts services/app-api/test/database-enrichment.test.ts packages/contracts/src/enrichment.ts packages/contracts/src/index.ts packages/contracts/generated
git commit -m "feat(3c): add enrichment persistence"
```

### Task 3: Canonical Worker Input and Result Contracts

**Files:**
- Create: `expense-tax-management/packages/contracts/src/internal/expense-enrichment-input-v1.ts`
- Create: `expense-tax-management/packages/contracts/src/internal/expense-enrichment-result-v1.ts`
- Modify: `expense-tax-management/packages/contracts/src/index.ts`
- Modify: generated JSON Schema/TypeScript/Python files
- Create: `expense-tax-management/packages/contracts/test/enrichment-contracts.test.ts`

**Interfaces:**
- Produces `ExpenseEnrichmentInputV1Schema`, `ExpenseEnrichmentResultV1Schema`, `ExpenseEnrichmentSuggestionResultSchema`, and Python models with `extra=forbid`.
- Consumes by Tasks 4-8; worker result cannot contain tenant/scope/expense selectors.

- [ ] **Step 1: Write failing serialization/security tests.**

Reject unknown fields, raw receipt text/bytes, tenant/profile/business selectors, missing job/version/rules version/outcome, outcome values outside `applied|stale|skipped`, confidence outside `[0,1]`, unbounded evidence, invalid candidate kind, and tax suggestions outside the Business-required tuple including profile version, taxonomy version, tax year, and expense version.

- [ ] **Step 2: Run red.**

Run: `pnpm exec vitest run packages/contracts/test/enrichment-contracts.test.ts`

Expected: FAIL because schemas/models do not exist.

- [ ] **Step 3: Implement versioned schemas.**

Use stable literal `schemaVersion: 1`, `resultSchemaVersion: "expense-enrichment-v1"`, bounded arrays (`50` history examples max, explicit candidate limits), normalized merchant/date fields, and evidence aggregate counts only.

- [ ] **Step 4: Regenerate all artifacts.**

Run: `pnpm contracts:generate && pnpm contracts:check`

Expected: generated OpenAPI, JSON Schema, TypeScript paths, and Python files are reproducible with no diff on the second generation.

```bash
git add packages/contracts/src packages/contracts/generated common/python/expense-contracts/src/expense_contracts/generated packages/contracts/test/enrichment-contracts.test.ts
git commit -m "feat(3c): publish enrichment contracts"
```

### Task 4: Transaction-Safe Job Creation and Manual/OCR/Forwarded Wiring

**Files:**
- Modify: `expense-tax-management/services/app-api/src/domain/processing-jobs.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/expenses.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/ocr.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/inbound-email.ts`
- Modify: `expense-tax-management/services/app-api/src/routes/jobs.ts`
- Modify: `expense-tax-management/services/app-api/src/config.ts`
- Modify: `expense-tax-management/services/app-api/src/app.ts`
- Modify: `expense-tax-management/services/app-api/test/jobs.test.ts`
- Modify: `expense-tax-management/services/app-api/test/ocr.test.ts`
- Modify: `expense-tax-management/services/app-api/test/expenses.test.ts`

**Interfaces:**
- Consumes `createJobInTransaction`, `JobReferenceV1`, and migration 016.
- Produces `createEnrichmentJobInTransaction`, `getEnrichmentInput`, and `submitEnrichmentResult` with job-bound scope/version validation.

- [ ] **Step 1: Write failing transaction tests.**

Cover exactly one enrichment job/outbox for manual ready creation, OCR materialization, and forwarded materialization; zero job for draft-only creation; rollback removes expense/job/outbox together; failure after job creation leaves ready expense and OCR/forwarded/dedup state unchanged; each retry has a new job but permanent equivalent suggestions remain deduplicated.

Add route tests for exact `ai-worker-app-machine` subject, configured audience, `jobs:enrichment-input` on input, `jobs:enrichment-result` on result, denial of wrong subject/audience/missing route scope, and preservation of existing OCR `jobs:write`/`files:read` authorization.

- [ ] **Step 2: Run red.**

Run: `pnpm --filter @expense-tax/app-api test -- test/jobs.test.ts test/ocr.test.ts test/expenses.test.ts`

Expected: FAIL because helper and job wiring are absent.

- [ ] **Step 3: Implement helper and manual path.**

Call helper immediately after `insert ... expenses` and before transaction return when `initialStatus === "ready"`; bind `expense.id`, `expense.version`, exact scope, and `ExpenseEnrichmentWorkflow`. When a manual create includes `spendingCategoryId`, insert an append-only `expense_spending_category_decisions` row with `source = "manual"`, `priorSpendingCategoryId = null`, actor, and created expense version in this same transaction.

```ts
if (created.status === "ready") {
  await createEnrichmentJobInTransaction(transaction, {
    tenantId: input.tenantId,
    scope: input.scope,
    expenseId: created.id,
    expectedExpenseVersion: created.version,
    requestedByUserId: input.actorUserId,
    requestId: input.requestId,
  });
}
```

- [ ] **Step 4: Wire OCR/forwarded path and dispatcher.**

Invoke the shared helper from `applyOcrExtraction` after ready expense creation and file binding, still inside the result-submit transaction. Dispatcher starts the workflow with opaque reference and updates job to `DISPATCHED` version 2/run ID; no customer input enters Temporal history.

- [ ] **Step 5: Add worker-only input/result routes.**

Require `CLERK_APP_SERVICE_SUBJECT` exact subject, `CLERK_APP_ENRICHMENT_INPUT_SCOPE` on input, and `CLERK_APP_ENRICHMENT_RESULT_SCOPE` on result; preserve existing `serviceGuard`/Clerk M2M verifier and audience checks. Resolve target from job row, require workflow type/schema/version/status, and reject body selectors. Input route returns `ExpenseEnrichmentInputResponseV1`; it does not mutate state. Worker submits returned `stale`/`skipped` outcome to result route, which atomically marks job `SUCCEEDED` with no customer mutation. Only actual inference/transport failure returns `FAILED`.

Add required config values with exact defaults used by local tests: `CLERK_APP_SERVICE_SUBJECT=ai-worker-app-machine`, `CLERK_APP_SERVICE_AUDIENCE=app-service-audience`, `CLERK_APP_ENRICHMENT_INPUT_SCOPE=jobs:enrichment-input`, and `CLERK_APP_ENRICHMENT_RESULT_SCOPE=jobs:enrichment-result`. Tests issue service tokens with the wrong subject, wrong audience, `jobs:write` only, input scope only, and result scope only; assert input accepts only exact subject+input scope and result accepts only exact subject+result scope. Existing OCR routes keep their current `jobs:write`/`files:read` behavior.

- [ ] **Step 6: Run focused suite and commit.**

Run: `pnpm --filter @expense-tax/app-api test -- test/jobs.test.ts test/ocr.test.ts test/expenses.test.ts`

Expected: PASS with atomic job/outbox assertions.

```bash
git add services/app-api/src/domain/processing-jobs.ts services/app-api/src/domain/expenses.ts services/app-api/src/domain/ocr.ts services/app-api/src/domain/inbound-email.ts services/app-api/src/routes/jobs.ts services/app-api/src/config.ts services/app-api/src/app.ts services/app-api/test/jobs.test.ts services/app-api/test/ocr.test.ts services/app-api/test/expenses.test.ts
git commit -m "feat(3c): enqueue enrichment transactionally"
```

### Task 5: Pure Rules and Bounded History Evaluator

**Files:**
- Create: `expense-tax-management/services/ai-worker/src/ai_worker/enrichment.py`
- Create: `expense-tax-management/services/ai-worker/tests/test_enrichment.py`
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/constants.py`

**Interfaces:**
- Consumes generated `ExpenseEnrichmentInputV1`.
- Produces generated `ExpenseEnrichmentResultV1` deterministically; no network or database imports.

- [ ] **Step 1: Write failing pure-function tests.**

Cover merchant slug tag, weekend tag, selected-category tag, rule version stability, three-example/80%-and-no-tie threshold, different profile/business isolation represented by input, archived/automated-only exclusions, old tax version exclusion, and no tax suggestion for Personal.

- [ ] **Step 2: Run red.**

Run: `uv --directory services/ai-worker run pytest tests/test_enrichment.py -q`

Expected: FAIL because evaluator is absent.

- [ ] **Step 3: Implement pure evaluator.**

Use exact generated input field names, one registry constant, stable key normalization, and required successful outcome:

```py
RULES_VERSION = 1
RULE_KEYS = ("merchant", "weekend", "selected_category")
def evaluate(input: ExpenseEnrichmentInputV1) -> ExpenseEnrichmentResultV1:
    tags = deterministic_rule_tags(input)
    suggestions = infer_history(
        input.history,
        eligible_tag_keys=input.eligibleTagKeys,
        eligible_spending_category_ids=input.eligibleSpendingCategoryIds,
        eligible_tax_snapshot=input.eligibleTaxSnapshot,
    )
    return ExpenseEnrichmentResultV1(
        schemaVersion=1,
        rulesVersion=RULES_VERSION,
        outcome="applied",
        ruleTagKeys=tags,
        suggestions=suggestions,
    )
```

Historical projections train only from active manual associations, accepted historical tags, latest manual/manual-baseline/accepted-historical category decisions, and reviewed user-saved active Business tax treatments. Cap prior 24-month same-merchant history at 50 most recent rows.

- [ ] **Step 4: Run pure suite/lint and commit.**

Run: `uv --directory services/ai-worker run pytest tests/test_enrichment.py && uv --directory services/ai-worker run ruff check src tests && uv --directory services/ai-worker run ruff format --check src tests`

Expected: PASS.

```bash
git add services/ai-worker/src/ai_worker/enrichment.py services/ai-worker/src/ai_worker/constants.py services/ai-worker/tests/test_enrichment.py
git commit -m "feat(3c): add deterministic enrichment rules"
```

### Task 6: App API Projection, Rule Application, and Replay Safety

**Files:**
- Create: `expense-tax-management/services/app-api/src/domain/enrichment.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/processing-jobs.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/expenses.ts`
- Modify: `expense-tax-management/services/app-api/src/database/types.ts`
- Create: `expense-tax-management/services/app-api/test/enrichment.test.ts`

**Interfaces:**
- Consumes `ExpenseEnrichmentInputV1`/result, exact job binding, tag/history tables.
- Produces `buildEnrichmentInput`, `applyEnrichmentResult`, `resolveSuggestion`, and `rerunEnrichment`.

- [ ] **Step 1: Write failing domain tests.**

Assert rule output is recomputed server-side; ineligible tag/category/tax IDs are rejected; worker cannot redirect tenant/scope/expense; rules auto-apply only active rule tags; historical outputs stay pending; repeated result after generic idempotency expiry returns original result; same operation key with changed normalized payload conflicts. Add expense update coverage proving a manual `spendingCategoryId` change inserts one append-only decision with `source = "manual"`, prior/new IDs, actor, and expense version, and supersedes all pending spending-category suggestions for that expense in the same transaction.

- [ ] **Step 2: Run red.**

Run: `pnpm --filter @expense-tax/app-api test -- test/enrichment.test.ts`

Expected: FAIL because projection/application functions are absent.

- [ ] **Step 3: Implement bounded input projection.**

Query job-bound expense, active candidates, same-scope same-merchant ready/non-archived expenses in prior 24 months, and explicit training projections. Never send receipt text, file bytes, tenant selectors, or tax details to worker.

- [ ] **Step 4: Implement manual category decision and transactional result application.**

In `updateExpense`, when `spendingCategoryId` is supplied, lock the expense, update its version, insert one `expense_spending_category_decisions` row with `source = "manual"`, and mark pending spending-category suggestions `superseded` with the prior expected expense version. Keep this in the expense update transaction. Then lock job and target expense, compare expected job/expense versions, recompute deterministic tags, skip removed/manual/archived decisions, insert/update one association row per expense/tag, insert pending suggestions using evidence hash, and write audit/provenance. If version changed, persist `outcome: "stale"`, complete the job `SUCCEEDED`, and make no customer mutations.

- [ ] **Step 5: Implement permanent replay operation.**

Canonicalize `{tenantId, jobId, expenseId, kind, candidateId, evidenceHash, normalizedResult}`; insert the full binding into `app.enrichment_operation_keys` before mutation; return original stored response for identical replay and `409` for any binding/payload hash mismatch. Do not depend on `app.idempotency_records.expires_at`.

- [ ] **Step 6: Run focused suite and commit.**

Run: `pnpm --filter @expense-tax/app-api test -- test/enrichment.test.ts test/jobs.test.ts`

Expected: PASS.

```bash
git add services/app-api/src/domain/enrichment.ts services/app-api/src/domain/processing-jobs.ts services/app-api/src/domain/expenses.ts services/app-api/src/database/types.ts services/app-api/test/enrichment.test.ts services/app-api/test/jobs.test.ts
git commit -m "feat(3c): validate and apply enrichment results"
```

### Task 7: Python Enrichment Workflow and Worker Client

**Files:**
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/app_api_client.py`
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/config.py`
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/workflows.py`
- Modify: `expense-tax-management/services/ai-worker/src/ai_worker/run_worker.py`
- Modify: `expense-tax-management/services/ai-worker/tests/test_service_clients.py`
- Modify: `expense-tax-management/services/ai-worker/tests/test_config.py`
- Modify: `expense-tax-management/services/ai-worker/tests/test_workflows.py`

**Interfaces:**
- Consumes opaque `JobReferenceV1`, `ExpenseEnrichmentInputV1`, pure evaluator.
- Produces registered `ExpenseEnrichmentWorkflow` and activity names `enrichment_mark_running`, `enrichment_get_input`, `enrichment_submit_result`, `enrichment_mark_failed`.

- [ ] **Step 1: Write failing worker tests.**

Assert workflow history contains only job reference/activity payloads, input request has no selectors, status version chain is `2 -> RUNNING -> SUCCEEDED/FAILED`, result key is `jobId:enrichment:result:v1`, nonretryable 4xx fails fast, transient HTTP retries are bounded, and evaluator receives exact App API input. Assert evaluator results with `outcome = "applied"`, `"stale"`, and `"skipped"` all submit successful callbacks and end `SUCCEEDED`; only thrown inference/transport failure invokes `mark_failed` and ends `FAILED`.

- [ ] **Step 2: Run red.**

Run: `uv --directory services/ai-worker run pytest tests/test_config.py tests/test_service_clients.py tests/test_workflows.py -q`

Expected: FAIL because client methods/workflow are absent.

- [ ] **Step 3: Implement client and activities.**

Use generated Pydantic models and existing `CachedM2MTokenProvider`. `get_enrichment_input` performs `GET /internal/v1/jobs/{jobId}/enrichment-input` with configured `jobs:enrichment-input` and returns `ExpenseEnrichmentInputResponseV1`; submit performs `POST /internal/v1/jobs/{jobId}/enrichment-result` with configured `jobs:enrichment-result`, expected job version, and permanent result key. Client requests `CLERK_APP_SERVICE_AUDIENCE`, authenticates as exact `CLERK_APP_SERVICE_SUBJECT=ai-worker-app-machine`, and preserves existing `files:read` for OCR.

- [ ] **Step 4: Implement workflow and registration.**

Use `DISPATCHED_JOB_VERSION = 2`, opaque reference only, separate `RetryPolicy(maximum_attempts=5)` for HTTP, and terminal failure callback that changes only enrichment job. Branch on input response: `evaluate` passes `input` to evaluator; `stale`/`skipped` bypass evaluator and submit same no-mutation outcome. Never send `FAILED` for those outcomes. Do not call Foundry client.

- [ ] **Step 5: Run worker verification and commit.**

Run: `uv --directory services/ai-worker run pytest && uv --directory services/ai-worker run ruff check src tests && uv --directory services/ai-worker run ruff format --check src tests`

Expected: PASS.

```bash
git add services/ai-worker/src/ai_worker/app_api_client.py services/ai-worker/src/ai_worker/config.py services/ai-worker/src/ai_worker/workflows.py services/ai-worker/src/ai_worker/run_worker.py services/ai-worker/tests/test_config.py services/ai-worker/tests/test_service_clients.py services/ai-worker/tests/test_workflows.py
git commit -m "feat(3c): run enrichment workflow"
```

### Task 8: Tag CRUD, Associations, Merge Invariants, and Suggestion Resolution API

**Files:**
- Create: `expense-tax-management/services/app-api/src/domain/tags.ts`
- Create: `expense-tax-management/services/app-api/src/routes/tags.ts`
- Create: `expense-tax-management/services/app-api/src/routes/enrichment.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/enrichment.ts`
- Modify: `expense-tax-management/services/app-api/src/app.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/spending-categories.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/tax.ts`
- Create: `expense-tax-management/services/app-api/test/tags.test.ts`
- Modify: `expense-tax-management/services/app-api/test/enrichment.test.ts`
- Modify: `expense-tax-management/services/app-api/test/spending-categories.test.ts`
- Modify: `expense-tax-management/services/app-api/test/tax.test.ts`

**Interfaces:**
- Public tenant routes: `GET/POST /api/v1/tenants/:tenantId/tags`, `PATCH/POST .../:tagId`, with owner/admin mutation.
- Scope routes: `GET/PUT/DELETE .../{personal-profiles|businesses}/:scopeId/expenses/:expenseId/tags/:tagId`, suggestion list/resolve, and `POST .../expenses/:expenseId/enrichment-runs`.
- `mergeTags` locks source/target sorted UUID order, associations, and pending suggestions; it preserves precedence and provenance.

- [ ] **Step 1: Write failing route/domain tests.**

Cover tenant membership read, owner/admin mutation, exact Personal/Business membership, cross-scope denial, archived key collision, explicit unarchive, self/cross-tenant/archived-target/stale merge rejection, manual-over-history-over-rule conflict, source suggestion superseding, and audit count.

- [ ] **Step 2: Run red.**

Run: `pnpm --filter @expense-tax/app-api test -- test/tags.test.ts test/enrichment.test.ts`

Expected: FAIL because domains/routes are absent.

- [ ] **Step 3: Implement tag CRUD and association decisions.**

Keep one association row per expense/tag pair. Manual apply/remove updates source/status/version and writes audit; removal retains `removed` row; automation never changes manual row.

- [ ] **Step 4: Implement merge transaction.**

Acquire locks in `ORDER BY tag.id`, then lock affected rows in stable ID order. On collision select stronger decision: manual, accepted historical, rule; explicit removed/manual beats automatic active. Supersede pending source suggestions, retain terminal source candidate reference, archive source, increment target, and write one merge audit event.

- [ ] **Step 5: Implement suggestion resolution.**

Require pending status, expected suggestion/expense versions, and permanent idempotency key. Tag accept creates historical active association unless manual/removed exists. Spending accept updates expense version and appends decision. Tax accept requires active Business profile/taxonomy/year/category plus user deductible percentage and writes treatment `unreviewed`; automation provides none. Reject is terminal and retained. Bind and compare the full tax snapshot: `businessTaxProfileId`, profile `version`, `taxonomyVersionId`, `taxYear`, tax category ID/status, expense version, and Business scope. Any profile update/close, taxonomy supersession, category archival, treatment update/delete, or expense version change supersedes pending tax suggestions in the same transaction.

- [ ] **Step 6: Add category and tax invalidation tests/implementation.**

In `spending-categories.ts`, archive a category only after locking it and mark pending spending-category suggestions referencing it `superseded`; test active-scope authorization, version conflict, and no suggestion remains pending. In `tax.ts`, lock profile/taxonomy/category/treatment rows before mutation and supersede pending tax suggestions whose stored snapshot no longer matches; tests cover profile version change, taxonomy version change, category status change, treatment review/status change, and expense version change. No invalidation changes an accepted/rejected terminal suggestion.

- [ ] **Step 7: Run focused API tests and commit.**

Run: `pnpm --filter @expense-tax/app-api test -- test/tags.test.ts test/enrichment.test.ts test/spending-categories.test.ts test/tax.test.ts && pnpm --filter @expense-tax/app-api run typecheck`

Expected: PASS.

```bash
git add services/app-api/src/domain/tags.ts services/app-api/src/routes/tags.ts services/app-api/src/routes/enrichment.ts services/app-api/src/domain/enrichment.ts services/app-api/src/domain/spending-categories.ts services/app-api/src/domain/tax.ts services/app-api/src/app.ts services/app-api/test/tags.test.ts services/app-api/test/enrichment.test.ts services/app-api/test/spending-categories.test.ts services/app-api/test/tax.test.ts packages/contracts/generated
git commit -m "feat(3c): expose scoped tag review API"
```

### Task 9: Server-Side Tag AND Filtering and Expense Contract Projection

**Files:**
- Modify: `expense-tax-management/packages/contracts/src/expenses.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/expenses.ts`
- Modify: `expense-tax-management/services/app-api/src/routes/expenses.ts`
- Modify: `expense-tax-management/services/app-api/src/pagination/cursor.ts`
- Modify: `expense-tax-management/services/app-api/test/expenses.test.ts`
- Modify: generated OpenAPI/TypeScript artifacts

**Interfaces:**
- `LedgerQuerySchema` accepts repeated `tagId` UUID values.
- `listPersonal/listBusiness` return active tag chips and apply every requested tag via grouped server-side query, not client filtering.

- [ ] **Step 1: Write failing API/database tests.**

Assert `[tagA, tagB]` returns only expenses containing both active tags, removed tags do not match, scope isolation holds, cursor with same filters succeeds, cursor with changed tags fails validation, and page 2 retains filters.

- [ ] **Step 2: Run red.**

Run: `pnpm --filter @expense-tax/app-api test -- test/expenses.test.ts`

Expected: FAIL because contracts/query/projection lack tag support.

- [ ] **Step 3: Implement grouped query.**

Use `EXISTS` per requested tag or a grouped subquery with `HAVING count(distinct expense_tag.tag_id) = requestedCount`; include `status = 'active'` and exact tenant/scope predicates. Add tag IDs to `ledgerFilterHash` before cursor decode/encode.

- [ ] **Step 4: Run focused tests, regenerate, commit.**

Run: `pnpm --filter @expense-tax/app-api test -- test/expenses.test.ts && pnpm contracts:generate && pnpm contracts:check`

Expected: PASS and clean generated artifacts.

```bash
git add packages/contracts/src/expenses.ts services/app-api/src/domain/expenses.ts services/app-api/src/routes/expenses.ts services/app-api/src/pagination/cursor.ts services/app-api/test/expenses.test.ts packages/contracts/generated
git commit -m "feat(3c): add server tag filtering"
```

### Task 10: Office Personal/Business Scope and Review UI

**Files:**
- Modify: `expense-tax-management/frontend/office-web/src/lib/session.ts`
- Modify: `expense-tax-management/frontend/office-web/src/lib/api.ts`
- Modify: `expense-tax-management/frontend/office-web/src/lib/page-data.ts`
- Modify: `expense-tax-management/frontend/office-web/src/app/(office)/layout.tsx`
- Modify: `expense-tax-management/frontend/office-web/src/components/office-shell.tsx`
- Modify: `expense-tax-management/frontend/office-web/src/app/(office)/expenses/page.tsx`
- Modify: `expense-tax-management/frontend/office-web/src/app/(office)/settings/page.tsx`
- Create: `expense-tax-management/frontend/office-web/src/app/(office)/expenses/[expenseId]/page.tsx`
- Modify: `expense-tax-management/frontend/office-web/src/lib/api.test.ts`
- Modify: `expense-tax-management/frontend/office-web/src/lib/page-data.test.ts`
- Create: `expense-tax-management/frontend/office-web/src/lib/enrichment.test.ts`
- Modify: `expense-tax-management/frontend/office-web/src/lib/fixtures.ts`
- Modify: `expense-tax-management/frontend/office-web/src/app/styles.css`

**Interfaces:**
- `OfficeSession = { apiBaseUrl, tenantId, scope: { kind: "personal"; profileId } | { kind: "business"; businessId }, label }`.
- API helpers use generated paths and selected scope; no Business-only fallback or tenant-only expense route.

- [ ] **Step 1: Write failing UI/helper tests.**

Cover selected scope URL, repeated `tagId` query values, cursor preservation, loading/empty/unauthorized/retry/success/conflict/stale states, rule vs History source labels, tax acceptance requiring deductible percentage, and fail-closed missing scope.

- [ ] **Step 2: Run red.**

Run: `pnpm --filter @expense-tax/office-web test`

Expected: FAIL because Personal scope/tag/enrichment helpers and views are absent.

- [ ] **Step 3: Implement scope/session and API layer.**

Refactor `readOfficeSession`, `OfficeData`, `OfficeShell`, dashboard, expenses, forwarding, duplicates, settings, and all API/page-data helpers to consume discriminated Personal/Business scope. `dashboard`, `expenses`, `forwarding`, `duplicates`, and tag settings use either scope; `businesses`, `projects`, `tax`, and `exports` require Business scope and render an explicit unavailable state for Personal rather than constructing a Business URL. Update login/session initialization and every current route test/fixture to create both scope variants. Use server pagination; do not filter `data.items` in the browser. Keep `tagId` array and cursor in page state. Use stable idempotency keys per user action where the action can be retried.

- [ ] **Step 4: Implement ledger/detail review surfaces.**

Render active tag chips, multi-tag filter controls, pending suggestion candidate/confidence/evidence/source, review-only status, and tax accept form requiring deductible percentage. Display `unreviewed` after tax acceptance and never render an automatic percentage.

- [ ] **Step 5: Implement settings tag management.**

Add create, rename, archive/unarchive, and merge forms with version fields, explicit conflict refresh, accessible labels, and disabled/loading states. Restrict management controls to owner/admin response permissions.

- [ ] **Step 6: Run Office verification and commit.**

Run: `pnpm --filter @expense-tax/office-web test && pnpm --filter @expense-tax/office-web run lint && pnpm --filter @expense-tax/office-web run typecheck && pnpm --filter @expense-tax/office-web run build`

Expected: PASS with Personal and Business route matrices covering every current Business-only consumer.

```bash
git add frontend/office-web
git commit -m "feat(office): review scoped enrichment"
```

### Task 11: Real PostgreSQL Integration and Zero-Skip Regression

**Files:**
- Modify: `expense-tax-management/test/integration/app-domain-3c-auto-tagging.test.ts`
- Modify: `expense-tax-management/test/integration/zero-skip-regression.test.ts`
- Modify: `expense-tax-management/test/integration/compose-boundaries.test.ts` only to share existing disposable-Postgres setup
- Modify: `expense-tax-management/package.json` - add the explicit `test:integration:3c` command.

**Interfaces:**
- Consumes real `runMigrations`, runtime/migrator roles, `createAppDatabase`, `createExpenseDomain`, `createProcessingJobsDomain`, `createEnrichmentDomain`, and `createTagDomain`.
- Produces required evidence that PostgreSQL—not mocks—enforces scope/FK/trigger/transaction/replay invariants.

- [ ] **Step 1: Write integration cases before implementation completion.**

Seed tenant with two Personal profiles and two Businesses. Define `seed` with `userId`, `tenantId`, `businessId`, `otherProfileId`, `enrichmentJobId`, `tagAId`, `tagBId`, and `expenseWithBothTagsId`; define `countRows(table, column, value)` as a parameterized Kysely count query. Assert all of the following against disposable PostgreSQL:

```ts
expect(await countRows("app.processing_jobs", "workflow_type", "ExpenseEnrichmentWorkflow")).toBe(1);
expect(await countRows("app.processing_job_dispatch_outbox", "processing_job_id", seed.enrichmentJobId)).toBe(1);
const businessPage = await expenseDomain.listBusiness({
  actorUserId: seed.userId, tenantId: seed.tenantId, businessId: seed.businessId,
  query: { tagIds: [seed.tagAId, seed.tagBId], limit: 50, sort: "incurredOn", direction: "desc" },
});
expect(businessPage.items.map((row) => row.id)).toContain(seed.expenseWithBothTagsId);
expect((await expenseDomain.listPersonal({
  actorUserId: seed.userId, tenantId: seed.tenantId, profileId: seed.otherProfileId,
  query: { limit: 50, sort: "incurredOn", direction: "desc" },
})).items).toHaveLength(0);
```

Cover manual/OCR/forwarded atomic creation, rollback, ready-state preservation after enrichment failure, 3/80%/tie thresholds, archived/automated-only/old-taxonomy exclusion, manual/history/rule precedence, rejected/removed non-recreation, stale expense no-op, worker callback scope redirect rejection, permanent replay after deleting expired generic idempotency row, archived-key collision, merge invariants/audit, tax invalidation, and cursor AND filters.

- [ ] **Step 2: Run integration red or expose missing behavior.**

Run: `pnpm test:integration:3c`

Expected: prerequisite failure if Docker/PostgreSQL is unavailable; otherwise tests execute against disposable PostgreSQL and fail on unimplemented Phase 3C behavior, with JSON result inspection rejecting skipped/pending tests.

- [ ] **Step 3: Remove accidental skips in Phase 3C coverage.**

Keep environment guards for unavailable Docker in the general suite, but Phase 3C’s dedicated command uses the exact prerequisite exception from Task 1 and never skips. `zero-skip-regression.test.ts` asserts `PHASE_3C_INTEGRATION === "1"`; the shell JSON inspection in `test:integration:3c` rejects every `skipped` or `pending` result.

- [ ] **Step 4: Run full real-PostgreSQL verification.**

Run: `pnpm test:integration:3c`

Expected: PASS with migration through 016, all assertions executed, and disposable database dropped in `afterAll`.

```bash
git add test/integration/app-domain-3c-auto-tagging.test.ts test/integration/zero-skip-regression.test.ts test/integration/compose-boundaries.test.ts package.json
git commit -m "test(3c): verify PostgreSQL enrichment invariants"
```

### Task 12: Full Generated, API, Worker, Office, and Regression Verification

**Files:**
- Modify: `docs/superpowers/plans/2026-09-12-phase-3c-auto-tagging.md` - record final verification evidence and command outcomes.

**Interfaces:**
- Consumes every Phase 3C artifact and test suite.
- Produces clean generated contracts, zero unexpected skips, and command evidence for handoff.

- [x] **Step 1: Regenerate twice and check cleanliness.**

Run: `pnpm contracts:generate && pnpm contracts:check && pnpm contracts:generate && git diff --exit-code -- packages/contracts/generated common/python/expense-contracts/src/expense_contracts/generated`

Expected: second generation produces no diff.

**Evidence (2026-09-19):** `pnpm contracts:generate` → exit 0; `pnpm contracts:check` → exit 0; second `pnpm contracts:generate` → exit 0; `git diff --exit-code` → exit 0 (no diff). Generated artifacts idempotent. ✅

- [x] **Step 2: Run TypeScript suites.**

Run: `pnpm ci:test`

Expected: gateway-policy, contracts, App API, Foundry, and canonical frontend packages pass. No transitional expense-service/frontend/web suite is added to Phase 3C scope.

**Evidence (2026-09-19, fixed at `0542feb`):** All 6 scoped packages pass. contracts: 14 files / 240 tests passed. capture-web: 2 files / 9 tests. foundry-web: 4 files / 12 tests. foundry-service: 10 files / 128 passed | 1 skipped (pre-existing). office-web: 11 files / 143 tests. app-api: 33 files / 425 passed | 49 skipped (pre-existing non-3C). Exit 0. ✅

- [x] **Step 3: Run Python suites.**

Run: `pnpm ci:python:lint && pnpm ci:python:test`

Expected: generated contract tests and all worker tests pass; no Foundry call occurs.

**Evidence (2026-09-19, fixed at `f0353a0`):** `pnpm ci:python:lint` → ruff check + format clean on expense-contracts (12 files) and ai-worker (25 files), exit 0. `pnpm ci:python:test` → expense-contracts: 5 passed; ai-worker: 138 passed (test_enrichment 55, test_auth_client 15, test_config 20, test_constants 1, test_activities 2, test_fake_ocr 2, test_ocr_activities 6, test_ocr_workflow 5, test_service_clients 12, test_workflows 20). 0 failed, 0 skipped. No Foundry call. Exit 0. ✅

- [x] **Step 4: Run Office suites.**

Run: `pnpm --filter @expense-tax/office-web test && pnpm --filter @expense-tax/office-web run lint && pnpm --filter @expense-tax/office-web run typecheck && pnpm --filter @expense-tax/office-web run build`

Expected: all scope, pagination, review, conflict, accessibility-state, and tag-management tests pass.

**Evidence (2026-09-19, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_ci`):** test → 11 files / 143 tests passed (clerk 6, api 22, shell-nav 4, page-data 8, duplicates-ui 18, ledger-ui 12, fixtures 1, duplicates 16, scope-ui 13, session 12, enrichment 31). lint → eslint exit 0. typecheck → tsc --noEmit exit 0. build → Next.js 16.3.4 Turbopack, 14 routes compiled, exit 0. ✅

- [x] **Step 5: Run real PostgreSQL and zero-skip checks.**

Run: `pnpm test:integration:3c`

Expected: PASS with zero skipped Phase 3C tests and disposable database cleanup.

**Evidence (2026-09-19):** 5 suites / 90 tests passed: app-domain-3c-auto-tagging.test.ts (33), zero-skip-regression.test.ts (1), spending-categories.test.ts (5), tags.test.ts (43), tax.test.ts (8). numPendingTests: 0, numTodoTests: 0, numSkippedTests: 0. Exit 0. ✅

- [x] **Step 6: Run diff/security checks.**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intended canonical API/contracts/worker/Office/integration files changed; no secrets, live provider calls, transitional surfaces, or production mutations.

**Evidence (2026-09-19):** `git diff --check` → exit 0 (no whitespace errors). `git status --short` → no output (clean working tree). Only this plan doc staged and committed. No secrets, provider calls, or transitional surfaces present. ✅

```bash
git add docs/superpowers/plans/2026-09-12-phase-3c-auto-tagging.md
git commit -m "docs(3c): record implementation verification"
```

## Spec Coverage Checklist

- [x] Rules registry applies merchant, weekend, and selected-category tags at confidence `1.0`; no large-purchase/payment-method/currency-conversion rules.
- [x] History uses same tenant/scope/merchant, ready non-archived expenses, 24 months, 50 rows, manual/accepted projections, 3 examples, 80%, and no tie.
- [x] Tag, association, category-decision, suggestion, and permanent operation schemas enforce scope and provenance in PostgreSQL.
- [x] Manual/OCR/forwarded creation creates one enrichment job/outbox atomically; enrichment failure leaves source workflow state unchanged.
- [x] Temporal stores only opaque references; worker cannot select target tenant/scope/expense/candidates and cannot access customer DB.
- [x] App API recomputes rules, validates candidates, applies only rule tags, stores review-only historical suggestions, and handles stale versions.
- [x] Suggestions accept/reject with permanent replay keys; tax acceptance requires user percentage and stores `unreviewed`.
- [x] Server tag filtering is cursor-paginated with AND semantics and filter-preserving cursors.
- [x] Office supports Personal/Business scope, chips, review, tax input, settings CRUD/merge, and explicit failure states.
- [x] Merge locks sorted UUIDs, preserves precedence/provenance, supersedes pending source suggestions, archives source, increments target, audits counts.
- [x] Generated artifacts are clean; real PostgreSQL integration passes; zero-skip regression passes.

Plan complete and saved to `docs/superpowers/plans/2026-09-12-phase-3c-auto-tagging.md`. Two execution options:

1. **Subagent-driven** - dispatch fresh worker per task with review checkpoints.
2. **Inline execution** - execute task batches in current session with checkpoints.
