/**
 * Phase 3D-C mailbox ingestion contracts (Task 1: contracts + migration 020
 * prerequisite).
 *
 * - App stages direct broker-uploaded attachments into bounded storage
 *   (issueUploadGrant/uploadAttachment), scans before READY, then creates a
 *   normal storage-backed OCR job. Structured fields arrive via a separate
 *   direct broker-to-App callback (submitStructuredResult) and a
 *   transaction-level expense/dedup path.
 * - Every type below is a plain TypeScript interface, not a Zod schema --
 *   same "provider I/O / Temporal-boundary payloads are plain interfaces,
 *   validated by the domain layers added in later tasks" convention as
 *   ./mailbox.ts (Phase 3D-A Task 1 Ruling 2) and ./mailbox-discovery.ts's
 *   broker<->App/Temporal-boundary section. None of these shapes is a new
 *   persisted-entity public record (unlike MailboxCandidateV1/
 *   MailboxScanRunV1), so none needs its own runtime-enforced schema here.
 * - MailboxBrokerUploadGrantV1.maxBytes/maxAttachments are numeric literal
 *   types (26214400 / 5), verbatim from the plan's canonical block -- the
 *   contract test proves these literals equal MAX_UPLOAD_BYTES (./files.ts)
 *   and MAX_CANDIDATE_ATTACHMENTS (./mailbox-discovery.ts) rather than
 *   re-deriving a third cap.
 * - Ruling (Phase 3D-C controller progress.md): "canonical MailboxIngestionAppClient
 *   extends the existing MailboxBrokerMaterializeAppClient (keeps
 *   loadCandidateBinding)". MailboxBrokerMaterializeAppClient was
 *   previously a broker-local interface (services/mailbox-broker/src/
 *   app-client.ts); it is canonicalized into ./mailbox-discovery.ts so
 *   MailboxIngestionAppClient below can extend it directly -- see that
 *   file's own comment on the move.
 * - Spec authority: 2026-09-12-phase-3d-connected-mailbox-design.md
 *   Plan authority: 2026-09-12-phase-3d-c-mailbox-ingestion.md ("Canonical
 *   C Contracts").
 */
import type { MailboxErrorCodeV1, MailboxScope } from "./mailbox.js";
import type {
  MailboxBrokerDiscoveryAppClient,
  MailboxBrokerMaterializeAppClient,
  MailboxDiscoveryProviderAdapter,
} from "./mailbox-discovery.js";

// ------------------------------------------------------------------ //
// Broker<->App boundary payloads -- attachment upload grant/stream.
// Caps are numeric literal types, not runtime-validated here (same
// deferred-validation convention as ./mailbox-discovery.ts's broker<->App
// boundary payloads); the domain layer added in a later task enforces them.
// ------------------------------------------------------------------ //

export interface MailboxBrokerUploadGrantRequestV1 {
  readonly candidateId: string;
  readonly expectedCandidateVersion: number;
  readonly operationId: string;
}

export interface MailboxBrokerUploadGrantV1 {
  readonly candidateId: string;
  readonly connectionId: string;
  readonly uploadGrantId: string;
  readonly expiresAt: string;
  readonly maxBytes: 26214400;
  readonly maxAttachments: 5;
}

export interface MailboxBrokerAttachmentUploadV1 {
  readonly candidateId: string;
  readonly attachmentIndex: number;
  readonly uploadGrantId: string;
  readonly expectedCandidateVersion: number;
  readonly idempotencyKey: string;
}

export interface MailboxAttachmentUploadResultV1 {
  readonly candidateId: string;
  readonly attachmentIndex: number;
  readonly fileId: string;
  readonly status: "READY" | "REVIEW" | "FAILED";
  readonly errorCode: MailboxErrorCodeV1 | null;
  readonly idempotencyKey: string;
}

// ------------------------------------------------------------------ //
// Materialize -- broker refetches the Gmail message (via the
// MailboxBrokerCandidateBindingV1 binding, loaded separately through
// MailboxBrokerMaterializeAppClient.loadCandidateBinding) and extracts
// structured fields. Temporal/the worker see only opaque IDs.
// ------------------------------------------------------------------ //

export interface MaterializeInput {
  readonly connectionId: string;
  readonly candidateId: string;
  readonly operationId: string;
}

export interface StructuredReceiptResultV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly connectionId: string;
  readonly candidateVersion: number;
  readonly merchant: string;
  readonly amount: string;
  readonly currency: string;
  readonly incurredOn: string;
  readonly orderNumber: string | null;
  readonly notes: string | null;
  readonly evidence: readonly string[];
  readonly idempotencyKey: string;
}

export interface MailboxResolvedStructuredReceiptV1 extends StructuredReceiptResultV1 {
  readonly scope: MailboxScope;
  readonly scopeSource: "connection_default" | "review_assignment";
}

export interface Phase3CEnrichmentInputV1 {
  readonly expenseId: string;
  readonly tenantId: string;
  readonly scope: MailboxScope;
  readonly source: "connected_mailbox";
  readonly expectedExpenseVersion: number;
  readonly idempotencyKey: string;
}

export type MailboxOcrJobActorV1 =
  | { readonly kind: "user"; readonly requestedByUserId: string }
  | { readonly kind: "service"; readonly actorServicePrincipal: "mailbox-broker-app" };

export interface MailboxMaterializationResultV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly status: "queued" | "processed" | "duplicate" | "review" | "failed";
  readonly processingJobId: string | null;
  readonly expenseId: string | null;
  readonly sourceId: string | null;
  readonly duplicateMatchId: string | null;
  readonly idempotencyKey: string;
}

// ------------------------------------------------------------------ //
// Direct callbacks -- broker-to-App, outside Temporal.
// ------------------------------------------------------------------ //

export interface MailboxStructuredReceiptCallbackV1 {
  readonly result: StructuredReceiptResultV1;
  readonly idempotencyKey: string;
}

/**
 * Temporal-boundary input for the (not-yet-named-by-this-task) worker
 * activity/workflow that drives materialization. scanRunId refers to the
 * candidate's originating scan run (app.mailbox_candidates.scan_run_id),
 * not a new run started for materialization itself -- there is none.
 */
export interface MailboxWorkerMaterializationInputV1 {
  readonly scanRunId: string;
  readonly candidateId: string;
}

export interface MailboxIngestionAppClient
  extends MailboxBrokerDiscoveryAppClient,
    MailboxBrokerMaterializeAppClient {
  issueUploadGrant(input: MailboxBrokerUploadGrantRequestV1): Promise<MailboxBrokerUploadGrantV1>;
  uploadAttachment(
    input: MailboxBrokerAttachmentUploadV1,
    source: AsyncIterable<Buffer>,
  ): Promise<MailboxAttachmentUploadResultV1>;
  submitStructuredResult(
    input: MailboxStructuredReceiptCallbackV1,
  ): Promise<MailboxMaterializationResultV1>;
}

export interface MailboxIngestionProviderAdapter extends MailboxDiscoveryProviderAdapter {
  materialize(input: MaterializeInput): Promise<MailboxMaterializationResultV1>;
}
