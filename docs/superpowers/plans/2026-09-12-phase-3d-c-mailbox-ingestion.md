# Phase 3D-C Mailbox Ingestion and Connected Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Not started; blocked by Phase 3D-B. Refresh `origin/dev` and use a new `feature/*` worktree after Phase 3D-B merges.

**Goal:** Stream Gmail attachments through direct broker-to-App callbacks, create storage-backed OCR jobs without bytes in Temporal, materialize bounded structured receipts, preserve connected provenance and Phase 3B pending dedup, and finish Office status UI.

**Architecture:** Broker owns Gmail refetch and streams bytes directly to an App signed upload endpoint. App stages into bounded storage, scans before READY, then creates a normal storage-backed OCR job using immutable owner/service actor and deterministic entitlement-selected `modeKey`. Structured fields use a direct broker-to-App callback and transaction-level expense/dedup path. Worker orchestrates opaque candidate IDs/counts only.

**Tech Stack:** TypeScript Fastify/Kysely/PostgreSQL, Node streams, bounded temp/object storage, malware scanner, existing file/OCR/job domains, Phase 3B dedup, TypeScript Temporal SDK (`services/workflow-worker`), Next.js 16 React 19 Office Web, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md`

## Global Constraints

- Phase 3C migration 016, runtime migration Task 7 Stage A migration 017, 3D-A migration 018, and 3D-B migration 019 must be complete. 3D-C owns migration `020` only.
- Consume exact A/B names unchanged: `MailboxConnectionV1`, `MailboxConnectionRecordV1`, `MailboxScope`, `MailboxProviderAdapter`, `MailboxDiscoveryProviderAdapter`, `MailboxBrokerDiscoveryAppClient`, `MailboxErrorCodeV1`, `mailboxIdempotencyKey`, `MailboxScanRunV1`, `MailboxCandidateV1`, `MailboxCandidateOutcomeV1`.
- No reuse of current OCR workflow for mailbox attachments: current workflow passes receipt bytes through Temporal. Mailbox workflow calls broker/App direct opaque callbacks; after App storage is READY, existing OCR worker reads by file ID through normal job-bound storage URL.
- Temporal inputs/results/heartbeats/errors contain only opaque scan/candidate/job IDs, counts, page sequence, and typed errors. No Gmail cursor/history ID, pre-fence token, message/thread ID, sender, subject, attachment bytes/metadata, HTML, or structured fields.
- Attachment caps are exactly five accepted attachments per candidate/message and 25 MiB per attachment. Broker and App enforce both; no 125 MiB aggregate buffer is created.
- Parser consumes bounded byte stream/buffer with pre-allocation length check, bounded decode, node/depth/deadline checks; no unbounded string conversion, external fetch, script execution, XML DTD/entity expansion, or decompression beyond Gmail bound.
- Connected source is App-owned, `expense_sources.source_type = "connected_mailbox"`, includes `mailbox_candidate_id`, and remains pending-review through Phase 3B dedup. No automatic merge.
- A creates mailbox Office page/API base; B modifies it for scan/review; C modifies it only for ingestion status. A creates broker/worker base; B creates scan modules; C creates ingestion modules.
- This plan's workflows run only on the TypeScript `services/workflow-worker`; production activation requires runtime migration Task 7 cutover (`sub-plans/runtime-typescript-temporal-migration.md`).
- Remote Clerk writes require explicit execution-time confirmation. Local commits and all remote git operations follow `AGENTS.md`.

---

## Phase 3D-B Handoff Corrections (recorded by 3D-B Task 6, as actually built)

Real 3D-B interfaces differ from this plan's assumptions in four places. Corrected here in place, per 3D-A Task 6's own precedent of fixing a handoff mismatch directly in the consuming plan rather than leaving it for C's implementer to rediscover.

- **Candidate states: `ingest` only reaches `queued`, with no job/expense yet.** `resolveCandidate`'s `ingest` action (`services/app-api/src/domain/mailbox-candidates.ts`) assigns the target scope and sets `MailboxCandidateV1.status = "queued"`, then stops -- it does not create a processing job, file, or expense (3D-B Task 5's own report: "ingest's scope assignment does not yet create a processing job/expense ... candidate moves to queued and stops there by design"). C's ingestion entry point is therefore **candidates already in status `queued`**, not `review`/`staged` directly; C's Task 1/3 polling or dispatch logic must filter on `status = "queued"` to find work, and C's own materialization (`issueUploadGrant`/`submitStructuredReceipt`) is what eventually advances a `queued` candidate to `processed`/`duplicate`/`review`/`failed`. Migration 019's `mailbox_candidates_status_check` enum (`staged|review|queued|processed|duplicate|skipped|failed`) already has `queued` — no migration 020 change needed for this status value itself.
- **Materialize binding is `MailboxBrokerMaterializeAppClient.loadCandidateBinding`, a standalone interface, not folded into `MailboxBrokerDiscoveryAppClient`.** B's Task 4 fix round 1 added `POST /internal/v1/mailbox/candidates/:candidateId/broker-binding` (guarded by broker subject `mailbox-broker-app`, scope **`mailbox:materialize`** — distinct from the page-callback routes' `mailbox:write`) and a matching client method `loadCandidateBinding(candidateId): Promise<MailboxBrokerCandidateBindingV1>` (`services/mailbox-broker/src/app-client.ts`). It was deliberately kept as its own interface rather than added to `MailboxBrokerConnectionAppClient`/`MailboxBrokerDiscoveryAppClient` (Task 4 Ruling 3: "Neither canonical contract names a client method for this route"). This plan's `MailboxIngestionAppClient extends MailboxBrokerDiscoveryAppClient` does **not** inherit `loadCandidateBinding` — C's Task 2/5 implementation must also extend/compose `MailboxBrokerMaterializeAppClient` (or add an equivalent method) to call this route and obtain the real `providerMessageId`/`providerThreadId` before `materialize()` refetches the Gmail message. The `mailbox:materialize` scope on the worker's own Clerk identity (`workflow-worker-mailbox`) this plan's Global Constraints already expect (`sub-plans/runtime-typescript-temporal-migration.md`) is the broker's scope, not the worker's — the worker never calls this route directly, only the broker does, on the broker's own `mailbox-broker-app` service identity.
- **Classification evidence is a fixed 9-code catalog, not free-form strings.** `services/mailbox-broker/src/classification.ts` exports `MAILBOX_CANDIDATE_REASON_CODES` (`pdf_attachment_detected`, `order_confirmation_schema`, `structured_html_invoice`, `sender_domain_known_retailer`, `sender_domain_unverified`, `subject_keyword_order`, `free_text_only_low_confidence`, `marketing_keyword_match`, `no_structured_or_attachment_evidence`) and `classifyCandidateEvidence`, wired into the live Gmail discovery path (`discovery.ts`, Task 4 fix round 2). `MailboxCandidateV1.evidence` entries are always members of this catalog (one additive exception: `discovery.ts` appends the literal string `"attachment_oversize"`, which is **not** in the catalog, when an attachment exceeds 25 MiB). `hasStructuredHtmlSignal`/`hasOrderConfirmationSchema` are reserved input flags for exactly the structured-HTML detector C's Task 2 (`parseStructuredReceipt`) builds — C should feed its own structured-HTML detection result into this existing classifier via those flags (surfacing `order_confirmation_schema`/`structured_html_invoice` evidence) rather than inventing a parallel evidence vocabulary for `StructuredReceiptResultV1.evidence`, which is a separate field (parsed-field provenance: which merchant/amount/date signals were found) and intentionally does not share this catalog.
- **Scheduled scans require an operator-run reconcile command; nothing creates a connection's Temporal Schedule automatically.** B's Task 3 fix round 1 added `services/app-api/src/temporal/mailbox-schedule-reconcile.ts` (`node dist/temporal/mailbox-schedule-reconcile.js reconcile`) specifically because `ensureMailboxSchedule` is never invoked from `buildApp`/module import (Ruling: "prefer reconciliation over import-time creation"). An existing connection's daily `02:00` schedule — the mechanism that eventually produces the `MailboxScanRunV1`/candidates C's ingestion consumes — will not exist until an operator runs this command once after `MAILBOX_FEATURE_ENABLED` is turned on (and, for production, after the runtime migration Task 7 cutover below). C's Task 7 operator-gated end-to-end verification step should run `mailbox-schedule-reconcile.js reconcile` before expecting any scheduled scan to fire.

---

## Canonical C Contracts

```ts
// AttachmentManifestV1 is consumed unchanged from Phase 3D-B.
export interface MailboxBrokerUploadGrantRequestV1 { readonly candidateId: string; readonly expectedCandidateVersion: number; readonly operationId: string; }
export interface MailboxBrokerUploadGrantV1 { readonly candidateId: string; readonly connectionId: string; readonly uploadGrantId: string; readonly expiresAt: string; readonly maxBytes: 26214400; readonly maxAttachments: 5; }
export interface MailboxBrokerAttachmentUploadV1 { readonly candidateId: string; readonly attachmentIndex: number; readonly uploadGrantId: string; readonly expectedCandidateVersion: number; readonly idempotencyKey: string; }
export interface MailboxAttachmentUploadResultV1 { readonly candidateId: string; readonly attachmentIndex: number; readonly fileId: string; readonly status: "READY" | "REVIEW" | "FAILED"; readonly errorCode: MailboxErrorCodeV1 | null; readonly idempotencyKey: string; }
export interface MaterializeInput { readonly connectionId: string; readonly candidateId: string; readonly operationId: string; }
export interface StructuredReceiptResultV1 {
  readonly schemaVersion: 1; readonly candidateId: string; readonly connectionId: string; readonly candidateVersion: number;
  readonly merchant: string; readonly amount: string; readonly currency: string; readonly incurredOn: string;
  readonly orderNumber: string | null; readonly notes: string | null;
  readonly evidence: readonly string[]; readonly idempotencyKey: string;
}
export interface MailboxResolvedStructuredReceiptV1 extends StructuredReceiptResultV1 {
  readonly scope: MailboxScope; readonly scopeSource: "connection_default" | "review_assignment";
}
export interface Phase3CEnrichmentInputV1 { readonly expenseId: string; readonly tenantId: string; readonly scope: MailboxScope; readonly source: "connected_mailbox"; readonly expectedExpenseVersion: number; readonly idempotencyKey: string; }
export type MailboxOcrJobActorV1 =
  | { readonly kind: "user"; readonly requestedByUserId: string }
  | { readonly kind: "service"; readonly actorServicePrincipal: "mailbox-broker-app" };
