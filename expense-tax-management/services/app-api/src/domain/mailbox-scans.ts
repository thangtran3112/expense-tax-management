/**
 * Phase 3D-B Task 2 — connection-wide single-flight scan lease, scan-run
 * domain, and the fenced candidate-page callback.
 *
 * App API owns the scan lease (migration 018's `active_scan_run_id`/
 * `active_scan_lease_expires_at` on `app.mailbox_connections`), the
 * scan-run ledger (migration 019's `app.mailbox_scan_runs`), the cursor
 * fence (migration 019's `current_history_id`/`current_cursor_digest`/
 * `pre_fence_token`/`next_page_sequence` columns), and candidate staging
 * (`app.mailbox_candidates`/`app.mailbox_scan_page_outcomes`). The broker
 * reads Gmail and calls `recordCandidateMetadata` directly; this module
 * never sees a Gmail history ID's meaning, only compares it/the opaque
 * cursor digest and pre-fence token for exact equality (fencing, never
 * interpretation).
 *
 * Temporal dispatch is explicitly NOT this module's job: per the plan
 * (Task 3's file list owns `src/temporal/client.ts`,
 * `src/temporal/mailbox-schedules.ts`, and the workflow/activity files),
 * `startManualScan`/`startScheduledScan` only acquire the lease and create
 * the scan-run row; Task 3 wires the actual `MailboxScanWorkflow` start on
 * top of these domain functions. This keeps MAILBOX_SCAN_WORKFLOW_TYPE
 * dispatch -- and its "bypass the Task 7 generation fence" ruling -- in
 * the one place that already imports the Temporal starter.
 *
 * Five domain functions beyond lease/scan-run bookkeeping:
 * - loadScanBinding: the broker's read of "where does this scan currently
 *   stand" (connection version + cursor fence + next expected page).
 * - finalizeScanRun (Phase 3D-B Task 3 fix round 1): the worker-only
 *   terminal callback. Marks the scan run completed/failed (no content,
 *   no Gmail error body -- just a bare succeeded/failed outcome) and
 *   releases the connection's scan lease, but ONLY if this run still
 *   holds it (same run-identity fence as loadScanBinding/
 *   recordCandidateMetadata -- a stale run whose lease was already
 *   stolen by a successor must never clear that successor's lease).
 *   Idempotent: a run that is already terminal returns its current state
 *   without re-updating or attempting a second (harmless, no-op) release.
 * - loadCandidateBinding (Phase 3D-B Task 4): the broker-authenticated
 *   `POST .../candidates/:candidateId/broker-binding` read -- returns a
 *   candidate's connectionId/version/provider message+thread IDs so the
 *   broker can refetch it later (3D-C's materialize flow). A plain
 *   lookup, no lease/fence involvement: unlike loadScanBinding, nothing
 *   here mutates or depends on which scan run is currently active.
 * - recordCandidateMetadata: the fenced page callback. Locks run and
 *   connection, requires the run to still hold the connection's active
 *   scan lease (fix round 1: a run whose lease was stolen by a later run
 *   is rejected by run identity, not just by fence-field comparison --
 *   see loadScanBinding's matching check), requires exact fence-field
 *   equality and pageSequence === nextPageSequence, persists candidates
 *   (classification receipt -> staged, ambiguous -> review, not_receipt ->
 *   discovered-only, never persisted), writes a durable page outcome, and
 *   only then advances the connection's cursor/page-sequence pointer.
 *   Duplicate pages replay via the same permanent
 *   `app.mailbox_operation_keys` ledger migration 018 built for exactly
 *   this purpose; out-of-order/stale/superseded pages are rejected with
 *   `DomainError.versionConflict()` (fix round 1: the brief's required
 *   typed VERSION_CONFLICT -- a generic conflict was used before review).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  mailboxIdempotencyKey,
  type MailboxBrokerCandidateBindingV1,
  type MailboxBrokerScanBindingV1,
  type MailboxCandidateMetadataStagingResultV1,
  type MailboxCandidateMetadataStagingV1,
  type MailboxScanRunV1,
  type MailboxScope,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable } from "kysely";

import type { AppDatabase, JsonValue } from "../database/types.js";
import { DomainError } from "../errors.js";
import { requireScopeRole } from "./files.js";
import { hashNormalizedRequest, toJsonValue } from "./idempotency.js";
import type { PlansDomain } from "./plans.js";

type ConnectionRow = Selectable<AppDatabase["app.mailbox_connections"]>;
type ScanRunRow = Selectable<AppDatabase["app.mailbox_scan_runs"]>;

/** Connection-wide scan lease TTL. Release on scan completion is Task 3's
 * job (the workflow that actually runs the scan); an expired, un-released
 * lease simply lets the next start attempt win the CAS. */
