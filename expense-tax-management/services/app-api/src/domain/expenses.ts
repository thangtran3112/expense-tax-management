import { randomUUID } from "node:crypto";

import type {
  BusinessExpenseCollectionParams,
  BusinessExpenseParams,
  Expense,
  ExpenseArchiveRequest,
  ExpenseCreateRequest,
  ExpenseList,
  ExpenseTagChip,
  ExpenseUpdateRequest,
  LedgerQuery,
  PersonalExpenseCollectionParams,
  PersonalExpenseParams,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { AppDatabase, ExpenseTable } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import { createEnrichmentJobInTransaction } from "./enrichment-jobs.js";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  ledgerFilterHash,
} from "../pagination/cursor.js";

export interface PersonalExpenseCreateCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly profileId: string;
  readonly request: ExpenseCreateRequest;
  readonly requestId: string;
}

export interface BusinessExpenseCreateCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly request: ExpenseCreateRequest;
  readonly requestId: string;
}

export interface ExpenseUpdateCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly expenseId: string;
  readonly request: ExpenseUpdateRequest;
  readonly requestId: string;
}

export interface ExpenseArchiveCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly expenseId: string;
  readonly request: ExpenseArchiveRequest;
  readonly requestId: string;
}

export interface ExpenseDomain {
  createPersonal(input: PersonalExpenseCreateCommand): Promise<Expense>;
  createBusiness(input: BusinessExpenseCreateCommand): Promise<Expense>;
  listPersonal(
    input: PersonalExpenseCollectionParams & {
      readonly actorUserId: string;
      readonly query: LedgerQuery;
    },
  ): Promise<ExpenseList>;
  listBusiness(
    input: BusinessExpenseCollectionParams & {
      readonly actorUserId: string;
      readonly query: LedgerQuery;
    },
  ): Promise<ExpenseList>;
  getPersonal(input: PersonalExpenseParams & { readonly actorUserId: string }): Promise<Expense>;
  getBusiness(input: BusinessExpenseParams & { readonly actorUserId: string }): Promise<Expense>;
  updatePersonal(input: ExpenseUpdateCommand & { readonly profileId: string }): Promise<Expense>;
  updateBusiness(input: ExpenseUpdateCommand & { readonly businessId: string }): Promise<Expense>;
  archivePersonal(input: ExpenseArchiveCommand & { readonly profileId: string }): Promise<void>;
  archiveBusiness(input: ExpenseArchiveCommand & { readonly businessId: string }): Promise<void>;
}

function dateOnly(value: Date | string): string {
  if (typeof value === "string") return value;
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(
    value.getMonth() + 1,
  ).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function toExpense(row: Selectable<ExpenseTable>, tags: ExpenseTagChip[] = []): Expense {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    createdByUserId: row.created_by_user_id,
    personalProfileId: row.personal_profile_id,
    businessId: row.business_id,
    projectId: row.project_id,
    spendingCategoryId: row.spending_category_id,
    merchant: row.merchant,
    description: row.description,
    amount: String(row.amount),
    currency: row.currency,
    incurredOn: dateOnly(row.incurred_on as Date | string),
    taxYear: row.tax_year,
    source: row.source,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    tags,
  };
}

type Scope =
  | { readonly kind: "personal"; readonly profileId: string }
  | { readonly kind: "business"; readonly businessId: string };

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

function canWrite(role: "owner" | "editor" | "viewer"): boolean {
  return role === "owner" || role === "editor";
}

function assertRequestScope(request: ExpenseCreateRequest, scope: Scope): void {
  if (scope.kind === "personal") {
    if (request.personalProfileId !== scope.profileId || request.businessId != null) {
      throw DomainError.notFound();
    }
    if (request.projectId != null) throw DomainError.validation();
    return;
  }
  if (request.businessId !== scope.businessId || request.personalProfileId != null) {
    throw DomainError.notFound();
  }
}

/**
 * Explicit enrichment mode for insertExpenseInTransaction.
 *
 * - "manual-ready"  : expense is immediately ready; create enrichment job inline
 *                     in the same transaction before returning. Used by public
 *                     manual creates (createPersonal, createBusiness).
 * - "ocr-deferred"  : expense is ready but caller (applyOcrExtraction) will
 *                     create the enrichment job itself after file binding.
 *                     Prevents a duplicate job when OCR explicitly calls
 *                     createEnrichmentJobInTransaction.
 * - "draft"         : expense starts as draft; no enrichment job created.
 *                     Used by OCR draft holding and internal callers.
 */