export interface MailboxMaterializationResultV1 {
  readonly schemaVersion: 1; readonly candidateId: string; readonly status: "queued" | "processed" | "duplicate" | "review" | "failed";
  readonly processingJobId: string | null; readonly expenseId: string | null; readonly sourceId: string | null; readonly duplicateMatchId: string | null; readonly idempotencyKey: string;
}
```

Direct callbacks return only these contracts:

```ts
interface MailboxStructuredReceiptCallbackV1 { readonly result: StructuredReceiptResultV1; readonly idempotencyKey: string; }
interface MailboxWorkerMaterializationInputV1 { readonly scanRunId: string; readonly candidateId: string; }
interface MailboxIngestionAppClient extends MailboxBrokerDiscoveryAppClient {
  issueUploadGrant(input: MailboxBrokerUploadGrantRequestV1): Promise<MailboxBrokerUploadGrantV1>;
  uploadAttachment(input: MailboxBrokerAttachmentUploadV1, source: AsyncIterable<Buffer>): Promise<MailboxAttachmentUploadResultV1>;
  submitStructuredResult(input: MailboxStructuredReceiptCallbackV1): Promise<MailboxMaterializationResultV1>;
}
interface MailboxIngestionProviderAdapter extends MailboxDiscoveryProviderAdapter {
  materialize(input: MaterializeInput): Promise<MailboxMaterializationResultV1>;
}
```

### Task 1: Contracts and Migration 020 with Connected Provenance

**Local testability:** Fully local with fakes. No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/packages/contracts/src/mailbox-ingestion.ts`
- Modify: `expense-tax-management/packages/contracts/src/index.ts`
- Create: `expense-tax-management/packages/contracts/test/mailbox-ingestion.test.ts`
- Create: `expense-tax-management/services/app-api/src/database/migrations/020_mailbox_ingestion.ts`
- Modify: `expense-tax-management/services/app-api/src/database/types.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-ingestion-database.test.ts`

