/**
 * Task 6 — App API enrichment domain (Fix Round 1).
 *
 * Implements:
 * - buildEnrichmentInput: bounded projection for the AI worker
 * - applyEnrichmentResult: one atomic transaction — lock job, check permanent
 *   result key, validate/recompute, apply, insert result op key, mark SUCCEEDED
 *
 * Security boundaries (unchanged):
 * - No tenantId, profileId, businessId, selectors, raw receipt text,
 *   amount, tax treatment, review status, or deductible percentage in worker input.
 * - Worker cannot redirect scope; all scope/tenant resolution from job row.
 * - All candidate eligibility enforced server-side; server recomputes rule tags.
 *
 * Fix Round 1 changes vs original:
 * - F1/F2: operation kind 'result' for job-level permanent key (no tag-placeholder).
 * - F1/F3/F4: single unified atomic transaction for submitEnrichmentResult/applied;
 *   permanent result key checked+inserted inside the job-locked transaction;
 *   removed checkPermanentReplay export, sentinel pattern, and post-commit recording.
 * - F5: 24-month history cutoff uses direct date arithmetic (no setMonth overflow);
 *   queries expenses.incurred_on directly with incurred_on < current AND >= cutoff.
 * - F6: spending-category history from latest qualifying append-only decision per
 *   historical expense (source manual/manual_baseline/historical), not expenses col.
 * - F7: tax history requires reviewed treatment, non-null updated_by_user_id,
 *   same active profile/taxonomy/year, active category, ready non-archived expense.
 * - F8: normalizedMerchant is the raw slug from normalizeMerchant() with spaces;
 *   merchantTagKey() wraps it verbatim (no space→hyphen on server side).
 * - F10: expense_tag update increments version (sql`version + 1`).
 * - F11: all op key rows inserted inside the single application transaction.
 * - F13: exactly one audit event per result submission with actor+outcome metadata.
 * - F14: job update includes expected version predicate while row lock held.
 * - F15: removed resolveSuggestion/rerunEnrichment stubs (Task 8 owns them).
 * - F17: named HISTORY_MAX_EXPENSES/HISTORY_MAX_CANDIDATE_TAG_KEYS/
 *   HISTORY_MAX_CANDIDATE_CATEGORY_IDS constants; removed dead evidence variable.
 */

import { randomUUID, createHash } from "node:crypto";