export type ExpenseInsertMode = "manual-ready" | "ocr-deferred" | "draft";

export async function insertExpenseInTransaction(
  transaction: Transaction<AppDatabase>,
  input: {
    actorUserId: string;
    tenantId: string;
    request: ExpenseCreateRequest;
    requestId: string;
    scope: Scope;
    source?: "manual" | "ocr" | "forwarded_email" | "connected_mailbox";
    /**
     * Required: explicit mode governs initial status and enrichment job creation.
     * Callers must choose one of the three explicit modes — no default.
     * Omitting mode is a TypeScript compile-time error.
     */
    mode: ExpenseInsertMode;
  },
): Promise<Expense> {
  const effectiveMode = input.mode;
  const initialStatus =
    effectiveMode === "draft" ? "draft" : "ready";

  const now = new Date();
  const created = await transaction
    .insertInto("app.expenses")
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      created_by_user_id: input.actorUserId,
      personal_profile_id: input.scope.kind === "personal" ? input.scope.profileId : null,
      business_id: input.scope.kind === "business" ? input.scope.businessId : null,
      project_id: input.request.projectId ?? null,
      spending_category_id: input.request.spendingCategoryId ?? null,
      merchant: input.request.merchant,
      description: input.request.description ?? null,
      amount: input.request.amount,
      currency: input.request.currency,
      incurred_on: input.request.incurredOn,
      source: input.source ?? "manual",
      status: initialStatus,
      version: 1,
      created_at: now,
      updated_at: now,
      archived_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordAuditEvent(transaction, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: "expense.created",
    outcome: "success",
    resourceType: "expense",
    resourceId: created.id,
    requestId: input.requestId,
  });

  // Append-only spending-category decision when category present on manual create.
  if (
    (input.source === undefined || input.source === "manual") &&
    input.request.spendingCategoryId != null
  ) {
    await transaction
      .insertInto("app.expense_spending_category_decisions")
      .values({
        id: randomUUID(),
        tenant_id: input.tenantId,
        personal_profile_id: input.scope.kind === "personal" ? input.scope.profileId : null,
        business_id: input.scope.kind === "business" ? input.scope.businessId : null,
        expense_id: created.id,
        prior_spending_category_id: null,
        new_spending_category_id: input.request.spendingCategoryId,
        source: "manual",
        actor_user_id: input.actorUserId,
        expense_version: created.version,
        suggestion_id: null,
      })
      .execute();
  }

  // Enqueue enrichment workflow for manual-ready path only.
  // "ocr-deferred" skips here; applyOcrExtraction explicitly calls
  // createEnrichmentJobInTransaction after file binding (avoids duplicate).
  if (effectiveMode === "manual-ready") {
    await createEnrichmentJobInTransaction(transaction, {
      tenantId: input.tenantId,
      scope:
        input.scope.kind === "personal"
          ? { personalProfileId: input.scope.profileId }
          : { businessId: input.scope.businessId },
      expenseId: created.id,
      expectedExpenseVersion: created.version,
      requestedByUserId: input.actorUserId,
      requestId: input.requestId,
    });
  }

  return toExpense(created);
}

