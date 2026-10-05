import { randomUUID } from "node:crypto";

import type {
  SpendingCategory,
  SpendingCategoryArchiveRequest,
  SpendingCategoryCreateRequest,
  SpendingCategoryUpdateRequest,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type {
  AppDatabase,
  SpendingCategoryTable,
} from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";

export interface SpendingCategoryDomain {
  list(actorUserId: string, tenantId: string): Promise<readonly SpendingCategory[]>;
  create(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly request: SpendingCategoryCreateRequest;
    readonly requestId: string;
  }): Promise<SpendingCategory>;
  update(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly categoryId: string;
    readonly request: SpendingCategoryUpdateRequest;
    readonly requestId: string;
  }): Promise<SpendingCategory>;
  archive(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly categoryId: string;
    readonly request: SpendingCategoryArchiveRequest;
    readonly requestId: string;
  }): Promise<SpendingCategory>;
}

function toCategory(row: Selectable<SpendingCategoryTable>): SpendingCategory {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    templateKey: row.template_key,
    name: row.name,
    description: row.description,
    color: row.color,
    icon: row.icon,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function tenantAccess(
  database: Kysely<AppDatabase>,
  actorUserId: string,
  tenantId: string,
): Promise<"owner" | "admin" | "member"> {
  const access = await database
    .selectFrom("app.tenants as tenant")
    .innerJoin("app.tenant_memberships as membership", (join) =>
      join
        .onRef("membership.tenant_id", "=", "tenant.id")
        .on("membership.user_id", "=", actorUserId)
        .on("membership.status", "=", "active"),
    )
    .select("membership.role")
    .where("tenant.id", "=", tenantId)
    .where("tenant.status", "=", "active")
    .executeTakeFirst();
  if (!access) throw DomainError.notFound();
  return access.role;
}

async function requireTenantAdministrator(
  database: Kysely<AppDatabase>,
  actorUserId: string,
  tenantId: string,
): Promise<void> {
  const role = await tenantAccess(database, actorUserId, tenantId);
  if (role !== "owner" && role !== "admin") throw DomainError.forbidden();
}

async function requireMutableCategory(
  transaction: Transaction<AppDatabase>,
  tenantId: string,
  categoryId: string,
): Promise<void> {
  const category = await transaction
    .selectFrom("app.spending_categories")
    .select("status")
    .where("id", "=", categoryId)
    .where("tenant_id", "=", tenantId)
    .executeTakeFirst();
  if (!category) throw DomainError.notFound();
  if (category.status === "archived") throw DomainError.conflict();
}

function mapUniqueViolation(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  ) {
    throw DomainError.conflict();
  }
  throw error;
}

export function createSpendingCategoryDomain(
  database: Kysely<AppDatabase>,
): SpendingCategoryDomain {
  return {
    async list(actorUserId, tenantId) {
      await tenantAccess(database, actorUserId, tenantId);
      const rows = await database
        .selectFrom("app.spending_categories")
        .selectAll()
        .where("tenant_id", "=", tenantId)
        .where("status", "=", "active")
        .orderBy("name", "asc")
        .execute();
      return rows.map(toCategory);
    },

    async create(input) {
      try {
        return await database.transaction().execute(async (transaction) => {
          await requireTenantAdministrator(
            transaction,
            input.actorUserId,
            input.tenantId,
          );
          const now = new Date();
          const created = await transaction
            .insertInto("app.spending_categories")
            .values({
              id: randomUUID(),
              tenant_id: input.tenantId,
              template_key: null,
              name: input.request.name,
              description: input.request.description ?? null,
              color: input.request.color,
              icon: input.request.icon,
              status: "active",
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
            action: "spending_category.created",
            outcome: "success",
            resourceType: "spending_category",
            resourceId: created.id,
            requestId: input.requestId,
          });
          return toCategory(created);
        });
      } catch (error: unknown) {
        return mapUniqueViolation(error);
      }
    },

    async update(input) {
      try {
        return await database.transaction().execute(async (transaction) => {
          await requireTenantAdministrator(
            transaction,
            input.actorUserId,
            input.tenantId,
          );
          await requireMutableCategory(
            transaction,
            input.tenantId,
            input.categoryId,
          );
          const updated = await transaction
            .updateTable("app.spending_categories")
            .set({
              ...(input.request.name === undefined
                ? {}
                : { name: input.request.name }),
              ...(input.request.description === undefined
                ? {}
                : { description: input.request.description }),
              ...(input.request.color === undefined
                ? {}
                : { color: input.request.color }),
              ...(input.request.icon === undefined
                ? {}
                : { icon: input.request.icon }),
              version: sql<number>`version + 1`,
              updated_at: new Date(),
            })
            .where("id", "=", input.categoryId)
            .where("tenant_id", "=", input.tenantId)
            .where("status", "=", "active")
            .where("version", "=", input.request.expectedVersion)
            .returningAll()
            .executeTakeFirst();
          if (!updated) throw DomainError.conflict();
          await recordAuditEvent(transaction, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            action: "spending_category.updated",
            outcome: "success",
            resourceType: "spending_category",
            resourceId: input.categoryId,
            requestId: input.requestId,
          });
          return toCategory(updated);
        });
      } catch (error: unknown) {
        return mapUniqueViolation(error);
      }
    },

    async archive(input) {
      return database.transaction().execute(async (transaction) => {
        await requireTenantAdministrator(
          transaction,
          input.actorUserId,
          input.tenantId,
        );
        // Lock the category row before mutation
        await requireMutableCategory(
          transaction,
          input.tenantId,
          input.categoryId,
        );
        const updated = await transaction
          .updateTable("app.spending_categories")
          .set({
            status: "archived",
            archived_at: new Date(),
            updated_at: new Date(),
            version: sql<number>`version + 1`,
          })
          .where("id", "=", input.categoryId)
          .where("tenant_id", "=", input.tenantId)
          .where("status", "=", "active")
          .where("version", "=", input.request.expectedVersion)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();

        // Supersede pending spending_category suggestions referencing this category.
        // Only pending — accepted/rejected terminal suggestions are immutable.
        const now = new Date();
        await transaction
          .updateTable("app.expense_enrichment_suggestions")
          .set({
            status: "superseded",
            resolved_at: now,
            resolved_by_user_id: null,
          })
          .where("tenant_id", "=", input.tenantId)
          .where("kind", "=", "spending_category")
          .where("spending_category_id", "=", input.categoryId)
          .where("status", "=", "pending")
          .execute();

        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "spending_category.archived",
          outcome: "success",
          resourceType: "spending_category",
          resourceId: input.categoryId,
          requestId: input.requestId,
        });
        return toCategory(updated);
      });
    },
  };
}