- [ ] **Step 1: Write failing tests** for migration prerequisite `016,017,018,019`, exact contract fields, 5 x 25 MiB caps, no raw content, and connected source constraints.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/contracts exec vitest run test/mailbox-ingestion.test.ts && pnpm --filter @expense-tax/app-api test -- test/mailbox-ingestion-database.test.ts`; expected FAIL.
- [ ] **Step 3: Alter Phase 3B source schema exclusively in migration 020.** Extend `source_type` check to `manual_upload|forwarded_email|connected_mailbox`; add nullable `mailbox_candidate_id`; require connected rows to have candidate ID, no inbound email requirement, and exact tenant/scope match through trigger/FK. Add unique `(tenant_id, mailbox_candidate_id)`. Do not modify historical migration 015.
- [ ] **Step 4: Add `app.mailbox_ingestion_operations`.** Store operation kind, candidate/connection IDs, normalized request hash, original result, status/version, and permanent key with unique `(tenant_id, operation_key, idempotency_key)`; reject same-key/different-payload.
- [ ] **Step 5: Run:** `pnpm contracts:generate && pnpm contracts:check && pnpm --filter @expense-tax/app-api typecheck`; expected PASS with no generated drift.
- [ ] **Step 6: Commit:** `git add packages/contracts/src/mailbox-ingestion.ts packages/contracts/src/index.ts packages/contracts/test/mailbox-ingestion.test.ts services/app-api/src/database/migrations/020_mailbox_ingestion.ts services/app-api/src/database/types.ts services/app-api/test/mailbox-ingestion-database.test.ts packages/contracts/generated && git commit -m "feat(mailbox): add connected ingestion schema"`

### Task 2: Bounded Broker Streaming and Structured Parser

**Local testability:** Fully local with fakes (synthetic streams/HTML fixtures). No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/services/mailbox-broker/src/ingestion.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/structured-receipt.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/ingestion.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/structured-receipt.test.ts`
- Modify: `expense-tax-management/services/mailbox-broker/src/routes/connections.ts`
- Modify: `expense-tax-management/services/mailbox-broker/src/app-client.ts`
- Modify: `expense-tax-management/services/mailbox-broker/test/app-client.test.ts`

