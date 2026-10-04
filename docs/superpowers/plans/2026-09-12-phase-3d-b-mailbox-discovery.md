# Phase 3D-B Mailbox Discovery and Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Not started; blocked by Phase 3D-A. Refresh `origin/dev` and use a new `feature/*` worktree after Phase 3D-A merges.

**Goal:** Add single-flight scheduled/manual scans, fenced Gmail discovery, deterministic candidate staging/classification, and Office review on top of 3D-A.

**Architecture:** App API owns scan/candidate rows, cursor fences, lease CAS, entitlement checks, and review authorization. Broker reads Gmail and calls App staging directly. Temporal and the TypeScript workflow worker orchestrate only opaque run/candidate IDs, counts, page sequence, and typed errors; they never receive or return Gmail cursor/history IDs or provider metadata.

**Tech Stack:** TypeScript Fastify/Kysely/PostgreSQL, Temporal client/worker, TypeScript Temporal SDK (`services/workflow-worker`), Gmail API through 3D-A broker, Zod/OpenAPI, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md`

## Global Constraints

- Phase 3C migration 016 and runtime migration Task 7 Stage A migration 017 must be complete. 3D-B owns migration `019` after 3D-A migration `018`; 3D-C owns `020` after 019.
- Consume A names unchanged: `MailboxConnectionV1`, `MailboxConnectionRecordV1`, `MailboxScope`, `MailboxProviderAdapter`, `MailboxErrorCodeV1`, `MailboxBrokerConnectionAppClient`, `MailboxAppApiClient`, and `mailboxIdempotencyKey`.
- Temporal inputs/results/heartbeats/errors contain only `scanRunId`, `candidateId`, counts, page sequence, and typed errors. No history ID, cursor, pre-fence token, message ID, thread ID, sender, subject, attachment metadata, or provider error body.
- Broker stages complete candidate metadata directly to App; worker receives only staged App IDs/counts.
- Initial Gmail sync uses 30-day default lookback, 90-day hard maximum, 100-message maximum, pre-fence/replay. Incremental sync handles history 404 with bounded full-sync recovery.
- Every App staging callback binds `expectedConnectionVersion`, `cursorBeforeDigest`, `preFenceToken`, and `pageSequence`; App atomically advances cursor and rejects out-of-order pages.
- No Pub/Sub, Gmail modification, Outlook implementation, live LLM, raw body/MIME/HTML/token persistence, automatic duplicate merge, or cross-scope routing.
- Workflows and activities here run only on the TypeScript `services/workflow-worker`. Source may merge to `dev` once 3D-A is in, but production activation requires runtime migration Task 7 cutover (`sub-plans/runtime-typescript-temporal-migration.md`).
- B modifies A-owned mailbox page/API base and A worker/broker base files only for scan/review integration. B creates scan workflow/activity/classification modules; C creates ingestion modules and modifies existing pages for ingestion status.
- Permanent operation uniqueness returns original result for identical replay and typed conflict for same key/different payload.

---

## Canonical B Contracts

```ts
export type MailboxScanRunStatus = "pending" | "running" | "completed" | "partial" | "failed" | "skipped";
export type MailboxCandidateClassification = "receipt" | "ambiguous" | "not_receipt";
export type MailboxCandidateStatus = "staged" | "review" | "queued" | "processed" | "duplicate" | "skipped" | "failed";
export interface AttachmentManifestV1 { readonly name: string; readonly mimeType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf"; readonly sizeBytes: number; readonly sha256: string; }

export interface MailboxScanRunV1 {
  readonly schemaVersion: 1; readonly id: string; readonly connectionId: string; readonly tenantId: string;
  readonly initiatedBy: string | "schedule"; readonly entitlementVersion: number; readonly connectionVersion: number;
  readonly status: MailboxScanRunStatus; readonly discoveredCount: number; readonly stagedCount: number;
  readonly reviewCount: number; readonly duplicateCount: number; readonly skippedCount: number; readonly failedCount: number;
  readonly errorCode: MailboxErrorCodeV1 | null; readonly idempotencyKey: string;
  readonly createdAt: string; readonly startedAt: string | null; readonly completedAt: string | null;
}

export interface MailboxCandidateV1 {
  readonly schemaVersion: 1; readonly id: string; readonly scanRunId: string; readonly connectionId: string; readonly tenantId: string;
  readonly receivedAt: string; readonly senderAddress: string; readonly senderDomain: string; readonly subject: string;
  readonly contentHash: string;
  readonly attachmentManifest: readonly AttachmentManifestV1[];
  readonly classification: MailboxCandidateClassification; readonly confidence: number; readonly evidence: readonly string[];
  readonly scope: MailboxScope | null; readonly status: MailboxCandidateStatus;
  readonly processingJobId: string | null; readonly expenseId: string | null; readonly sourceId: string | null;
  readonly duplicateMatchId: string | null; readonly version: number; readonly idempotencyKey: string;
  readonly errorCode: MailboxErrorCodeV1 | null; readonly createdAt: string; readonly updatedAt: string;
}
export interface MailboxCandidateRecordV1 extends MailboxCandidateV1 {
  readonly providerMessageId: string; readonly providerThreadId: string | null;
}
export interface MailboxBrokerCandidateBindingV1 {
  readonly candidateId: string; readonly connectionId: string; readonly expectedCandidateVersion: number;
  readonly providerMessageId: string; readonly providerThreadId: string | null;
}

export interface MailboxScanExecutionInputV1 { readonly schemaVersion: 1; readonly scanRunId: string; }
export interface MailboxCandidateBatchV1 { readonly schemaVersion: 1; readonly scanRunId: string; readonly candidateIds: readonly string[]; readonly stagedCount: number; readonly reviewCount: number; readonly failedCount: number; }
export interface MailboxScanCountResultV1 { readonly schemaVersion: 1; readonly scanRunId: string; readonly candidateIds: readonly string[]; readonly counts: { readonly discovered: number; readonly staged: number; readonly review: number; readonly failed: number }; }
export interface MailboxCandidateOutcomeV1 { readonly schemaVersion: 1; readonly candidateId: string; readonly expectedCandidateVersion: number; readonly status: "staged" | "review" | "skipped" | "failed"; readonly errorCode: MailboxErrorCodeV1 | null; readonly idempotencyKey: string; }
export interface DiscoveryInput { readonly connectionId: string; readonly scanRunId: string; }
export interface DiscoveryPageV1 { readonly scanRunId: string; readonly pageSequence: number; readonly candidateCount: number; readonly retryCount: number; }
export interface MailboxBrokerScanBindingV1 {
  readonly scanRunId: string; readonly connectionId: string; readonly expectedConnectionVersion: number;
  readonly currentHistoryId: string | null; readonly currentCursorDigest: string;
  readonly preFenceToken: string; readonly nextPageSequence: number;
}
export interface MailboxCandidateMetadataStagingV1 {
  readonly schemaVersion: 1; readonly scanRunId: string; readonly connectionId: string;
  readonly expectedConnectionVersion: number; readonly cursorBeforeDigest: string;
  readonly preFenceToken: string; readonly pageSequence: number; readonly nextHistoryId: string | null;
  readonly messages: readonly { receivedAt: string; senderAddress: string; senderDomain: string; subject: string;
    contentHash: string; attachmentManifest: readonly AttachmentManifestV1[];
    classification: MailboxCandidateClassification; confidence: number; evidence: readonly string[];
    providerMessageId: string; providerThreadId: string | null; }[];
  readonly idempotencyKey: string;
}
export interface MailboxCandidateMetadataStagingResultV1 {
  readonly schemaVersion: 1; readonly scanRunId: string; readonly pageSequence: number;
  readonly candidateIds: readonly string[]; readonly counts: { discovered: number; staged: number; review: number; failed: number };
}
export interface MailboxBrokerDiscoveryAppClient extends MailboxBrokerConnectionAppClient {
  loadScanBinding(scanRunId: string): Promise<MailboxBrokerScanBindingV1>;
  stageCandidateMetadata(input: MailboxCandidateMetadataStagingV1): Promise<MailboxCandidateMetadataStagingResultV1>;
}
export interface MailboxDiscoveryProviderAdapter extends MailboxProviderAdapter {
  discover(input: DiscoveryInput): Promise<DiscoveryPageV1>;
}

```

`MailboxCandidateMetadataStagingV1` and `MailboxCandidateMetadataStagingResultV1` are B-owned broker-to-App contracts. Their `nextHistoryId` is actual Gmail cursor and crosses only broker-to-App. Provider message/thread IDs are never returned to worker or Temporal. `preFenceToken` and cursor digests are opaque App/broker values and never workflow fields.

### Task 1: Contracts and Migration 019

**Local testability:** Fully local with fakes. No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/packages/contracts/src/mailbox-discovery.ts`
- Modify: `expense-tax-management/packages/contracts/src/index.ts`
- Create: `expense-tax-management/packages/contracts/test/mailbox-discovery.test.ts`
- Create: `expense-tax-management/services/app-api/src/database/migrations/019_mailbox_discovery.ts`
- Modify: `expense-tax-management/services/app-api/src/database/types.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-discovery-database.test.ts`

- [x] **Step 1: Write failing tests** for exact contracts, no provider metadata in execution/batch/count contracts, five-attachment manifest, migration prerequisite `016,017,018`, unique candidate/message key, unique permanent operation key, and terminal candidate immutability.
- [x] **Step 2: Run red:** `pnpm --filter @expense-tax/contracts exec vitest run test/mailbox-discovery.test.ts && pnpm --filter @expense-tax/app-api test -- test/mailbox-discovery-database.test.ts`; expected FAIL.
- [x] **Step 3: Implement contracts and 019.** Add scan runs, candidates, durable page outcomes/retries, cursor fence columns, and indexes. Store provider message ID only in App candidate row.
- [x] **Step 4: Run:** `pnpm contracts:generate && pnpm contracts:check && pnpm --filter @expense-tax/app-api typecheck`; expected PASS.
- [x] **Step 5: Commit:** `git add packages/contracts/src/mailbox-discovery.ts packages/contracts/src/index.ts packages/contracts/test/mailbox-discovery.test.ts services/app-api/src/database/migrations/019_mailbox_discovery.ts services/app-api/src/database/types.ts services/app-api/test/mailbox-discovery-database.test.ts packages/contracts/generated && git commit -m "feat(mailbox): add discovery schema"`

### Task 2: Lease, Scan Domain, and Fenced Page Callback

**Local testability:** Fully local with fakes. No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/services/app-api/src/domain/mailbox-scans.ts`
- Create: `expense-tax-management/services/app-api/src/routes/mailbox-internal.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-scans.test.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-internal.test.ts`
- Modify: `expense-tax-management/services/app-api/src/routes/mailbox-connections.ts`
- Modify: `expense-tax-management/services/app-api/src/app.ts`
- Modify: `expense-tax-management/services/mailbox-broker/src/app-client.ts`
- Modify: `expense-tax-management/services/mailbox-broker/test/app-client.test.ts`

**Interfaces:**
- `startManualScan`/`startScheduledScan` return `MailboxScanRunV1` and status `started|skipped_overlap`.
- `recordCandidateMetadata(input: MailboxCandidateMetadataStagingV1): Promise<MailboxCandidateMetadataStagingResultV1>` authenticates `mailbox-broker-app`, validates run/connection binding and exact fence fields, inserts candidates, persists actual `nextHistoryId` in App `mailbox_connections`, and atomically advances App cursor state.
- `MailboxBrokerDiscoveryAppClient extends MailboxBrokerConnectionAppClient` adds `loadScanBinding(scanRunId)` and `stageCandidateMetadata(input)`; B implements these methods in broker `app-client.ts` and owns corresponding App routes.
- Callback transaction locks connection/run, requires `pageSequence === lastPageSequence + 1`, exact `expectedConnectionVersion`, exact `cursorBeforeDigest`, exact `preFenceToken`, and matching permanent request hash. Any duplicate page returns original result; out-of-order/stale page returns `VERSION_CONFLICT` without cursor movement.

- [x] **Step 1: Write failing tests** for concurrent schedule/manual lease, entitlement version, active connection version, cursor-before digest, pre-fence token, page 0/1 order, duplicate replay, out-of-order rejection, and cursor advancement only after all page outcomes are durable.
- [x] **Step 2: Run red:** `pnpm --filter @expense-tax/app-api test -- test/mailbox-scans.test.ts test/mailbox-internal.test.ts`; expected FAIL.
- [x] **Step 3: Implement lease CAS and callback transaction.** Add broker-authenticated `POST /internal/v1/mailbox/scan-runs/:scanRunId/broker-binding` and `POST /internal/v1/mailbox/scan-runs/:scanRunId/candidate-pages`. Implement `MailboxBrokerDiscoveryAppClient` methods in broker `app-client.ts`. App obtains cursor/fence from connection/run state; broker never causes worker to carry it. Return only IDs/counts to worker-facing route.
- [x] **Step 4: Add scan history/manual routes and register them.** Preserve A Office page/API ownership; expose scan run counts/status only.
- [x] **Step 5: Run:** `pnpm --filter @expense-tax/app-api test -- test/mailbox-scans.test.ts test/mailbox-internal.test.ts && pnpm --filter @expense-tax/app-api typecheck`; expected PASS.
- [x] **Step 6: Commit:** `git add services/app-api/src/domain/mailbox-scans.ts services/app-api/src/routes/mailbox-internal.ts services/app-api/src/routes/mailbox-connections.ts services/app-api/src/app.ts services/app-api/test/mailbox-scans.test.ts services/app-api/test/mailbox-internal.test.ts services/mailbox-broker/src/app-client.ts services/mailbox-broker/test/app-client.test.ts && git commit -m "feat(mailbox): fence discovery pages"`

### Task 3: Scan Schedule and Opaque Worker Orchestration

**Local testability:** Fully local with fakes (Temporal test environment, fake Clerk JWKS). No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/services/app-api/src/temporal/mailbox-schedules.ts`
- Create: `expense-tax-management/services/workflow-worker/src/workflows/mailbox-scan.ts`
- Create: `expense-tax-management/services/workflow-worker/src/activities/mailbox.ts`
- Create: `expense-tax-management/services/workflow-worker/test/mailbox-workflows.test.ts`
- Create: `expense-tax-management/services/workflow-worker/test/mailbox-activities.test.ts`
- Modify: `expense-tax-management/services/app-api/src/temporal/client.ts`
- Modify: `expense-tax-management/services/workflow-worker/src/worker.ts`
- Modify: `expense-tax-management/services/workflow-worker/src/workflows/index.ts`
- Modify: `expense-tax-management/services/workflow-worker/src/activities/index.ts`
- Modify: `expense-tax-management/services/workflow-worker/src/clients/mailbox-client.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-temporal.test.ts`

**Interfaces:** `MailboxScanWorkflow.run(MailboxScanExecutionInputV1)` receives only scanRunId. Activities return only `MailboxCandidateBatchV1`, `MailboxScanCountResultV1`, or typed errors.

**Phase 3D-A Task 6 handoff correction (real interface differs from what this task originally assumed):** `MailboxAppApiClient` (`services/workflow-worker/src/clients/mailbox-client.ts`, built by 3D-A Task 3) is **not** a business-method interface — it has no `runDiscovery` method and 3D-A deliberately never added one ("no `discover`/`materialize` business methods ... those are 3D-B/C's job, which build concrete calls on top of this client rather than inventing routes here" — see that file's own header comment). Its real, exact shape is four plumbing primitives only:
```ts
export interface MailboxAppApiClient {
  mintAppToken(): Promise<string>;
  mintBrokerToken(): Promise<string>;
  requestAppApi<T>(input: MailboxApiRequestInput<T>): Promise<T>;
  requestBroker<T>(input: MailboxApiRequestInput<T>): Promise<T>;
}
```
This task's activity must call the broker directly through `requestBroker<DiscoveryPageV1>({ path: ..., method: "POST", responseSchema: ..., body: { scanRunId } })` (or add its own named method, e.g. `runDiscovery`, to this same file/interface as part of this task's own "Modify: services/workflow-worker/src/clients/mailbox-client.ts" step) — it must not assume a pre-existing `.runDiscovery()` method already exists on the object `createMailboxAppApiClient` returns today. Broker calls App directly with `MailboxCandidateMetadataStagingV1`; worker never receives that payload.

- [x] **Step 1: Write failing tests** inspecting serialized workflow inputs/results/heartbeats/errors for absence of history/cursor IDs, pre-fence token, provider IDs, sender, subject, attachment metadata, body, and raw provider errors; assert only opaque IDs/counts/page sequence.
- [x] **Step 2: Run red:** `pnpm --filter @expense-tax/workflow-worker exec vitest run test/mailbox-workflows.test.ts test/mailbox-activities.test.ts && pnpm --filter @expense-tax/app-api test -- test/mailbox-temporal.test.ts`; expected FAIL.
- [x] **Step 3: Implement daily `02:00` schedule** with stable `mailbox-schedule-${connectionId}`, manual workflow `mailbox-scan-${runId}`, overlap skip, entitlement/connection recheck, and lease release. Register `MailboxScanWorkflow` on task queue `expense-tax-processing`, namespace `expense-tax`.
- [x] **Step 4: Implement worker identity.** `MailboxAppApiClient` signs worker-to-App scan endpoints with existing App audience, subject `workflow-worker-mailbox`, scopes `mailbox:discover`/`mailbox:materialize`; add config, negative JWT tests, and provisioning references.
- [x] **Step 5: Run:** `pnpm --filter @expense-tax/workflow-worker exec vitest run test/mailbox-workflows.test.ts test/mailbox-activities.test.ts && pnpm --filter @expense-tax/app-api test -- test/mailbox-temporal.test.ts`; expected PASS.
 - [x] **Step 6: Commit:** `git add services/app-api/src/temporal/mailbox-schedules.ts services/app-api/src/temporal/client.ts services/app-api/test/mailbox-temporal.test.ts services/workflow-worker/src/workflows/mailbox-scan.ts services/workflow-worker/src/activities/mailbox.ts services/workflow-worker/src/worker.ts services/workflow-worker/src/workflows/index.ts services/workflow-worker/src/activities/index.ts services/workflow-worker/src/clients/mailbox-client.ts services/workflow-worker/test/mailbox-workflows.test.ts services/workflow-worker/test/mailbox-activities.test.ts && git commit -m "feat(mailbox): orchestrate opaque scans"`

**Operator note (fix round 1):** registering daily Schedules is not automatic. An operator (or a future startup hook) runs the reconciliation command compiled into the app-api image, the same pattern as Task 7 Stage A's `dispatch-routing` CLI, with migration credentials:
```
APP_MIGRATION_DATABASE_URL=... TEMPORAL_HOST=... TEMPORAL_NAMESPACE=expense-tax MAILBOX_FEATURE_ENABLED=true \
  node dist/temporal/mailbox-schedule-reconcile.js reconcile
```
Idempotent across any number of runs and any set of active, scan-enabled connections; refuses immediately (before touching the database or Temporal) when `MAILBOX_FEATURE_ENABLED` is not `true`. `MailboxScanWorkflow`'s terminal callback (`mailbox_finalize_scan`, added fix round 1) releases each scan's own lease on completion, so an ordinary scan never depends on this reconciliation command running on any particular schedule -- it only governs whether the *daily* Schedule objects themselves exist.

### Task 4: Gmail Fenced Discovery and Direct App Staging

**Local testability:** Mostly local with fakes (stub Gmail API responses). Real-Gmail verification of 404-history recovery and rate-limit backoff against a live test mailbox is **operator-gated** (deferred to Task 6 end-to-end verification against a provisioned test Google account).

**Files:**
- Create: `expense-tax-management/services/mailbox-broker/src/discovery.ts`
- Modify: `expense-tax-management/services/mailbox-broker/src/google-mailbox.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/discovery.test.ts`
- Modify: `expense-tax-management/services/mailbox-broker/src/routes/connections.ts`
- Modify: `expense-tax-management/services/app-api/src/routes/mailbox-internal.ts`
- Modify: `expense-tax-management/services/workflow-worker/src/activities/mailbox.ts`
- Modify: `expense-tax-management/services/workflow-worker/test/mailbox-activities.test.ts`

- [x] **Step 1: Write failing tests** for full pre-fence, bounded lookback, 100 messages, incremental pagination, 404 full-sync recovery, 401 reauth, 429/5xx retry, direct broker->App staging, page fence values, and worker opaque output.
- [x] **Step 2: Run red:** `pnpm --filter @expense-tax/mailbox-broker exec vitest run test/discovery.test.ts && pnpm --filter @expense-tax/workflow-worker exec vitest run test/mailbox-activities.test.ts`; expected FAIL.
- [x] **Step 3: Implement broker discovery.** Broker obtains the connection's decrypted access token and all Gmail cursor/fence state internally through App-bound `scanRunId`; it builds metadata staging callback, calls App directly, and returns only candidate IDs/counts/page sequence to worker.
- [x] **Step 3a: Add broker-authenticated candidate binding.** App exposes `POST /internal/v1/mailbox/candidates/:candidateId/broker-binding`, authenticated as `mailbox-broker-app` with `mailbox:materialize`; it returns `MailboxBrokerCandidateBindingV1` only to broker. Broker uses provider IDs from this binding to refetch the message; worker and Office never receive them.
- [x] **Step 4: Implement 404 recovery.** Re-read App-bound run state, create new internal pre-fence token, perform bounded full sync/replay, and submit ordered callbacks; never expose cursor/history values to worker.
- [x] **Step 5: Run:** `pnpm --filter @expense-tax/mailbox-broker test && pnpm --filter @expense-tax/app-api test -- test/mailbox-internal.test.ts && pnpm --filter @expense-tax/workflow-worker exec vitest run test/mailbox-activities.test.ts`; expected PASS.
- [x] **Step 6: Commit:** `git add services/mailbox-broker/src/discovery.ts services/mailbox-broker/src/google-mailbox.ts services/mailbox-broker/src/routes/connections.ts services/mailbox-broker/test/discovery.test.ts services/app-api/src/routes/mailbox-internal.ts services/workflow-worker/src/activities/mailbox.ts services/workflow-worker/test/mailbox-activities.test.ts && git commit -m "feat(mailbox): stage fenced Gmail candidates"`

### Task 5: Deterministic Classification and Review

**Local testability:** Fully local with fakes. No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/services/mailbox-broker/src/classification.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/classification.test.ts`
- Create: `expense-tax-management/services/app-api/src/domain/mailbox-candidates.ts`
- Create: `expense-tax-management/services/app-api/src/routes/mailbox-candidates.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-candidates.test.ts`
- Modify: `expense-tax-management/frontend/office-web/src/app/(office)/mailbox/page.tsx`
- Modify: `expense-tax-management/frontend/office-web/src/lib/mailbox.ts`
- Modify: `expense-tax-management/frontend/office-web/src/lib/api.ts`
- Modify: `expense-tax-management/frontend/office-web/src/lib/page-data.ts`

- [x] **Step 1: Write failing tests** for deterministic attachment/structured evidence, free-text review, ambiguous scope, duplicate pending, exact reviewer grants, current target-scope membership, retry-only transient errors, and no raw body.
- [x] **Step 2: Run red:** `pnpm --filter @expense-tax/mailbox-broker exec vitest run test/classification.test.ts && pnpm --filter @expense-tax/app-api test -- test/mailbox-candidates.test.ts && pnpm --filter @expense-tax/office-web test -- src/lib/mailbox.test.ts`; expected FAIL.
- [x] **Step 3: Implement classifier/domain.** Broker classification goes into direct App staging contract; App controls candidate status and resolution transaction. No LLM or automatic duplicate merge.
- [x] **Step 4: Extend A Office page/API base.** Add scan history and candidate review actions without changing canonical types or storing provider identifiers in browser storage.
- [x] **Step 5: Run:** `pnpm --filter @expense-tax/mailbox-broker test && pnpm --filter @expense-tax/app-api test -- test/mailbox-candidates.test.ts && pnpm --filter @expense-tax/office-web test`; expected PASS.
- [x] **Step 6: Commit:** `git add services/mailbox-broker/src/classification.ts services/mailbox-broker/test/classification.test.ts services/app-api/src/domain/mailbox-candidates.ts services/app-api/src/routes/mailbox-candidates.ts services/app-api/test/mailbox-candidates.test.ts "frontend/office-web/src/app/(office)/mailbox/page.tsx" frontend/office-web/src/lib/mailbox.ts frontend/office-web/src/lib/api.ts frontend/office-web/src/lib/page-data.ts && git commit -m "feat(mailbox): add candidate review"`

### Task 6: B Verification and C Handoff

**Local testability:** Fully local with fakes for unit/integration suites. End-to-end verification against a real Gmail test account/mailbox is **operator-gated** and does not block `dev` merge; run it before any production activation decision.

**Files:**
- Create: `expense-tax-management/test/integration/app-domain-3d-b-mailbox.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/discovery-security.test.ts`

- [x] **Step 1: Test** lease single flight, permanent replay, page ordering/fences, cursor atomicity, 404 recovery, entitlement pause, review auth, and serialized Temporal payload redaction.
- [x] **Step 2: Run:** `pnpm test && pnpm lint && pnpm typecheck && pnpm build && pnpm contracts:generate && pnpm contracts:check && pnpm --filter @expense-tax/mailbox-broker test && pnpm --filter @expense-tax/office-web test && pnpm --filter @expense-tax/app-api test && pnpm --filter @expense-tax/workflow-worker test && pnpm test:integration -- test/integration/app-domain-3d-b-mailbox.test.ts && git diff --check`; expected PASS with generated drift absent.
- [x] **Step 3: Handoff.** C consumes `MailboxScanRunV1`, `MailboxCandidateV1`, `MailboxCandidateOutcomeV1`, App candidate routes, direct broker staging boundary, and migration 019. C must not place cursor/history/fence values in Temporal. Production activation of this plan's workflows requires runtime migration Task 7 cutover.

#### Task 6 verification record

All checkboxes across this plan (Tasks 1-6) are now marked `[x]`: re-confirmed against the real, built source that every task's deliverables exist, type-check, lint clean, and pass their own test suites (`pnpm ci:lint`, `ci:typecheck`, `ci:test`, `ci:build`, `contracts:check`, `ci:python:lint`, `ci:python:test`, `test:integration` all green; Docker-gated regression for Tasks 2/3/5/6 and 3D-A's own Task 6 suite re-run together against one real PostgreSQL 17 instance, 37/37 pass), plus a new consolidated real-PostgreSQL phase-verification suite (`test/integration/app-domain-3d-b-mailbox.test.ts`) and a broker security-regression suite (`services/mailbox-broker/test/discovery-security.test.ts`), both committed in this task. No defect was found in Task 5's concurrently-re-reviewed files (`4a2153a`); none were modified.

**3D-C handoff corrections recorded:** `docs/superpowers/plans/2026-09-12-phase-3d-c-mailbox-ingestion.md` has been corrected in place (new "Phase 3D-B Handoff Corrections" section, before its Canonical C Contracts) for four places where C's plan assumed something B's real implementation does differently: (1) `ingest` only reaches candidate status `queued` with no job/expense yet -- C's own materialization is what advances it further; (2) the candidate materialize binding is the standalone `MailboxBrokerMaterializeAppClient.loadCandidateBinding` (scope `mailbox:materialize`), not inherited through `MailboxBrokerDiscoveryAppClient`; (3) classification evidence is the fixed `MAILBOX_CANDIDATE_REASON_CODES` catalog (`classification.ts`), which C's structured-HTML detector should feed via its reserved `hasStructuredHtmlSignal`/`hasOrderConfirmationSchema` flags rather than inventing a parallel vocabulary; (4) scheduled scans require an operator to run `mailbox-schedule-reconcile.js reconcile` once after enabling the feature -- nothing creates a connection's Temporal Schedule automatically.