async function queryExpenses(
  database: Kysely<AppDatabase>,
  input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly scope: Scope;
    readonly query: LedgerQuery;
  },
): Promise<ExpenseList> {
  if (input.scope.kind === "personal" && input.query.taxReviewStatus !== undefined) {
    throw DomainError.validation();
  }
  const cursorScope =
    input.scope.kind === "personal"
      ? { tenantId: input.tenantId, profileId: input.scope.profileId }
      : { tenantId: input.tenantId, businessId: input.scope.businessId };
  const filterHash = ledgerFilterHash(input.query as unknown as Record<string, unknown>);
  const cursor = input.query.cursor
    ? (() => {
        try {
          const decoded = decodeLedgerCursor(input.query.cursor);
          if (
            JSON.stringify(decoded.scope) !== JSON.stringify(cursorScope) ||
            decoded.filterHash !== filterHash ||
            decoded.sort !== input.query.sort ||
            decoded.direction !== input.query.direction
          ) {
            throw new Error("Ledger cursor does not match query");
          }
          return decoded;
        } catch {
          throw DomainError.validation();
        }
      })()
    : null;

  // Task 9: tagIds is canonical (sorted, deduped) after LedgerQuerySchema transform.
  const tagIds = input.query.tagIds ?? [];

  let query = database
    .selectFrom("app.expenses as expense")
    .leftJoin("app.expense_tax_treatments as treatment", "treatment.expense_id", "expense.id")
    .selectAll("expense")
    .where("expense.tenant_id", "=", input.tenantId)
    .where("expense.status", "!=", "archived");
  if (input.scope.kind === "personal") {
    query = query.where("expense.personal_profile_id", "=", input.scope.profileId);
  } else {
    query = query.where("expense.business_id", "=", input.scope.businessId);
  }

  // Task 9: AND semantics — one EXISTS subquery per requested tagId.
  // Each subquery checks: active association AND active tag definition AND same scope.
  // Scope column is branched explicitly so no sql.raw() or unsafe string injection is needed.
  for (const tagId of tagIds) {
    const tenantId = input.tenantId;
    if (input.scope.kind === "personal") {
      const profileId = input.scope.profileId;
      query = query.where(
        sql<boolean>`EXISTS (
          SELECT 1
          FROM app.expense_tags AS et2
          INNER JOIN app.tags AS t2
            ON t2.id = et2.tag_id
           AND t2.status = 'active'
           AND t2.tenant_id = ${tenantId}
          WHERE et2.expense_id = expense.id
            AND et2.tag_id = ${tagId}
            AND et2.tenant_id = ${tenantId}
            AND et2.status = 'active'
            AND et2.personal_profile_id = ${profileId}
        )`,
      );
    } else {
      const businessId = input.scope.businessId;
      query = query.where(
        sql<boolean>`EXISTS (
          SELECT 1
          FROM app.expense_tags AS et2
          INNER JOIN app.tags AS t2
            ON t2.id = et2.tag_id
           AND t2.status = 'active'
           AND t2.tenant_id = ${tenantId}
          WHERE et2.expense_id = expense.id
            AND et2.tag_id = ${tagId}
            AND et2.tenant_id = ${tenantId}
            AND et2.status = 'active'
            AND et2.business_id = ${businessId}
        )`,
      );
    }
  }

  if (input.query.incurredFrom !== undefined) {
    query = query.where(
      "expense.incurred_on",
      ">=",
      new Date(`${input.query.incurredFrom}T00:00:00.000Z`),
    );
  }
  if (input.query.incurredTo !== undefined) {
    query = query.where(
      "expense.incurred_on",
      "<=",
      new Date(`${input.query.incurredTo}T00:00:00.000Z`),
    );
  }
  if (input.query.amountMin !== undefined) {
    query = query.where("expense.amount", ">=", input.query.amountMin);
  }
  if (input.query.amountMax !== undefined) {
    query = query.where("expense.amount", "<=", input.query.amountMax);
  }
  if (input.query.status !== undefined) {
    query = query.where("expense.status", "=", input.query.status);
  }
  if (input.query.spendingCategoryId !== undefined) {
    query = query.where("expense.spending_category_id", "=", input.query.spendingCategoryId);
  }
  if (input.query.projectId !== undefined) {
    query = query.where("expense.project_id", "=", input.query.projectId);
  }
  if (input.query.taxReviewStatus !== undefined) {
    query = query.where("treatment.review_status", "=", input.query.taxReviewStatus);
  }
  if (cursor) {
    const column =
      input.query.sort === "amount"
        ? "amount"
        : input.query.sort === "merchant"
          ? "merchant"
          : input.query.sort === "createdAt"
            ? "created_at"
            : "incurred_on";
    const reference = sql.ref(`expense.${column}`);
    const idReference = sql.ref("expense.id");
    const operator = input.query.direction === "asc" ? sql`>` : sql`<`;
    const lastValue =
      input.query.sort === "incurredOn"
        ? new Date(`${cursor.lastValue}T00:00:00.000Z`)
        : input.query.sort === "createdAt"
          ? new Date(cursor.lastValue)
          : cursor.lastValue;
    query = query.where(sql<boolean>`(
      ${reference} ${operator} ${lastValue}
      OR (${reference} = ${lastValue} AND ${idReference} ${operator} ${cursor.lastId})
    )`);
  }
  const direction = input.query.direction;
  if (input.query.sort === "amount") {
    query = query.orderBy("expense.amount", direction).orderBy("expense.id", direction);
  } else if (input.query.sort === "merchant") {
    query = query.orderBy("expense.merchant", direction).orderBy("expense.id", direction);
  } else if (input.query.sort === "createdAt") {
    query = query.orderBy("expense.created_at", direction).orderBy("expense.id", direction);
  } else {
    query = query.orderBy("expense.incurred_on", direction).orderBy("expense.id", direction);
  }
  const rows = await query.limit(input.query.limit + 1).execute();
  const pageRows = rows.slice(0, input.query.limit);
  const lastRow = pageRows.at(-1);
  const nextCursor = rows.length > input.query.limit && lastRow
    ? encodeLedgerCursor({
        scope: cursorScope,
        filterHash,
        sort: input.query.sort,
        direction: input.query.direction,
        lastValue:
          input.query.sort === "incurredOn"
            ? dateOnly(lastRow.incurred_on as Date | string)
            : input.query.sort === "createdAt"
              ? lastRow.created_at.toISOString()
              : input.query.sort === "amount"
                ? String(lastRow.amount)
                : lastRow.merchant,
        lastId: lastRow.id,
      })
    : null;

  // Task 9: project active tag chips for expenses on this page.
  // Single bulk query — join expense_tags + tags, filter active on both sides.
  // Order: name ASC, id ASC — deterministic chip ordering per expense.
  // Scope column branched explicitly — no sql.raw() or unsafe string injection.
  const pageExpenseIds = pageRows.map((r) => r.id);
  const tagChipsByExpenseId = new Map<string, ExpenseTagChip[]>();
  if (pageExpenseIds.length > 0) {
    let chipQuery = database
      .selectFrom("app.expense_tags as et")
      .innerJoin("app.tags as t", (join) =>
        join
          .onRef("t.id", "=", "et.tag_id")
          .on("t.status", "=", "active")
          .on("t.tenant_id", "=", input.tenantId),
      )
      .select(["et.expense_id", "t.id", "t.name", "t.color"])
      .where("et.expense_id", "in", pageExpenseIds)
      .where("et.status", "=", "active")
      .where("et.tenant_id", "=", input.tenantId)
      .orderBy("t.name", "asc")
      .orderBy("t.id", "asc");
    if (input.scope.kind === "personal") {
      chipQuery = chipQuery.where("et.personal_profile_id", "=", input.scope.profileId);
    } else {
      chipQuery = chipQuery.where("et.business_id", "=", input.scope.businessId);
    }
    const chipRows = await chipQuery.execute();
    for (const chip of chipRows) {
      const chips = tagChipsByExpenseId.get(chip.expense_id) ?? [];
      chips.push({ id: chip.id, name: chip.name, color: chip.color });
      tagChipsByExpenseId.set(chip.expense_id, chips);
    }
  }

  return {
    items: pageRows.map((row) => toExpense(row, tagChipsByExpenseId.get(row.id) ?? [])),
    nextCursor,
  };
}

