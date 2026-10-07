import { createHash, randomUUID } from "node:crypto";

import type {
  CreateUploadSessionRequest,
  CreateUploadSessionResponse,
  ExpenseFile,
  FileList,
  MailboxAttachmentUploadResultV1,
  MailboxErrorCodeV1,
} from "@expense-tax/contracts";
import {
  CreateUploadSessionResponseSchema,
  MAX_CANDIDATE_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
} from "@expense-tax/contracts";
import { type Kysely, type Selectable, type Transaction } from "kysely";
import sharp from "sharp";

import type { AppDatabase } from "../database/types.js";
import type { MalwareScanner } from "../inbound/security.js";
import { attachmentMagicMatches } from "../inbound/security.js";
import {
  StorageWriteSizeExceededError,
  type StorageAdapter,
} from "../storage/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import {
  executeIdempotentMutation,
  hashNormalizedRequest,
  type MutationResult,
} from "./idempotency.js";

type FileRow = Selectable<AppDatabase["app.expense_files"]>;
type MailboxCandidateRow = Selectable<AppDatabase["app.mailbox_candidates"]>;

/** Exactly the column's own literal union (migration 003/007's
 * app.expense_files.content_type) -- the only types the magic-byte sniffer
 * ever assigns. */
type SniffedContentType = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
const SNIFFABLE_CONTENT_TYPES: readonly SniffedContentType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

function sniffContentType(bytes: Buffer): SniffedContentType | null {
  for (const candidate of SNIFFABLE_CONTENT_TYPES) {
    if (attachmentMagicMatches(candidate, bytes)) return candidate;
  }
  return null;
}

/**
 * Phase 3D-C Task 3 -- App-side malware scan adapter for mailbox staged
 * attachments. `scanStream` is the optional fast path (not implemented
 * here); `scanStagedObject` is the required fallback the brief names:
 * read the staged object back bounded to MAX_UPLOAD_BYTES, call the
 * existing deterministic malware engine (PatternMalwareScanner in
 * production and in tests -- it is already local/EICAR-pattern-based, so
 * "never call external scanners in tests" is satisfied by construction).
 *
 * Fix round 2 -- deletes the staging object only when INFECTED. A clean
 * result leaves it in place: writeMailboxAttachment now streams the
 * attachment directly into the staging key (review Important #1, no
 * full-body buffer anywhere in this path) and, on a clean scan, promotes
 * that SAME already-verified object to its final key via a pure
 * storage.moveObject (no second full read/write) -- which requires the
 * staged bytes to still exist. Deleting unconditionally (the brief's
 * original, pre-streaming wording) would delete the only copy of a
 * clean attachment before it could ever be promoted.
 */
export interface MailboxStagingScanner {
  scanStream?(
    source: AsyncIterable<Buffer>,
  ): Promise<{ readonly clean: boolean; readonly code: string | null }>;
  scanStagedObject(input: {
    readonly storageKey: string;
    readonly sizeBytes: number;
    readonly contentType: string;
  }): Promise<{ readonly clean: boolean; readonly code: string | null }>;
}

export function createMailboxStagingScanner(
  storage: StorageAdapter,
  engine: MalwareScanner,
): MailboxStagingScanner {
  return {
    async scanStagedObject({ storageKey, sizeBytes, contentType }) {
      void contentType;
      if (sizeBytes > MAX_UPLOAD_BYTES) {
        await storage.deleteObject(storageKey);
        return { clean: false, code: "ATTACHMENT_BOUND_EXCEEDED" };
      }
      const bytes = await storage.readObject(storageKey);
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        await storage.deleteObject(storageKey);
        return { clean: false, code: "ATTACHMENT_BOUND_EXCEEDED" };
      }
      const result = await engine.scan(bytes);
      if (!result.clean) {
        // Blocked = dead end (owner ruling): delete the only copy of an
        // infected attachment immediately, never leave it staged.
        await storage.deleteObject(storageKey);
        return { clean: false, code: "MALWARE_DETECTED" };
      }
      return { clean: true, code: null };
    },
  };
}

export type FileScope =
  | { readonly kind: "personal"; readonly profileId: string }
  | { readonly kind: "business"; readonly businessId: string };

export const UPLOAD_SESSION_TTL_MS = 15 * 60 * 1_000;
export const FILE_READ_URL_TTL_MS = 15 * 60 * 1_000;

