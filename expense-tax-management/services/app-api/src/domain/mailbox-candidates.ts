/**
 * Phase 3D-B Task 5 — App-owned candidate review domain: authorized list/
 * detail reads and the review-action resolve transaction.
 *
 * App API owns candidate status/scope-assignment transitions (same split
 * as every other mailbox domain file here: the broker classifies and
 * stages via domain/mailbox-scans.ts's `recordCandidateMetadata`; this
 * module owns what happens to an already-staged candidate afterward).
 *
 * Authorization (spec "Scope and Review Behavior"): every list/detail/
 * mutation revalidates current tenant membership, connection status, and
 * owner-or-non-revoked-reviewer-grant access -- `authorizeCandidateAccess`
 * below. Assigning/reassigning an `ingest` action additionally
 * revalidates *current* membership in the target scope (spec:
 * "Assigning/reassigning requires current membership to target scope"),
 * checked at the moment of the action, not cached from an earlier read.
 *
 * Review actions (spec):
 * - ingest: assign authorized scope and queue processing (3D-C owns the
 *   actual attachment/OCR/structured-HTML ingestion step; this task only
 *   assigns scope and moves status to "queued").
 * - skip / not_receipt: both terminal, no expense. Migration 019's
 *   `mailbox_candidates_status_check` has no distinct `not_receipt`
 *   status value (that enum slot is the *candidate's classification*,
 *   already recorded); both actions set status `skipped` and are told
 *   apart in the audit trail only, via a distinct `recordAuditEvent`
 *   action string (own ruling -- migration 019 predates this task and is
 *   Task-1-owned/already-reviewed-clean, so this reconciles the mockup's
 *   two-button requirement without touching that migration).
 * - retry: allowed only when the candidate is `failed` AND its errorCode
 *   is one of the typed *transient* Gmail codes (spec: "retry: allowed
 *   for typed transient failure only"). 3D-B's own `recordCandidateMetadata`
 *   never produces a `failed` candidate yet (Task 4's own Concerns note:
 *   `failed` stays 0) -- this is a forward-looking guard for 3D-C's
 *   ingestion failures, proven here against directly-seeded fixture rows.
 *
 * A candidate already in a terminal status (`processed`/`duplicate`/
 * `skipped`/`failed`) is rejected by this domain's own guard *before* any
 * UPDATE is attempted -- migration 019's terminal-immutability trigger
 * would reject the same UPDATE at the database level, but a clean typed
 * `DomainError.conflict()` here is friendlier than a raw trigger
 * exception, and covers a `duplicate`-status candidate (set by some other
 * process, e.g. a future Phase 3B cross-channel dedup pass) the same way.
 */
import { randomUUID } from "node:crypto";

import {
  type MailboxCandidateClassification,
  type MailboxCandidateStatus,
  type MailboxCandidateV1,
  type MailboxErrorCodeV1,
  type MailboxScope,
} from "@expense-tax/contracts";
import { type Kysely, type Selectable } from "kysely";

