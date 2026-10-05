import { createHash, randomUUID } from "node:crypto";

import {
  DEDUPLICATION_CURRENCY_MINOR_UNIT_SCALES,
  FORWARDED_RECEIPT_WORKFLOW_TYPE,
  type DeduplicationEvidenceV1,
  DuplicateMatchEvidenceSchema,
  type DuplicateMatchList,
  type DuplicateMatchStatus,
  DuplicateResolutionResponseSchema,
  type DuplicateResolutionAction,
  type DuplicateResolutionResponse,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import { requireScopeRole, type FileScope } from "./files.js";
import {
  executeIdempotentMutation,
  hashNormalizedRequest,
  toJsonValue,
} from "./idempotency.js";

const FINGERPRINT_VERSION = 1;
// ISO 4217 currencies not listed here use conventional two minor units.

export interface DeduplicationFingerprint {
  readonly version: number;
  readonly normalizedMerchant: string;
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly incurredOn: string;
  readonly hash: string;
}

export interface RecordDeduplicationEvidenceInput {
  readonly request: DeduplicationEvidenceV1;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

export interface ListDeduplicationMatchesInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly scope: FileScope;
  readonly status?: DuplicateMatchStatus;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ResolveDeduplicationMatchInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly scope: FileScope;
  readonly matchId: string;
  readonly action: DuplicateResolutionAction;
  readonly expectedMatchVersion: number;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface DeduplicationDomain {
  recordEvidence(input: RecordDeduplicationEvidenceInput): Promise<{
    readonly decision: "no_match" | "review";
    readonly matchIds: readonly string[];
  }>;
  listMatches(input: ListDeduplicationMatchesInput): Promise<DuplicateMatchList>;
  resolveMatch?(input: ResolveDeduplicationMatchInput): Promise<DuplicateResolutionResponse>;
}

export interface DeduplicationCandidateFile {
  readonly expenseId: string | null;
  readonly sha256Hex: string | null;
  readonly status?: "PENDING" | "READY" | "FAILED" | "DELETED";
  readonly personalProfileId: string | null;
  readonly businessId: string | null;
}

export interface DeduplicationCandidateFingerprint {
  readonly expenseId: string;
  readonly fingerprintHash: string;
  readonly normalizedMerchant: string;
  readonly amountMinorUnits: number;
  readonly currency: string;
  readonly incurredOn: Date | string;
  readonly personalProfileId: string | null;
  readonly businessId: string | null;
}

export interface DeterministicCandidate {
  readonly existingExpenseId: string;
  readonly matchType: "file_sha256" | "fingerprint" | "fuzzy_fields";
  readonly confidence: number;
  readonly evidence: Record<string, unknown>;
}

export function normalizeMerchant(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function toAmountMinorUnits(value: string, scale = 2): number {
  const match = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.exec(value.trim());
  if (!match) throw DomainError.validation();
  const [whole, fraction = ""] = value.trim().split(".");
  if (fraction.length > scale) throw DomainError.validation();
  const factor = 10n ** BigInt(scale);
  const minorUnits = BigInt(whole ?? "") * factor + BigInt(fraction.padEnd(scale, "0"));
  if (minorUnits <= 0n || minorUnits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw DomainError.validation();
  }
  return Number(minorUnits);
}

function dateOnly(value: Date | string): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function canonicalDate(value: string): string {
  const date = value.trim();
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime())) {
    throw DomainError.validation();
  }
  const canonical = parsed.toISOString().slice(0, 10);
  if (canonical !== date) throw DomainError.validation();
  return canonical;
}

export function buildDeduplicationFingerprint(input: {
  readonly merchant: string;
  readonly amount: string;
  readonly currency: string;
  readonly incurredOn: string;
}): DeduplicationFingerprint | null {
  const normalizedMerchant = normalizeMerchant(input.merchant);
  if (!normalizedMerchant || !input.amount || !input.currency || !input.incurredOn) return null;
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw DomainError.validation();
  const amountMinorUnits = toAmountMinorUnits(
    input.amount,
    DEDUPLICATION_CURRENCY_MINOR_UNIT_SCALES[currency as keyof typeof DEDUPLICATION_CURRENCY_MINOR_UNIT_SCALES] ?? 2,
  );
  const incurredOn = canonicalDate(input.incurredOn);
  const canonical = [
    `v${FINGERPRINT_VERSION}`,
    normalizedMerchant,
    amountMinorUnits,
    currency,
    incurredOn,
  ].join("\n");
  return {
    version: FINGERPRINT_VERSION,
    normalizedMerchant,
    amountMinorUnits,
    currency,
    incurredOn,
    hash: createHash("sha256").update(canonical).digest("hex"),
  };
}

export function buildMatchIdempotencyKey(
  requestIdempotencyKey: string,
  matchType: DeterministicCandidate["matchType"],
  existingExpenseId: string,
): string {
  return `dedup:${createHash("sha256")
    .update(`${requestIdempotencyKey}\n${matchType}\n${existingExpenseId}`)
    .digest("hex")}`;
}

function sameScope(
  row:
    | { readonly personal_profile_id: string | null; readonly business_id: string | null }
    | { readonly personalProfileId: string | null; readonly businessId: string | null },
  scope: FileScope,
): boolean {
  const personalProfileId =
    "personal_profile_id" in row ? row.personal_profile_id : row.personalProfileId;
  const businessId = "business_id" in row ? row.business_id : row.businessId;
  return scope.kind === "personal"
    ? personalProfileId === scope.profileId && businessId === null
    : businessId === scope.businessId && personalProfileId === null;
}

function daysBetween(left: string, right: string): number {
  return Math.abs(
    (Date.parse(`${left}T00:00:00.000Z`) - Date.parse(`${right}T00:00:00.000Z`)) /
      86_400_000,
  );
}

export function findDeterministicCandidates(input: {
  readonly scope: FileScope;
  readonly candidateExpenseId: string;
  readonly file: DeduplicationCandidateFile;
  readonly fingerprint: DeduplicationFingerprint | null;
  readonly files: readonly DeduplicationCandidateFile[];
  readonly fingerprints: readonly DeduplicationCandidateFingerprint[];
}): DeterministicCandidate[] {
  const candidates: DeterministicCandidate[] = [];
  if (input.file.sha256Hex) {
    for (const other of input.files) {
      if (
        other.expenseId === null ||
        other.expenseId === input.candidateExpenseId ||
        other.status !== "READY" ||
        other.sha256Hex !== input.file.sha256Hex ||
        !sameScope(other, input.scope)
      ) continue;
      candidates.push({
        existingExpenseId: other.expenseId,
        matchType: "file_sha256",
        confidence: 1,
        evidence: { fileSha256: input.file.sha256Hex },
      });
    }
  }
  if (!input.fingerprint) return candidates;
  for (const other of input.fingerprints) {
    if (other.expenseId === input.candidateExpenseId || !sameScope(other, input.scope)) continue;
    if (other.fingerprintHash === input.fingerprint.hash) {
      candidates.push({
        existingExpenseId: other.expenseId,
        matchType: "fingerprint",
        confidence: 1,
        evidence: { fingerprintHash: input.fingerprint.hash },
      });
      continue;
    }
    if (
      other.normalizedMerchant !== input.fingerprint.normalizedMerchant ||
      other.currency !== input.fingerprint.currency
    ) continue;
    const amountDifferencePercent =
      Math.abs(other.amountMinorUnits - input.fingerprint.amountMinorUnits) /
      input.fingerprint.amountMinorUnits * 100;
    const incurredOnDifferenceDays = daysBetween(
      dateOnly(other.incurredOn),
      input.fingerprint.incurredOn,
    );
    if (amountDifferencePercent <= 5 && incurredOnDifferenceDays <= 2) {
      candidates.push({
        existingExpenseId: other.expenseId,
        matchType: "fuzzy_fields",
        confidence: 0.8,
        evidence: {
          normalizedMerchant: input.fingerprint.normalizedMerchant,
          amountMinorUnits: input.fingerprint.amountMinorUnits,
          existingAmountMinorUnits: other.amountMinorUnits,
          candidateAmountMinorUnits: input.fingerprint.amountMinorUnits,
          currency: input.fingerprint.currency,
          incurredOn: input.fingerprint.incurredOn,
          existingIncurredOn: dateOnly(other.incurredOn),
          candidateIncurredOn: input.fingerprint.incurredOn,
          amountDifferencePercent,
          incurredOnDifferenceDays,
        },
      });
    }
  }
  return candidates;
}

export function resolveCandidateExpenseId(input: {
  readonly targetAggregateId: string | null;
  readonly fileExpenseId: string | null;
}): string {
  if (input.targetAggregateId && input.fileExpenseId && input.targetAggregateId !== input.fileExpenseId) {
    throw DomainError.validation();
  }
  const candidateExpenseId = input.targetAggregateId ?? input.fileExpenseId;
  if (!candidateExpenseId) throw DomainError.validation();
  return candidateExpenseId;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

function matchEvidence(value: unknown) {
  return DuplicateMatchEvidenceSchema.parse(value);
}

function toDuplicateMatch(row: Selectable<AppDatabase["app.expense_duplicate_matches"]>) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personalProfileId: row.personal_profile_id,
    businessId: row.business_id,
    existingExpenseId: row.existing_expense_id,
    candidateExpenseId: row.candidate_expense_id,
    matchType: row.match_type,
    confidence: Number(row.confidence),
    evidence: matchEvidence(row.evidence),
    status: row.status,
    version: row.version,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolutionIdempotencyKey: row.resolution_idempotency_key,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
  };
}

function encodeMatchCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

function decodeMatchCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf("|");
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (separator < 0 || Number.isNaN(createdAt.getTime()) || !id) throw DomainError.validation();
  return { createdAt, id };
}

function resolvedStatus(action: DuplicateResolutionAction): "merged" | "separate" | "dismissed" {
  return action === "merge" ? "merged" : action === "keep_both" ? "separate" : "dismissed";
}

async function loadScopedMatch(
  transaction: Transaction<AppDatabase>,
  input: ResolveDeduplicationMatchInput,
) {
  let query = transaction
    .selectFrom("app.expense_duplicate_matches")
    .selectAll()
    .where("id", "=", input.matchId)
    .where("tenant_id", "=", input.tenantId);
  query = input.scope.kind === "personal"
    ? query.where("personal_profile_id", "=", input.scope.profileId).where("business_id", "is", null)
    : query.where("business_id", "=", input.scope.businessId).where("personal_profile_id", "is", null);
  const match = await query.forUpdate().executeTakeFirst();
  if (!match) throw DomainError.notFound();
  if (match.status !== "pending") throw DomainError.conflict();
  if (match.version !== input.expectedMatchVersion) throw DomainError.conflict();
  return match;
}

async function loadScopedExpense(
  transaction: Transaction<AppDatabase>,
  input: { readonly tenantId: string; readonly scope: FileScope; readonly expenseId: string },
) {
  let query = transaction
    .selectFrom("app.expenses")
    .selectAll()
    .where("id", "=", input.expenseId)
    .where("tenant_id", "=", input.tenantId);
  query = input.scope.kind === "personal"
    ? query.where("personal_profile_id", "=", input.scope.profileId).where("business_id", "is", null)
    : query.where("business_id", "=", input.scope.businessId).where("personal_profile_id", "is", null);
  const expense = await query.forUpdate().executeTakeFirst();
  if (!expense || expense.status === "archived") throw DomainError.conflict();
  return expense;
}