**Interfaces:**
- `streamAttachment(input: MailboxBrokerAttachmentUploadV1, target: { write(chunk: Buffer): Promise<void>; abort(): Promise<void> }): Promise<AttachmentManifestV1>` uses backpressure and never returns bytes.
- `parseStructuredReceipt(stream: AsyncIterable<Buffer>, metadata: { candidateId: string; connectionId: string; candidateVersion: number }): Promise<StructuredReceiptResultV1 | { status: "review" | "skipped"; errorCode: MailboxErrorCodeV1 }>`; parser result is scope-free and broker never selects a scope.

- [ ] **Step 1: Write failing tests** for first-chunk magic checks, byte-count cutoff at 25 MiB, sixth attachment rejection, SHA-256, backpressure, stream abort, parser input pre-allocation refusal above 1 MiB decoded budget, bounded decode, 20,000 nodes, depth 64, 2 seconds, and no unbounded string.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/mailbox-broker exec vitest run test/ingestion.test.ts test/structured-receipt.test.ts`; expected FAIL.
- [ ] **Step 3: Implement stream and ingestion client extension.** Implement `MailboxIngestionAppClient` upload-grant, upload-attachment, and typed structured-result methods in broker `app-client.ts`. Broker streams directly to App signed upload callback; checks exactly five attachments and 25 MiB each before accepting; malware scan runs in App staging path, not Temporal.
- [ ] **Step 4: Implement parser.** Read bounded chunks into at most 1 MiB owned parser buffer after length accounting; decode only after bound passes; enforce deadline/node/depth counters; emit normalized fields/evidence only.
- [ ] **Step 5: Run:** `pnpm --filter @expense-tax/mailbox-broker test && pnpm --filter @expense-tax/mailbox-broker lint && pnpm --filter @expense-tax/mailbox-broker typecheck`; expected PASS.
- [ ] **Step 6: Commit:** `git add services/mailbox-broker/src/ingestion.ts services/mailbox-broker/src/structured-receipt.ts services/mailbox-broker/src/routes/connections.ts services/mailbox-broker/src/app-client.ts services/mailbox-broker/test/app-client.test.ts services/mailbox-broker/test/ingestion.test.ts services/mailbox-broker/test/structured-receipt.test.ts && git commit -m "feat(mailbox): bound attachment and HTML processing"`

### Task 3: App Streaming-to-Storage, Malware Scan, and OCR Handoff

**Local testability:** Fully local with fakes (fake malware-scanner adapter, local storage). No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/services/app-api/src/storage/bounded-stream.ts`
- Create: `expense-tax-management/services/app-api/src/domain/mailbox-ingestion.ts`
- Create: `expense-tax-management/services/app-api/src/routes/mailbox-ingestion.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-ingestion.test.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/files.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/processing-jobs.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/ocr.ts`
- Modify: `expense-tax-management/services/app-api/src/app.ts`