import {
  EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION,
  EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
  ExpenseEnrichmentResultV1Schema,
  type ExpenseEnrichmentInputResponseV1,
  type ExpenseEnrichmentInputV1,
  type ProcessingJob,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { AppDatabase, JsonValue } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import { normalizeMerchant } from "./deduplication.js";
import {
  hashNormalizedRequest,
  toJsonValue,
  type MutationResult,
} from "./idempotency.js";
import { toProcessingJob, type ProcessingJobRow } from "./processing-job-view.js";

// ------------------------------------------------------------------ //
// Constants
// ------------------------------------------------------------------ //

const ENRICHMENT_RULES_VERSION = 1;

/** Maximum prior expenses to include in history training. */
const HISTORY_MAX_EXPENSES = 50;

/** Maximum tag candidate entries returned in history. */
const HISTORY_MAX_CANDIDATE_TAG_KEYS = 20;

/** Maximum category/tax candidate entries returned in history. */
const HISTORY_MAX_CANDIDATE_CATEGORY_IDS = 10;

// ------------------------------------------------------------------ //
// Helpers
// ------------------------------------------------------------------ //

/** Canonical SHA-256 (lowercase hex, 64 chars). */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Canonical JSON (sorted keys, no whitespace). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Tag key for the merchant rule.
 *
 * F8: normalizedMerchant field in the worker input is the final stable slug
 * with spaces replaced by hyphens (required: tag key constraint allows only
 * [a-z0-9_:.-]+, no spaces). The worker uses `f"merchant:{inp.normalizedMerchant}"`.
 * Server passes the same slug and produces the same key — no second transformation
 * at recomputation time (the slug is already the slugified form).
 *
 * Slug derivation: normalizeMerchant() → lowercase, punctuation removed, spaces normalized
 *   → replace spaces with hyphens (stable URL-safe slug).
 */
function merchantTagKey(normalizedMerchant: string): string {
  // normalizedMerchant is already the hyphenated slug
  return `merchant:${normalizedMerchant}`;
}

/**
 * Produce the stable merchant slug for the worker input's normalizedMerchant field.
 * Converts spaces to hyphens so the slug is URL-safe and satisfies the tag key
 * constraint ([a-z0-9_:.-]+). The raw normalizedMerchant from normalizeMerchant()
 * may have spaces; this converts to the wire format the worker receives.
 */
function toMerchantSlug(rawNormalizedMerchant: string): string {
  return rawNormalizedMerchant.replace(/\s+/g, "-");
}

/**
 * Incurred-on day-of-week for weekend rule.
 * Returns true for Saturday or Sunday (ISO: 6=Sat, 0=Sun in getDay()).
 */
function isWeekend(dateStr: string): boolean {
  const [year, month, day] = dateStr.split("-").map(Number) as [number, number, number];
  // Use local noon to avoid UTC midnight roll-overs on server
  const d = new Date(year, month - 1, day, 12, 0, 0);
  const dow = d.getDay(); // 0=Sun, 6=Sat
  return dow === 0 || dow === 6;
}

/**
 * Compute server-side deterministic rule tag keys for an expense.
 * Must exactly mirror services/ai-worker/src/ai_worker/enrichment.py evaluate().
 *
 * Rules (applied in order, each independently gated on eligibility):
 * 1. merchant:<normalizedMerchant>  — if normalizedMerchant non-null and key eligible
 * 2. timing:weekend                 — if incurredOn is Sat/Sun and key eligible
 * 3. category:<spendingCategoryId>  — if spendingCategoryId non-null and key eligible
 */
function computeRuleTagKeys(input: {
  readonly normalizedMerchant: string | null;
  readonly incurredOn: string;
  readonly spendingCategoryId: string | null;
  readonly eligibleTagKeys: readonly string[];
}): string[] {
  const result: string[] = [];

  if (input.normalizedMerchant) {
    const key = merchantTagKey(input.normalizedMerchant);
    if (input.eligibleTagKeys.includes(key)) result.push(key);
  }

  if (isWeekend(input.incurredOn)) {
    const weekendKey = "timing:weekend";
    if (input.eligibleTagKeys.includes(weekendKey)) result.push(weekendKey);
  }

  if (input.spendingCategoryId) {
    const catKey = `category:${input.spendingCategoryId}`;
    if (input.eligibleTagKeys.includes(catKey)) result.push(catKey);
  }

  return result;
}

/**
 * Convert a DB incurred_on (Date | string) to "YYYY-MM-DD".
 */
export function toDateStr(raw: Date | string | null): string {
  if (raw instanceof Date) {
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, "0");
    const d = String(raw.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(raw ?? "");
}

/**
 * Compute the 24-month cutoff date string (YYYY-MM-DD).
 *
 * Subtracts exactly 2 years from the given date, then clamps the day to the last
 * valid day in the resulting year/month so leap-year boundaries are handled correctly.
 *
 * Examples:
 *   2026-09-15 → 2024-09-15  (same day, same month)
 *   2028-02-29 → 2026-02-28  (2026 is not a leap year → clamp to Feb 28)
 *   2026-03-31 → 2024-03-31  (2024 has 31 days in March)
 *
 * Exported for unit testing.
 */
export function twentyFourMonthCutoff(fromDateStr: string): string {
  const [y, m, d] = fromDateStr.split("-").map(Number) as [number, number, number];
  const cutoffYear = y - 2;
  const cutoffMonth = m; // 1-based, unchanged
  // Clamp day to last valid day in cutoffYear/cutoffMonth.
  // new Date(year, month, 0) returns the last day of month-1, i.e. last day of cutoffMonth.
  const lastDay = new Date(cutoffYear, cutoffMonth, 0).getDate();
  const cutoffDay = Math.min(d, lastDay);
  return `${cutoffYear}-${String(cutoffMonth).padStart(2, "0")}-${String(cutoffDay).padStart(2, "0")}`;
}

// ------------------------------------------------------------------ //
// buildEnrichmentInput — bounded projection
// ------------------------------------------------------------------ //

/**
 * Build the full worker input for the given enrichment job.
 *
 * Called from the getEnrichmentInput route handler.
 * Runs in its own transaction; writes exactly one audit event.
 *
 * F5: History cutoff is `incurred_on >= cutoff AND incurred_on < currentIncurredOn`
 *     computed via direct year arithmetic (no setMonth overflow).
 * F6: Spending-category candidates from latest qualifying decision (source
 *     manual/manual_baseline/historical) per historical expense.
 * F7: Tax candidates from reviewed treatments on ready non-archived expenses,
 *     same active profile/taxonomy/year, active tax category.
 * F8: normalizedMerchant is the raw slug (spaces kept) passed verbatim to worker.
 */
export async function buildEnrichmentInput(
  database: Kysely<AppDatabase>,
  jobId: string,
  actorServicePrincipal: string,
  requestId: string,
): Promise<ExpenseEnrichmentInputResponseV1> {
  return database.transaction().execute(async (transaction) => {
    // ---- Validate job ----
    const job = await transaction
      .selectFrom("app.processing_jobs")
      .selectAll()
      .where("id", "=", jobId)
      .executeTakeFirst();

    if (!job || job.workflow_type !== EXPENSE_ENRICHMENT_WORKFLOW_TYPE) {
      throw DomainError.notFound();
    }
    if (job.allowed_result_schema_version !== EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION) {
      throw DomainError.notFound();
    }
    if (job.status !== "RUNNING") throw DomainError.conflict();
    if (!job.target_aggregate_id || job.target_aggregate_type !== "expense") {
      throw DomainError.validation();
    }

    const expenseId = job.target_aggregate_id;
    const tenantId = job.tenant_id;

    // ---- Validate expense ----
    const expense = await transaction
      .selectFrom("app.expenses")
      .selectAll()
      .where("id", "=", expenseId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();

    let outcome: "evaluate" | "stale" | "skipped";
    if (!expense || expense.status === "archived") {
      outcome = "skipped";
    } else if (
      job.expected_aggregate_version !== null &&
      expense.version !== job.expected_aggregate_version
    ) {
      outcome = "stale";
    } else {
      outcome = "evaluate";
    }

    // ---- Audit (exactly one event, I8/F13) ----
    await recordAuditEvent(transaction, {
      tenantId,
      actorServicePrincipal,
      action: "processing_job.enrichment_input_read",
      outcome: "success",
      resourceType: "processing_job",
      resourceId: jobId,
      requestId,
      metadata: { inputOutcome: outcome },
    });

    if (outcome === "skipped") return { outcome: "skipped" as const };
    if (outcome === "stale") return { outcome: "stale" as const };

    // outcome === "evaluate" — build full input
    const isPersonal = expense!.personal_profile_id !== null;
    const scopeProfileId = expense!.personal_profile_id;
    const scopeBusinessId = expense!.business_id;

    // F8: normalizedMerchant = stable slug for the worker (hyphens, not spaces).
    // normalizeMerchant() produces lowercase with spaces; toMerchantSlug() converts
    // to hyphens so it satisfies tag key constraint and matches worker key derivation.
    const rawMerchant = expense!.merchant?.trim() ?? "";
    const rawNormalized = rawMerchant ? (normalizeMerchant(rawMerchant) || null) : null;
    const normalizedMerchant = rawNormalized ? toMerchantSlug(rawNormalized) : null;

    const incurredOn = toDateStr(expense!.incurred_on as Date | string | null);

    // ---- Eligible tag keys (absent-or-active; never archived) ----
    const candidateTagKeys: string[] = [];
    if (normalizedMerchant) candidateTagKeys.push(merchantTagKey(normalizedMerchant));
    candidateTagKeys.push("timing:weekend");
    if (expense!.spending_category_id) {
      candidateTagKeys.push(`category:${expense!.spending_category_id}`);
    }

    const archivedTagKeys =
      candidateTagKeys.length > 0
        ? new Set(
            (await transaction
              .selectFrom("app.tags")
              .select("key")
              .where("tenant_id", "=", tenantId)
              .where("key", "in", candidateTagKeys)
              .where("status", "=", "archived")
              .execute()
            ).map((r) => r.key),
          )
        : new Set<string>();

    const eligibleTagKeys = candidateTagKeys
      .filter((k) => !archivedTagKeys.has(k))
      .sort();

    // ---- Eligible spending category IDs ----
    const eligibleSpendingCategoryIds = (
      await transaction
        .selectFrom("app.spending_categories")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "active")
        .execute()
    )
      .map((r) => r.id)
      .sort();

    // ---- Eligible tax snapshot (Business only) ----
    let eligibleTaxSnapshot: ExpenseEnrichmentInputV1["eligibleTaxSnapshot"] = null;

    if (!isPersonal && scopeBusinessId) {
      const taxProfile = await transaction
        .selectFrom("app.business_tax_profiles as btp")
        .select(["btp.id", "btp.version", "btp.taxonomy_version_id", "btp.tax_year"])
        .where("btp.tenant_id", "=", tenantId)
        .where("btp.business_id", "=", scopeBusinessId)
        .where("btp.tax_year", "=", expense!.tax_year)
        .where("btp.status", "=", "active")
        .limit(1)
        .executeTakeFirst();

      if (taxProfile) {
        const activeTaxCatIds = (
          await transaction
            .selectFrom("app.tax_category_definitions")
            .select("id")
            .where("taxonomy_version_id", "=", taxProfile.taxonomy_version_id)
            .where("status", "=", "active")
            .execute()
        )
          .map((r) => r.id)
          .sort();

        eligibleTaxSnapshot = {
          businessTaxProfileId: taxProfile.id,
          businessTaxProfileVersion: Number(taxProfile.version),
          taxonomyVersionId: taxProfile.taxonomy_version_id,
          taxYear: taxProfile.tax_year,
          activeTaxCategoryIds: activeTaxCatIds,
        };
      }
    }

    // ---- History (F5, F6, F7) ----
    // Cutoff: 24 months before current expense's incurred_on, no overflow.
    // Window: incurred_on >= cutoff AND incurred_on < currentIncurredOn.
    const cutoffDateStr = twentyFourMonthCutoff(incurredOn);

    const emptyHistory: ExpenseEnrichmentInputV1["history"] = {
      exampleCount: 0,
      candidateTagKeys: [],
      candidateSpendingCategoryIds: [],
      candidateTaxCategoryIds: [],
    };

    // rawNormalized is the dedup fingerprint value (spaces); normalizedMerchant is the slug (hyphens)
    const fingerprintMerchant = rawNormalized; // matches expense_dedup_fingerprints.normalized_merchant

    // Merchant is required for meaningful history
    if (!normalizedMerchant) {
      const evalInput: ExpenseEnrichmentInputV1 = {
        schemaVersion: 1, jobId, expenseId, expenseVersion: expense!.version,
        normalizedMerchant: null, incurredOn,
        spendingCategoryId: expense!.spending_category_id,
        rulesVersion: ENRICHMENT_RULES_VERSION,
        eligibleTagKeys, eligibleSpendingCategoryIds, eligibleTaxSnapshot,
        history: emptyHistory,
      };
      return { outcome: "evaluate" as const, input: evalInput };
    }

    // F5: Find same-merchant historical expenses via dedup fingerprints table,
    // date-filtered directly on the fingerprints.incurred_on column.
    // Then cross-check readiness on the expense itself.
    let historicalExpensesQuery = transaction
      .selectFrom("app.expenses as e")
      .select(["e.id"])
      .where("e.tenant_id", "=", tenantId)
      .where("e.status", "!=", "archived")
      .where("e.id", "!=", expenseId);

    if (isPersonal && scopeProfileId) {
      historicalExpensesQuery = historicalExpensesQuery.where(
        "e.personal_profile_id", "=", scopeProfileId,
      );
    } else if (!isPersonal && scopeBusinessId) {
      historicalExpensesQuery = historicalExpensesQuery.where(
        "e.business_id", "=", scopeBusinessId,
      );
    }

    // F5: date bounds on expenses.incurred_on directly (not via fingerprints date)
    // incurred_on >= cutoff AND incurred_on < currentExpense.incurredOn
    historicalExpensesQuery = historicalExpensesQuery
      .where("e.incurred_on", ">=", new Date(`${cutoffDateStr}T12:00:00.000Z`))
      .where("e.incurred_on", "<", new Date(`${incurredOn}T12:00:00.000Z`));

    // Filter by same normalized merchant via fingerprint join
    const fpQuery = transaction
      .selectFrom("app.expense_dedup_fingerprints as fp")
      .select("fp.expense_id")
      .where("fp.tenant_id", "=", tenantId)
      .where("fp.normalized_merchant", "=", fingerprintMerchant ?? normalizedMerchant);

    const fpRows = await fpQuery.execute();
    const fpIdSet = new Set(fpRows.map((r) => r.expense_id));

    if (fpIdSet.size === 0) {
      const evalInput: ExpenseEnrichmentInputV1 = {
        schemaVersion: 1, jobId, expenseId, expenseVersion: expense!.version,
        normalizedMerchant, incurredOn,
        spendingCategoryId: expense!.spending_category_id,
        rulesVersion: ENRICHMENT_RULES_VERSION,
        eligibleTagKeys, eligibleSpendingCategoryIds, eligibleTaxSnapshot,
        history: emptyHistory,
      };
      return { outcome: "evaluate" as const, input: evalInput };
    }

    historicalExpensesQuery = historicalExpensesQuery.where(
      "e.id", "in", [...fpIdSet],
    );

    const historicalExpenses = await historicalExpensesQuery
      .orderBy("e.incurred_on", "desc")
      .limit(HISTORY_MAX_EXPENSES)
      .execute();

    const exampleCount = historicalExpenses.length;

    if (exampleCount === 0) {
      const evalInput: ExpenseEnrichmentInputV1 = {
        schemaVersion: 1, jobId, expenseId, expenseVersion: expense!.version,
        normalizedMerchant, incurredOn,
        spendingCategoryId: expense!.spending_category_id,
        rulesVersion: ENRICHMENT_RULES_VERSION,
        eligibleTagKeys, eligibleSpendingCategoryIds, eligibleTaxSnapshot,
        history: emptyHistory,
      };
      return { outcome: "evaluate" as const, input: evalInput };
    }

    const historicalIds = historicalExpenses.map((e) => e.id);

    // ---- Candidate tag keys (active manual/accepted-historical tags) ----
    const candidateTagKeyMap = new Map<string, number>();
    {
      const tagRows = await transaction
        .selectFrom("app.expense_tags as et")
        .innerJoin("app.tags as t", (join) =>
          join.onRef("t.id", "=", "et.tag_id").on("t.status", "=", "active"),
        )
        .select(["t.key", "et.expense_id"])
        .where("et.expense_id", "in", historicalIds)
        .where("et.status", "=", "active")
        .where("et.source", "in", ["manual", "historical"])
        .execute();

      const tagsByExpense = new Map<string, Set<string>>();
      for (const row of tagRows) {
        if (!tagsByExpense.has(row.expense_id)) tagsByExpense.set(row.expense_id, new Set());
        tagsByExpense.get(row.expense_id)!.add(row.key);
      }
      for (const [, keys] of tagsByExpense) {
        for (const key of keys) {
          candidateTagKeyMap.set(key, (candidateTagKeyMap.get(key) ?? 0) + 1);
        }
      }
    }

    const candidateTagKeysList = [...candidateTagKeyMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, HISTORY_MAX_CANDIDATE_TAG_KEYS)
      .map(([key, count]) => ({ key, count }));

    // ---- Candidate spending category IDs (F6: from latest qualifying decision) ----
    // For each historical expense, find the latest manual/manual_baseline/historical decision.
    const candidateCatMap = new Map<string, number>();
    if (historicalIds.length > 0) {
      // Find latest qualifying decision per historical expense.
      // "Latest" = highest expense_version (append-only decisions always bump expense_version),
      // with created_at as tiebreaker when version is the same (edge case: same-version rows
      // from legacy baseline inserts).
      const decisionRows = await transaction
        .selectFrom("app.expense_spending_category_decisions as d")
        .select(["d.expense_id", "d.new_spending_category_id", "d.expense_version"])
        .where("d.expense_id", "in", historicalIds)
        .where("d.source", "in", ["manual", "manual_baseline", "historical"])
        .where("d.new_spending_category_id", "is not", null)
        .orderBy("d.expense_id")
        .orderBy("d.expense_version", "desc")
        .orderBy("d.created_at", "desc")
        .execute();

      // Take the first (latest) decision per expense
      const seenExpenses = new Set<string>();
      for (const row of decisionRows) {
        if (seenExpenses.has(row.expense_id)) continue;
        seenExpenses.add(row.expense_id);
        const catId = row.new_spending_category_id;
        if (catId) {
          candidateCatMap.set(catId, (candidateCatMap.get(catId) ?? 0) + 1);
        }
      }
    }

    const candidateSpendingCategoryIds = [...candidateCatMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, HISTORY_MAX_CANDIDATE_CATEGORY_IDS)
      .map(([id, count]) => ({ id, count }));

    // ---- Candidate tax category IDs (F7: reviewed treatments) ----
    // Requirements: reviewed treatment, non-null updated_by_user_id (already schema-required),
    // same active profile, current taxonomy version, current tax year, active category,
    // ready/non-archived same-scope expense.
    const candidateTaxCatMap = new Map<string, number>();
    if (!isPersonal && scopeBusinessId && eligibleTaxSnapshot && historicalIds.length > 0) {
      const taxRows = await transaction
        .selectFrom("app.expense_tax_treatments as ett")
        .innerJoin("app.expenses as e2", (join) =>
          join
            .onRef("e2.id", "=", "ett.expense_id")
            .on("e2.status", "!=", "archived"),
        )
        .innerJoin("app.tax_category_definitions as tcd", (join) =>
          join
            .onRef("tcd.id", "=", "ett.tax_category_definition_id")
            .on("tcd.status", "=", "active"),
        )
        .select(["ett.tax_category_definition_id", "ett.expense_id"])
        .where("ett.expense_id", "in", historicalIds)
        .where("ett.tenant_id", "=", tenantId)
        .where("ett.business_id", "=", scopeBusinessId)
        .where("ett.business_tax_profile_id", "=", eligibleTaxSnapshot.businessTaxProfileId)
        .where("ett.taxonomy_version_id", "=", eligibleTaxSnapshot.taxonomyVersionId)
        .where("ett.tax_year", "=", eligibleTaxSnapshot.taxYear)
        .where("ett.review_status", "=", "reviewed")
        .execute();

      for (const row of taxRows) {
        candidateTaxCatMap.set(
          row.tax_category_definition_id,
          (candidateTaxCatMap.get(row.tax_category_definition_id) ?? 0) + 1,
        );
      }
    }

    const candidateTaxCategoryIds = [...candidateTaxCatMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, HISTORY_MAX_CANDIDATE_CATEGORY_IDS)
      .map(([id, count]) => ({ id, count }));

    const history: ExpenseEnrichmentInputV1["history"] = {
      exampleCount,
      candidateTagKeys: candidateTagKeysList,
      candidateSpendingCategoryIds,
      candidateTaxCategoryIds,
    };

    const evalInput: ExpenseEnrichmentInputV1 = {
      schemaVersion: 1,
      jobId,
      expenseId,
      expenseVersion: expense!.version,
      normalizedMerchant,
      incurredOn,
      spendingCategoryId: expense!.spending_category_id,
      rulesVersion: ENRICHMENT_RULES_VERSION,
      eligibleTagKeys,
      eligibleSpendingCategoryIds,
      eligibleTaxSnapshot,
      history,
    };

    return { outcome: "evaluate" as const, input: evalInput };
  });
}

// ------------------------------------------------------------------ //
// applyEnrichmentResult — single unified atomic transaction
// ------------------------------------------------------------------ //

export interface ApplyEnrichmentResultInput {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly expectedJobVersion: number;
  readonly result: unknown;
  readonly actorServicePrincipal: string;
  readonly requestId: string;
}

/**
 * Process an enrichment result atomically (F1/F3):
 *
 * 1. Lock job (FOR UPDATE with version predicate on update, F14).
 * 2. Check permanent result operation key BEFORE status rejection (F3 replay-safe).
 *    Same payload → replay; changed payload → permanent CONFLICT.
 * 3. Verify RUNNING status, parse canonical result.
 * 4. Lock expense; handle stale/skipped as no-mutation completions.
 * 5. For applied: server-recompute rule tags; reject mismatch (CONFLICT).
 * 6. Create/reuse tenant-level rule tags; upsert expense_tag with version
 *    increment (F10); skip manual/removed decisions.
 * 7. Insert pending historical suggestions (ineligible skip).
 * 8. Insert per-tag and per-suggestion operation keys (all inside transaction, F11).
 * 9. Insert job-level 'result' operation key (F1/F2: kind='result', null candidate).
 * 10. Mark job SUCCEEDED with version predicate (F14).
 * 11. Write one audit event with actor and outcome (F13).
 */
export async function applyEnrichmentResult(
  database: Kysely<AppDatabase>,
  input: ApplyEnrichmentResultInput,
): Promise<MutationResult<ProcessingJob, 200>> {
  const payloadHash = hashNormalizedRequest({ jobId: input.jobId, result: input.result });
  const resultOpKey = `result:${input.jobId}:${input.idempotencyKey}`;

  return database.transaction().execute(async (transaction) => {
    // ---- Lock job ----
    const job = await transaction
      .selectFrom("app.processing_jobs")
      .selectAll()
      .where("id", "=", input.jobId)
      .forUpdate()
      .executeTakeFirst();

    if (!job || job.workflow_type !== EXPENSE_ENRICHMENT_WORKFLOW_TYPE) {
      throw DomainError.notFound();
    }
    if (job.allowed_result_schema_version !== EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION) {
      throw DomainError.notFound();
    }
    // Require non-null expense target before any replay/mutation so malformed
    // enrichment jobs cannot create result keys or complete (Fix 2).
    if (!job.target_aggregate_id || job.target_aggregate_type !== "expense") {
      throw DomainError.validation();
    }

    // ---- F3: Check permanent result operation key BEFORE status rejection ----
    // This ensures replay after generic idempotency expiry works even for a
    // job that is now SUCCEEDED.
    const existingResultKey = await transaction
      .selectFrom("app.enrichment_operation_keys")
      .select(["payload_hash", "response_json"])
      .where("tenant_id", "=", job.tenant_id)
      .where("operation_key", "=", resultOpKey)
      .forUpdate()
      .executeTakeFirst();

    if (existingResultKey) {
      if (existingResultKey.payload_hash !== payloadHash) throw DomainError.conflict();
      // Identical replay
      const stored = existingResultKey.response_json as Record<string, unknown>;
      return {
        statusCode: 200,
        body: stored as ProcessingJob,
        replayed: true,
      };
    }

    // ---- Validate job state ----
    if (job.version !== input.expectedJobVersion) throw DomainError.preconditionFailed();
    if (job.status !== "RUNNING") throw DomainError.conflict();

    // ---- Parse canonical result ----
    const parsed = ExpenseEnrichmentResultV1Schema.safeParse(input.result);
    if (!parsed.success) throw DomainError.validation();
    const resultData = parsed.data;
    const outcome = resultData.outcome;

    // ---- Load and lock expense ----
    // target_aggregate_id is already validated non-null above.
    const expenseId = job.target_aggregate_id!;

    const expense = await transaction
      .selectFrom("app.expenses")
      .selectAll()
      .where("id", "=", expenseId)
      .where("tenant_id", "=", job.tenant_id)
      .forUpdate()
      .executeTakeFirst();

    const tenantId = job.tenant_id;
    const now = new Date();

    // ---- Stale/skipped: no-mutation completion ----
    if (!expense || expense.status === "archived") {
      return _completeAndRecordResult(
        transaction, job, input, "skipped", now, resultOpKey, payloadHash,
      );
    }
    if (
      job.expected_aggregate_version !== null &&
      expense.version !== job.expected_aggregate_version
    ) {
      return _completeAndRecordResult(
        transaction, job, input, "stale", now, resultOpKey, payloadHash,
      );
    }
    if (outcome === "stale" || outcome === "skipped") {
      return _completeAndRecordResult(
        transaction, job, input, outcome, now, resultOpKey, payloadHash,
      );
    }

    // ---- outcome: applied ----
    const isPersonal = expense.personal_profile_id !== null;
    const scopeProfileId = expense.personal_profile_id;
    const scopeBusinessId = expense.business_id;

    // F8: same merchantTagKey logic as projection — slug with hyphens (not spaces)
    const rawMerchant = expense.merchant?.trim() ?? "";
    const rawNormalizedMerchant = rawMerchant ? (normalizeMerchant(rawMerchant) || null) : null;
    const normalizedMerchant = rawNormalizedMerchant ? toMerchantSlug(rawNormalizedMerchant) : null;
    const incurredOn = toDateStr(expense.incurred_on as Date | string | null);

    // Build candidate tag keys and eligibility (absent-or-active; never archived)
    const candidateTagKeysList: string[] = [];
    if (normalizedMerchant) candidateTagKeysList.push(merchantTagKey(normalizedMerchant));
    candidateTagKeysList.push("timing:weekend");
    if (expense.spending_category_id) {
      candidateTagKeysList.push(`category:${expense.spending_category_id}`);
    }

    const archivedTagKeys =
      candidateTagKeysList.length > 0
        ? new Set(
            (await transaction
              .selectFrom("app.tags")
              .select("key")
              .where("tenant_id", "=", tenantId)
              .where("key", "in", candidateTagKeysList)
              .where("status", "=", "archived")
              .execute()
            ).map((r) => r.key),
          )
        : new Set<string>();

    const eligibleTagKeys = candidateTagKeysList
      .filter((k) => !archivedTagKeys.has(k))
      .sort();

    // Server recomputes deterministic rule tags and validates against worker's list
    const serverRuleTagKeys = computeRuleTagKeys({
      normalizedMerchant,
      incurredOn,
      spendingCategoryId: expense.spending_category_id,
      eligibleTagKeys,
    }).sort();

    const workerRuleTagKeys = [...resultData.ruleTagKeys].sort();
    if (
      serverRuleTagKeys.length !== workerRuleTagKeys.length ||
      serverRuleTagKeys.some((k, i) => k !== workerRuleTagKeys[i])
    ) {
      throw DomainError.conflict();
    }

    // ---- Validate suggestion eligibility ----
    const eligibleCatIds = new Set(
      (await transaction
        .selectFrom("app.spending_categories")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "active")
        .forShare()
        .execute()
      ).map((r) => r.id),
    );

    let activeTaxProfileId: string | null = null;
    let activeTaxProfileVersion: number | null = null;
    let activeTaxonomyVersionId: string | null = null;
    let activeTaxYear: number | null = null;
    let activeTaxCatIdSet = new Set<string>();

    if (!isPersonal && scopeBusinessId) {
      const taxProfile = await transaction
        .selectFrom("app.business_tax_profiles as btp")
        .select(["btp.id", "btp.version", "btp.taxonomy_version_id", "btp.tax_year"])
        .where("btp.tenant_id", "=", tenantId)
        .where("btp.business_id", "=", scopeBusinessId)
        .where("btp.tax_year", "=", expense.tax_year)
        .where("btp.status", "=", "active")
        .forShare()
        .limit(1)
        .executeTakeFirst();

      if (taxProfile) {
        activeTaxProfileId = taxProfile.id;
        activeTaxProfileVersion = Number(taxProfile.version);
        activeTaxonomyVersionId = taxProfile.taxonomy_version_id;
        activeTaxYear = taxProfile.tax_year;
        activeTaxCatIdSet = new Set(
          (await transaction
            .selectFrom("app.tax_category_definitions")
            .select("id")
            .where("taxonomy_version_id", "=", taxProfile.taxonomy_version_id)
            .where("status", "=", "active")
            .forShare()
            .execute()
          ).map((r) => r.id),
        );
      }
    }

    for (const sug of resultData.suggestions) {
      if (sug.source !== "historical") throw DomainError.validation();
      if (sug.kind === "spending_category") {
        if (!eligibleCatIds.has(sug.spendingCategoryId)) throw DomainError.conflict();
      } else if (sug.kind === "tag") {
        if (!eligibleTagKeys.includes(sug.tagKey)) throw DomainError.conflict();
      } else if (sug.kind === "tax_category") {
        if (isPersonal) throw DomainError.conflict();
        if (
          sug.businessTaxProfileId !== activeTaxProfileId ||
          sug.businessTaxProfileVersion !== activeTaxProfileVersion ||
          sug.taxonomyVersionId !== activeTaxonomyVersionId ||
          sug.taxYear !== activeTaxYear ||
          !activeTaxCatIdSet.has(sug.taxCategoryDefinitionId)
        ) {
          throw DomainError.conflict();
        }
      }
    }

    // ---- Apply rule tags ----
    for (const ruleKey of serverRuleTagKeys) {
      const existingTag = await transaction
        .selectFrom("app.tags")
        .select(["id", "status"])
        .where("tenant_id", "=", tenantId)
        .where("key", "=", ruleKey)
        .forUpdate()
        .executeTakeFirst();

      let tagId: string;
      if (existingTag) {
        if (existingTag.status === "archived") continue; // permanently ineligible
        tagId = existingTag.id;
      } else {
        const proposedTagId = randomUUID();
        const insertedTag = await transaction
          .insertInto("app.tags")
          .values({
            id: proposedTagId,
            tenant_id: tenantId,
            key: ruleKey,
            name: ruleKey,
            color: null,
            origin: "rule",
            status: "active",
            created_by_user_id: null,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(["tenant_id", "key"]).doNothing(),
          )
          .returning("id")
          .executeTakeFirst();

        if (insertedTag) {
          tagId = insertedTag.id;
        } else {
          const concurrentTag = await transaction
            .selectFrom("app.tags")
            .select(["id", "status"])
            .where("tenant_id", "=", tenantId)
            .where("key", "=", ruleKey)
            .forUpdate()
            .executeTakeFirstOrThrow();
          if (concurrentTag.status === "archived") continue;
          tagId = concurrentTag.id;
        }
      }

      const existingAssoc = await transaction
        .selectFrom("app.expense_tags")
        .select(["id", "status", "source"])
        .where("tenant_id", "=", tenantId)
        .where("expense_id", "=", expenseId)
        .where("tag_id", "=", tagId)
        .executeTakeFirst();

      if (existingAssoc) {
        if (existingAssoc.source === "manual" || existingAssoc.status === "removed") {
          continue; // Manual/removed decision blocks auto-application
        }
        // F10: increment version on update
        await transaction
          .updateTable("app.expense_tags")
          .set({
            status: "active",
            source: "rule",
            confidence: "1",
            rule_version: ENRICHMENT_RULES_VERSION,
            applied_at: now,
            version: sql<number>`version + 1`,
          })
          .where("id", "=", existingAssoc.id)
          .execute();
      } else {
        await transaction
          .insertInto("app.expense_tags")
          .values({
            id: randomUUID(),
            tenant_id: tenantId,
            personal_profile_id: scopeProfileId,
            business_id: scopeBusinessId,
            expense_id: expenseId,
            tag_id: tagId,
            source: "rule",
            confidence: "1",
            rule_version: ENRICHMENT_RULES_VERSION,
            suggestion_id: null,
            status: "active",
            applied_by_user_id: null,
            removed_by_user_id: null,
            applied_at: now,
            removed_at: null,
            created_at: now,
          })
          .execute();
      }

      // F11: operation key inside transaction
      await _insertOperationKey(transaction, {
        tenantId,
        jobId: input.jobId,
        expenseId,
        kind: "tag",
        candidateId: tagId,
        evidenceHash: sha256Hex(canonicalJson({ kind: "rule_tag", key: ruleKey })),
        operationKey: `${input.jobId}:rule:${ruleKey}`,
        payloadHash: hashNormalizedRequest({ kind: "rule_tag", key: ruleKey, jobId: input.jobId }),
        responseJson: null,
        now,
      });
    }

    // ---- Create pending historical suggestions ----
    for (const sug of resultData.suggestions) {
      const idempotencyKey = `${input.jobId}:sug:${sug.kind}:${sug.evidenceHash}`;

      let tagId: string | null = null;
      let spendingCategoryId: string | null = null;
      let taxCategoryDefinitionId: string | null = null;
      let businessTaxProfileId: string | null = null;
      let businessTaxProfileVersion: number | null = null;
      let taxonomyVersionId: string | null = null;
      let taxYear: number | null = null;
      let candidateId: string | null = null;

      if (sug.kind === "tag") {
        const tagRow = await transaction
          .selectFrom("app.tags")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where("key", "=", sug.tagKey)
          .where("status", "=", "active")
          .forShare()
          .executeTakeFirst();
        if (!tagRow) continue;
        tagId = tagRow.id;
        candidateId = tagId;
      } else if (sug.kind === "spending_category") {
        spendingCategoryId = sug.spendingCategoryId;
        candidateId = spendingCategoryId;
      } else if (sug.kind === "tax_category") {
        taxCategoryDefinitionId = sug.taxCategoryDefinitionId;
        businessTaxProfileId = sug.businessTaxProfileId;
        businessTaxProfileVersion = sug.businessTaxProfileVersion;
        taxonomyVersionId = sug.taxonomyVersionId;
        taxYear = sug.taxYear;
        candidateId = taxCategoryDefinitionId;
      }

      // Preserve prior review decisions across jobs. Tax suggestions bind the
      // full validation snapshot so a changed profile or taxonomy can produce
      // a new review candidate without recreating unchanged evidence.
      const existingSug = sug.kind === "tag"
        ? await transaction
          .selectFrom("app.expense_enrichment_suggestions")
          .select(["id"])
          .where("tenant_id", "=", tenantId)
          .where("expense_id", "=", expenseId)
          .where("kind", "=", sug.kind)
          .where("tag_id", "=", tagId)
          .where("evidence_hash", "=", sug.evidenceHash)
          .where("status", "in", ["pending", "accepted", "rejected", "superseded"])
          .executeTakeFirst()
        : sug.kind === "spending_category"
          ? await transaction
            .selectFrom("app.expense_enrichment_suggestions")
            .select(["id"])
            .where("tenant_id", "=", tenantId)
            .where("expense_id", "=", expenseId)
            .where("kind", "=", sug.kind)
            .where("spending_category_id", "=", spendingCategoryId)
            .where("evidence_hash", "=", sug.evidenceHash)
            .where("status", "in", ["pending", "accepted", "rejected", "superseded"])
            .executeTakeFirst()
          : await transaction
            .selectFrom("app.expense_enrichment_suggestions")
            .select(["id"])
            .where("tenant_id", "=", tenantId)
            .where("expense_id", "=", expenseId)
            .where("kind", "=", sug.kind)
            .where("tax_category_definition_id", "=", taxCategoryDefinitionId)
            .where("business_tax_profile_id", "=", businessTaxProfileId)
            .where("business_tax_profile_version", "=", businessTaxProfileVersion)
            .where("taxonomy_version_id", "=", taxonomyVersionId)
            .where("tax_year", "=", taxYear)
            .where("evidence_hash", "=", sug.evidenceHash)
            .where("status", "in", ["pending", "accepted", "rejected", "superseded"])
            .executeTakeFirst();

      if (existingSug) continue;

      const sugId = randomUUID();
      const evidence: JsonValue = toJsonValue({
        exampleCount: sug.aggregateCounts.exampleCount,
        matchCount: sug.aggregateCounts.matchCount,
      });

      await transaction
        .insertInto("app.expense_enrichment_suggestions")
        .values({
          id: sugId,
          tenant_id: tenantId,
          personal_profile_id: scopeProfileId,
          business_id: scopeBusinessId,
          expense_id: expenseId,
          job_id: input.jobId,
          kind: sug.kind,
          tag_id: tagId,
          spending_category_id: spendingCategoryId,
          tax_category_definition_id: taxCategoryDefinitionId,
          business_tax_profile_id: businessTaxProfileId,
          business_tax_profile_version: businessTaxProfileVersion,
          taxonomy_version_id: taxonomyVersionId,
          tax_year: taxYear,
          source: "historical",
          confidence: String(sug.confidence),
          evidence,
          evidence_hash: sug.evidenceHash,
          status: "pending",
          version: 1,
          expense_version: expense.version,
          idempotency_key: idempotencyKey,
          resolved_by_user_id: null,
          resolved_at: null,
          created_at: now,
        })
        .execute();

      // F11: suggestion operation key inside transaction
      await _insertOperationKey(transaction, {
        tenantId,
        jobId: input.jobId,
        expenseId,
        kind: sug.kind as "tag" | "spending_category" | "tax_category",
        candidateId,
        evidenceHash: sug.evidenceHash,
        operationKey: idempotencyKey,
        payloadHash: hashNormalizedRequest({
          kind: sug.kind, candidateId, evidenceHash: sug.evidenceHash, jobId: input.jobId,
        }),
        responseJson: toJsonValue({ suggestionId: sugId }),
        now,
      });
    }

    // ---- Mark job SUCCEEDED (F14: version predicate while lock held) ----
    const updated = await transaction
      .updateTable("app.processing_jobs")
      .set({
        status: "SUCCEEDED",
        result: toJsonValue(input.result as Record<string, unknown>),
        updated_at: now,
        completed_at: now,
        version: job.version + 1,
      })
      .where("id", "=", input.jobId)
      .where("version", "=", job.version) // F14: version predicate
      .returningAll()
      .executeTakeFirst();

    if (!updated) throw DomainError.preconditionFailed();

    // ---- F13: single audit event with actor and outcome ----
    await recordAuditEvent(transaction, {
      tenantId,
      actorServicePrincipal: input.actorServicePrincipal,
      action: "processing_job.enrichment_result_submitted",
      outcome: "success",
      resourceType: "processing_job",
      resourceId: input.jobId,
      requestId: input.requestId,
      metadata: { outcome: "applied" },
    });

    // ---- F1/F2: Insert job-level 'result' operation key (kind='result', null candidate) ----
    const responseBody = toProcessingJob(updated);
    await _insertOperationKey(transaction, {
      tenantId,
      jobId: input.jobId,
      expenseId,
      kind: "result",
      candidateId: null,
      evidenceHash: payloadHash, // canonical normalized result hash directly (F2)
      operationKey: resultOpKey,
      payloadHash,
      responseJson: toJsonValue(responseBody),
      now,
    });

    return { statusCode: 200, body: responseBody, replayed: false };
  });
}

// ------------------------------------------------------------------ //
// Stale/skipped completion helper
// ------------------------------------------------------------------ //

async function _completeAndRecordResult(
  transaction: Transaction<AppDatabase>,
  job: ProcessingJobRow,
  input: ApplyEnrichmentResultInput,
  terminalOutcome: "stale" | "skipped",
  now: Date,
  resultOpKey: string,
  payloadHash: string,
): Promise<MutationResult<ProcessingJob, 200>> {
  const updated = await transaction
    .updateTable("app.processing_jobs")
    .set({
      status: "SUCCEEDED",
      result: toJsonValue(input.result as Record<string, unknown>),
      updated_at: now,
      completed_at: now,
      version: job.version + 1,
    })
    .where("id", "=", input.jobId)
    .where("version", "=", job.version) // F14: version predicate
    .returningAll()
    .executeTakeFirst();

  if (!updated) throw DomainError.preconditionFailed();

  // F13: single audit event
  await recordAuditEvent(transaction, {
    tenantId: job.tenant_id,
    actorServicePrincipal: input.actorServicePrincipal,
    action: "processing_job.enrichment_result_submitted",
    outcome: "success",
    resourceType: "processing_job",
    resourceId: input.jobId,
    requestId: input.requestId,
    metadata: { outcome: terminalOutcome },
  });

  const responseBody = toProcessingJob(updated);

  // F1/F2: result operation key for stale/skipped too (ensures replay works).
  // target_aggregate_id must be non-null for any enrichment job completion;
  // the caller validates this before reaching here.
  const expenseId = job.target_aggregate_id!;
  await _insertOperationKey(transaction, {
    tenantId: job.tenant_id,
    jobId: input.jobId,
    expenseId,
    kind: "result",
    candidateId: null,
    evidenceHash: payloadHash,
    operationKey: resultOpKey,
    payloadHash,
    responseJson: toJsonValue(responseBody),
    now,
  });

  return { statusCode: 200, body: responseBody, replayed: false };
}

// ------------------------------------------------------------------ //
// resolveSuggestion — Task 8 (no stubs)
// ------------------------------------------------------------------ //

export interface ResolveSuggestionInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly profileId: string | null;
  readonly businessId: string | null;
  readonly expenseId: string;
  readonly suggestionId: string;
  readonly request: {
    readonly action: "accepted" | "rejected";
    readonly expectedSuggestionVersion: number;
    readonly expectedExpenseVersion: number;
    readonly idempotencyKey: string;
    readonly taxAcceptance?: {
      readonly businessTaxProfileId: string;
      readonly deductiblePercent: string;
    };
  };
  readonly requestId: string;
}

export interface ResolveSuggestionResult {
  readonly suggestionId: string;
  readonly status: "pending" | "accepted" | "rejected" | "superseded";
  readonly version: number;
}

/**
 * Resolve (accept/reject) a pending enrichment suggestion.
 *
 * Rules:
 * - Require pending status, expected suggestion+expense versions, scope match.
 * - Permanent idempotency by (tenantId, expenseId, idempotencyKey):
 *   identical replay returns original; changed payload conflicts.
 * - Tag accept: creates/promotes historical association unless manual/removed blocks.
 * - Spending accept: updates expense version, appends historical decision,
 *   supersedes competing pending category/tax suggestions in same transaction.
 * - Tax accept: Business-only; revalidates profile ID/version, active taxonomy/year/category,
 *   expense version/scope; user supplies deductible percentage; writes treatment as 'unreviewed'.
 * - Reject: terminal, retained.
 * - Automation supplies no percentage; public superseded action not allowed.
 */
export async function resolveSuggestion(
  database: Kysely<AppDatabase>,
  input: ResolveSuggestionInput,
): Promise<ResolveSuggestionResult> {
  const resolveOpKey = `resolve:${input.expenseId}:${input.request.idempotencyKey}`;
  const payloadHash = hashNormalizedRequest({
    suggestionId: input.suggestionId,
    action: input.request.action,
    expectedSuggestionVersion: input.request.expectedSuggestionVersion,
    expectedExpenseVersion: input.request.expectedExpenseVersion,
    taxAcceptance: input.request.taxAcceptance ?? null,
  });

  return database.transaction().execute(async (transaction) => {
    // Permanent idempotency check
    const existingKey = await transaction
      .selectFrom("app.enrichment_operation_keys")
      .select(["payload_hash", "response_json"])
      .where("tenant_id", "=", input.tenantId)
      .where("operation_key", "=", resolveOpKey)
      .forUpdate()
      .executeTakeFirst();

    if (existingKey) {
      if (existingKey.payload_hash !== payloadHash) throw DomainError.conflict();
      const stored = existingKey.response_json as unknown as ResolveSuggestionResult;
      return stored;
    }

    // Lock expense before suggestions so manual mutations and resolution use
    // one deterministic lock order.
    const expense = await transaction
      .selectFrom("app.expenses")
      .selectAll()
      .where("id", "=", input.expenseId)
      .where("tenant_id", "=", input.tenantId)
      .where("status", "!=", "archived")
      .forUpdate()
      .executeTakeFirst();

    if (!expense) throw DomainError.notFound();

    // A concurrent identical request can create the operation key while this
    // transaction waits for the expense lock. Recheck before state validation.
    const concurrentKey = await transaction
      .selectFrom("app.enrichment_operation_keys")
      .select(["payload_hash", "response_json"])
      .where("tenant_id", "=", input.tenantId)
      .where("operation_key", "=", resolveOpKey)
      .executeTakeFirst();

    if (concurrentKey) {
      if (concurrentKey.payload_hash !== payloadHash) throw DomainError.conflict();
      return concurrentKey.response_json as unknown as ResolveSuggestionResult;
    }

    if (expense.version !== input.request.expectedExpenseVersion) throw DomainError.conflict();

    const suggestion = await transaction
      .selectFrom("app.expense_enrichment_suggestions")
      .selectAll()
      .where("id", "=", input.suggestionId)
      .where("tenant_id", "=", input.tenantId)
      .where("expense_id", "=", input.expenseId)
      .forUpdate()
      .executeTakeFirst();

    if (!suggestion) throw DomainError.notFound();
    if (suggestion.status !== "pending") throw DomainError.conflict();
    if (suggestion.version !== input.request.expectedSuggestionVersion) throw DomainError.conflict();
    if (suggestion.expense_version !== expense.version) throw DomainError.conflict();

    if (input.profileId !== null && suggestion.personal_profile_id !== input.profileId) {
      throw DomainError.notFound();
    }
    if (input.businessId !== null && suggestion.business_id !== input.businessId) {
      throw DomainError.notFound();
    }

    const now = new Date();

    if (input.request.action === "rejected") {
      // Reject — terminal, no side effects
      await transaction
        .updateTable("app.expense_enrichment_suggestions")
        .set({
          status: "rejected",
          version: sql<number>`version + 1`,
          resolved_by_user_id: input.actorUserId,
          resolved_at: now,
        })
        .where("id", "=", input.suggestionId)
        .execute();
    } else {
      // Accept
      if (suggestion.kind === "tag") {
        await _acceptTagSuggestion(transaction, {
          suggestion,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          now,
        });
      } else if (suggestion.kind === "spending_category") {
        await _acceptSpendingCategorySuggestion(transaction, {
          suggestion,
          expense,
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          now,
        });
      } else if (suggestion.kind === "tax_category") {
        await _acceptTaxCategorySuggestion(transaction, {
          suggestion,
          expense,
          tenantId: input.tenantId,
          businessId: input.businessId!,
          actorUserId: input.actorUserId,
          ...(input.request.taxAcceptance !== undefined
            ? { taxAcceptance: input.request.taxAcceptance }
            : {}),
          now,
        });
      }

      await transaction
        .updateTable("app.expense_enrichment_suggestions")
        .set({
          status: "accepted",
          version: sql<number>`version + 1`,
          resolved_by_user_id: input.actorUserId,
          resolved_at: now,
        })
        .where("id", "=", input.suggestionId)
        .execute();
    }

    // Fix-5: read back the actual version written by the DB (version + 1) rather
    // than computing it in application code. This is the authoritative value stored
    // in the op-key and returned to the caller for replay safety.
    const resolved = await transaction
      .selectFrom("app.expense_enrichment_suggestions")
      .select(["version", "status"])
      .where("id", "=", input.suggestionId)
      .executeTakeFirstOrThrow();

    const result: ResolveSuggestionResult = {
      suggestionId: input.suggestionId,
      status: resolved.status as ResolveSuggestionResult["status"],
      version: resolved.version,
    };

    // Record permanent op key
    await transaction
      .insertInto("app.enrichment_operation_keys")
      .values({
        id: randomUUID(),
        tenant_id: input.tenantId,
        job_id: suggestion.job_id,
        expense_id: input.expenseId,
        kind: suggestion.kind,
        candidate_id: suggestion.tag_id ?? suggestion.spending_category_id ?? suggestion.tax_category_definition_id,
        evidence_hash: suggestion.evidence_hash,
        operation_key: resolveOpKey,
        payload_hash: payloadHash,
        response_json: toJsonValue(result),
        created_at: now,
      })
      .execute();

    await recordAuditEvent(transaction, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: `enrichment_suggestion.${input.request.action}`,
      outcome: "success",
      resourceType: "enrichment_suggestion",
      resourceId: input.suggestionId,
      requestId: input.requestId,
      metadata: { kind: suggestion.kind, action: input.request.action },
    });

    return result;
  });
}