const DEFAULT_SCAN_LEASE_TTL_SECONDS = 15 * 60;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Deterministic, App-computed fence token -- never Gmail-derived. Scoped
 * to one scan run (via its fresh `preFenceToken`) and one page sequence,
 * so each page has exactly one valid "next cursorBeforeDigest". Page 0 is
 * the digest a fresh scan's first page (pageSequence 1) must present.
 */
function computeCursorDigest(
  connectionId: string,
  preFenceToken: string,
  pageSequence: number,
): string {
  return sha256Hex(`${connectionId}:${preFenceToken}:${pageSequence}`);
}

function toMailboxScope(
  row: Pick<ConnectionRow, "personal_profile_id" | "business_id">,
): MailboxScope {
  return row.personal_profile_id !== null
    ? { kind: "personal", profileId: row.personal_profile_id }
    : { kind: "business", businessId: row.business_id as string };
}

function toMailboxScanRunV1(row: ScanRunRow): MailboxScanRunV1 {
  return {
    schemaVersion: 1,
    id: row.id,
    connectionId: row.connection_id,
    tenantId: row.tenant_id,
    initiatedBy: row.initiated_by as MailboxScanRunV1["initiatedBy"],
    entitlementVersion: row.entitlement_version,
    connectionVersion: row.connection_version,
    status: row.status,
    discoveredCount: row.discovered_count,
    stagedCount: row.staged_count,
    reviewCount: row.review_count,
    duplicateCount: row.duplicate_count,
    skippedCount: row.skipped_count,
    failedCount: row.failed_count,
    errorCode: row.error_code as MailboxScanRunV1["errorCode"],
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export interface StartManualScanInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly requestId: string;
}

export interface StartScheduledScanInput {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly requestId: string;
}

export interface StartScanResult {
  readonly scanRun: MailboxScanRunV1;
  readonly status: "started" | "skipped_overlap";
}

export interface FinalizeScanRunInput {
  readonly scanRunId: string;
  readonly outcome: "succeeded" | "failed";
}

export interface FinalizeScanRunResult {
  readonly scanRun: MailboxScanRunV1;
  readonly leaseReleased: boolean;
}

const TERMINAL_SCAN_RUN_STATUSES = new Set<MailboxScanRunV1["status"]>([
  "completed",
  "partial",
  "failed",
  "skipped",
]);

export interface ListScanRunsInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly connectionId: string;
}

export interface MailboxScansDomain {
  startManualScan(input: StartManualScanInput): Promise<StartScanResult>;
  startScheduledScan(input: StartScheduledScanInput): Promise<StartScanResult>;
  listScanRuns(
    input: ListScanRunsInput,
  ): Promise<{ readonly items: readonly MailboxScanRunV1[] }>;
  loadScanBinding(scanRunId: string): Promise<MailboxBrokerScanBindingV1>;
  loadCandidateBinding(candidateId: string): Promise<MailboxBrokerCandidateBindingV1>;
  recordCandidateMetadata(
    input: MailboxCandidateMetadataStagingV1,
  ): Promise<MailboxCandidateMetadataStagingResultV1>;
  finalizeScanRun(input: FinalizeScanRunInput): Promise<FinalizeScanRunResult>;
}