**Interfaces:**
- `FilesDomain.writeMailboxAttachment(input: { candidateId: string; attachmentIndex: number; uploadGrantId: string; expectedCandidateVersion: number; actorServicePrincipal: "mailbox-broker-app"; requestId: string }, source: AsyncIterable<Buffer>): Promise<MailboxAttachmentUploadResultV1>`.
- `createMailboxIngestionDomain` exposes `issueUploadGrant`, `receiveAttachment`, `submitStructuredReceipt`, and `recordConnectedMailboxEvidence`.
- OCR handoff consumes `MailboxOcrJobActorV1`; App adds a mailbox-specific command accepting that exact actor union and resolves `modeKey` internally from `connected_mailbox_scan` entitlement, always selecting `"ocr_mode_fast"` for this phase.
- `MailboxStagingScanner` is new: `scanStream(source: AsyncIterable<Buffer>): Promise<{ clean: boolean; code: string | null }>` is optional; required fallback is `scanStagedObject(input: { storageKey: string; sizeBytes: number; contentType: string }): Promise<{ clean: boolean; code: string | null }>` before READY. The fallback stages to bounded temp/object storage, reads only within 25 MiB, calls the existing malware engine through this adapter, then deletes the staged object on either result.
- Worker never calls current `writePendingContent(Buffer)`. New method writes bounded temp file/object incrementally, computes hash/size, scans before READY, and never creates a 25 MiB Buffer in Temporal; no mailbox bytes enter Temporal.