async function findExpense(
  database: Kysely<AppDatabase>,
  input: { tenantId: string; expenseId: string; scope: Scope },
): Promise<Selectable<ExpenseTable>> {
  let query = database
    .selectFrom("app.expenses")
    .selectAll()
    .where("id", "=", input.expenseId)
    .where("tenant_id", "=", input.tenantId)
    .where("status", "!=", "archived");
  query =
    input.scope.kind === "personal"
      ? query.where("personal_profile_id", "=", input.scope.profileId)
      : query.where("business_id", "=", input.scope.businessId);
  const row = await query.executeTakeFirst();
  if (!row) throw DomainError.notFound();
  return row;
}

async function updateExpense(
  database: Kysely<AppDatabase>,
  input: ExpenseUpdateCommand & { readonly scope: Scope },
): Promise<Expense> {
  return database.transaction().execute(async (transaction) => {
    // Lock expense for update
    const current = await transaction
      .selectFrom("app.expenses")
      .selectAll()
      .where("id", "=", input.expenseId)
      .where("tenant_id", "=", input.tenantId)
      .where("status", "!=", "archived")
      .$if(input.scope.kind === "personal", (q) =>
        q.where("personal_profile_id", "=", (input.scope as { profileId: string }).profileId),
      )
      .$if(input.scope.kind === "business", (q) =>
        q.where("business_id", "=", (input.scope as { businessId: string }).businessId),
      )
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw DomainError.notFound();

    if (input.scope.kind === "personal" && input.request.projectId !== undefined) {
      if (input.request.projectId !== null) throw DomainError.validation();
    }

    const categoryChanging =
      input.request.spendingCategoryId !== undefined &&
      input.request.spendingCategoryId !== current.spending_category_id;

    const updated = await transaction
      .updateTable("app.expenses")
      .set({
        ...(input.request.merchant === undefined ? {} : { merchant: input.request.merchant }),
        ...(input.request.description === undefined
          ? {}
          : { description: input.request.description }),
        ...(input.request.amount === undefined ? {} : { amount: input.request.amount }),
        ...(input.request.currency === undefined ? {} : { currency: input.request.currency }),
        ...(input.request.incurredOn === undefined
          ? {}
          : { incurred_on: input.request.incurredOn }),
        ...(input.request.projectId === undefined ? {} : { project_id: input.request.projectId }),
        ...(input.request.spendingCategoryId === undefined
          ? {}
          : { spending_category_id: input.request.spendingCategoryId }),
        ...(input.request.status === undefined ? {} : { status: input.request.status }),
        version: sql<number>`version + 1`,
        updated_at: new Date(),
      })
      .where("id", "=", current.id)
      .where("tenant_id", "=", input.tenantId)
      .where("version", "=", input.request.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw DomainError.conflict();

    // Manual spendingCategoryId change: append decision row + supersede pending suggestions
    if (categoryChanging) {
      await transaction
        .insertInto("app.expense_spending_category_decisions")
        .values({
          id: randomUUID(),
          tenant_id: input.tenantId,
          personal_profile_id:
            input.scope.kind === "personal"
              ? (input.scope as { profileId: string }).profileId
              : null,
          business_id:
            input.scope.kind === "business"
              ? (input.scope as { businessId: string }).businessId
              : null,
          expense_id: input.expenseId,
          prior_spending_category_id: current.spending_category_id,
          new_spending_category_id: input.request.spendingCategoryId ?? null,
          source: "manual",
          actor_user_id: input.actorUserId,
          // expense_version is the NEW version after the update
          expense_version: updated.version,
          suggestion_id: null,
        })
        .execute();

      // Supersede all pending spending_category suggestions for this expense
      const now = new Date();
      await transaction
        .updateTable("app.expense_enrichment_suggestions")
        .set({
          status: "superseded",
          resolved_at: now,
          resolved_by_user_id: null, // system supersession — resolver may be null
        })
        .where("expense_id", "=", input.expenseId)
        .where("tenant_id", "=", input.tenantId)
        .where("kind", "=", "spending_category")
        .where("status", "=", "pending")
        .execute();
    }

    await recordAuditEvent(transaction, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: "expense.updated",
      outcome: "success",
      resourceType: "expense",
      resourceId: input.expenseId,
      requestId: input.requestId,
    });
    return toExpense(updated);
  });
}