// Tag accept — Fix-1: reject if tag is currently archived at acceptance time.
async function _acceptTagSuggestion(
  transaction: Transaction<AppDatabase>,
  {
    suggestion,
    tenantId,
    actorUserId,
    now,
  }: {
    suggestion: { expense_id: string; tag_id: string | null; personal_profile_id: string | null; business_id: string | null; };
    tenantId: string;
    actorUserId: string;
    now: Date;
  },
): Promise<void> {
  if (!suggestion.tag_id) return;

  // Fix-1: Validate the candidate tag is still active at acceptance time.
  // If it has been archived since the suggestion was created, the accept is a CONFLICT.
  const tag = await transaction
    .selectFrom("app.tags")
    .select(["id", "status"])
    .where("id", "=", suggestion.tag_id)
    .where("tenant_id", "=", tenantId)
    .executeTakeFirst();
  if (!tag || tag.status === "archived") throw DomainError.conflict();

  // Check for existing association — if manual or removed, don't overwrite
  const existingAssoc = await transaction
    .selectFrom("app.expense_tags")
    .select(["id", "source", "status"])
    .where("tenant_id", "=", tenantId)
    .where("expense_id", "=", suggestion.expense_id)
    .where("tag_id", "=", suggestion.tag_id)
    .executeTakeFirst();

  if (existingAssoc) {
    // Manual/removed decision blocks historical promotion
    if (existingAssoc.source === "manual" || existingAssoc.status === "removed") return;
    // Promote existing to historical active
    await transaction
      .updateTable("app.expense_tags")
      .set({
        source: "historical",
        status: "active",
        applied_by_user_id: actorUserId,
        applied_at: now,
        version: sql<number>`version + 1`,
      })
      .where("id", "=", existingAssoc.id)
      .execute();
  } else {
    // Create new historical active association
    await transaction
      .insertInto("app.expense_tags")
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        personal_profile_id: suggestion.personal_profile_id,
        business_id: suggestion.business_id,
        expense_id: suggestion.expense_id,
        tag_id: suggestion.tag_id,
        source: "historical",
        confidence: "1",
        rule_version: null,
        suggestion_id: null,
        status: "active",
        applied_by_user_id: actorUserId,
        removed_by_user_id: null,
        applied_at: now,
        removed_at: null,
        created_at: now,
      })
      .execute();
  }
}