export interface MailboxScansDomainOptions {
  readonly scanLeaseTtlSeconds?: number;
}

async function resolveEntitlementVersion(
  plansDomain: PlansDomain,
  tenantId: string,
  actorUserId: string,
): Promise<number> {
  const entitlements = await plansDomain.resolveEffectiveEntitlements({
    tenantId,
    actorUserId,
  });
  const scanEntitlement = entitlements.find(
    (entitlement) => entitlement.featureKey === "connected_mailbox_scan",
  );
  if (!scanEntitlement?.isEnabled) throw DomainError.forbidden();
  const subscription = await plansDomain.getSubscription({ tenantId });
  return subscription.currentEntitlementVersion;
}

/** Shared lease-CAS + scan-run creation core for both start paths. */
async function startScan(
  database: Kysely<AppDatabase>,
  ttlSeconds: number,
  input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly initiatedBy: string;
    readonly requestId: string;
    readonly entitlementVersion: number;
  },
): Promise<StartScanResult> {
  const payloadHash = hashNormalizedRequest({
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    initiatedBy: input.initiatedBy,
  });

  return database.transaction().execute(async (transaction) => {
    // Permanent replay first (migration 019's own
    // UNIQUE(connection_id, idempotency_key) ledger on mailbox_scan_runs
    // itself -- no separate response cache needed, the row IS the result).
    const existingRun = await transaction
      .selectFrom("app.mailbox_scan_runs")
      .selectAll()
      .where("connection_id", "=", input.connectionId)
      .where("idempotency_key", "=", input.requestId)
      .executeTakeFirst();
    if (existingRun) {
      if (existingRun.normalized_request_hash !== payloadHash) {
        throw DomainError.idempotencyConflict();
      }
      return { scanRun: toMailboxScanRunV1(existingRun), status: "started" as const };
    }

    const connection = await transaction
      .selectFrom("app.mailbox_connections")
      .selectAll()
      .where("id", "=", input.connectionId)
      .where("tenant_id", "=", input.tenantId)
      .forUpdate()
      .executeTakeFirst();
    if (!connection) throw DomainError.notFound();
    if (connection.status !== "active") throw DomainError.conflict();

    const now = new Date();
    const leaseActive =
      connection.active_scan_run_id !== null &&
      connection.active_scan_lease_expires_at !== null &&
      connection.active_scan_lease_expires_at.getTime() > now.getTime();
    if (leaseActive) {
      // "manual start returns the existing run with HTTP 409 semantics" /
      // "scheduled start returns typed skipped_overlap" (spec, Temporal
      // Scheduling section) -- same status value either way at the
      // domain layer; the HTTP 409 projection is the route's job.
      const activeRun = await transaction
        .selectFrom("app.mailbox_scan_runs")
        .selectAll()
        .where("id", "=", connection.active_scan_run_id)
        .executeTakeFirstOrThrow();
      return { scanRun: toMailboxScanRunV1(activeRun), status: "skipped_overlap" as const };
    }

    const scanRunId = randomUUID();
    // Fresh per scan run -- invalidates any stale page submission from a
    // prior scan run on this same connection. current_history_id is
    // deliberately NOT reset here: it is the real Gmail cursor and must
    // survive across scans (recordCandidateMetadata only ever advances
    // it forward).
    const preFenceToken = randomBytes(32).toString("hex");
    const initialCursorDigest = computeCursorDigest(input.connectionId, preFenceToken, 0);
    const leaseExpiresAt = new Date(now.getTime() + ttlSeconds * 1_000);

    const updatedConnection = await transaction
      .updateTable("app.mailbox_connections")
      .set({
        active_scan_run_id: scanRunId,
        active_scan_lease_expires_at: leaseExpiresAt,
        pre_fence_token: preFenceToken,
        current_cursor_digest: initialCursorDigest,
        next_page_sequence: 1,
      })
      .where("id", "=", input.connectionId)
      .where("connection_version", "=", connection.connection_version)
      .returningAll()
      .executeTakeFirst();
    if (!updatedConnection) throw DomainError.conflict();

    const createdRun = await transaction
      .insertInto("app.mailbox_scan_runs")
      .values({
        id: scanRunId,
        connection_id: input.connectionId,
        tenant_id: input.tenantId,
        initiated_by: input.initiatedBy,
        entitlement_version: input.entitlementVersion,
        connection_version: updatedConnection.connection_version,
        status: "pending",
        idempotency_key: input.requestId,
        normalized_request_hash: payloadHash,
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { scanRun: toMailboxScanRunV1(createdRun), status: "started" as const };
  });
}

export function createMailboxScansDomain(
  database: Kysely<AppDatabase>,
  deps: { readonly plansDomain: PlansDomain },
  options: MailboxScansDomainOptions = {},
): MailboxScansDomain {
  const ttlSeconds = options.scanLeaseTtlSeconds ?? DEFAULT_SCAN_LEASE_TTL_SECONDS;

  async function requireConnection(tenantId: string, connectionId: string): Promise<ConnectionRow> {
    const connection = await database
      .selectFrom("app.mailbox_connections")
      .selectAll()
      .where("id", "=", connectionId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    if (!connection) throw DomainError.notFound();
    return connection;
  }

  return {
    async startManualScan(input) {
      const connection = await requireConnection(input.tenantId, input.connectionId);
      await requireScopeRole(database, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: toMailboxScope(connection),
      });
      const entitlementVersion = await resolveEntitlementVersion(
        deps.plansDomain,
        input.tenantId,
        input.actorUserId,
      );
      return startScan(database, ttlSeconds, {
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        initiatedBy: input.actorUserId,
        requestId: input.requestId,
        entitlementVersion,
      });
    },

    async startScheduledScan(input) {
      const connection = await requireConnection(input.tenantId, input.connectionId);
      // Scheduled trigger acts on the connection owner's behalf -- there
      // is no acting user, and the owner is who authorized the schedule.
      const entitlementVersion = await resolveEntitlementVersion(
        deps.plansDomain,
        input.tenantId,
        connection.owner_user_id,
      );
      return startScan(database, ttlSeconds, {
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        initiatedBy: "schedule",
        requestId: input.requestId,
        entitlementVersion,
      });
    },

    async listScanRuns(input) {
      const connection = await requireConnection(input.tenantId, input.connectionId);
      await requireScopeRole(database, {
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        scope: toMailboxScope(connection),
      });
      const rows = await database
        .selectFrom("app.mailbox_scan_runs")
        .selectAll()
        .where("connection_id", "=", input.connectionId)
        .where("tenant_id", "=", input.tenantId)
        .orderBy("created_at", "desc")
        .limit(50)
        .execute();
      return { items: rows.map(toMailboxScanRunV1) };
    },

    async loadScanBinding(scanRunId) {
      const scanRun = await database
        .selectFrom("app.mailbox_scan_runs")
        .selectAll()
        .where("id", "=", scanRunId)
        .executeTakeFirst();
      if (!scanRun) throw DomainError.notFound();
      if (scanRun.status !== "pending" && scanRun.status !== "running") {
        throw DomainError.conflict();
      }

      const connection = await database
        .selectFrom("app.mailbox_connections")
        .selectAll()
        .where("id", "=", scanRun.connection_id)
        .executeTakeFirstOrThrow();

      // This run must still be the one currently holding the connection's
      // scan lease. Without this check, a run whose lease expired and was
      // then stolen by a later run would be handed that LATER run's
      // current fence values (connection state is shared, not per-run),
      // letting a stale worker masquerade as the active one.
      if (connection.active_scan_run_id !== scanRunId) {
        throw DomainError.versionConflict();
      }

      // Both set together by startScan whenever a scan run is created, so
      // any scan run reaching this point always has non-null values here.
      return {
        scanRunId,
        connectionId: connection.id,
        expectedConnectionVersion: connection.connection_version,
        currentHistoryId: connection.current_history_id,
        currentCursorDigest: connection.current_cursor_digest as string,
        preFenceToken: connection.pre_fence_token as string,
        nextPageSequence: connection.next_page_sequence,
      };
    },

    async loadCandidateBinding(candidateId) {
      const candidate = await database
        .selectFrom("app.mailbox_candidates")
        .select(["id", "connection_id", "version", "provider_message_id", "provider_thread_id"])
        .where("id", "=", candidateId)
        .executeTakeFirst();
      if (!candidate) throw DomainError.notFound();
      return {
        candidateId: candidate.id,
        connectionId: candidate.connection_id,
        expectedCandidateVersion: candidate.version,
        providerMessageId: candidate.provider_message_id,
        providerThreadId: candidate.provider_thread_id,
      };
    },

    async finalizeScanRun(input) {
      return database.transaction().execute(async (transaction) => {
        const scanRun = await transaction
          .selectFrom("app.mailbox_scan_runs")
          .selectAll()
          .where("id", "=", input.scanRunId)
          .forUpdate()
          .executeTakeFirst();
        if (!scanRun) throw DomainError.notFound();

        const now = new Date();
        const alreadyTerminal = TERMINAL_SCAN_RUN_STATUSES.has(
          scanRun.status as MailboxScanRunV1["status"],
        );
        const finalRun = alreadyTerminal
          ? scanRun
          : await transaction
              .updateTable("app.mailbox_scan_runs")
              .set({
                status: input.outcome === "succeeded" ? "completed" : "failed",
                started_at: scanRun.started_at ?? now,
                completed_at: now,
              })
              .where("id", "=", input.scanRunId)
              .returningAll()
              .executeTakeFirstOrThrow();

        // Release the connection's scan lease ONLY if this run still
        // holds it -- a stale/superseded run (lease already stolen by a
        // later run) must never clear that successor's active lease.
        // Harmless no-op (0 rows updated) on a second/idempotent call.
        const released = await transaction
          .updateTable("app.mailbox_connections")
          .set({
            active_scan_run_id: null,
            active_scan_lease_expires_at: null,
            updated_at: now,
          })
          .where("id", "=", scanRun.connection_id)
          .where("active_scan_run_id", "=", input.scanRunId)
          .returning(["id"])
          .executeTakeFirst();

        return {
          scanRun: toMailboxScanRunV1(finalRun),
          leaseReleased: released !== undefined,
        };
      });
    },

    async recordCandidateMetadata(input) {
      const operationKey = `stage-candidate-page:${input.scanRunId}`;
      const payloadHash = hashNormalizedRequest({
        connectionId: input.connectionId,
        expectedConnectionVersion: input.expectedConnectionVersion,
        cursorBeforeDigest: input.cursorBeforeDigest,
        preFenceToken: input.preFenceToken,
        pageSequence: input.pageSequence,
        nextHistoryId: input.nextHistoryId,
        messages: input.messages,
      });

      return database.transaction().execute(async (transaction) => {
        const scanRun = await transaction
          .selectFrom("app.mailbox_scan_runs")
          .selectAll()
          .where("id", "=", input.scanRunId)
          .forUpdate()
          .executeTakeFirst();
        if (!scanRun || scanRun.connection_id !== input.connectionId) {
          throw DomainError.notFound();
        }

        // Permanent replay (migration 018's app.mailbox_operation_keys
        // ledger, the same one mailbox-connections.ts's domain uses --
        // generic enough to key on this page's own operation/idempotency
        // key without a dedicated response column on
        // mailbox_scan_page_outcomes).
        const existingKey = await transaction
          .selectFrom("app.mailbox_operation_keys")
          .select(["normalized_request_hash", "response_json"])
          .where("tenant_id", "=", scanRun.tenant_id)
          .where("operation_key", "=", operationKey)
          .where("idempotency_key", "=", input.idempotencyKey)
          .executeTakeFirst();
        if (existingKey) {
          if (existingKey.normalized_request_hash !== payloadHash) {
            throw DomainError.idempotencyConflict();
          }
          return existingKey.response_json as unknown as MailboxCandidateMetadataStagingResultV1;
        }

        if (scanRun.status !== "pending" && scanRun.status !== "running") {
          throw DomainError.conflict();
        }

        const connection = await transaction
          .selectFrom("app.mailbox_connections")
          .selectAll()
          .where("id", "=", input.connectionId)
          .where("tenant_id", "=", scanRun.tenant_id)
          .forUpdate()
          .executeTakeFirst();
        if (!connection) throw DomainError.notFound();

        // This run must still hold the connection's scan lease. A run
        // whose lease expired and was stolen by a later run must be
        // rejected here even if (improbably) its stale fence values still
        // happened to match -- the run identity itself is the fence of
        // last resort, checked before the field-level comparisons below.
        if (connection.active_scan_run_id !== input.scanRunId) {
          throw DomainError.versionConflict();
        }

        // Exact fence-field equality + the one legal next page sequence.
        // A stale/out-of-order page (pageSequence !== connection's
        // nextPageSequence) or any fence-field mismatch is rejected
        // without moving the cursor.
        if (
          input.pageSequence !== connection.next_page_sequence ||
          input.expectedConnectionVersion !== connection.connection_version ||
          input.cursorBeforeDigest !== connection.current_cursor_digest ||
          input.preFenceToken !== connection.pre_fence_token
        ) {
          throw DomainError.versionConflict();
        }

        const now = new Date();
        const candidateRows = input.messages.flatMap((message) => {
          // not_receipt is discovered-only: it contributes to this
          // page's discovered count but is never persisted as a
          // candidate (spec: "Plain free text never creates an expense
          // automatically"; the staging result's counts shape has no
          // not_receipt bucket at all, only discovered/staged/review/
          // failed).
          if (message.classification === "not_receipt") return [];
          const status: "staged" | "review" =
            message.classification === "receipt" ? "staged" : "review";
          return [
            {
              id: randomUUID(),
              scan_run_id: input.scanRunId,
              connection_id: input.connectionId,
              tenant_id: scanRun.tenant_id,
              received_at: new Date(message.receivedAt),
              sender_address: message.senderAddress,
              sender_domain: message.senderDomain,
              subject: message.subject,
              content_hash: message.contentHash,
              // node-pg encodes a plain JS array as a Postgres ARRAY
              // literal, not JSON text -- an explicit ::jsonb cast of the
              // JSON string is required for an array-shaped jsonb column
              // (unlike the object-shaped `evidence`/`metadata` jsonb
              // columns elsewhere in this codebase, which accept a plain
              // JS object via toJsonValue unmodified).
              attachment_manifest: sql<JsonValue>`${JSON.stringify(toJsonValue(message.attachmentManifest))}::jsonb`,
              classification: message.classification,
              confidence: message.confidence,
              evidence: [...message.evidence],
              status,
              idempotency_key: mailboxIdempotencyKey(
                input.connectionId,
                "candidate",
                message.providerMessageId,
                input.pageSequence,
              ),
              normalized_request_hash: hashNormalizedRequest(message),
              provider_message_id: message.providerMessageId,
              provider_thread_id: message.providerThreadId,
              created_at: now,
              updated_at: now,
            },
          ];
        });

        // Phase 3D-B Task 4 -- 404-recovery's bounded full sync can
        // re-list a provider_message_id this connection already has a
        // candidate for (from an earlier, now-stale incremental sync).
        // Spec: "Existing unique message IDs make recovery idempotent."
        // `onConflict...doNothing()` silently skips exactly those rows
        // (migration 019's own `mailbox_candidates_message_unique`
        // constraint) instead of throwing a raw constraint violation;
        // `staged`/`review`/`candidateIds` are computed only from rows
        // that actually inserted, via `returning`, not from every row
        // this page attempted.
        //
        // Fix round 1 (review Important #3) -- "idempotent" means
        // identical replay only. A conflicting `provider_message_id`
        // whose freshly-computed `normalized_request_hash` does NOT match
        // the already-stored row's hash is a genuinely different payload
        // for the same message (corruption, or a real Gmail edit) and
        // must be rejected as `IDEMPOTENCY_CONFLICT`, not silently
        // dropped -- the same hash-compare pattern this file already uses
        // for scan-run/page-level permanent idempotency keys above.
        let staged = 0;
        let review = 0;
        const candidateIds: string[] = [];
        if (candidateRows.length > 0) {
          const insertedRows = await transaction
            .insertInto("app.mailbox_candidates")
            .values(candidateRows)
            .onConflict((builder) => builder.columns(["connection_id", "provider_message_id"]).doNothing())
            .returning(["id", "classification", "provider_message_id"])
            .execute();
          const insertedProviderMessageIds = new Set(insertedRows.map((row) => row.provider_message_id));
          const conflictedRows = candidateRows.filter(
            (row) => !insertedProviderMessageIds.has(row.provider_message_id),
          );
          for (const conflicted of conflictedRows) {
            const existing = await transaction
              .selectFrom("app.mailbox_candidates")
              .select(["normalized_request_hash"])
              .where("connection_id", "=", input.connectionId)
              .where("provider_message_id", "=", conflicted.provider_message_id)
              .executeTakeFirstOrThrow();
            if (existing.normalized_request_hash !== conflicted.normalized_request_hash) {
              throw DomainError.idempotencyConflict();
            }
          }
          for (const row of insertedRows) {
            candidateIds.push(row.id);
            if (row.classification === "receipt") staged += 1;
            else review += 1;
          }
        }

        // Durable page outcome before the cursor advances (spec: "cursor
        // advances only after App API records every page/message
        // outcome"). UNIQUE(scan_run_id, page_sequence) is an additional
        // DB-level guard against double-processing one page.
        await transaction
          .insertInto("app.mailbox_scan_page_outcomes")
          .values({
            id: randomUUID(),
            scan_run_id: input.scanRunId,
            connection_id: input.connectionId,
            tenant_id: scanRun.tenant_id,
            page_sequence: input.pageSequence,
            candidate_count: input.messages.length,
            status: "completed",
            created_at: now,
            updated_at: now,
          })
          .execute();

        const nextCursorDigest = computeCursorDigest(
          input.connectionId,
          input.preFenceToken,
          input.pageSequence,
        );
        await transaction
          .updateTable("app.mailbox_connections")
          .set({
            current_cursor_digest: nextCursorDigest,
            next_page_sequence: input.pageSequence + 1,
            // Persist the real Gmail history ID only once the broker
            // reports it (spec: "Persist post-replay history ID only
            // after every discovered message ID has a durable candidate
            // or durable retry record" -- an intermediate page may not
            // have one yet).
            ...(input.nextHistoryId !== null
              ? { current_history_id: input.nextHistoryId }
              : {}),
            updated_at: now,
          })
          .where("id", "=", input.connectionId)
          .execute();

        await transaction
          .updateTable("app.mailbox_scan_runs")
          .set({
            status: scanRun.status === "pending" ? "running" : scanRun.status,
            started_at: scanRun.started_at ?? now,
            discovered_count: sql<number>`discovered_count + ${input.messages.length}`,
            staged_count: sql<number>`staged_count + ${staged}`,
            review_count: sql<number>`review_count + ${review}`,
          })
          .where("id", "=", input.scanRunId)
          .execute();

        const result: MailboxCandidateMetadataStagingResultV1 = {
          schemaVersion: 1,
          scanRunId: input.scanRunId,
          pageSequence: input.pageSequence,
          candidateIds,
          counts: {
            discovered: input.messages.length,
            staged,
            review,
            failed: 0,
          },
        };

        await transaction
          .insertInto("app.mailbox_operation_keys")
          .values({
            id: randomUUID(),
            tenant_id: scanRun.tenant_id,
            connection_id: input.connectionId,
            operation_key: operationKey,
            idempotency_key: input.idempotencyKey,
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