- [ ] **Step 1: Write failing tests** for grant binding, stream size/hash, 5 x 25 MiB, malware clean/infected, temp/object cleanup, READY only after scan, candidate version conflict, and no `Buffer` argument crossing worker/Temporal.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/app-api test -- test/mailbox-ingestion.test.ts`; expected FAIL.
- [ ] **Step 3: Implement bounded storage interface.** Use chunked writes to existing storage adapter or bounded temp file; enforce `MAX_UPLOAD_BYTES` per attachment and five attachments at candidate level; delete failed temp/object before returning typed review/failed result.
- [ ] **Step 4: Implement immutable OCR handoff.** Resolve candidate owner from App row; set `requestedByUserId` to immutable connection owner for user-owned scans or `actorServicePrincipal = "mailbox-broker-app"` for service-owned review ingestion; select deterministic `modeKey = "ocr_mode_fast"` only after App entitlement resolution; create a normal `processing_jobs` row with existing storage-backed `fileId` and new workflow type `MailboxOcrReceiptWorkflow` only after READY. Modify `processing-jobs.ts` and OCR materialization so legal flow is `PENDING -> DISPATCHED -> RUNNING -> SUCCEEDED` or `FAILED`; only SUCCEEDED atomically materializes expense, connected provenance, Phase 3C enrichment, and pending dedup, while FAILED creates no expense/provenance. Do not use `ForwardedReceiptWorkflow`/`OcrReceiptWorkflow`: their byte/result activity payloads violate this boundary.
- [ ] **Step 5: Run:** `pnpm --filter @expense-tax/app-api test -- test/mailbox-ingestion.test.ts && pnpm --filter @expense-tax/app-api typecheck`; expected PASS.
- [ ] **Step 6: Commit:** `git add services/app-api/src/storage/bounded-stream.ts services/app-api/src/domain/mailbox-ingestion.ts services/app-api/src/routes/mailbox-ingestion.ts services/app-api/src/domain/files.ts services/app-api/src/domain/processing-jobs.ts services/app-api/src/domain/ocr.ts services/app-api/src/app.ts services/app-api/test/mailbox-ingestion.test.ts && git commit -m "feat(mailbox): stream staged files into OCR"`

### Task 4: Structured Receipt Transaction and Shared Dedup Evidence

**Local testability:** Fully local with fakes (test PostgreSQL transaction tests). No Google credentials or production access needed.

**Files:**
- Modify: `expense-tax-management/services/app-api/src/domain/mailbox-ingestion.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/deduplication.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/expenses.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/processing-jobs.ts`
- Modify: `expense-tax-management/services/app-api/src/domain/ocr.ts`
- Modify: `expense-tax-management/services/app-api/src/routes/mailbox-ingestion.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-structured-receipt.test.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-deduplication.test.ts`

**Interfaces:**
- `recordConnectedMailboxEvidenceInTransaction(transaction, input: { expenseId: string; candidateId: string; connectionId: string; tenantId: string; scope: MailboxScope; sourceFileId: string | null; evidence: JsonValue; requestId: string; idempotencyKey: string }): Promise<{ sourceId: string; duplicateMatchIds: readonly string[]; decision: "no_match" | "review" }>` works without processing job/file and is shared by structured and OCR materialization.
- `submitStructuredReceipt(input: MailboxStructuredReceiptCallbackV1): Promise<MailboxMaterializationResultV1>` resolves candidate default/reviewed scope in App, constructs `MailboxResolvedStructuredReceiptV1`, calls `insertExpenseInTransaction`, inserts `expense_sources` connected row with `mailbox_candidate_id`, creates Phase 3C enrichment outbox/job, calls transaction-level dedup evidence, and commits atomically.

- [ ] **Step 1: Write failing transaction tests** for structured receipt success, invalid money/currency/date, stale candidate, scope mismatch, enrichment outbox rollback, connected source constraint, replay result, duplicate pending match, and structured receipt with no OCR job/file.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/app-api test -- test/mailbox-structured-receipt.test.ts test/mailbox-deduplication.test.ts`; expected FAIL.
- [ ] **Step 3: Implement shared transaction dedup.** App resolves same-tenant/exact-scope existing expenses, writes `connected_mailbox` provenance and Phase 3B pending match evidence, and never auto-merges or requires succeeded OCR job.
- [ ] **Step 4: Implement structured transaction.** Validate normalized merchant, decimal-to-minor-unit amount, ISO currency, date, optional order number, candidate version, and App-resolved scope; store evidence names/hashes only, never HTML/text.
- [ ] **Step 5: Run:** `pnpm --filter @expense-tax/app-api test -- test/mailbox-structured-receipt.test.ts test/mailbox-deduplication.test.ts test/deduplication.test.ts && pnpm --filter @expense-tax/app-api typecheck`; expected PASS.
- [ ] **Step 6: Commit:** `git add services/app-api/src/domain/mailbox-ingestion.ts services/app-api/src/domain/deduplication.ts services/app-api/src/domain/expenses.ts services/app-api/src/domain/processing-jobs.ts services/app-api/src/domain/ocr.ts services/app-api/src/routes/mailbox-ingestion.ts services/app-api/test/mailbox-structured-receipt.test.ts services/app-api/test/mailbox-deduplication.test.ts && git commit -m "feat(mailbox): materialize structured receipts safely"`

### Task 5: Direct Broker/App Materialization and Opaque Worker Activity

**Local testability:** Fully local with fakes (fake broker/App HTTP clients, Temporal test environment). No Google credentials or production access needed.