function scopePart(scope: FileScope): string {
  return scope.kind === "personal"
    ? `personal-${scope.profileId}`
    : `business-${scope.businessId}`;
}

export function sanitizeFilename(filename: string): string {
  const sanitized = filename
    .replace(/[\\/]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 255);
  return sanitized || "upload";
}

export function buildStorageKey(input: {
  tenantId: string;
  scope: FileScope;
  fileId: string;
  filename: string;
}): string {
  return `tenants/${input.tenantId}/${scopePart(input.scope)}/originals/${input.fileId}/${sanitizeFilename(input.filename)}`;
}

export function buildThumbnailKey(input: {
  tenantId: string;
  scope: FileScope;
  fileId: string;
}): string {
  return `tenants/${input.tenantId}/${scopePart(input.scope)}/thumbnails/${input.fileId}/thumb.webp`;
}

async function personalRole(
  database: Kysely<AppDatabase>,
  input: { actorUserId: string; tenantId: string; profileId: string },
): Promise<"owner" | "editor" | "viewer"> {
  const access = await database
    .selectFrom("app.personal_profiles as profile")
    .innerJoin("app.tenants as tenant", (join) =>
      join.onRef("tenant.id", "=", "profile.tenant_id").on("tenant.status", "=", "active"),
    )
    .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
      join
        .onRef("tenant_membership.tenant_id", "=", "profile.tenant_id")
        .on("tenant_membership.user_id", "=", input.actorUserId)
        .on("tenant_membership.status", "=", "active"),
    )
    .innerJoin("app.personal_memberships as membership", (join) =>
      join
        .onRef("membership.personal_profile_id", "=", "profile.id")
        .onRef("membership.tenant_id", "=", "profile.tenant_id")
        .on("membership.user_id", "=", input.actorUserId)
        .on("membership.status", "=", "active"),
    )
    .select("membership.role")
    .where("profile.id", "=", input.profileId)
    .where("profile.tenant_id", "=", input.tenantId)
    .executeTakeFirst();
  if (!access) throw DomainError.notFound();
  return access.role;
}

async function businessRole(
  database: Kysely<AppDatabase>,
  input: { actorUserId: string; tenantId: string; businessId: string },
): Promise<"owner" | "editor" | "viewer"> {
  const access = await database
    .selectFrom("app.businesses as business")
    .innerJoin("app.tenants as tenant", (join) =>
      join.onRef("tenant.id", "=", "business.tenant_id").on("tenant.status", "=", "active"),
    )
    .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
      join
        .onRef("tenant_membership.tenant_id", "=", "business.tenant_id")
        .on("tenant_membership.user_id", "=", input.actorUserId)
        .on("tenant_membership.status", "=", "active"),
    )
    .innerJoin("app.business_memberships as membership", (join) =>
      join
        .onRef("membership.business_id", "=", "business.id")
        .onRef("membership.tenant_id", "=", "business.tenant_id")
        .on("membership.user_id", "=", input.actorUserId)
        .on("membership.status", "=", "active"),
    )
    .select("membership.role")
    .where("business.id", "=", input.businessId)
    .where("business.tenant_id", "=", input.tenantId)
    .where("business.status", "=", "active")
    .executeTakeFirst();
  if (!access) throw DomainError.notFound();
  return access.role;
}

export async function requireScopeRole(
  database: Kysely<AppDatabase>,
  input: { actorUserId: string; tenantId: string; scope: FileScope },
): Promise<"owner" | "editor" | "viewer"> {
  return input.scope.kind === "personal"
    ? personalRole(database, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        profileId: input.scope.profileId,
      })
    : businessRole(database, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        businessId: input.scope.businessId,
      });
}

function canWrite(role: "owner" | "editor" | "viewer"): boolean {
  return role === "owner" || role === "editor";
}

function toExpenseFile(row: FileRow): ExpenseFile {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personalProfileId: row.personal_profile_id,
    businessId: row.business_id,
    expenseId: row.expense_id,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    sha256Hex: row.sha256_hex,
    storageKey: row.storage_key,
    thumbnailStorageKey: row.thumbnail_storage_key,
    thumbnailStatus: row.thumbnail_status,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  if (separator < 0) throw DomainError.validation();
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) throw DomainError.validation();
  return { createdAt, id };
}

export interface CreateUploadSessionCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly scope: FileScope;
  readonly request: CreateUploadSessionRequest;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface ConfirmUploadSessionCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly scope: FileScope;
  readonly sessionId: string;
  readonly requestId: string;
}