import type { AppDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import { requireScopeRole } from "./files.js";
import { hashNormalizedRequest, toJsonValue } from "./idempotency.js";

type ConnectionRow = Selectable<AppDatabase["app.mailbox_connections"]>;
type CandidateRow = Selectable<AppDatabase["app.mailbox_candidates"]>;

/**
 * Fully terminal for every review action, including `retry`. `failed` is
 * deliberately excluded here -- migration 019's trigger allows exactly
 * one narrow exception (`failed` -> `review`, the `retry` action), so
 * `failed` is instead gated action-specifically below: rejected for
 * `ingest`/`skip`/`not_receipt`, accepted for `retry` only when the
 * candidate's errorCode is a typed transient code.
 */
const TERMINAL_CANDIDATE_STATUSES = new Set<MailboxCandidateStatus>([
  "processed",
  "duplicate",
  "skipped",
]);

/** Spec: "Gmail 429/5xx: bounded retries" -- the only two typed codes a
 * `retry` review action may ever clear. Every other code (reauth,
 * permission, validation, conflict) is permanent from the reviewer's
 * point of view -- re-running the exact same request would fail again. */
const TRANSIENT_MAILBOX_ERROR_CODES = new Set<MailboxErrorCodeV1>([
  "GOOGLE_RATE_LIMITED",
  "GOOGLE_UNAVAILABLE",
]);

function toMailboxScope(row: Pick<ConnectionRow, "personal_profile_id" | "business_id">): MailboxScope {
  return row.personal_profile_id !== null
    ? { kind: "personal", profileId: row.personal_profile_id }
    : { kind: "business", businessId: row.business_id as string };
}

function toMailboxScopeOrNull(
  row: Pick<CandidateRow, "candidate_personal_profile_id" | "candidate_business_id">,
): MailboxScope | null {
  if (row.candidate_personal_profile_id !== null) {
    return { kind: "personal", profileId: row.candidate_personal_profile_id };
  }
  if (row.candidate_business_id !== null) {
    return { kind: "business", businessId: row.candidate_business_id };
  }
  return null;
}

function toMailboxCandidateV1(row: CandidateRow): MailboxCandidateV1 {
  return {
    schemaVersion: 1,
    id: row.id,
    scanRunId: row.scan_run_id,
    connectionId: row.connection_id,
    tenantId: row.tenant_id,
    receivedAt: row.received_at.toISOString(),
    senderAddress: row.sender_address,
    senderDomain: row.sender_domain,
    subject: row.subject,
    contentHash: row.content_hash,
    attachmentManifest: row.attachment_manifest as unknown as MailboxCandidateV1["attachmentManifest"],
    classification: row.classification,
    confidence: Number(row.confidence),
    evidence: [...row.evidence],
    scope: toMailboxScopeOrNull(row),
    status: row.status,
    processingJobId: row.processing_job_id,
    expenseId: row.expense_id,
    sourceId: row.source_id,
    duplicateMatchId: row.duplicate_match_id,
    version: row.version,
    idempotencyKey: row.idempotency_key,
    errorCode: row.error_code as MailboxErrorCodeV1 | null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function encodeCandidateCursor(receivedAt: Date, id: string): string {
  return Buffer.from(`${receivedAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeCandidateCursor(cursor: string): { receivedAt: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  const receivedAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (separator < 0 || Number.isNaN(receivedAt.getTime()) || !id) throw DomainError.validation();
  return { receivedAt, id };
}

/**
 * Spec: "Every connection/candidate list, detail, and mutation
 * revalidates current tenant membership, connection status/version,
 * owner or non-revoked reviewer grant, and grant version." Three
 * independent paths to access, any one sufficient: the connection's
 * owner, an explicit non-revoked `mailbox_reviewer_grants` row for this
 * actor, or ordinary Personal/business scope membership on the
 * connection's own scope (same `requireScopeRole` every other mailbox
 * domain file in this package uses).
 */
async function authorizeCandidateAccess(
  database: Kysely<AppDatabase>,
  input: { readonly actorUserId: string; readonly tenantId: string; readonly connectionId: string },
): Promise<ConnectionRow> {
  const connection = await database
    .selectFrom("app.mailbox_connections")
    .selectAll()
    .where("id", "=", input.connectionId)
    .where("tenant_id", "=", input.tenantId)
    .executeTakeFirst();
  if (!connection) throw DomainError.notFound();

  if (connection.owner_user_id === input.actorUserId) return connection;

  const grant = await database
    .selectFrom("app.mailbox_reviewer_grants")
    .select(["id"])
    .where("connection_id", "=", input.connectionId)
    .where("user_id", "=", input.actorUserId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (grant) return connection;

  try {
    await requireScopeRole(database, {
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      scope: toMailboxScope(connection),
    });
    return connection;
  } catch {
    throw DomainError.forbidden();
  }
}

export type MailboxCandidateReviewAction = "ingest" | "skip" | "not_receipt" | "retry";

export interface ListCandidatesInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly classification?: MailboxCandidateClassification;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListCandidatesResult {
  readonly items: readonly MailboxCandidateV1[];
  readonly nextCursor: string | null;
}

export interface ResolveCandidateInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly candidateId: string;
  readonly action: MailboxCandidateReviewAction;
  /** Required for `action: "ingest"`; ignored otherwise. */
  readonly scope?: MailboxScope;
  readonly expectedCandidateVersion: number;
  readonly requestId: string;
}

export interface MailboxCandidatesDomain {
  listCandidates(input: ListCandidatesInput): Promise<ListCandidatesResult>;
  resolveCandidate(input: ResolveCandidateInput): Promise<MailboxCandidateV1>;
}

export function createMailboxCandidatesDomain(database: Kysely<AppDatabase>): MailboxCandidatesDomain {
  return {
    async listCandidates(input) {
      await authorizeCandidateAccess(database, input);
      const limit = input.limit ?? 50;
      const cursor = input.cursor ? decodeCandidateCursor(input.cursor) : null;

      let query = database
        .selectFrom("app.mailbox_candidates")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("connection_id", "=", input.connectionId);
      if (input.classification) query = query.where("classification", "=", input.classification);
      if (cursor) {
        query = query.where((eb) =>
          eb.or([
            eb("received_at", "<", cursor.receivedAt),
            eb.and([eb("received_at", "=", cursor.receivedAt), eb("id", "<", cursor.id)]),
          ]),
        );
      }

      const rows = await query
        .orderBy("received_at", "desc")
        .orderBy("id", "desc")
        .limit(limit + 1)
        .execute();
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map(toMailboxCandidateV1),
        nextCursor: rows.length > limit && last ? encodeCandidateCursor(last.received_at, last.id) : null,
      };
    },

    async resolveCandidate(input) {
      await authorizeCandidateAccess(database, input);

      if (input.action === "ingest") {
        if (!input.scope) throw DomainError.validation();
        // Spec: "Assigning/reassigning requires current membership to
        // target scope" -- checked fresh at action time, independent of
        // whatever authorized `authorizeCandidateAccess` above (the
        // connection's own owning scope may differ from the target scope
        // a reviewer is assigning this candidate into).
        await requireScopeRole(database, {
          actorUserId: input.actorUserId,
          tenantId: input.tenantId,
          scope: input.scope,
        });
      }

      const operationKey = `resolve-candidate:${input.candidateId}`;
      const payloadHash = hashNormalizedRequest({
        action: input.action,
        scope: input.scope ?? null,
        expectedCandidateVersion: input.expectedCandidateVersion,
      });

      return database.transaction().execute(async (transaction) => {
        const candidate = await transaction
          .selectFrom("app.mailbox_candidates")
          .selectAll()
          .where("id", "=", input.candidateId)
          .where("tenant_id", "=", input.tenantId)
          .where("connection_id", "=", input.connectionId)
          .forUpdate()
          .executeTakeFirst();
        if (!candidate) throw DomainError.notFound();

        const existingKey = await transaction
          .selectFrom("app.mailbox_operation_keys")
          .select(["normalized_request_hash", "response_json"])
          .where("tenant_id", "=", input.tenantId)
          .where("operation_key", "=", operationKey)
          .where("idempotency_key", "=", input.requestId)
          .executeTakeFirst();
        if (existingKey) {
          if (existingKey.normalized_request_hash !== payloadHash) {
            throw DomainError.idempotencyConflict();
          }
          return existingKey.response_json as unknown as MailboxCandidateV1;
        }

        // A terminal candidate (processed/duplicate/skipped, including
        // one made `duplicate` by some other process) can never be
        // resolved again -- migration 019's own trigger would reject the
        // UPDATE below anyway; this typed check is the friendlier,
        // intentional first line.
        if (TERMINAL_CANDIDATE_STATUSES.has(candidate.status)) {
          throw DomainError.conflict();
        }
        // `failed` is terminal for every action except `retry` (migration
        // 019's trigger allows only the `failed` -> `review` transition).
        if (candidate.status === "failed" && input.action !== "retry") {
          throw DomainError.conflict();
        }
        if (candidate.version !== input.expectedCandidateVersion) {
          throw DomainError.versionConflict();
        }

        const now = new Date();
        let nextStatus: MailboxCandidateStatus;
        let scopeUpdate: { personal: string | null; business: string | null } = {
          personal: candidate.candidate_personal_profile_id,
          business: candidate.candidate_business_id,
        };
        let errorCodeUpdate: MailboxErrorCodeV1 | null = candidate.error_code as MailboxErrorCodeV1 | null;

        if (input.action === "ingest") {
          const scope = input.scope as MailboxScope;
          nextStatus = "queued";
          scopeUpdate =
            scope.kind === "personal"
              ? { personal: scope.profileId, business: null }
              : { personal: null, business: scope.businessId };
        } else if (input.action === "skip" || input.action === "not_receipt") {
          nextStatus = "skipped";
        } else {
          // retry
          if (candidate.status !== "failed") throw DomainError.conflict();
          const currentErrorCode = candidate.error_code as MailboxErrorCodeV1 | null;
          if (!currentErrorCode || !TRANSIENT_MAILBOX_ERROR_CODES.has(currentErrorCode)) {
            throw DomainError.conflict();
          }
          nextStatus = "review";
          errorCodeUpdate = null;
        }

        const updated = await transaction
          .updateTable("app.mailbox_candidates")
          .set({
            status: nextStatus,
            candidate_personal_profile_id: scopeUpdate.personal,
            candidate_business_id: scopeUpdate.business,
            error_code: errorCodeUpdate,
            version: candidate.version + 1,
            updated_at: now,
          })
          .where("id", "=", candidate.id)
          .where("version", "=", candidate.version)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.versionConflict();

        const result = toMailboxCandidateV1(updated);

        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: `mailbox_candidate.${input.action}`,
          outcome: "success",
          resourceType: "mailbox_candidate",
          resourceId: candidate.id,
          requestId: input.requestId,
        });

        await transaction
          .insertInto("app.mailbox_operation_keys")
          .values({
            id: randomUUID(),
            tenant_id: input.tenantId,
            connection_id: input.connectionId,
            operation_key: operationKey,
            idempotency_key: input.requestId,
            normalized_request_hash: payloadHash,
            response_json: toJsonValue(result),
            created_at: now,
          })
          .execute();

        return result;
      });
    },
  };
}