// Spending category accept
async function _acceptSpendingCategorySuggestion(
  transaction: Transaction<AppDatabase>,
  {
    suggestion,
    expense,
    tenantId,
    actorUserId,
    now,
  }: {
    suggestion: {
      expense_id: string;
      spending_category_id: string | null;
      personal_profile_id: string | null;
      business_id: string | null;
    };
    expense: { id: string; spending_category_id: string | null; version: number; personal_profile_id: string | null; business_id: string | null; };
    tenantId: string;
    actorUserId: string;
    now: Date;
  },
): Promise<void> {
  const newCatId = suggestion.spending_category_id;
  if (!newCatId) return;

  // Validate category still active
  const cat = await transaction
    .selectFrom("app.spending_categories")
    .select("id")
    .where("id", "=", newCatId)
    .where("tenant_id", "=", tenantId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!cat) throw DomainError.conflict();

  const priorCatId = expense.spending_category_id;
  const newExpenseVersion = expense.version + 1;

  // Update expense spending_category_id + bump version
  await transaction
    .updateTable("app.expenses")
    .set({
      spending_category_id: newCatId,
      version: sql<number>`version + 1`,
      updated_at: now,
    })
    .where("id", "=", expense.id)
    .where("version", "=", expense.version)
    .execute();

  // Append historical decision
  await transaction
    .insertInto("app.expense_spending_category_decisions")
    .values({
      id: randomUUID(),
      tenant_id: tenantId,
      personal_profile_id: expense.personal_profile_id,
      business_id: expense.business_id,
      expense_id: expense.id,
      prior_spending_category_id: priorCatId,
      new_spending_category_id: newCatId,
      source: "historical",
      actor_user_id: actorUserId,
      expense_version: newExpenseVersion,
      suggestion_id: null,
      created_at: now,
    })
    .execute();

  // Supersede competing pending category and tax suggestions for this expense
  await transaction
    .updateTable("app.expense_enrichment_suggestions")
    .set({
      status: "superseded",
      resolved_at: now,
      resolved_by_user_id: null,
    })
    .where("tenant_id", "=", tenantId)
    .where("expense_id", "=", expense.id)
    .where("status", "=", "pending")
    .where("kind", "in", ["spending_category", "tax_category"])
    .execute();
}

