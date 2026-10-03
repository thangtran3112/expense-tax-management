/**
 * Phase 3D-B mailbox discovery contracts (Task 1: contracts + migration 019
 * prerequisite).
 *
 * - App API owns scan-run/candidate rows, cursor fences, lease CAS, and
 *   review authorization. Broker reads Gmail and calls App staging directly.
 * - Temporal and the TypeScript workflow worker orchestrate only opaque
 *   run/candidate IDs, counts, page sequence, and typed errors -- they never
 *   receive or return Gmail cursor/history IDs or provider metadata. The
 *   "execution/batch/count" contract group below is tested for exactly this.
 * - MailboxScanRunV1/MailboxCandidateV1/MailboxCandidateRecordV1/
 *   AttachmentManifestV1 are App-persisted/HTTP-boundary entities (same
 *   role as MailboxConnectionV1/RecordV1 in ./mailbox.ts) and are therefore
 *   strict Zod schemas, not plain interfaces, so size/count/format bounds
 *   (five-attachment cap, SHA-256 digest, MIME allow-list) are enforced at
 *   runtime, not just at compile time.
 * - The remaining App<->broker and Temporal-boundary payload shapes are
 *   plain TypeScript interfaces, verbatim from the plan's canonical
 *   contracts block, matching ./mailbox.ts's "provider I/O types are plain
 *   interfaces" precedent (Phase 3D-A Task 1 Ruling 2) -- validated by the
 *   domain/broker layers added in later 3D-B tasks.
 * - Spec authority: 2026-09-12-phase-3d-connected-mailbox-design.md
 *   Plan authority: 2026-09-12-phase-3d-b-mailbox-discovery.md ("Canonical
 *   B Contracts").
 */
import { z } from "zod";

import { FileContentTypeSchema, MAX_UPLOAD_BYTES } from "./files.js";
import {
  MailboxErrorCodeV1Schema,
  MailboxScopeSchema,
  type MailboxErrorCodeV1,
  type MailboxScope,
} from "./mailbox.js";
import { TimestampSchema, VersionSchema } from "./expenses.js";

// ------------------------------------------------------------------ //
// Enums
// ------------------------------------------------------------------ //

export const MailboxScanRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
  "skipped",
]);
export type MailboxScanRunStatus = z.infer<typeof MailboxScanRunStatusSchema>;

export const MailboxCandidateClassificationSchema = z.enum([
  "receipt",
  "ambiguous",
  "not_receipt",
]);
export type MailboxCandidateClassification = z.infer<typeof MailboxCandidateClassificationSchema>;

export const MailboxCandidateStatusSchema = z.enum([
  "staged",
  "review",
  "queued",
  "processed",
  "duplicate",
  "skipped",
  "failed",
]);
export type MailboxCandidateStatus = z.infer<typeof MailboxCandidateStatusSchema>;

const Sha256DigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Digest must be a 64-char lowercase hex SHA-256");

// ------------------------------------------------------------------ //
// AttachmentManifestV1 -- names, MIME types, sizes, SHA-256 only. Spec:
// "Message may include at most 5 accepted attachments, each at most
// existing MAX_UPLOAD_BYTES (25 MiB)." The 5-count bound is enforced where
// this schema is embedded in an array (MailboxCandidateV1.attachmentManifest),
// not on the item schema itself.
// ------------------------------------------------------------------ //

export const AttachmentManifestV1Schema = z.strictObject({
  name: z.string().trim().min(1).max(255),
  mimeType: FileContentTypeSchema,
  sizeBytes: z.int().positive().max(MAX_UPLOAD_BYTES),
  sha256: Sha256DigestSchema,
});
export type AttachmentManifestV1 = z.infer<typeof AttachmentManifestV1Schema>;

export const MAX_CANDIDATE_ATTACHMENTS = 5;
const AttachmentManifestListSchema = z
  .array(AttachmentManifestV1Schema)
  .max(MAX_CANDIDATE_ATTACHMENTS);

// ------------------------------------------------------------------ //
// MailboxScanRunV1
// ------------------------------------------------------------------ //

export const MailboxScanRunV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  connectionId: z.uuid(),
  tenantId: z.uuid(),
  initiatedBy: z.union([z.uuid(), z.literal("schedule")]),
  entitlementVersion: VersionSchema,
  connectionVersion: VersionSchema,
  status: MailboxScanRunStatusSchema,
  discoveredCount: z.int().nonnegative(),
  stagedCount: z.int().nonnegative(),
  reviewCount: z.int().nonnegative(),
  duplicateCount: z.int().nonnegative(),
  skippedCount: z.int().nonnegative(),
  failedCount: z.int().nonnegative(),
  errorCode: MailboxErrorCodeV1Schema.nullable(),
  idempotencyKey: z.string().trim().min(1).max(500),
  createdAt: TimestampSchema,
  startedAt: TimestampSchema.nullable(),
  completedAt: TimestampSchema.nullable(),
});
export type MailboxScanRunV1 = z.infer<typeof MailboxScanRunV1Schema>;

// ------------------------------------------------------------------ //
// MailboxCandidate -- public/App-persisted fields shared by the public and
// the internal (App-persisted) record shapes (same split pattern as
// MailboxConnectionV1Schema / MailboxConnectionRecordV1Schema).
// ------------------------------------------------------------------ //