**Files:**
- Modify: `expense-tax-management/services/mailbox-broker/src/ingestion.ts`
- Modify: `expense-tax-management/services/mailbox-broker/src/structured-receipt.ts`
- Modify: `expense-tax-management/services/mailbox-broker/src/routes/connections.ts`
- Create: `expense-tax-management/services/workflow-worker/src/activities/mailbox-ingestion.ts`
- Create: `expense-tax-management/services/workflow-worker/test/mailbox-ingestion.test.ts`
- Modify: `expense-tax-management/services/workflow-worker/src/workflows/mailbox-scan.ts`
- Modify: `expense-tax-management/services/workflow-worker/src/worker.ts`
- Modify: `expense-tax-management/services/workflow-worker/src/clients/mailbox-client.ts`

- [ ] **Step 1: Write failing tests** for broker direct signed upload/materialization callbacks, exact `mailbox-broker-app` callback identity, worker App identity `workflow-worker-mailbox` with App audience/scopes, opaque workflow payloads, permanent callback keys, and no current OCR byte/result reuse.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/workflow-worker exec vitest run test/mailbox-ingestion.test.ts test/mailbox-workflows.test.ts`; expected FAIL.
- [ ] **Step 3: Implement direct callbacks.** Broker calls App upload grant/upload/result routes directly; structured result calls App direct. Worker receives candidate IDs/counts and invokes only broker operation by opaque ID; broker/App return opaque `MailboxMaterializationResultV1`.
- [ ] **Step 4: Implement `MailboxOcrReceiptWorkflow`.** It receives only `JobReferenceV1`; one activity loads job-bound file ID, downloads bytes, runs deterministic OCR extraction, submits the validated result and shared transaction-level dedup evidence directly to App, and returns only `MailboxMaterializationResultV1`/typed error. Bytes and extraction fields remain inside activity memory and never become workflow input, result, heartbeat, exception, or history. App-created READY file and normal processing job use this workflow through existing dispatch on task queue `expense-tax-processing`.
- [ ] **Step 5: Run:** `pnpm --filter @expense-tax/workflow-worker test && pnpm --filter @expense-tax/workflow-worker lint && pnpm --filter @expense-tax/workflow-worker typecheck && pnpm --filter @expense-tax/mailbox-broker test`; expected PASS.
- [ ] **Step 6: Commit:** `git add services/mailbox-broker/src/ingestion.ts services/mailbox-broker/src/structured-receipt.ts services/mailbox-broker/src/routes/connections.ts services/workflow-worker/src/activities/mailbox-ingestion.ts services/workflow-worker/src/workflows/mailbox-scan.ts services/workflow-worker/src/worker.ts services/workflow-worker/src/clients/mailbox-client.ts services/workflow-worker/test/mailbox-ingestion.test.ts && git commit -m "feat(mailbox): use direct materialization callbacks"`

### Task 6: Office Ingestion Status UI

**Local testability:** Fully local with fakes. No Google credentials or production access needed.

**Files:**
- Modify: `expense-tax-management/frontend/office-web/src/app/(office)/mailbox/page.tsx`
- Modify: `expense-tax-management/frontend/office-web/src/lib/mailbox.ts`
- Modify: `expense-tax-management/frontend/office-web/src/lib/api.ts`
- Modify: `expense-tax-management/frontend/office-web/src/lib/page-data.ts`
- Create: `expense-tax-management/frontend/office-web/src/lib/mailbox-ingestion.test.ts`

- [ ] **Step 1: Write failing tests** for queued/processed/duplicate/review/failed status, OCR job/file-free structured receipt response, pending dedup link, no raw content, stale conflict refresh, and disconnected access.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/office-web test -- src/lib/mailbox-ingestion.test.ts`; expected FAIL.
- [ ] **Step 3: Modify A/B mailbox page/API.** Render ingestion status and opaque result references/counts; keep connection, scan, candidate, and review actions intact; no provider message IDs or content in browser storage.
- [ ] **Step 4: Run:** `pnpm --filter @expense-tax/office-web test && pnpm --filter @expense-tax/office-web lint && pnpm --filter @expense-tax/office-web typecheck && pnpm --filter @expense-tax/office-web build`; expected PASS.
- [ ] **Step 5: Commit:** `git add "frontend/office-web/src/app/(office)/mailbox/page.tsx" frontend/office-web/src/lib/mailbox.ts frontend/office-web/src/lib/api.ts frontend/office-web/src/lib/page-data.ts frontend/office-web/src/lib/mailbox-ingestion.test.ts && git commit -m "feat(office): show mailbox ingestion status"`