// Tax category accept
async function _acceptTaxCategorySuggestion(
  transaction: Transaction<AppDatabase>,
  {
    suggestion,
    expense,
    tenantId,
    businessId,
    actorUserId,
    taxAcceptance,
    now,
  }: {
    suggestion: {
      expense_id: string;
      tax_category_definition_id: string | null;
      business_tax_profile_id: string | null;
      business_tax_profile_version: number | null;
      taxonomy_version_id: string | null;
      tax_year: number | null;
      personal_profile_id: string | null;
      business_id: string | null;
    };
    expense: { id: string; business_id: string | null; personal_profile_id: string | null; tax_year: number; version: number; };
    tenantId: string;
    businessId: string;
    actorUserId: string;
    taxAcceptance?: { businessTaxProfileId: string; deductiblePercent: string };
    now: Date;
  },
): Promise<void> {
  // Tax suggestions require Business scope
  if (!suggestion.business_id) throw DomainError.conflict();
  if (!taxAcceptance) throw DomainError.validation();

  const { businessTaxProfileId, deductiblePercent } = taxAcceptance;

  // Fix-4: The current expense's tax_year must equal the suggestion's stored tax_year
  // (stale detection: the expense may have moved to a different tax year since the
  // suggestion was created). Reject if they diverge.
  if (expense.tax_year !== suggestion.tax_year) throw DomainError.conflict();

  // Revalidate: active profile with same ID, version, taxonomy_version_id, AND tax_year
  // Fix-4: bind tax_year in the profile query to close the race where a new profile
  // for a different year is returned first.
  const profile = await transaction
    .selectFrom("app.business_tax_profiles")
    .selectAll()
    .where("id", "=", businessTaxProfileId)
    .where("tenant_id", "=", tenantId)
    .where("business_id", "=", businessId)
    .where("tax_year", "=", suggestion.tax_year!)
    .where("status", "=", "active")
    .executeTakeFirst();

  if (!profile) throw DomainError.conflict();
  if (profile.id !== suggestion.business_tax_profile_id) throw DomainError.conflict();
  if (Number(profile.version) !== suggestion.business_tax_profile_version) throw DomainError.conflict();
  if (profile.taxonomy_version_id !== suggestion.taxonomy_version_id) throw DomainError.conflict();
  if (profile.tax_year !== suggestion.tax_year) throw DomainError.conflict();

  // Validate tax category still active in current taxonomy
  const taxCat = await transaction
    .selectFrom("app.tax_category_definitions")
    .select("id")
    .where("id", "=", suggestion.tax_category_definition_id!)
    .where("taxonomy_version_id", "=", suggestion.taxonomy_version_id!)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!taxCat) throw DomainError.conflict();

  // Upsert tax treatment as 'unreviewed'
  await transaction
    .insertInto("app.expense_tax_treatments")
    .values({
      expense_id: expense.id,
      tenant_id: tenantId,
      business_id: businessId,
      tax_year: expense.tax_year,
      business_tax_profile_id: businessTaxProfileId,
      taxonomy_version_id: suggestion.taxonomy_version_id!,
      tax_category_definition_id: suggestion.tax_category_definition_id!,
      deductible_percent: deductiblePercent,
      review_status: "unreviewed",
      note: null,
      version: 1,
      created_by_user_id: actorUserId,
      updated_by_user_id: actorUserId,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict.column("expense_id").doUpdateSet({
        business_tax_profile_id: businessTaxProfileId,
        taxonomy_version_id: suggestion.taxonomy_version_id!,
        tax_category_definition_id: suggestion.tax_category_definition_id!,
        deductible_percent: deductiblePercent,
        review_status: "unreviewed",
        version: sql<number>`expense_tax_treatments.version + 1`,
        updated_by_user_id: actorUserId,
        updated_at: now,
      }),
    )
    .execute();

  // Supersede competing pending tax suggestions for this expense
  await transaction
    .updateTable("app.expense_enrichment_suggestions")
    .set({
      status: "superseded",
      resolved_at: now,
      resolved_by_user_id: null,
    })
    .where("tenant_id", "=", tenantId)
    .where("expense_id", "=", expense.id)
    .where("status", "=", "pending")
    .where("kind", "=", "tax_category")
    .execute();
}

