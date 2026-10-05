/**
 * Task 8 — Tag CRUD, Association Decisions, and Merge Transaction.
 * Fix Round 1 corrections:
 *
 * F1/Fix-1: archiveTag now runs in ONE transaction: archive tag row + supersede
 *   pending tag suggestions with resolved_at and resolved_by_user_id set. Only
 *   pending suggestions are touched; accepted/rejected remain immutable.
 *   _acceptTagSuggestion checks tag status at acceptance time and rejects if archived.
 *
 * F1/Fix-2: createTag, updateTag, archiveTag, unarchiveTag each run entirely in a
 *   single database transaction — the mutation and its audit event are atomic.
 *   A failure after the INSERT/UPDATE but before the audit no longer leaves the
 *   mutation without an audit record.
 *
 * F1/Fix-3: removeExpenseTag UPDATE predicate now includes the exact scope column:
 *   personal_profile_id for personal scope, business_id for business scope.
 *   This prevents a user with access to a tag on one scope removing the row for
 *   the same (expense_id, tag_id) pair that belongs to another scope.
 *
 * F1/Fix-5: resolveSuggestion returns the version number read back from the DB
 *   after the UPDATE, not a manually computed finalVersion. Both the initial
 *   response and the stored replay record carry this actual DB value.
 *
 * F1/Fix-6: Merge collision handling never hard-deletes the source association.
 *   When target wins, source is rewritten to source=manual/status=removed with
 *   removed_at/removed_by_user_id so the full history is preserved. When source
 *   wins, source is rewritten to tag_id=target and retained; target is rewritten
 *   with the source decision. Audit metadata includes provenanceSrcWins and
 *   provenanceTgtWins counts.
 *
 * F1/Fix-7: listTags uses a composite opaque cursor (name, id) matching the
 *   ORDER BY (name ASC, id ASC), so tags with identical names are handled
 *   correctly across page boundaries. Cursor is base64-encoded JSON {n,i}.
 */

import { randomUUID } from "node:crypto";