### Task 7: C End-to-End Verification

**Local testability:** Integration suite is fully local with fakes (test PostgreSQL, fake Gmail/Clerk). The e2e suite against a real Gmail test account/mailbox and production-shaped Compose is **operator-gated**; it does not block `dev` merge and runs before any production activation decision, after runtime migration Task 7 cutover.

**Files:**
- Create: `expense-tax-management/test/integration/app-domain-3d-c-mailbox.test.ts`
- Create: `expense-tax-management/test/e2e/connected-mailbox.e2e.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/no-sensitive-data.test.ts`

- [ ] **Step 1: Test** migration sequence 016/017/018/019/020, direct upload, bounded scan/cleanup, exactly 5 x 25 MiB, READY gating, storage-backed OCR job actor/mode, direct structured transaction, connected source constraint, transaction-level pending dedup, Phase 3C handoff, Office status, disconnect, and permanent replay.
- [ ] **Step 2: Assert** Temporal payload/history/heartbeat/error, App rows, broker token-vault database, broker/App logs, HTTP responses, browser storage, and VPS files contain no plaintext cursor/history ID, pre-fence token, Gmail ID, token/code/verifier/client secret, body/HTML/MIME, or attachment bytes.
- [ ] **Step 3: Run full verification:** `pnpm --filter @expense-tax/mailbox-broker run lint && pnpm --filter @expense-tax/mailbox-broker run typecheck && pnpm --filter @expense-tax/mailbox-broker run test && pnpm --filter @expense-tax/mailbox-broker run build && pnpm --filter @expense-tax/office-web run lint && pnpm --filter @expense-tax/office-web run typecheck && pnpm --filter @expense-tax/office-web run test && pnpm --filter @expense-tax/office-web run build && pnpm --filter @expense-tax/app-api run lint && pnpm --filter @expense-tax/app-api run typecheck && pnpm --filter @expense-tax/app-api run test && pnpm --filter @expense-tax/app-api run build && pnpm --filter @expense-tax/foundry-service run lint && pnpm --filter @expense-tax/foundry-service run typecheck && pnpm --filter @expense-tax/foundry-service run test && pnpm --filter @expense-tax/foundry-service run build && pnpm --filter @expense-tax/workflow-worker run lint && pnpm --filter @expense-tax/workflow-worker run typecheck && pnpm --filter @expense-tax/workflow-worker run test && pnpm --filter @expense-tax/workflow-worker run build && pnpm contracts:generate && pnpm contracts:check && git diff --check`; expected PASS with generated drift absent.
- [ ] **Step 4: Run reserved-word and diff checks:** `if grep -R -nE 'T\\x42D|T\\x4fDO|placeh\\x6clder|Similar\\x20to\\x20Task|handle\\x20edge\\x20cases|appropriate\\x20error' docs/superpowers/plans/2026-09-12-phase-3d-a-mailbox-broker.md docs/superpowers/plans/2026-09-12-phase-3d-b-mailbox-discovery.md docs/superpowers/plans/2026-09-12-phase-3d-c-mailbox-ingestion.md; then exit 1; fi; git diff --check`; expected no grep output and clean diff check.
- [ ] **Step 5: Run integration:** `PHASE_3D_INTEGRATION=1 pnpm exec vitest run test/integration/app-domain-3d-c-mailbox.test.ts`; expected PASS through migration 020, all replay/authorization/security checks, and no remote writes.
- [ ] **Step 6 (operator-gated, after Task 7 cutover):** `pnpm exec vitest run test/e2e/connected-mailbox.e2e.test.ts` against a provisioned test Google account and the VPS Compose stack; expected PASS with no remote writes outside the test mailbox.