const MailboxCandidatePublicFields = {
  schemaVersion: z.literal(1),
  id: z.uuid(),
  scanRunId: z.uuid(),
  connectionId: z.uuid(),
  tenantId: z.uuid(),
  receivedAt: TimestampSchema,
  senderAddress: z.email().max(320),
  senderDomain: z.string().trim().min(1).max(255),
  subject: z.string().trim().max(998),
  contentHash: Sha256DigestSchema,
  attachmentManifest: AttachmentManifestListSchema,
  classification: MailboxCandidateClassificationSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().trim().min(1).max(500)),
  scope: MailboxScopeSchema.nullable(),
  status: MailboxCandidateStatusSchema,
  processingJobId: z.uuid().nullable(),
  expenseId: z.uuid().nullable(),
  sourceId: z.uuid().nullable(),
  duplicateMatchId: z.uuid().nullable(),
  version: VersionSchema,
  idempotencyKey: z.string().trim().min(1).max(500),
  errorCode: MailboxErrorCodeV1Schema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
};

export const MailboxCandidateV1Schema = z.strictObject(MailboxCandidatePublicFields);
export type MailboxCandidateV1 = z.infer<typeof MailboxCandidateV1Schema>;

/**
 * Internal (App-persisted) candidate record -- adds the provider message
 * and thread IDs. Provider message ID is stored only in this App row and
 * is never returned to the worker/Temporal (see MailboxScanExecutionInputV1
 * / MailboxCandidateBatchV1 / MailboxScanCountResultV1 below, which carry
 * only App-minted candidateIds).
 */
export const MailboxCandidateRecordV1Schema = z.strictObject({
  ...MailboxCandidatePublicFields,
  providerMessageId: z.string().trim().min(1).max(255),
  providerThreadId: z.string().trim().min(1).max(255).nullable(),
});
export type MailboxCandidateRecordV1 = z.infer<typeof MailboxCandidateRecordV1Schema>;

/**
 * Broker-side candidate binding (not Zod-validated here -- see ./mailbox.ts
 * "Provider I/O types" note; validated by broker/App domain layers added in
 * later 3D-B tasks).
 */
export interface MailboxBrokerCandidateBindingV1 {
  readonly candidateId: string;
  readonly connectionId: string;
  readonly expectedCandidateVersion: number;
  readonly providerMessageId: string;
  readonly providerThreadId: string | null;
}

// ------------------------------------------------------------------ //
// Temporal-boundary payloads -- opaque IDs, counts, page sequence, and
// typed errors ONLY. No history ID, cursor, pre-fence token, message ID,
// thread ID, sender, subject, or attachment metadata may appear here (see
// the "no provider metadata" contract tests).
// ------------------------------------------------------------------ //

export interface MailboxScanExecutionInputV1 {
  readonly schemaVersion: 1;
  readonly scanRunId: string;
}

export interface MailboxCandidateBatchV1 {
  readonly schemaVersion: 1;
  readonly scanRunId: string;
  readonly candidateIds: readonly string[];
  readonly stagedCount: number;
  readonly reviewCount: number;
  readonly failedCount: number;
}

export interface MailboxScanCountResultV1 {
  readonly schemaVersion: 1;
  readonly scanRunId: string;
  readonly candidateIds: readonly string[];
  readonly counts: {
    readonly discovered: number;
    readonly staged: number;
    readonly review: number;
    readonly failed: number;
  };
}

export interface MailboxCandidateOutcomeV1 {
  readonly schemaVersion: 1;
  readonly candidateId: string;
  readonly expectedCandidateVersion: number;
  readonly status: "staged" | "review" | "skipped" | "failed";
  readonly errorCode: MailboxErrorCodeV1 | null;
  readonly idempotencyKey: string;
}

export interface DiscoveryInput {
  readonly connectionId: string;
  readonly scanRunId: string;
}

export interface DiscoveryPageV1 {
  readonly scanRunId: string;
  readonly pageSequence: number;
  readonly candidateCount: number;
  readonly retryCount: number;
}

// ------------------------------------------------------------------ //
// Broker<->App boundary payloads -- opaque cursor/pre-fence state crosses
// only here, never through Temporal. Not Zod-validated here (same
// deferred-validation convention as ./mailbox.ts's provider I/O types).
// ------------------------------------------------------------------ //

export interface MailboxBrokerScanBindingV1 {
  readonly scanRunId: string;
  readonly connectionId: string;
  readonly expectedConnectionVersion: number;
  readonly currentHistoryId: string | null;
  readonly currentCursorDigest: string;
  readonly preFenceToken: string;
  readonly nextPageSequence: number;
}

export interface MailboxCandidateMetadataStagingV1 {
  readonly schemaVersion: 1;
  readonly scanRunId: string;
  readonly connectionId: string;
  readonly expectedConnectionVersion: number;
  readonly cursorBeforeDigest: string;
  readonly preFenceToken: string;
  readonly pageSequence: number;
  readonly nextHistoryId: string | null;
  readonly messages: readonly {
    receivedAt: string;
    senderAddress: string;
    senderDomain: string;
    subject: string;
    contentHash: string;
    attachmentManifest: readonly AttachmentManifestV1[];
    classification: MailboxCandidateClassification;
    confidence: number;
    evidence: readonly string[];
    providerMessageId: string;
    providerThreadId: string | null;
  }[];
  readonly idempotencyKey: string;
}

export interface MailboxCandidateMetadataStagingResultV1 {
  readonly schemaVersion: 1;
  readonly scanRunId: string;
  readonly pageSequence: number;
  readonly candidateIds: readonly string[];
  readonly counts: {
    discovered: number;
    staged: number;
    review: number;
    failed: number;
  };
}

export interface MailboxBrokerDiscoveryAppClient {
  loadScanBinding(scanRunId: string): Promise<MailboxBrokerScanBindingV1>;
  stageCandidateMetadata(
    input: MailboxCandidateMetadataStagingV1,
  ): Promise<MailboxCandidateMetadataStagingResultV1>;
}

export interface MailboxDiscoveryProviderAdapter {
  discover(input: DiscoveryInput): Promise<DiscoveryPageV1>;
}

export type { MailboxScope };