async function mergeCandidate(
  transaction: Transaction<AppDatabase>,
  input: {
    readonly tenantId: string;
    readonly existing: Selectable<AppDatabase["app.expenses"]>;
    readonly candidate: Selectable<AppDatabase["app.expenses"]>;
  },
): Promise<void> {
  const { existing, candidate } = input;
  const enrichment = {
    ...(existing.description === null && candidate.description !== null
      ? { description: candidate.description }
      : {}),
    ...(existing.project_id === null && candidate.project_id !== null
      ? { project_id: candidate.project_id }
      : {}),
    ...(existing.spending_category_id === null && candidate.spending_category_id !== null
      ? { spending_category_id: candidate.spending_category_id }
      : {}),
    ...(existing.incurred_on === null && candidate.incurred_on !== null
      ? { incurred_on: candidate.incurred_on }
      : {}),
  };
  if (Object.keys(enrichment).length > 0) {
    await transaction
      .updateTable("app.expenses")
      .set({ ...enrichment, updated_at: new Date(), version: sql<number>`version + 1` })
      .where("id", "=", existing.id)
      .execute();
  }
  await transaction
    .updateTable("app.expense_files")
    .set({ expense_id: existing.id })
    .where("tenant_id", "=", input.tenantId)
    .where("expense_id", "=", candidate.id)
    .execute();
  await transaction
    .updateTable("app.expense_sources")
    .set({ expense_id: existing.id })
    .where("tenant_id", "=", input.tenantId)
    .where("expense_id", "=", candidate.id)
    .execute();
  await transaction
    .updateTable("app.expenses")
    .set({
      status: "archived",
      archived_at: new Date(),
      updated_at: new Date(),
      version: sql<number>`version + 1`,
    })
    .where("id", "=", candidate.id)
    .where("status", "!=", "archived")
    .execute();
}