async function archiveExpense(
  database: Kysely<AppDatabase>,
  input: ExpenseArchiveCommand & { readonly scope: Scope },
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await findExpense(transaction, {
      tenantId: input.tenantId,
      expenseId: input.expenseId,
      scope: input.scope,
    });
    const updated = await transaction
      .updateTable("app.expenses")
      .set({
        status: "archived",
        archived_at: new Date(),
        updated_at: new Date(),
        version: sql<number>`version + 1`,
      })
      .where("id", "=", input.expenseId)
      .where("tenant_id", "=", input.tenantId)
      .where("version", "=", input.request.expectedVersion)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw DomainError.conflict();
    await recordAuditEvent(transaction, {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      action: "expense.archived",
      outcome: "success",
      resourceType: "expense",
      resourceId: input.expenseId,
      requestId: input.requestId,
    });
  });
}

/**
 * Fetch active tag chips for a single expense. Active association AND active tag
 * definition in same tenant/exact scope. Results ordered name ASC, id ASC.
 */
async function projectExpenseTagChips(
  database: Kysely<AppDatabase>,
  input: { tenantId: string; expenseId: string; scope: Scope },
): Promise<ExpenseTagChip[]> {
  // Scope column branched explicitly — no sql.raw() or unsafe string injection.
  let chipQuery = database
    .selectFrom("app.expense_tags as et")
    .innerJoin("app.tags as t", (join) =>
      join
        .onRef("t.id", "=", "et.tag_id")
        .on("t.status", "=", "active")
        .on("t.tenant_id", "=", input.tenantId),
    )
    .select(["t.id", "t.name", "t.color"])
    .where("et.expense_id", "=", input.expenseId)
    .where("et.status", "=", "active")
    .where("et.tenant_id", "=", input.tenantId)
    .orderBy("t.name", "asc")
    .orderBy("t.id", "asc");
  if (input.scope.kind === "personal") {
    chipQuery = chipQuery.where("et.personal_profile_id", "=", input.scope.profileId);
  } else {
    chipQuery = chipQuery.where("et.business_id", "=", input.scope.businessId);
  }
  const chipRows = await chipQuery.execute();
  return chipRows.map((r) => ({ id: r.id, name: r.name, color: r.color }));
}