// ------------------------------------------------------------------ //
// rerunEnrichment — Task 8 (no stubs)
// ------------------------------------------------------------------ //

export interface RerunEnrichmentInput {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly profileId: string | null;
  readonly businessId: string | null;
  readonly expenseId: string;
  readonly kinds: readonly string[];
  readonly requestId: string;
}

/**
 * Trigger a new enrichment run for the given expense in the exact scope.
 * Requires ready (non-archived) expense. Creates a new enrichment job + outbox.
 * Never alters prior terminal records.
 */
export async function rerunEnrichment(
  database: Kysely<AppDatabase>,
  input: RerunEnrichmentInput,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    // Validate expense belongs to the exact scope
    let expenseQuery = transaction
      .selectFrom("app.expenses")
      .select(["id", "version", "personal_profile_id", "business_id"])
      .where("id", "=", input.expenseId)
      .where("tenant_id", "=", input.tenantId)
      .where("status", "!=", "archived");

    if (input.profileId !== null) {
      expenseQuery = expenseQuery.where("personal_profile_id", "=", input.profileId);
    } else if (input.businessId !== null) {
      expenseQuery = expenseQuery.where("business_id", "=", input.businessId);
    }

    const expense = await expenseQuery.executeTakeFirst();
    if (!expense) throw DomainError.notFound();

    // Create enrichment job via the helper
    const { createEnrichmentJobInTransaction } = await import("./enrichment-jobs.js");
    const scope =
      input.profileId !== null
        ? { personalProfileId: input.profileId }
        : { businessId: input.businessId! };

    await createEnrichmentJobInTransaction(transaction, {
      tenantId: input.tenantId,
      scope,
      expenseId: input.expenseId,
      expectedExpenseVersion: expense.version,
      requestedByUserId: input.actorUserId,
      requestId: input.requestId,
    });
  });
}