async function lockResolutionExpenses(
  transaction: Transaction<AppDatabase>,
  input: { readonly tenantId: string; readonly scope: FileScope },
  expenseIds: readonly [string, string],
): Promise<{
  readonly existing: Selectable<AppDatabase["app.expenses"]>;
  readonly candidate: Selectable<AppDatabase["app.expenses"]>;
}> {
  const locked = new Map<string, Selectable<AppDatabase["app.expenses"]>>();
  for (const expenseId of [...expenseIds].sort()) {
    locked.set(
      expenseId,
      await loadScopedExpense(transaction, {
        tenantId: input.tenantId,
        scope: input.scope,
        expenseId,
      }),
    );
  }
  return {
    existing: locked.get(expenseIds[0]) as Selectable<AppDatabase["app.expenses"]>,
    candidate: locked.get(expenseIds[1]) as Selectable<AppDatabase["app.expenses"]>,
  };
}

async function requireJob(
  transaction: Transaction<AppDatabase>,
  input: DeduplicationEvidenceV1,
) {
  const job = await transaction
    .selectFrom("app.processing_jobs")
    .selectAll()
    .where("id", "=", input.jobId)
    .forUpdate()
    .executeTakeFirst();
  if (!job) throw DomainError.notFound();
  if (job.status !== "SUCCEEDED") throw DomainError.conflict();
  if (job.target_aggregate_id !== null && job.target_aggregate_type !== "expense") {
    throw DomainError.validation();
  }
  if (job.version !== input.expectedJobVersion) throw DomainError.preconditionFailed();
  if (job.source_file_id !== input.sourceFileId) throw DomainError.validation();
  if (job.personal_profile_id === null && job.business_id === null) throw DomainError.validation();
  if (job.personal_profile_id !== null && job.business_id !== null) throw DomainError.validation();
  return job;
}

