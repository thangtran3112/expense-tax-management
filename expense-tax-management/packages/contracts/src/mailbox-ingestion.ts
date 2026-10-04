/**
 * Phase 3D-C mailbox ingestion contracts (Task 1: contracts + migration 020
 * prerequisite).
 *
 * - App stages direct broker-uploaded attachments into bounded storage
 *   (issueUploadGrant/uploadAttachment), scans before READY, then creates a
 *   normal storage-backed OCR job. Structured fields arrive via a separate
 *   direct broker-to-App callback (submitStructuredResult) and a
 *   transaction-level expense/dedup path.
 * - Most types below are plain TypeScript interfaces, not Zod schemas --
 *   same "provider I/O / Temporal-boundary payloads are plain interfaces,
 *   validated by the domain layers added in later tasks" convention as
 *   ./mailbox.ts (Phase 3D-A Task 1 Ruling 2) and ./mailbox-discovery.ts's
 *   broker<->App/Temporal-boundary section.
 * - Exception (fix round 2, review Important finding on migration 020's
 *   response_json): MailboxBrokerUploadGrantV1, MailboxAttachmentUploadResultV1,
 *   and MailboxMaterializationResultV1 -- the three shapes
 *   app.mailbox_ingestion_operations.response_json ever caches -- ARE Zod
 *   schemas. The review asked for a "strict Zod contract on write" in
 *   addition to the DB-level per-operation-kind trigger (migration 020);
 *   these are that contract, exported for whichever later task (3/4) first
 *   writes to this ledger to `.parse()` against before persisting. Field
 *   formats mirror the DB trigger's regexes exactly (UUID ids, bounded
 *   whitespace-free opaque tokens, the canonical error-code token pattern)
 *   so the two enforcement layers can never silently drift apart.
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
import { z } from "zod";

import { MailboxErrorCodeV1Schema, type MailboxScope } from "./mailbox.js";
import {
  MAX_CANDIDATE_ATTACHMENTS,
  type MailboxBrokerDiscoveryAppClient,
  type MailboxBrokerMaterializeAppClient,
  type MailboxDiscoveryProviderAdapter,
} from "./mailbox-discovery.js";
import { MAX_UPLOAD_BYTES } from "./files.js";
import { TimestampSchema } from "./expenses.js";

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

/**
 * Bounded, whitespace-free opaque token -- broker/storage-minted IDs
 * (uploadGrantId, fileId) and the mailbox idempotency-key format
 * (mailboxIdempotencyKey() in ./mailbox.js) are none of them guaranteed to
 * be UUIDs, but none of them is free-form prose either. Printable ASCII,
 * no whitespace/control characters (so a multi-line HTML/MIME body can
 * never satisfy it), bounded to the same 500-character column CHECK used
 * throughout this schema (e.g. migration 018's idempotency_key columns).
 * Mirrors migration 020's validate_mailbox_ingestion_operation_response
 * regex exactly.
 */
const OpaqueTokenSchema = z
  .string()
  .regex(/^[\x21-\x7e]{1,500}$/, "must be a bounded, whitespace-free printable-ASCII token");

export const MailboxBrokerUploadGrantV1Schema = z.strictObject({
  candidateId: z.uuid(),
  connectionId: z.uuid(),
  uploadGrantId: OpaqueTokenSchema,
  expiresAt: TimestampSchema,
  maxBytes: z.literal(MAX_UPLOAD_BYTES as 26214400),
  maxAttachments: z.literal(MAX_CANDIDATE_ATTACHMENTS),
});
export type MailboxBrokerUploadGrantV1 = z.infer<typeof MailboxBrokerUploadGrantV1Schema>;

export interface MailboxBrokerAttachmentUploadV1 {
  readonly candidateId: string;
  readonly attachmentIndex: number;
  readonly uploadGrantId: string;
  readonly expectedCandidateVersion: number;
  readonly idempotencyKey: string;
}

export const MailboxAttachmentUploadResultV1Schema = z.strictObject({
  candidateId: z.uuid(),
  attachmentIndex: z.int().min(0).max(MAX_CANDIDATE_ATTACHMENTS - 1),
  fileId: OpaqueTokenSchema,
  status: z.enum(["READY", "REVIEW", "FAILED"]),
  errorCode: MailboxErrorCodeV1Schema.nullable(),
  idempotencyKey: OpaqueTokenSchema,
});
export type MailboxAttachmentUploadResultV1 = z.infer<typeof MailboxAttachmentUploadResultV1Schema>;

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

export const MailboxMaterializationResultV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  candidateId: z.uuid(),
  status: z.enum(["queued", "processed", "duplicate", "review", "failed"]),
  processingJobId: z.uuid().nullable(),
  expenseId: z.uuid().nullable(),
  sourceId: z.uuid().nullable(),
  duplicateMatchId: z.uuid().nullable(),
  idempotencyKey: OpaqueTokenSchema,
});
export type MailboxMaterializationResultV1 = z.infer<typeof MailboxMaterializationResultV1Schema>;

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