export interface FileScopeCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly scope: FileScope;
}

export interface FileReadCommand extends FileScopeCommand {
  readonly fileId: string;
}

export interface FileListCommand extends FileScopeCommand {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface FileDeleteCommand extends FileReadCommand {
  readonly requestId: string;
}

export interface WorkerFileReadCommand {
  readonly fileId: string;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

export interface WritePendingContentCommand {
  readonly fileId: string;
  readonly data: Buffer;
  readonly contentType: string;
}

/**
 * Phase 3D-C Task 3. Deliberately carries no tenantId/scope (unlike every
 * other FilesDomain command): candidateId is enough to resolve both --
 * writeMailboxAttachment loads app.mailbox_candidates itself, the same
 * "job binding IS the authorization" precedent ocr.ts's
 * applyOcrExtraction already uses for the generic OCR path. uploadGrantId
 * is carried through for audit/traceability only -- validating the grant
 * itself (looked up via app.mailbox_ingestion_operations) is
 * domain/mailbox-ingestion.ts's job, upstream of this call, since that
 * ledger table is mailbox-ingestion's own concern, not files.ts's.
 */
export interface WriteMailboxAttachmentCommand {
  readonly candidateId: string;
  readonly attachmentIndex: number;
  readonly uploadGrantId: string;
  readonly expectedCandidateVersion: number;
  readonly actorServicePrincipal: "mailbox-broker-app";
  readonly requestId: string;
}

export interface FilesDomain {
  createUploadSession(
    input: CreateUploadSessionCommand,
  ): Promise<MutationResult<CreateUploadSessionResponse, 201>>;
  confirmUploadSession(input: ConfirmUploadSessionCommand): Promise<ExpenseFile>;
  writePendingContent(input: WritePendingContentCommand): Promise<void>;
  /**
   * Streams one mailbox attachment directly into bounded storage: never
   * calls writePendingContent/a Buffer-shaped command, writes/hashes
   * incrementally with a hard MAX_UPLOAD_BYTES cap, verifies the stored
   * hash against the candidate's own attachment-manifest entry (staged by
   * Phase 3D-B discovery, before this upload ever happens), scans before
   * READY, and never creates a file row the caller didn't ask for -- a
   * blocked (oversize/signature-rejected/hash-mismatched/infected) upload
   * is marked FAILED and never confirmed (owner ruling: blocked is a dead
   * end, dismiss only).
   */
  writeMailboxAttachment(
    input: WriteMailboxAttachmentCommand,
    source: AsyncIterable<Buffer>,
  ): Promise<MailboxAttachmentUploadResultV1>;
  /**
   * Fix round 3 (review Important #1) -- compensates a mailbox attachment
   * THIS SAME upload attempt already wrote via writeMailboxAttachment, for
   * use when mailbox-ingestion.ts's own fencing check later discovers the
   * attempt was superseded by a reclaimed lease (a stale claim's owning
   * attempt is still alive and finishes late, after a retry already
   * reclaimed and completed the same ledger row). Deletes the persisted
   * object (best-effort; a row that never reached READY has none at its
   * final key) and marks the row FAILED, so a superseded attempt never
   * leaves a live READY file with no job wired to it. Internal-only, no
   * scope/role check -- same "candidateId/fileId is enough" precedent as
   * writeMailboxAttachment itself; the caller already owns the fencing
   * decision. Idempotent: a second call on an already-FAILED/DELETED row
   * is a no-op.
   */
  compensateMailboxAttachment(fileId: string): Promise<void>;
  readReadyContent(
    fileId: string,
  ): Promise<{ readonly data: Buffer; readonly contentType: string }>;
  listFiles(input: FileListCommand): Promise<FileList>;
  getFile(input: FileReadCommand): Promise<ExpenseFile>;
  issueFileReadUrl(input: FileReadCommand): Promise<{ readonly url: string; readonly expiresAt: string }>;
  issueWorkerReadUrl(
    input: WorkerFileReadCommand,
  ): Promise<{ readonly url: string; readonly expiresAt: string }>;
  deleteFile(input: FileDeleteCommand): Promise<void>;
}

export function createFilesDomain(
  database: Kysely<AppDatabase>,
  storage: StorageAdapter,
  deps: {
    readonly mailboxScanner: MailboxStagingScanner;
    /**
     * Web session wiring design (2026-10-06) -- the worker must download
     * files from inside the Docker network, an origin the browser-facing
     * `storage` adapter's base URL (STORAGE_LOCAL_BASE_URL, the public API
     * origin) may not be reachable from. When provided, issueWorkerReadUrl
     * issues its read URL through this adapter instead (production:
     * STORAGE_INTERNAL_BASE_URL, e.g. http://app-api:8100). Defaults to
     * `storage` -- today's behavior -- when omitted.
     */
    readonly workerStorage?: StorageAdapter;
  },
): FilesDomain {
  async function requireBoundExpense(
    transaction: Transaction<AppDatabase>,
    input: { tenantId: string; scope: FileScope; expenseId: string },
  ): Promise<void> {
    const expense = await transaction
      .selectFrom("app.expenses")
      .select(["id", "tenant_id", "personal_profile_id", "business_id"])
      .where("id", "=", input.expenseId)
      .executeTakeFirst();
    if (!expense || expense.tenant_id !== input.tenantId) {
      throw DomainError.notFound();
    }
    const scopeMatches =
      input.scope.kind === "personal"
        ? expense.personal_profile_id === input.scope.profileId
        : expense.business_id === input.scope.businessId;
    if (!scopeMatches) throw DomainError.notFound();
  }

  async function loadScopedFile(
    executor: Kysely<AppDatabase> | Transaction<AppDatabase>,
    input: { tenantId: string; scope: FileScope; fileId: string },
  ): Promise<FileRow> {
    let query = executor
      .selectFrom("app.expense_files")
      .selectAll()
      .where("id", "=", input.fileId)
      .where("tenant_id", "=", input.tenantId);
    query =
      input.scope.kind === "personal"
        ? query.where("personal_profile_id", "=", input.scope.profileId)
        : query.where("business_id", "=", input.scope.businessId);
    const row = await query.executeTakeFirst();
    if (!row || row.status === "DELETED") throw DomainError.notFound();
    return row;
  }

  return {
    async createUploadSession(input) {
      const role = await requireScopeRole(database, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: input.scope,
      });
      if (!canWrite(role)) throw DomainError.forbidden();

      return executeIdempotentMutation(database, {
        actorKey: `user:${input.actorUserId}`,
        operationKey: "file.upload-session.create",
        idempotencyKey: input.idempotencyKey,
        requestHash: hashNormalizedRequest({
          tenantId: input.tenantId,
          scope: input.scope,
          request: input.request,
        }),
        statusCode: 201,
        parseBody: (value) => CreateUploadSessionResponseSchema.parse(value),
        execute: async (transaction) => {
          if (input.request.expenseId) {
            await requireBoundExpense(transaction, {
              tenantId: input.tenantId,
              scope: input.scope,
              expenseId: input.request.expenseId,
            });
          }
          const now = new Date();
          const fileId = randomUUID();
          const sessionId = randomUUID();
          const storageKey = buildStorageKey({
            tenantId: input.tenantId,
            scope: input.scope,
            fileId,
            filename: input.request.originalFilename,
          });
          const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL_MS);

          const created = await transaction
            .insertInto("app.expense_files")
            .values({
              id: fileId,
              tenant_id: input.tenantId,
              personal_profile_id:
                input.scope.kind === "personal" ? input.scope.profileId : null,
              business_id:
                input.scope.kind === "business" ? input.scope.businessId : null,
              expense_id: input.request.expenseId ?? null,
              original_filename: sanitizeFilename(input.request.originalFilename),
              content_type: input.request.contentType,
              size_bytes: null,
              sha256_hex: null,
              storage_key: storageKey,
              thumbnail_storage_key: null,
              thumbnail_status: "pending",
              status: "PENDING",
              version: 1,
              created_at: now,
              updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          await transaction
            .insertInto("app.upload_sessions")
            .values({
              id: sessionId,
              expense_file_id: fileId,
              status: "PENDING",
              expires_at: expiresAt,
              confirmed_at: null,
              created_at: now,
            })
            .execute();

          const target = await storage.issueUploadTarget({
            fileId,
            storageKey,
            contentType: input.request.contentType,
            expiresAt,
          });

          await recordAuditEvent(transaction, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            action: "expense_file.upload_session_created",
            outcome: "success",
            resourceType: "expense_file",
            resourceId: fileId,
            requestId: input.requestId,
          });

          return {
            file: toExpenseFile(created),
            uploadSession: {
              id: sessionId,
              expenseFileId: fileId,
              status: "PENDING" as const,
              expiresAt: expiresAt.toISOString(),
              confirmedAt: null,
              createdAt: now.toISOString(),
            },
            uploadTarget: {
              url: target.url,
              method: "PUT" as const,
              requiredHeaders: { ...target.requiredHeaders },
              expiresAt: expiresAt.toISOString(),
            },
          };
        },
      });
    },

    async writePendingContent(input) {
      const row = await database
        .selectFrom("app.expense_files")
        .selectAll()
        .where("id", "=", input.fileId)
        .executeTakeFirst();
      if (!row || row.status === "DELETED") throw DomainError.notFound();
      if (row.status !== "PENDING") throw DomainError.conflict();
      if (input.contentType !== row.content_type) throw DomainError.validation();
      if (input.data.byteLength > MAX_UPLOAD_BYTES) {
        throw DomainError.validation();
      }
      await storage.writeObject({
        storageKey: row.storage_key,
        data: input.data,
        contentType: input.contentType,
      });
    },

    async writeMailboxAttachment(input, source) {
      if (
        !Number.isInteger(input.attachmentIndex) ||
        input.attachmentIndex < 0 ||
        input.attachmentIndex >= MAX_CANDIDATE_ATTACHMENTS
      ) {
        throw DomainError.validation();
      }

      const candidate: MailboxCandidateRow | undefined = await database
        .selectFrom("app.mailbox_candidates")
        .selectAll()
        .where("id", "=", input.candidateId)
        .executeTakeFirst();
      if (!candidate) throw DomainError.notFound();
      if (candidate.version !== input.expectedCandidateVersion) {
        throw DomainError.versionConflict();
      }
      if (candidate.status !== "queued") throw DomainError.conflict();

      const manifest = candidate.attachment_manifest as unknown as readonly {
        readonly sha256: string;
      }[];
      const manifestEntry = manifest[input.attachmentIndex];
      if (!manifestEntry) throw DomainError.validation();

      const scope: FileScope = candidate.candidate_personal_profile_id
        ? { kind: "personal", profileId: candidate.candidate_personal_profile_id }
        : candidate.candidate_business_id
          ? { kind: "business", businessId: candidate.candidate_business_id }
          : (() => {
              throw DomainError.validation();
            })();

      const fileId = randomUUID();
      const now = new Date();
      const storageKey = buildStorageKey({
        tenantId: candidate.tenant_id,
        scope,
        fileId,
        filename: `mailbox-attachment-${input.attachmentIndex}`,
      });
      // Type-system placeholder: expense_files.content_type is a 4-member
      // literal union with no "unknown yet" member. Overwritten with the
      // real sniffed type before this row ever reaches READY; a row that
      // never leaves PENDING/FAILED (bound exceeded, bad signature, hash
      // mismatch, infected) keeps this placeholder, which is harmless --
      // nothing reads content_type on a dead, never-confirmed file.
      const PLACEHOLDER_CONTENT_TYPE = "application/pdf" as const;

      const created = await database
        .insertInto("app.expense_files")
        .values({
          id: fileId,
          tenant_id: candidate.tenant_id,
          personal_profile_id: scope.kind === "personal" ? scope.profileId : null,
          business_id: scope.kind === "business" ? scope.businessId : null,
          expense_id: null,
          original_filename: `mailbox-attachment-${input.attachmentIndex}`,
          content_type: PLACEHOLDER_CONTENT_TYPE,
          size_bytes: null,
          sha256_hex: null,
          storage_key: storageKey,
          thumbnail_storage_key: null,
          thumbnail_status: "skipped",
          status: "PENDING",
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const fail = async (
        errorCode: MailboxErrorCodeV1,
      ): Promise<MailboxAttachmentUploadResultV1> => {
        await database
          .updateTable("app.expense_files")
          .set({ status: "FAILED", updated_at: new Date() })
          .where("id", "=", fileId)
          .where("status", "<>", "DELETED")
          .execute();
        return {
          candidateId: input.candidateId,
          attachmentIndex: input.attachmentIndex,
          fileId,
          status: "FAILED",
          errorCode,
          idempotencyKey: input.requestId,
        };
      };

      // Fix round 2 (review Important #1 + #3): the ENTIRE post-row
      // sequence -- stream-to-staging, sniff, hash-verify, scan, promote,
      // persisted-size check, READY confirmation -- runs inside one try
      // block. Any failure anywhere in it (typed or not: a storage
      // network error, an unexpected scanner exception, a DB blip) falls
      // through to the single catch below, which compensates by deleting
      // both possible object locations and marking the row FAILED --
      // never a stranded PENDING row, never an orphaned object, for any
      // failure after the row was created.
      const stagingKey = `${storageKey}.scan-staging`;
      try {
        // Streams the request body straight into bounded, incrementally-
        // hashed storage -- no Buffer.concat, no full-body buffer anywhere
        // in this path. Magic-byte sniffing uses only the first bytes
        // already captured while streaming (headerBytes), never a
        // separate read-back of the whole object.
        let streamed;
        try {
          streamed = await storage.writeObjectStream(
            { storageKey: stagingKey, contentType: "application/octet-stream", maxBytes: MAX_UPLOAD_BYTES },
            source,
          );
        } catch (error) {
          if (error instanceof StorageWriteSizeExceededError) {
            return fail("ATTACHMENT_BOUND_EXCEEDED");
          }
          throw error;
        }

        const sniffed = sniffContentType(streamed.headerBytes);
        if (!sniffed) {
          await storage.deleteObject(stagingKey).catch(() => {});
          return fail("ATTACHMENT_SIGNATURE_REJECTED");
        }
        if (streamed.sha256Hex !== manifestEntry.sha256) {
          await storage.deleteObject(stagingKey).catch(() => {});
          return fail("ATTACHMENT_HASH_MISMATCH");
        }

        await database
          .updateTable("app.expense_files")
          .set({
            content_type: sniffed,
            size_bytes: streamed.sizeBytes,
            sha256_hex: streamed.sha256Hex,
            updated_at: new Date(),
          })
          .where("id", "=", fileId)
          .execute();

        // Scanner reads back its OWN staged copy (bounded to
        // MAX_UPLOAD_BYTES -- the only point in this path a full-size
        // buffer is briefly materialized, which the actual malware-scan
        // operation requires) and always deletes that staging key,
        // clean or infected.
        const scan = await deps.mailboxScanner.scanStagedObject({
          storageKey: stagingKey,
          sizeBytes: streamed.sizeBytes,
          contentType: sniffed,
        });
        if (!scan.clean) {
          // Blocked = dead end, dismiss only (owner ruling): never
          // confirmed. The bytes were only ever written to the (now
          // deleted) staging key, never promoted to storage_key.
          return fail((scan.code as MailboxErrorCodeV1 | null) ?? "ATTACHMENT_SIGNATURE_REJECTED");
        }

        // Scan passed and the hash was already verified against the
        // candidate's own manifest above. Promote the already-verified
        // staged object to its final key via a pure move (no re-read of
        // the full buffer -- the bytes are unchanged from what was
        // already hashed while streaming); a persisted-size check (not a
        // full re-hash) confirms the move actually landed before READY.
        await storage.moveObject(stagingKey, storageKey);
        const finalStat = await storage.statObject(storageKey);
        if (!finalStat || finalStat.sizeBytes !== streamed.sizeBytes) {
          throw new Error("final object size does not match the streamed size");
        }

        // Fix round 3 (review Important #2) -- a size match alone cannot
        // catch a same-length corruption introduced by the move/storage
        // layer (bit flip, truncated-and-padded write, etc.). Re-reads
        // the bytes actually persisted at the final key and re-hashes
        // them, comparing against the candidate's own attachment-manifest
        // entry (the same expected hash already verified against the
        // STREAMED bytes above) -- any mismatch throws into the catch-all
        // below, which compensates (deletes both possible object
        // locations) and marks the row FAILED, exactly like every other
        // failure in this block.
        const persistedBytes = await storage.readObject(storageKey);
        const persistedHash = createHash("sha256").update(persistedBytes).digest("hex");
        if (persistedHash !== manifestEntry.sha256) {
          throw new Error("persisted object hash does not match the candidate's attachment manifest");
        }

        const updateResult = await database
          .updateTable("app.expense_files")
          .set({ status: "READY", updated_at: new Date(), version: created.version + 1 })
          .where("id", "=", fileId)
          .where("status", "=", "PENDING")
          .executeTakeFirst();
        if (updateResult.numUpdatedRows !== 1n) {
          throw new Error("expense_files row was not PENDING when confirming READY");
        }

        return {
          candidateId: input.candidateId,
          attachmentIndex: input.attachmentIndex,
          fileId,
          status: "READY",
          errorCode: null,
          idempotencyKey: input.requestId,
        };
      } catch {
        await storage.deleteObject(stagingKey).catch(() => {});
        await storage.deleteObject(storageKey).catch(() => {});
        return fail("ATTACHMENT_CONFIRMATION_FAILED");
      }
    },

    async compensateMailboxAttachment(fileId) {
      const row = await database
        .selectFrom("app.expense_files")
        .selectAll()
        .where("id", "=", fileId)
        .executeTakeFirst();
      if (!row || row.status === "FAILED" || row.status === "DELETED") return;
      await storage.deleteObject(row.storage_key).catch(() => {});
      await database
        .updateTable("app.expense_files")
        .set({ status: "FAILED", updated_at: new Date() })
        .where("id", "=", fileId)
        .where("status", "=", row.status)
        .execute();
    },

    async readReadyContent(fileId) {
      const row = await database
        .selectFrom("app.expense_files")
        .selectAll()
        .where("id", "=", fileId)
        .executeTakeFirst();
      if (!row || row.status === "DELETED") throw DomainError.notFound();
      if (row.status !== "READY") throw DomainError.conflict();
      const data = await storage.readObject(row.storage_key);
      return { data, contentType: row.content_type };
    },

    async confirmUploadSession(input) {
      const role = await requireScopeRole(database, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: input.scope,
      });
      if (!canWrite(role)) throw DomainError.forbidden();

      const session = await database
        .selectFrom("app.upload_sessions")
        .selectAll()
        .where("id", "=", input.sessionId)
        .executeTakeFirst();
      if (!session) throw DomainError.notFound();
      const file = await loadScopedFile(database, {
        tenantId: input.tenantId,
        scope: input.scope,
        fileId: session.expense_file_id,
      });
      if (session.status === "CONFIRMED") return toExpenseFile(file);
      if (session.status === "EXPIRED") throw DomainError.conflict();
      if (file.status !== "PENDING") throw DomainError.conflict();
      if (session.expires_at.getTime() < Date.now()) {
        await database
          .updateTable("app.upload_sessions")
          .set({ status: "EXPIRED" })
          .where("id", "=", session.id)
          .where("status", "=", "PENDING")
          .execute();
        throw DomainError.conflict();
      }

      const objectStat = await storage.statObject(file.storage_key);
      if (!objectStat) throw DomainError.validation();
      if (objectStat.sizeBytes > MAX_UPLOAD_BYTES) throw DomainError.validation();
      const bytes = await storage.readObject(file.storage_key);
      if (bytes.byteLength > MAX_UPLOAD_BYTES) throw DomainError.validation();
      const sha256Hex = createHash("sha256").update(bytes).digest("hex");

      let thumbnailStorageKey: string | null = null;
      let thumbnailStatus: "ready" | "skipped" | "failed" = "skipped";
      if (file.content_type.startsWith("image/")) {
        try {
          const image = sharp(bytes);
          await image.metadata();
          const thumbnailBytes = await sharp(bytes)
            .resize({ width: 300, fit: "inside", withoutEnlargement: true })
            .webp()
            .toBuffer();
          thumbnailStorageKey = buildThumbnailKey({
            tenantId: file.tenant_id,
            scope: input.scope,
            fileId: file.id,
          });
          await storage.writeObject({
            storageKey: thumbnailStorageKey,
            data: thumbnailBytes,
            contentType: "image/webp",
          });
          thumbnailStatus = "ready";
        } catch {
          thumbnailStorageKey = null;
          thumbnailStatus = "failed";
        }
      } else {
        const isPdf = bytes.subarray(0, 5).toString("ascii") === "%PDF-";
        if (!isPdf) throw DomainError.validation();
        thumbnailStatus = "skipped";
      }

      return database.transaction().execute(async (transaction) => {
        const locked = await transaction
          .selectFrom("app.upload_sessions")
          .selectAll()
          .where("id", "=", session.id)
          .forUpdate()
          .executeTakeFirst();
        if (!locked || locked.status === "CONFIRMED") {
          return toExpenseFile(
            await loadScopedFile(transaction, {
              tenantId: input.tenantId,
              scope: input.scope,
              fileId: session.expense_file_id,
            }),
          );
        }
        if (locked.status !== "PENDING") throw DomainError.conflict();
        const now = new Date();
        const updated = await transaction
          .updateTable("app.expense_files")
          .set({
            size_bytes: bytes.byteLength,
            sha256_hex: sha256Hex,
            thumbnail_storage_key: thumbnailStorageKey,
            thumbnail_status: thumbnailStatus,
            status: "READY",
            updated_at: now,
            version: file.version + 1,
          })
          .where("id", "=", file.id)
          .where("status", "=", "PENDING")
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();
        await transaction
          .updateTable("app.upload_sessions")
          .set({ status: "CONFIRMED", confirmed_at: now })
          .where("id", "=", session.id)
          .execute();
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "expense_file.upload_confirmed",
          outcome: "success",
          resourceType: "expense_file",
          resourceId: file.id,
          requestId: input.requestId,
        });
        return toExpenseFile(updated);
      });
    },