export function createExpenseDomain(database: Kysely<AppDatabase>): ExpenseDomain {
  return {
    async createPersonal(input) {
      assertRequestScope(input.request, { kind: "personal", profileId: input.profileId });
      const role = await personalRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return database.transaction().execute((transaction) =>
        insertExpenseInTransaction(transaction, {
          ...input,
          scope: { kind: "personal", profileId: input.profileId },
          // Explicit mode: public manual creates are immediately ready and
          // the enrichment job is created inline in the same transaction.
          mode: "manual-ready",
        }),
      );
    },
    async createBusiness(input) {
      assertRequestScope(input.request, { kind: "business", businessId: input.businessId });
      const role = await businessRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return database.transaction().execute((transaction) =>
        insertExpenseInTransaction(transaction, {
          ...input,
          scope: { kind: "business", businessId: input.businessId },
          // Explicit mode: public manual creates are immediately ready and
          // the enrichment job is created inline in the same transaction.
          mode: "manual-ready",
        }),
      );
    },
    async listPersonal(input) {
      await personalRole(database, input);
      return queryExpenses(database, {
        ...input,
        scope: { kind: "personal", profileId: input.profileId },
      });
    },
    async listBusiness(input) {
      await businessRole(database, input);
      return queryExpenses(database, {
        ...input,
        scope: { kind: "business", businessId: input.businessId },
      });
    },
    async getPersonal(input) {
      await personalRole(database, input);
      const row = await findExpense(database, {
        tenantId: input.tenantId,
        expenseId: input.expenseId,
        scope: { kind: "personal", profileId: input.profileId },
      });
      const chips = await projectExpenseTagChips(database, {
        tenantId: input.tenantId,
        expenseId: row.id,
        scope: { kind: "personal", profileId: input.profileId },
      });
      return toExpense(row, chips);
    },
    async getBusiness(input) {
      await businessRole(database, input);
      const row = await findExpense(database, {
        tenantId: input.tenantId,
        expenseId: input.expenseId,
        scope: { kind: "business", businessId: input.businessId },
      });
      const chips = await projectExpenseTagChips(database, {
        tenantId: input.tenantId,
        expenseId: row.id,
        scope: { kind: "business", businessId: input.businessId },
      });
      return toExpense(row, chips);
    },
    async updatePersonal(input) {
      const role = await personalRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return updateExpense(database, {
        ...input,
        scope: { kind: "personal", profileId: input.profileId },
      });
    },
    async updateBusiness(input) {
      const role = await businessRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return updateExpense(database, {
        ...input,
        scope: { kind: "business", businessId: input.businessId },
      });
    },
    async archivePersonal(input) {
      const role = await personalRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return archiveExpense(database, {
        ...input,
        scope: { kind: "personal", profileId: input.profileId },
      });
    },
    async archiveBusiness(input) {
      const role = await businessRole(database, input);
      if (!canWrite(role)) throw DomainError.forbidden();
      return archiveExpense(database, {
        ...input,
        scope: { kind: "business", businessId: input.businessId },
      });
    },
  };
}