// ------------------------------------------------------------------ //
// Operation key insertion helper (transaction-local, F11)
// ------------------------------------------------------------------ //

interface InsertOpKeyInput {
  readonly tenantId: string;
  readonly jobId: string;
  readonly expenseId: string;
  readonly kind: "tag" | "spending_category" | "tax_category" | "result";
  readonly candidateId: string | null;
  readonly evidenceHash: string;
  readonly operationKey: string;
  readonly payloadHash: string;
  readonly responseJson: JsonValue;
  readonly now: Date;
}

async function _insertOperationKey(
  transaction: Transaction<AppDatabase>,
  input: InsertOpKeyInput,
): Promise<void> {
  // Check for existing key (checked under row lock for the job at transaction start)
  const existing = await transaction
    .selectFrom("app.enrichment_operation_keys")
    .select(["payload_hash"])
    .where("tenant_id", "=", input.tenantId)
    .where("operation_key", "=", input.operationKey)
    .executeTakeFirst();

  if (existing) {
    if (existing.payload_hash !== input.payloadHash) throw DomainError.conflict();
    return; // idempotent
  }

  await transaction
    .insertInto("app.enrichment_operation_keys")
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      job_id: input.jobId,
      expense_id: input.expenseId,
      kind: input.kind,
      candidate_id: input.candidateId,
      evidence_hash: input.evidenceHash,
      operation_key: input.operationKey,
      payload_hash: input.payloadHash,
      response_json: input.responseJson,
      created_at: input.now,
    })
    .execute();
}