    async listFiles(input) {
      await requireScopeRole(database, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: input.scope,
      });
      const limit = input.limit ?? 25;
      const cursor = input.cursor ? decodeCursor(input.cursor) : null;
      let query = database
        .selectFrom("app.expense_files")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("status", "<>", "DELETED");
      query =
        input.scope.kind === "personal"
          ? query.where("personal_profile_id", "=", input.scope.profileId)
          : query.where("business_id", "=", input.scope.businessId);
      if (cursor) {
        query = query.where((eb) =>
          eb.or([
            eb("created_at", "<", cursor.createdAt),
            eb.and([
              eb("created_at", "=", cursor.createdAt),
              eb("id", "<", cursor.id),
            ]),
          ]),
        );
      }
      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1)
        .execute();
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toExpenseFile),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor(last.created_at, last.id)
            : null,
      };
    },

    async getFile(input) {
      await requireScopeRole(database, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: input.scope,
      });
      return toExpenseFile(
        await loadScopedFile(database, {
          tenantId: input.tenantId,
          scope: input.scope,
          fileId: input.fileId,
        }),
      );
    },

    async issueFileReadUrl(input) {
      await requireScopeRole(database, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: input.scope,
      });
      const row = await loadScopedFile(database, {
        tenantId: input.tenantId,
        scope: input.scope,
        fileId: input.fileId,
      });
      if (row.status !== "READY") throw DomainError.conflict();
      const expiresAt = new Date(Date.now() + FILE_READ_URL_TTL_MS);
      const issued = await storage.issueReadUrl({
        fileId: row.id,
        storageKey: row.storage_key,
        expiresAt,
      });
      return { url: issued.url, expiresAt: expiresAt.toISOString() };
    },

    async issueWorkerReadUrl(input) {
      return database.transaction().execute(async (transaction) => {
        const row = await transaction
          .selectFrom("app.expense_files")
          .selectAll()
          .where("id", "=", input.fileId)
          .executeTakeFirst();
        if (!row || row.status === "DELETED") throw DomainError.notFound();
        if (row.status !== "READY") throw DomainError.conflict();
        const expiresAt = new Date(Date.now() + FILE_READ_URL_TTL_MS);
        const issued = await (deps?.workerStorage ?? storage).issueReadUrl({
          fileId: row.id,
          storageKey: row.storage_key,
          expiresAt,
        });
        await recordAuditEvent(transaction, {
          tenantId: row.tenant_id,
          actorServicePrincipal: input.actorServicePrincipal,
          action: "expense_file.worker_read_url_issued",
          outcome: "success",
          resourceType: "expense_file",
          resourceId: row.id,
          requestId: input.requestId,
        });
        return { url: issued.url, expiresAt: expiresAt.toISOString() };
      });
    },

    async deleteFile(input) {
      const role = await requireScopeRole(database, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: input.scope,
      });
      if (!canWrite(role)) throw DomainError.forbidden();
      const row = await loadScopedFile(database, {
        tenantId: input.tenantId,
        scope: input.scope,
        fileId: input.fileId,
      });
      await storage.deleteObject(row.storage_key);
      if (row.thumbnail_storage_key) {
        await storage.deleteObject(row.thumbnail_storage_key);
      }
      await database.transaction().execute(async (transaction) => {
        const updated = await transaction
          .updateTable("app.expense_files")
          .set({ status: "DELETED", updated_at: new Date(), version: row.version + 1 })
          .where("id", "=", row.id)
          .where("status", "<>", "DELETED")
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) throw DomainError.notFound();
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "expense_file.deleted",
          outcome: "success",
          resourceType: "expense_file",
          resourceId: row.id,
          requestId: input.requestId,
        });
      });
    },
  };
}