import {
  type Tag,
  type TagList,
  type TagCreateRequest,
  type TagUpdateRequest,
  type TagArchiveRequest,
  type TagUnarchiveRequest,
  type ExpenseTag,
  type ExpenseTagList,
  type EnrichmentSuggestionList,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { AppDatabase } from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";

// ------------------------------------------------------------------ //
// Mapping helpers
// ------------------------------------------------------------------ //

type TagRow = {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  color: string | null;
  origin: "custom" | "rule";
  status: "active" | "archived";
  version: number;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function toTag(row: TagRow): Tag {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    key: row.key,
    name: row.name,
    color: row.color,
    origin: row.origin,
    status: row.status,
    version: row.version,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

type ExpenseTagRow = {
  id: string;
  tenant_id: string;
  personal_profile_id: string | null;
  business_id: string | null;
  expense_id: string;
  tag_id: string;
  source: "manual" | "rule" | "historical" | "ai";
  confidence: string;
  rule_version: number | null;
  suggestion_id: string | null;
  status: "active" | "removed";
  version: number;
  applied_by_user_id: string | null;
  removed_by_user_id: string | null;
  applied_at: Date | null;
  removed_at: Date | null;
  created_at: Date;
};

function toExpenseTag(row: ExpenseTagRow): ExpenseTag {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    personalProfileId: row.personal_profile_id,
    businessId: row.business_id,
    expenseId: row.expense_id,
    tagId: row.tag_id,
    source: row.source,
    confidence: Number(row.confidence),
    ruleVersion: row.rule_version,
    suggestionId: row.suggestion_id,
    status: row.status,
    version: row.version,
    appliedByUserId: row.applied_by_user_id,
    removedByUserId: row.removed_by_user_id,
    appliedAt: row.applied_at?.toISOString() ?? null,
    removedAt: row.removed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

// ------------------------------------------------------------------ //
// Opaque cursor helpers — Fix-7
// ------------------------------------------------------------------ //

/**
 * Encode a (name, id) pair as a base64 opaque cursor.
 * ORDER BY: name ASC, id ASC — cursor pages forward from position (name, id).
 */
function encodeCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify({ n: name, i: id })).toString("base64");
}

/**
 * Decode the opaque cursor. Returns null on any parse error (treat as no cursor).
 */
function decodeCursor(cursor: string): { n: string; i: string } | null {
  try {
    const obj = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as unknown;
    if (typeof obj === "object" && obj !== null && "n" in obj && "i" in obj) {
      const { n, i } = obj as { n: unknown; i: unknown };
      if (typeof n === "string" && typeof i === "string") return { n, i };
    }
    return null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ //
// Auth helpers
// ------------------------------------------------------------------ //

async function requireTenantMembership(
  db: Kysely<AppDatabase> | Transaction<AppDatabase>,
  actorUserId: string,
  tenantId: string,
): Promise<"owner" | "admin" | "member"> {
  const access = await db
    .selectFrom("app.tenant_memberships as m")
    .innerJoin("app.tenants as t", (join) =>
      join.onRef("t.id", "=", "m.tenant_id").on("t.status", "=", "active"),
    )
    .select("m.role")
    .where("m.tenant_id", "=", tenantId)
    .where("m.user_id", "=", actorUserId)
    .where("m.status", "=", "active")
    .executeTakeFirst();
  if (!access) throw DomainError.notFound();
  return access.role;
}

async function requireTenantAdmin(
  db: Kysely<AppDatabase> | Transaction<AppDatabase>,
  actorUserId: string,
  tenantId: string,
): Promise<void> {
  const role = await requireTenantMembership(db, actorUserId, tenantId);
  if (role !== "owner" && role !== "admin") throw DomainError.forbidden();
}

// ------------------------------------------------------------------ //
// Scope membership helpers
// ------------------------------------------------------------------ //

async function requirePersonalMembership(
  db: Kysely<AppDatabase> | Transaction<AppDatabase>,
  actorUserId: string,
  tenantId: string,
  profileId: string,
): Promise<void> {
  const access = await db
    .selectFrom("app.personal_memberships as pm")
    .innerJoin("app.tenants as t", (join) =>
      join.onRef("t.id", "=", "pm.tenant_id").on("t.status", "=", "active"),
    )
    .select("pm.role")
    .where("pm.personal_profile_id", "=", profileId)
    .where("pm.tenant_id", "=", tenantId)
    .where("pm.user_id", "=", actorUserId)
    .where("pm.status", "=", "active")
    .executeTakeFirst();
  if (!access) throw DomainError.notFound();
}

async function requireBusinessMembership(
  db: Kysely<AppDatabase> | Transaction<AppDatabase>,
  actorUserId: string,
  tenantId: string,
  businessId: string,
): Promise<void> {
  const access = await db
    .selectFrom("app.business_memberships as bm")
    .innerJoin("app.tenants as t", (join) =>
      join.onRef("t.id", "=", "bm.tenant_id").on("t.status", "=", "active"),
    )
    .select("bm.role")
    .where("bm.business_id", "=", businessId)
    .where("bm.tenant_id", "=", tenantId)
    .where("bm.user_id", "=", actorUserId)
    .where("bm.status", "=", "active")
    .executeTakeFirst();
  if (!access) throw DomainError.notFound();
}

// ------------------------------------------------------------------ //
// Suggestion mapping
// ------------------------------------------------------------------ //

type SuggestionRow = {
  id: string;
  tenant_id: string;
  personal_profile_id: string | null;
  business_id: string | null;
  expense_id: string;
  job_id: string;
  kind: "tag" | "spending_category" | "tax_category";
  tag_id: string | null;
  spending_category_id: string | null;
  tax_category_definition_id: string | null;
  business_tax_profile_id: string | null;
  business_tax_profile_version: number | null;
  taxonomy_version_id: string | null;
  tax_year: number | null;
  source: "historical" | "ai";
  confidence: string;
  evidence: unknown;
  evidence_hash: string;
  status: "pending" | "accepted" | "rejected" | "superseded";
  version: number;
  expense_version: number;
  idempotency_key: string;
  resolved_by_user_id: string | null;
  resolved_at: Date | null;
  created_at: Date;
};

function toSuggestion(row: SuggestionRow) {
  const base = {
    id: row.id,
    tenantId: row.tenant_id,
    personalProfileId: row.personal_profile_id,
    businessId: row.business_id,
    expenseId: row.expense_id,
    jobId: row.job_id,
    kind: row.kind,
    source: row.source,
    confidence: Number(row.confidence),
    evidence: row.evidence as Record<string, unknown>,
    evidenceHash: row.evidence_hash,
    status: row.status,
    version: row.version,
    expenseVersion: row.expense_version,
    idempotencyKey: row.idempotency_key,
    resolvedByUserId: row.resolved_by_user_id,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
  if (row.kind === "tag") {
    return {
      ...base, kind: "tag" as const,
      tagId: row.tag_id!,
      spendingCategoryId: null,
      taxCategoryDefinitionId: null,
      businessTaxProfileId: null,
      businessTaxProfileVersion: null,
      taxonomyVersionId: null,
      taxYear: null,
    };
  } else if (row.kind === "spending_category") {
    return {
      ...base, kind: "spending_category" as const,
      tagId: null,
      spendingCategoryId: row.spending_category_id!,
      taxCategoryDefinitionId: null,
      businessTaxProfileId: null,
      businessTaxProfileVersion: null,
      taxonomyVersionId: null,
      taxYear: null,
    };
  } else {
    return {
      ...base, kind: "tax_category" as const,
      tagId: null,
      spendingCategoryId: null,
      taxCategoryDefinitionId: row.tax_category_definition_id!,
      businessTaxProfileId: row.business_tax_profile_id!,
      businessTaxProfileVersion: row.business_tax_profile_version!,
      taxonomyVersionId: row.taxonomy_version_id!,
      taxYear: row.tax_year!,
    };
  }
}

async function supersedePendingTagSuggestions(
  transaction: Transaction<AppDatabase>,
  input: {
    readonly tenantId: string;
    readonly expenseId: string;
    readonly tagId: string;
    readonly actorUserId: string;
    readonly now: Date;
  },
): Promise<void> {
  await transaction
    .updateTable("app.expense_enrichment_suggestions")
    .set({
      status: "superseded",
      resolved_at: input.now,
      resolved_by_user_id: input.actorUserId,
    })
    .where("tenant_id", "=", input.tenantId)
    .where("expense_id", "=", input.expenseId)
    .where("kind", "=", "tag")
    .where("tag_id", "=", input.tagId)
    .where("status", "=", "pending")
    .execute();
}

// ------------------------------------------------------------------ //
// Precedence helpers for merge
// ------------------------------------------------------------------ //

/**
 * Numeric precedence: higher = stronger.
 * manual-removed (4) > manual-active (3) > historical-active (2) > rule-active (1) > none (0)
 */
function associationPrecedence(source: string, status: string): number {
  if (source === "manual" && status === "removed") return 4;
  if (source === "manual" && status === "active") return 3;
  if (source === "historical" && status === "active") return 2;
  if (status === "active") return 1;
  return 0;
}

// ------------------------------------------------------------------ //
// TagDomain interface
// ------------------------------------------------------------------ //

export interface TagDomain {
  listTags(input: {
    actorUserId: string;
    tenantId: string;
    cursor?: string;
  }): Promise<TagList>;

  createTag(input: {
    actorUserId: string;
    tenantId: string;
    request: TagCreateRequest;
    requestId: string;
  }): Promise<Tag>;

  updateTag(input: {
    actorUserId: string;
    tenantId: string;
    tagId: string;
    request: TagUpdateRequest;
    requestId: string;
  }): Promise<Tag>;

  archiveTag(input: {
    actorUserId: string;
    tenantId: string;
    tagId: string;
    request: TagArchiveRequest;
    requestId: string;
  }): Promise<Tag>;

  unarchiveTag(input: {
    actorUserId: string;
    tenantId: string;
    tagId: string;
    request: TagUnarchiveRequest;
    requestId: string;
  }): Promise<Tag>;

  mergeTags(input: {
    actorUserId: string;
    tenantId: string;
    sourceTagId: string;
    targetTagId: string;
    expectedSourceVersion: number;
    expectedTargetVersion: number;
    requestId: string;
  }): Promise<void>;

  listExpenseTags(input: {
    actorUserId: string;
    tenantId: string;
    profileId: string | null;
    businessId: string | null;
    expenseId: string;
    cursor?: string;
  }): Promise<ExpenseTagList>;

  applyExpenseTag(input: {
    actorUserId: string;
    tenantId: string;
    profileId: string | null;
    businessId: string | null;
    expenseId: string;
    tagId: string;
    requestId: string;
  }): Promise<ExpenseTag>;

  removeExpenseTag(input: {
    actorUserId: string;
    tenantId: string;
    profileId: string | null;
    businessId: string | null;
    expenseId: string;
    tagId: string;
    expectedVersion: number;
    requestId: string;
  }): Promise<void>;

  listSuggestions(input: {
    actorUserId: string;
    tenantId: string;
    profileId: string | null;
    businessId: string | null;
    expenseId: string;
    cursor?: string;
  }): Promise<EnrichmentSuggestionList>;

  resolveSuggestion(input: {
    actorUserId: string;
    tenantId: string;
    profileId: string | null;
    businessId: string | null;
    expenseId: string;
    suggestionId: string;
    request: {
      action: "accepted" | "rejected";
      expectedSuggestionVersion: number;
      expectedExpenseVersion: number;
      idempotencyKey: string;
      taxAcceptance?: { businessTaxProfileId: string; deductiblePercent: string };
    };
    requestId: string;
  }): Promise<{ suggestionId: string; status: "pending" | "accepted" | "rejected" | "superseded"; version: number }>;

  rerunEnrichment(input: {
    actorUserId: string;
    tenantId: string;
    profileId: string | null;
    businessId: string | null;
    expenseId: string;
    kinds: string[];
    requestId: string;
  }): Promise<void>;
}

// ------------------------------------------------------------------ //
// Implementation
// ------------------------------------------------------------------ //

export function createTagDomain(database: Kysely<AppDatabase>): TagDomain {
  async function getEnrichmentOps() {
    const mod = await import("./enrichment.js");
    return { resolveSuggestion: mod.resolveSuggestion, rerunEnrichment: mod.rerunEnrichment };
  }

  return {
    // ------------------------------------------------------------------
    // listTags — Fix-7: composite (name, id) keyset cursor
    // ------------------------------------------------------------------
    async listTags({ actorUserId, tenantId, cursor }) {
      await requireTenantMembership(database, actorUserId, tenantId);

      const PAGE = 50;
      let query = database
        .selectFrom("app.tags")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .orderBy("name", "asc")
        .orderBy("id", "asc")
        .limit(PAGE + 1);

      if (cursor) {
        const parsed = decodeCursor(cursor);
        if (parsed) {
          // Rows where (name > cursorName) OR (name = cursorName AND id > cursorId)
          query = query.where((eb) =>
            eb.or([
              eb("name", ">", parsed.n),
              eb.and([eb("name", "=", parsed.n), eb("id", ">", parsed.i)]),
            ]),
          );
        }
      }

      const rows = await query.execute();
      const hasMore = rows.length === PAGE + 1;
      const items = (hasMore ? rows.slice(0, PAGE) : rows).map(toTag as (r: typeof rows[0]) => Tag);
      return {
        items,
        nextCursor: hasMore
          ? encodeCursor(items[items.length - 1]!.name, items[items.length - 1]!.id)
          : null,
      };
    },

    // ------------------------------------------------------------------
    // createTag — Fix-2: single transaction (insert + audit atomic)
    // ------------------------------------------------------------------
    async createTag({ actorUserId, tenantId, request, requestId }) {
      return database.transaction().execute(async (transaction) => {
        await requireTenantAdmin(transaction, actorUserId, tenantId);
        const now = new Date();
        const tagId = randomUUID();
        const key = `custom:${tagId}`;
        const created = await transaction
          .insertInto("app.tags")
          .values({
            id: tagId,
            tenant_id: tenantId,
            key,
            name: request.name.trim(),
            color: request.color ?? null,
            origin: "custom",
            status: "active",
            created_by_user_id: actorUserId,
            created_at: now,
            updated_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await recordAuditEvent(transaction, {
          tenantId,
          actorUserId,
          action: "tag.created",
          outcome: "success",
          resourceType: "tag",
          resourceId: created.id,
          requestId,
        });
        return toTag(created as TagRow);
      });
    },

    // ------------------------------------------------------------------
    // updateTag — Fix-2: single transaction (update + audit atomic)
    // ------------------------------------------------------------------
    async updateTag({ actorUserId, tenantId, tagId, request, requestId }) {
      return database.transaction().execute(async (transaction) => {
        await requireTenantAdmin(transaction, actorUserId, tenantId);
        const updated = await transaction
          .updateTable("app.tags")
          .set({
            ...(request.name !== undefined ? { name: request.name.trim() } : {}),
            ...(request.color !== undefined ? { color: request.color } : {}),
            version: sql<number>`version + 1`,
            updated_at: new Date(),
          })
          .where("id", "=", tagId)
          .where("tenant_id", "=", tenantId)
          .where("status", "=", "active")
          .where("version", "=", request.expectedVersion)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();
        await recordAuditEvent(transaction, {
          tenantId, actorUserId,
          action: "tag.updated", outcome: "success",
          resourceType: "tag", resourceId: tagId, requestId,
        });
        return toTag(updated as TagRow);
      });
    },

    // ------------------------------------------------------------------
    // archiveTag — Fix-1 + Fix-2: single transaction; supersede pending
    //   tag suggestions with resolved_at/actor set; accepted/rejected untouched.
    // ------------------------------------------------------------------
    async archiveTag({ actorUserId, tenantId, tagId, request, requestId }) {
      return database.transaction().execute(async (transaction) => {
        await requireTenantAdmin(transaction, actorUserId, tenantId);

        // Read-then-lock pattern: check status, then apply with version predicate.
        const existing = await transaction
          .selectFrom("app.tags")
          .select(["id", "status", "version"])
          .where("id", "=", tagId)
          .where("tenant_id", "=", tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (!existing) throw DomainError.notFound();
        if (existing.status === "archived") throw DomainError.conflict();

        const now = new Date();
        const updated = await transaction
          .updateTable("app.tags")
          .set({
            status: "archived",
            version: sql<number>`version + 1`,
            updated_at: now,
          })
          .where("id", "=", tagId)
          .where("tenant_id", "=", tenantId)
          .where("status", "=", "active")
          .where("version", "=", request.expectedVersion)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();

        // Fix-1: supersede pending suggestions that reference this tag.
        // resolved_by_user_id = actorUserId (actor-driven archive, not system).
        // accepted/rejected terminal rows are untouched.
        await transaction
          .updateTable("app.expense_enrichment_suggestions")
          .set({
            status: "superseded",
            resolved_at: now,
            resolved_by_user_id: actorUserId,
          })
          .where("tenant_id", "=", tenantId)
          .where("tag_id", "=", tagId)
          .where("status", "=", "pending")
          .execute();

        await recordAuditEvent(transaction, {
          tenantId, actorUserId,
          action: "tag.archived", outcome: "success",
          resourceType: "tag", resourceId: tagId, requestId,
        });
        return toTag(updated as TagRow);
      });
    },

    // ------------------------------------------------------------------
    // unarchiveTag — Fix-2: single transaction (update + audit atomic)
    // ------------------------------------------------------------------
    async unarchiveTag({ actorUserId, tenantId, tagId, request, requestId }) {
      return database.transaction().execute(async (transaction) => {
        await requireTenantAdmin(transaction, actorUserId, tenantId);
        const updated = await transaction
          .updateTable("app.tags")
          .set({
            status: "active",
            version: sql<number>`version + 1`,
            updated_at: new Date(),
          })
          .where("id", "=", tagId)
          .where("tenant_id", "=", tenantId)
          .where("status", "=", "archived")
          .where("version", "=", request.expectedVersion)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();
        await recordAuditEvent(transaction, {
          tenantId, actorUserId,
          action: "tag.unarchived", outcome: "success",
          resourceType: "tag", resourceId: tagId, requestId,
        });
        return toTag(updated as TagRow);
      });
    },

    // ------------------------------------------------------------------
    // mergeTags — Fix-6: preserve source assoc as removed (no hard-delete);
    //   include provenanceSrcWins/provenanceTgtWins in audit metadata.
    // ------------------------------------------------------------------
    async mergeTags({
      actorUserId, tenantId, sourceTagId, targetTagId,
      expectedSourceVersion, expectedTargetVersion, requestId,
    }) {
      if (sourceTagId === targetTagId) throw DomainError.validation();
      await requireTenantAdmin(database, actorUserId, tenantId);

      await database.transaction().execute(async (transaction) => {
        const initialSourceExpenses = await transaction
          .selectFrom("app.expense_tags")
          .select("expense_id")
          .distinct()
          .where("tag_id", "=", sourceTagId)
          .where("tenant_id", "=", tenantId)
          .orderBy("expense_id", "asc")
          .execute();
        const lockedExpenseIds = initialSourceExpenses.map((row) => row.expense_id);
        if (lockedExpenseIds.length > 0) {
          await transaction
            .selectFrom("app.expenses")
            .select("id")
            .where("tenant_id", "=", tenantId)
            .where("id", "in", lockedExpenseIds)
            .orderBy("id", "asc")
            .forUpdate()
            .execute();
        }

        const [lockFirst, lockSecond] = [sourceTagId, targetTagId].sort();
        const firstTag = await transaction
          .selectFrom("app.tags")
          .selectAll()
          .where("id", "=", lockFirst!)
          .where("tenant_id", "=", tenantId)
          .forUpdate()
          .executeTakeFirst();
        const secondTag = await transaction
          .selectFrom("app.tags")
          .selectAll()
          .where("id", "=", lockSecond!)
          .where("tenant_id", "=", tenantId)
          .forUpdate()
          .executeTakeFirst();

        if (!firstTag || !secondTag) throw DomainError.notFound();

        const sourceTag = firstTag.id === sourceTagId ? firstTag : secondTag;
        const targetTag = firstTag.id === targetTagId ? firstTag : secondTag;

        if (sourceTag.version !== expectedSourceVersion) throw DomainError.conflict();
        if (targetTag.version !== expectedTargetVersion) throw DomainError.conflict();
        if (targetTag.status === "archived") throw DomainError.conflict();

        const now = new Date();

        const sourceAssocs = await transaction
          .selectFrom("app.expense_tags")
          .selectAll()
          .where("tag_id", "=", sourceTagId)
          .where("tenant_id", "=", tenantId)
          .orderBy("id", "asc")
          .forUpdate()
          .execute();

        const sourceExpenseIds = sourceAssocs.map((a) => a.expense_id);
        const lockedExpenseIdSet = new Set(lockedExpenseIds);
        if (sourceExpenseIds.some((expenseId) => !lockedExpenseIdSet.has(expenseId))) {
          throw DomainError.conflict();
        }
        const targetAssocs = sourceExpenseIds.length > 0
          ? await transaction
            .selectFrom("app.expense_tags")
            .selectAll()
            .where("tag_id", "=", targetTagId)
            .where("tenant_id", "=", tenantId)
            .where("expense_id", "in", sourceExpenseIds)
            .orderBy("id", "asc")
            .forUpdate()
            .execute()
          : [];

        const targetAssocByExpense = new Map(targetAssocs.map((a) => [a.expense_id, a]));

        let movedCount = 0;
        let provenanceSrcWins = 0;
        let provenanceTgtWins = 0;

        for (const srcAssoc of sourceAssocs) {
          const tgtAssoc = targetAssocByExpense.get(srcAssoc.expense_id);

          if (!tgtAssoc) {
            // No collision: reassign source row to target tag.
            // If source is already removed, keep all fields as-is (just tag_id + version).
            // If source is active, move it intact.
            await transaction
              .updateTable("app.expense_tags")
              .set({ tag_id: targetTagId, version: sql<number>`version + 1` })
              .where("id", "=", srcAssoc.id)
              .execute();
            movedCount++;
          } else {
            // Collision: compare precedence.
            const srcPrec = associationPrecedence(srcAssoc.source, srcAssoc.status);
            const tgtPrec = associationPrecedence(tgtAssoc.source, tgtAssoc.status);

            if (srcPrec > tgtPrec) {
              // Source decision wins:
              // 1. Copy source decision (provenance intact) onto the target row.
              await transaction
                .updateTable("app.expense_tags")
                .set({
                  source: srcAssoc.source,
                  status: srcAssoc.status,
                  confidence: srcAssoc.confidence ?? "0",
                  rule_version: srcAssoc.rule_version,
                  suggestion_id: srcAssoc.suggestion_id,
                  applied_by_user_id: srcAssoc.applied_by_user_id,
                  removed_by_user_id: srcAssoc.removed_by_user_id,
                  applied_at: srcAssoc.applied_at,
                  removed_at: srcAssoc.removed_at,
                  version: sql<number>`version + 1`,
                })
                .where("id", "=", tgtAssoc.id)
                .execute();

              // 2. Source row: preserve provenance truthfully under archived source tag.
              //    N1/N2 rules:
              //    - If source row is already removed: do NOT touch it (original remover/time/version preserved).
              //    - If source row is active: mark removed by this merge (actor/time),
              //      but keep original source/confidence/rule/suggestion/applied provenance.
              if (srcAssoc.status === "removed") {
                // Already removed — preserve entirely (no update).
              } else {
                // Active → superseded by merge: set status=removed, merge actor as remover,
                // keep all original source/confidence/rule/suggestion/applied fields.
                await transaction
                  .updateTable("app.expense_tags")
                  .set({
                    // Provenance fields: preserved verbatim from source association.
                    // source, confidence, rule_version, suggestion_id, applied_by_user_id,
                    // applied_at are NOT changed — they record what was applied originally.
                    status: "removed",
                    removed_by_user_id: actorUserId,
                    removed_at: now,
                    version: sql<number>`version + 1`,
                  })
                  .where("id", "=", srcAssoc.id)
                  .execute();
              }
              provenanceSrcWins++;
            } else {
              // Target wins (or equal — target retained by stability):
              // Source row preserved under archived source tag, truthfully.
              // Same N1/N2 rules apply:
              if (srcAssoc.status === "removed") {
                // Already removed — preserve entirely (no update).
              } else {
                // Active → superseded by merge.
                await transaction
                  .updateTable("app.expense_tags")
                  .set({
                    status: "removed",
                    removed_by_user_id: actorUserId,
                    removed_at: now,
                    version: sql<number>`version + 1`,
                  })
                  .where("id", "=", srcAssoc.id)
                  .execute();
              }
              provenanceTgtWins++;
            }
          }
        }

        // Supersede pending source suggestions with actor set
        const supersededCount = await _supersedePendingSourceSuggestions(
          transaction, tenantId, sourceTagId, now, actorUserId,
        );

        // Archive source tag
        await transaction
          .updateTable("app.tags")
          .set({
            status: "archived",
            version: sql<number>`version + 1`,
            updated_at: now,
          })
          .where("id", "=", sourceTagId)
          .execute();

        // Increment target version
        await transaction
          .updateTable("app.tags")
          .set({
            version: sql<number>`version + 1`,
            updated_at: now,
          })
          .where("id", "=", targetTagId)
          .execute();

        await recordAuditEvent(transaction, {
          tenantId, actorUserId,
          action: "tag.merged",
          outcome: "success",
          resourceType: "tag",
          resourceId: sourceTagId,
          requestId,
          metadata: {
            targetTagId,
            movedAssociations: movedCount,
            provenanceSrcWins,
            provenanceTgtWins,
            supersededSuggestions: supersededCount,
          },
        });
      });
    },

    async listExpenseTags({ actorUserId, tenantId, profileId, businessId, expenseId, cursor }) {
      if (profileId !== null) {
        await requirePersonalMembership(database, actorUserId, tenantId, profileId);
      } else if (businessId !== null) {
        await requireBusinessMembership(database, actorUserId, tenantId, businessId);
      } else {
        throw DomainError.validation();
      }
      let query = database
        .selectFrom("app.expense_tags")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("expense_id", "=", expenseId)
        .orderBy("id", "asc")
        .limit(51);
      if (profileId !== null) {
        query = query.where("personal_profile_id", "=", profileId);
      } else if (businessId !== null) {
        query = query.where("business_id", "=", businessId);
      }
      if (cursor) {
        query = query.where("id", ">", cursor);
      }
      const rows = await query.execute();
      const hasMore = rows.length === 51;
      const items = (hasMore ? rows.slice(0, 50) : rows).map(toExpenseTag as (r: typeof rows[0]) => ExpenseTag);
      return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
    },

    async applyExpenseTag({ actorUserId, tenantId, profileId, businessId, expenseId, tagId, requestId }) {
      if (profileId !== null) {
        await requirePersonalMembership(database, actorUserId, tenantId, profileId);
      } else if (businessId !== null) {
        await requireBusinessMembership(database, actorUserId, tenantId, businessId);
      } else {
        throw DomainError.validation();
      }

      return database.transaction().execute(async (transaction) => {
        const expenseScope = profileId !== null
          ? { personal_profile_id: profileId, business_id: null as string | null }
          : { personal_profile_id: null as string | null, business_id: businessId };

        let expenseQuery = transaction
          .selectFrom("app.expenses")
          .select(["id", "personal_profile_id", "business_id", "version"])
          .where("id", "=", expenseId)
          .where("tenant_id", "=", tenantId)
          .where("status", "!=", "archived");

        if (profileId !== null) {
          expenseQuery = expenseQuery.where("personal_profile_id", "=", profileId);
        } else if (businessId !== null) {
          expenseQuery = expenseQuery.where("business_id", "=", businessId);
        }

        const expense = await expenseQuery.forUpdate().executeTakeFirst();
        if (!expense) throw DomainError.notFound();

        const tag = await transaction
          .selectFrom("app.tags")
          .select(["id", "status"])
          .where("id", "=", tagId)
          .where("tenant_id", "=", tenantId)
          .forUpdate()
          .executeTakeFirst();
        if (!tag) throw DomainError.notFound();
        if (tag.status === "archived") throw DomainError.conflict();

        const now = new Date();

        const existing = await transaction
          .selectFrom("app.expense_tags")
          .selectAll()
          .where("tenant_id", "=", tenantId)
          .where("expense_id", "=", expenseId)
          .where("tag_id", "=", tagId)
          .executeTakeFirst();

        if (existing) {
          const updated = await transaction
            .updateTable("app.expense_tags")
            .set({
              source: "manual",
              status: "active",
              confidence: "1",
              rule_version: null,
              applied_by_user_id: actorUserId,
              removed_by_user_id: null,
              applied_at: now,
              removed_at: null,
              version: sql<number>`version + 1`,
            })
            .where("id", "=", existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAuditEvent(transaction, {
            tenantId, actorUserId,
            action: "expense_tag.applied", outcome: "success",
            resourceType: "expense_tag", resourceId: existing.id, requestId,
          });
          await supersedePendingTagSuggestions(transaction, {
            tenantId,
            expenseId,
            tagId,
            actorUserId,
            now,
          });
          return toExpenseTag(updated as ExpenseTagRow);
        }

        const inserted = await transaction
          .insertInto("app.expense_tags")
          .values({
            id: randomUUID(),
            tenant_id: tenantId,
            personal_profile_id: expenseScope.personal_profile_id,
            business_id: expenseScope.business_id,
            expense_id: expenseId,
            tag_id: tagId,
            source: "manual",
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
          .returningAll()
          .executeTakeFirstOrThrow();

        await recordAuditEvent(transaction, {
          tenantId, actorUserId,
          action: "expense_tag.applied", outcome: "success",
          resourceType: "expense_tag", resourceId: inserted.id, requestId,
        });
        await supersedePendingTagSuggestions(transaction, {
          tenantId,
          expenseId,
          tagId,
          actorUserId,
          now,
        });
        return toExpenseTag(inserted as ExpenseTagRow);
      });
    },

    // ------------------------------------------------------------------
    // removeExpenseTag — Fix-3: predicate includes exact scope column
    // ------------------------------------------------------------------
    async removeExpenseTag({ actorUserId, tenantId, profileId, businessId, expenseId, tagId, expectedVersion, requestId }) {
      if (profileId !== null) {
        await requirePersonalMembership(database, actorUserId, tenantId, profileId);
      } else if (businessId !== null) {
        await requireBusinessMembership(database, actorUserId, tenantId, businessId);
      } else {
        throw DomainError.validation();
      }

      return database.transaction().execute(async (transaction) => {
        const now = new Date();

        let expenseQuery = transaction
          .selectFrom("app.expenses")
          .select("id")
          .where("id", "=", expenseId)
          .where("tenant_id", "=", tenantId)
          .where("status", "!=", "archived");
        if (profileId !== null) {
          expenseQuery = expenseQuery.where("personal_profile_id", "=", profileId);
        } else if (businessId !== null) {
          expenseQuery = expenseQuery.where("business_id", "=", businessId);
        }
        const expense = await expenseQuery.forUpdate().executeTakeFirst();
        if (!expense) throw DomainError.conflict();

        // Fix-3: include exact scope ID in the predicate so a cross-scope
        // request on the same (expense_id, tag_id, version) hits nothing.
        let updateQuery = transaction
          .updateTable("app.expense_tags")
          .set({
            source: "manual",
            status: "removed",
            removed_by_user_id: actorUserId,
            removed_at: now,
            version: sql<number>`version + 1`,
          })
          .where("tenant_id", "=", tenantId)
          .where("expense_id", "=", expenseId)
          .where("tag_id", "=", tagId)
          .where("version", "=", expectedVersion);

        if (profileId !== null) {
          updateQuery = updateQuery.where("personal_profile_id", "=", profileId);
        } else if (businessId !== null) {
          updateQuery = updateQuery.where("business_id", "=", businessId);
        }

        const updated = await updateQuery.returningAll().executeTakeFirst();
        if (!updated) throw DomainError.conflict();
        await supersedePendingTagSuggestions(transaction, {
          tenantId,
          expenseId,
          tagId,
          actorUserId,
          now,
        });
        await recordAuditEvent(transaction, {
          tenantId, actorUserId,
          action: "expense_tag.removed", outcome: "success",
          resourceType: "expense_tag", resourceId: updated.id, requestId,
        });
      });
    },

    async listSuggestions({ actorUserId, tenantId, profileId, businessId, expenseId, cursor }) {
      if (profileId !== null) {
        await requirePersonalMembership(database, actorUserId, tenantId, profileId);
      } else if (businessId !== null) {
        await requireBusinessMembership(database, actorUserId, tenantId, businessId);
      } else {
        throw DomainError.validation();
      }
      let query = database
        .selectFrom("app.expense_enrichment_suggestions")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("expense_id", "=", expenseId)
        .orderBy("id", "asc")
        .limit(51);
      if (profileId !== null) {
        query = query.where("personal_profile_id", "=", profileId);
      } else if (businessId !== null) {
        query = query.where("business_id", "=", businessId);
      }
      if (cursor) {
        query = query.where("id", ">", cursor);
      }
      const rows = await query.execute();
      const hasMore = rows.length === 51;
      const items = (hasMore ? rows.slice(0, 50) : rows).map(toSuggestion as (r: typeof rows[0]) => ReturnType<typeof toSuggestion>);
      return {
        items: items as EnrichmentSuggestionList["items"],
        nextCursor: hasMore ? (items[items.length - 1] as { id: string }).id : null,
      };
    },

    async resolveSuggestion(input) {
      if (input.profileId !== null) {
        await requirePersonalMembership(database, input.actorUserId, input.tenantId, input.profileId);
      } else if (input.businessId !== null) {
        await requireBusinessMembership(database, input.actorUserId, input.tenantId, input.businessId);
      } else {
        throw DomainError.validation();
      }
      const ops = await getEnrichmentOps();
      return ops.resolveSuggestion(database, input);
    },

    async rerunEnrichment(input) {
      if (input.profileId !== null) {
        await requirePersonalMembership(database, input.actorUserId, input.tenantId, input.profileId);
      } else if (input.businessId !== null) {
        await requireBusinessMembership(database, input.actorUserId, input.tenantId, input.businessId);
      } else {
        throw DomainError.validation();
      }
      const ops = await getEnrichmentOps();
      await ops.rerunEnrichment(database, input);
    },
  };
}

// ------------------------------------------------------------------ //
// Internal helper: supersede pending tag suggestions — Fix-1 actor
// ------------------------------------------------------------------ //

async function _supersedePendingSourceSuggestions(
  transaction: Transaction<AppDatabase>,
  tenantId: string,
  sourceTagId: string,
  now: Date,
  actorUserId: string | null = null,
): Promise<number> {
  const pendingRows = await transaction
    .selectFrom("app.expense_enrichment_suggestions")
    .select(["id"])
    .where("tenant_id", "=", tenantId)
    .where("tag_id", "=", sourceTagId)
    .where("status", "=", "pending")
    .orderBy("id", "asc")
    .forUpdate()
    .execute();

  if (pendingRows.length === 0) return 0;

  await transaction
    .updateTable("app.expense_enrichment_suggestions")
    .set({
      status: "superseded",
      resolved_at: now,
      resolved_by_user_id: actorUserId,
    })
    .where("id", "in", pendingRows.map((r) => r.id))
    .execute();

  return pendingRows.length;
}