async function findCandidate(
  transaction: Transaction<AppDatabase>,
  job: Awaited<ReturnType<typeof requireJob>>,
  sourceFileId: string,
) {
  const file = await transaction
    .selectFrom("app.expense_files")
    .selectAll()
    .where("id", "=", sourceFileId)
    .where("tenant_id", "=", job.tenant_id)
    .$if(job.personal_profile_id !== null, (query) =>
      query.where("personal_profile_id", "=", job.personal_profile_id),
    )
    .$if(job.business_id !== null, (query) =>
      query.where("business_id", "=", job.business_id),
    )
    .$if(job.personal_profile_id !== null, (query) => query.where("business_id", "is", null))
    .$if(job.business_id !== null, (query) => query.where("personal_profile_id", "is", null))
    .executeTakeFirst();
  if (!file || file.status === "DELETED") throw DomainError.notFound();
  if (
    file.personal_profile_id !== job.personal_profile_id ||
    file.business_id !== job.business_id
  ) throw DomainError.validation();
  const candidateExpenseId = resolveCandidateExpenseId({
    targetAggregateId: job.target_aggregate_id,
    fileExpenseId: file.expense_id,
  });
  const candidate = await transaction
    .selectFrom("app.expenses")
    .selectAll()
    .where("id", "=", candidateExpenseId)
    .where("tenant_id", "=", job.tenant_id)
    .$if(job.personal_profile_id !== null, (query) =>
      query.where("personal_profile_id", "=", job.personal_profile_id),
    )
    .$if(job.business_id !== null, (query) =>
      query.where("business_id", "=", job.business_id),
    )
    .$if(job.personal_profile_id !== null, (query) => query.where("business_id", "is", null))
    .$if(job.business_id !== null, (query) => query.where("personal_profile_id", "is", null))
    .executeTakeFirst();
  if (!candidate || candidate.status === "archived") throw DomainError.notFound();
  if (
    candidate.personal_profile_id !== job.personal_profile_id ||
    candidate.business_id !== job.business_id
  ) throw DomainError.validation();
  return { file, candidate };
}

/**
 * Exported (Phase 3D-C Task 3) so domain/mailbox-ingestion.ts's atomic
 * materialization path can insert a duplicate-match row using the exact
 * same idempotent-insert-then-select shape as the legacy
 * recordEvidence flow, instead of re-implementing it.
 */
export async function addMatch(
  transaction: Transaction<AppDatabase>,
  input: {
    readonly tenantId: string;
    readonly scope: FileScope;
    readonly candidateExpenseId: string;
    readonly existingExpenseId: string;
    readonly matchType: "file_sha256" | "fingerprint" | "fuzzy_fields";
    readonly confidence: number;
    readonly evidence: Record<string, unknown>;
    readonly idempotencyKey: string;
  },
): Promise<string> {
  const values = {
    id: randomUUID(),
    tenant_id: input.tenantId,
    personal_profile_id: input.scope.kind === "personal" ? input.scope.profileId : null,
    business_id: input.scope.kind === "business" ? input.scope.businessId : null,
    existing_expense_id: input.existingExpenseId,
    candidate_expense_id: input.candidateExpenseId,
    match_type: input.matchType,
    confidence: input.confidence.toFixed(4),
    evidence: toJsonValue(input.evidence),
    status: "pending" as const,
    version: 1,
    resolved_by: null,
    resolved_at: null,
    resolution_idempotency_key: null,
    idempotency_key: input.idempotencyKey,
  };
  try {
    await transaction
      .insertInto("app.expense_duplicate_matches")
      .values(values)
      .onConflict((oc) => oc.columns(["tenant_id", "idempotency_key"]).doNothing())
      .execute();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const row = await transaction
    .selectFrom("app.expense_duplicate_matches")
    .select("id")
    .where("tenant_id", "=", input.tenantId)
    .where("candidate_expense_id", "=", input.candidateExpenseId)
    .where("existing_expense_id", "=", input.existingExpenseId)
    .where("match_type", "=", input.matchType)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (!row) throw DomainError.conflict();
  return row.id;
}

export function createDeduplicationDomain(
  database: Kysely<AppDatabase>,
): DeduplicationDomain {
  return {
    async recordEvidence(input) {
      const result = await executeIdempotentMutation(database, {
        actorKey: `service:${input.actorServicePrincipal}`,
        operationKey: "deduplication.evidence.record",
        idempotencyKey: input.request.idempotencyKey,
        requestHash: hashNormalizedRequest(input.request),
        statusCode: 200 as const,
        parseBody: (value) => value as { decision: "no_match" | "review"; matchIds: string[] },
        execute: async (transaction) => {
          const job = await requireJob(transaction, input.request);
          const scope: FileScope =
            job.personal_profile_id !== null
              ? { kind: "personal", profileId: job.personal_profile_id }
              : { kind: "business", businessId: job.business_id as string };
          const { file, candidate } = await findCandidate(transaction, job, input.request.sourceFileId);
          const fingerprint =
            input.request.merchant !== undefined &&
            input.request.amount !== undefined &&
            input.request.currency !== undefined &&
            input.request.incurredOn !== undefined
              ? buildDeduplicationFingerprint({
                  merchant: input.request.merchant,
                  amount: input.request.amount,
                  currency: input.request.currency,
                  incurredOn: input.request.incurredOn,
                })
              : null;
          const inboundEmailId =
            job.workflow_type === FORWARDED_RECEIPT_WORKFLOW_TYPE &&
            typeof job.input_params === "object" &&
            job.input_params !== null &&
            typeof (job.input_params as Record<string, unknown>).inboundEmailId === "string"
              ? (job.input_params as Record<string, string>).inboundEmailId
              : null;
          if (job.workflow_type === FORWARDED_RECEIPT_WORKFLOW_TYPE && !inboundEmailId) {
            throw DomainError.validation();
          }
          if (inboundEmailId) {
            const inboundEmail = await transaction
              .selectFrom("app.inbound_emails")
              .select(["id", "tenant_id", "personal_profile_id", "business_id"])
              .where("id", "=", inboundEmailId)
              .where("tenant_id", "=", job.tenant_id)
              .executeTakeFirst();
            if (
              !inboundEmail ||
              inboundEmail.personal_profile_id !== job.personal_profile_id ||
              inboundEmail.business_id !== job.business_id
            ) throw DomainError.validation();
          }

          await transaction
            .insertInto("app.expense_sources")
            .values({
              id: randomUUID(),
              tenant_id: job.tenant_id,
              personal_profile_id: job.personal_profile_id,
              business_id: job.business_id,
              expense_id: candidate.id,
              source_type: inboundEmailId ? "forwarded_email" : "manual_upload",
              source_file_id: file.id,
              inbound_email_id: inboundEmailId,
              metadata: toJsonValue(input.request.orderNumber ? { orderNumber: input.request.orderNumber } : {}),
            })
            .onConflict((oc) =>
              oc
                .columns(["tenant_id", "source_file_id"])
                .where("source_file_id", "is not", null)
                .doNothing(),
            )
            .execute();
          if (fingerprint) {
            await transaction
              .insertInto("app.expense_dedup_fingerprints")
              .values({
                id: randomUUID(),
                tenant_id: job.tenant_id,
                personal_profile_id: job.personal_profile_id,
                business_id: job.business_id,
                expense_id: candidate.id,
                fingerprint_version: fingerprint.version,
                normalized_merchant: fingerprint.normalizedMerchant,
                amount_minor_units: fingerprint.amountMinorUnits,
                currency: fingerprint.currency,
                incurred_on: new Date(`${fingerprint.incurredOn}T00:00:00.000Z`),
                fingerprint_hash: fingerprint.hash,
              })
              .onConflict((oc) => oc.columns(["expense_id", "fingerprint_version"]).doNothing())
              .execute();
          }

          const matchIds: string[] = [];
          let fileQuery = transaction
            .selectFrom("app.expense_files as file")
            .innerJoin("app.expenses as existing_expense", (join) =>
              join
                .onRef("existing_expense.id", "=", "file.expense_id")
                .onRef("existing_expense.tenant_id", "=", "file.tenant_id")
                .on("existing_expense.status", "<>", "archived"),
            )
            .select([
              "file.expense_id as expense_id",
              "file.sha256_hex as sha256_hex",
              "file.status as status",
              "file.personal_profile_id as personal_profile_id",
              "file.business_id as business_id",
            ])
            .where("file.tenant_id", "=", job.tenant_id)
            .where("file.sha256_hex", "=", file.sha256_hex)
            .where("file.status", "=", "READY")
            .where("file.expense_id", "is not", null);
          fileQuery = job.personal_profile_id !== null
            ? fileQuery
                .where("file.personal_profile_id", "=", job.personal_profile_id)
                .where("file.business_id", "is", null)
            : fileQuery
                .where("file.business_id", "=", job.business_id)
                .where("file.personal_profile_id", "is", null);
          const files = file.sha256_hex ? await fileQuery.execute() : [];
          const fingerprints = fingerprint
            ? await (job.personal_profile_id !== null
                ? transaction
                    .selectFrom("app.expense_dedup_fingerprints as fingerprint")
                    .innerJoin("app.expenses as existing_expense", (join) =>
                      join
                        .onRef("existing_expense.id", "=", "fingerprint.expense_id")
                        .onRef("existing_expense.tenant_id", "=", "fingerprint.tenant_id")
                        .on("existing_expense.status", "<>", "archived"),
                    )
                    .selectAll("fingerprint")
                    .where("fingerprint.tenant_id", "=", job.tenant_id)
                    .where("fingerprint.normalized_merchant", "=", fingerprint.normalizedMerchant)
                    .where("fingerprint.personal_profile_id", "=", job.personal_profile_id)
                    .where("fingerprint.business_id", "is", null)
                : transaction
                    .selectFrom("app.expense_dedup_fingerprints as fingerprint")
                    .innerJoin("app.expenses as existing_expense", (join) =>
                      join
                        .onRef("existing_expense.id", "=", "fingerprint.expense_id")
                        .onRef("existing_expense.tenant_id", "=", "fingerprint.tenant_id")
                        .on("existing_expense.status", "<>", "archived"),
                    )
                    .selectAll("fingerprint")
                    .where("fingerprint.tenant_id", "=", job.tenant_id)
                    .where("fingerprint.normalized_merchant", "=", fingerprint.normalizedMerchant)
                    .where("fingerprint.business_id", "=", job.business_id)
                    .where("fingerprint.personal_profile_id", "is", null)
              ).execute()
            : [];
          const candidates = findDeterministicCandidates({
            scope,
            candidateExpenseId: candidate.id,
            file: {
              expenseId: file.expense_id,
              sha256Hex: file.sha256_hex,
              status: file.status,
              personalProfileId: file.personal_profile_id,
              businessId: file.business_id,
            },
            fingerprint,
            files: files.map((row) => ({
              expenseId: row.expense_id,
              sha256Hex: row.sha256_hex,
              status: row.status,
              personalProfileId: row.personal_profile_id,
              businessId: row.business_id,
            })),
            fingerprints: fingerprints.map((row) => ({
              expenseId: row.expense_id,
              fingerprintHash: row.fingerprint_hash,
              normalizedMerchant: row.normalized_merchant,
              amountMinorUnits: Number(row.amount_minor_units),
              currency: row.currency,
              incurredOn: row.incurred_on,
              personalProfileId: row.personal_profile_id,
              businessId: row.business_id,
            })),
          });
          for (const match of candidates) {
            matchIds.push(await addMatch(transaction, {
              tenantId: job.tenant_id,
              scope,
              candidateExpenseId: candidate.id,
              existingExpenseId: match.existingExpenseId,
              matchType: match.matchType,
              confidence: match.confidence,
              evidence: match.evidence,
              idempotencyKey: buildMatchIdempotencyKey(
                input.request.idempotencyKey,
                match.matchType,
                match.existingExpenseId,
              ),
            }));
          }
          await transaction
            .updateTable("app.processing_jobs")
            .set({ updated_at: new Date() })
            .where("id", "=", job.id)
            .execute();
          await recordAuditEvent(transaction, {
            tenantId: job.tenant_id,
            actorServicePrincipal: input.actorServicePrincipal,
            action: "deduplication.evidence_recorded",
            outcome: "success",
            resourceType: "processing_job",
            resourceId: job.id,
            requestId: input.requestId,
            metadata: { matchCount: matchIds.length },
          });
          return { decision: matchIds.length > 0 ? "review" as const : "no_match" as const, matchIds };
        },
      });
      return result.body;
    },

    async listMatches(input) {
      await requireScopeRole(database, input);
      const cursor = input.cursor ? decodeMatchCursor(input.cursor) : null;
      let query = database
        .selectFrom("app.expense_duplicate_matches")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("status", "=", input.status ?? "pending");
      query = input.scope.kind === "personal"
        ? query.where("personal_profile_id", "=", input.scope.profileId).where("business_id", "is", null)
        : query.where("business_id", "=", input.scope.businessId).where("personal_profile_id", "is", null);
      if (cursor) {
        query = query.where((eb) => eb.or([
          eb("created_at", "<", cursor.createdAt),
          eb.and([eb("created_at", "=", cursor.createdAt), eb("id", "<", cursor.id)]),
        ]));
      }
      const rows = await query
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit((input.limit ?? 50) + 1)
        .execute();
      const items = rows.slice(0, input.limit ?? 50);
      const last = items.at(-1);
      return {
        items: items.map(toDuplicateMatch),
        nextCursor: rows.length > (input.limit ?? 50) && last
          ? encodeMatchCursor(last.created_at, last.id)
          : null,
      };
    },

    async resolveMatch(input) {
      const role = await requireScopeRole(database, input);
      if (role !== "owner" && role !== "editor") throw DomainError.forbidden();
      const result = await executeIdempotentMutation(database, {
        actorKey: `user:${input.actorUserId}`,
        operationKey: "deduplication.match.resolve",
        idempotencyKey: input.idempotencyKey,
        requestHash: hashNormalizedRequest({
          tenantId: input.tenantId,
          scope: input.scope,
          matchId: input.matchId,
          action: input.action,
          expectedMatchVersion: input.expectedMatchVersion,
        }),
        statusCode: 200 as const,
        parseBody: (value) => DuplicateResolutionResponseSchema.parse(value),
        execute: async (transaction) => {
          const match = await loadScopedMatch(transaction, input);
          const expenses = await lockResolutionExpenses(transaction, {
            tenantId: input.tenantId,
            scope: input.scope,
          }, [match.existing_expense_id, match.candidate_expense_id]);
          if (input.action === "merge") {
            await mergeCandidate(transaction, {
              tenantId: input.tenantId,
              existing: expenses.existing,
              candidate: expenses.candidate,
            });
          } else if (input.action === "discard_new") {
            const archived = await transaction
              .updateTable("app.expenses")
              .set({
                status: "archived",
                archived_at: new Date(),
                updated_at: new Date(),
                version: sql<number>`version + 1`,
              })
              .where("id", "=", match.candidate_expense_id)
              .where("status", "!=", "archived")
              .executeTakeFirst();
            if (archived.numUpdatedRows !== 1n) throw DomainError.conflict();
          }
          const now = new Date();
          const updated = await transaction
            .updateTable("app.expense_duplicate_matches")
            .set({
              status: resolvedStatus(input.action),
              version: sql<number>`version + 1`,
              resolved_by: input.actorUserId,
              resolved_at: now,
              resolution_idempotency_key: input.idempotencyKey,
            })
            .where("id", "=", match.id)
            .where("tenant_id", "=", input.tenantId)
            .where("status", "=", "pending")
            .where("version", "=", input.expectedMatchVersion)
            .returning(["id", "version"])
            .executeTakeFirst();
          if (!updated) throw DomainError.conflict();
          const response = {
            matchId: updated.id,
            action: input.action,
            status: resolvedStatus(input.action),
            version: updated.version,
            idempotencyKey: input.idempotencyKey,
          } satisfies DuplicateResolutionResponse;
          await recordAuditEvent(transaction, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            action: `deduplication.match_${input.action}`,
            outcome: "success",
            resourceType: "expense_duplicate_match",
            resourceId: match.id,
            requestId: input.requestId,
            metadata: { action: input.action, status: response.status },
          });
          return response;
        },
      });
      return result.body;
    },
  };
}
