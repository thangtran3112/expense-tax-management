import { randomUUID } from "node:crypto";

import type {
  BusinessTaxProfile,
  BusinessTaxProfileCreateRequest,
  BusinessTaxProfileUpdateRequest,
  ExpenseTaxTreatment,
  ExpenseTaxTreatmentCreateRequest,
  TaxCategoryDefinition,
  TaxonomyVersion,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable } from "kysely";

import type {
  AppDatabase,
  BusinessTaxProfileTable,
  ExpenseTaxTreatmentTable,
  TaxCategoryDefinitionTable,
  TaxonomyVersionTable,
} from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";

interface BusinessScope {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly businessId: string;
}

export interface TaxDomain {
  listTaxonomies(): Promise<readonly TaxonomyVersion[]>;
  listTaxCategories(taxonomyVersionId: string): Promise<readonly TaxCategoryDefinition[]>;
  createProfile(input: BusinessScope & {
    readonly request: BusinessTaxProfileCreateRequest;
    readonly requestId: string;
  }): Promise<BusinessTaxProfile>;
  getProfile(input: BusinessScope & { readonly taxYear: number }): Promise<BusinessTaxProfile>;
  updateProfile(input: BusinessScope & {
    readonly taxYear: number;
    readonly request: BusinessTaxProfileUpdateRequest;
    readonly requestId: string;
  }): Promise<BusinessTaxProfile>;
  closeProfile(input: BusinessScope & {
    readonly taxYear: number;
    readonly expectedVersion: number;
    readonly requestId: string;
  }): Promise<void>;
  getTreatment(input: BusinessScope & { readonly expenseId: string }): Promise<ExpenseTaxTreatment>;
  upsertTreatment(input: BusinessScope & {
    readonly expenseId: string;
    readonly request: ExpenseTaxTreatmentCreateRequest;
    readonly requestId: string;
  }): Promise<ExpenseTaxTreatment>;
  deleteTreatment(input: BusinessScope & {
    readonly expenseId: string;
    readonly requestId: string;
  }): Promise<void>;
}

function toTaxonomy(row: Selectable<TaxonomyVersionTable>): TaxonomyVersion {
  return {
    id: row.id,
    jurisdictionCode: row.jurisdiction_code,
    taxYear: row.tax_year,
    code: row.code,
    name: row.name,
    status: row.status,
    sourceUrl: row.source_url,
    sourceRevision: row.source_revision,
    sourceChecksum: row.source_checksum,
    createdAt: row.created_at.toISOString(),
  };
}

function toTaxCategory(
  row: Selectable<TaxCategoryDefinitionTable>,
): TaxCategoryDefinition {
  return {
    id: row.id,
    taxonomyVersionId: row.taxonomy_version_id,
    code: row.code,
    name: row.name,
    description: row.description,
    officialForm: row.official_form,
    officialLine: row.official_line,
    status: row.status,
    sortOrder: row.sort_order,
  };
}

function toProfile(row: Selectable<BusinessTaxProfileTable>): BusinessTaxProfile {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    businessId: row.business_id,
    taxYear: row.tax_year,
    taxonomyVersionId: row.taxonomy_version_id,
    taxForm: row.tax_form,
    accountingMethod: row.accounting_method,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toTreatment(row: Selectable<ExpenseTaxTreatmentTable>): ExpenseTaxTreatment {
  return {
    expenseId: row.expense_id,
    tenantId: row.tenant_id,
    businessId: row.business_id,
    taxYear: row.tax_year,
    businessTaxProfileId: row.business_tax_profile_id,
    taxonomyVersionId: row.taxonomy_version_id,
    taxCategoryDefinitionId: row.tax_category_definition_id,
    deductiblePercent: String(row.deductible_percent),
    reviewStatus: row.review_status,
    note: row.note,
    version: row.version,
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function businessRole(
  database: Kysely<AppDatabase>,
  input: BusinessScope,
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

async function requireRole(
  database: Kysely<AppDatabase>,
  input: BusinessScope,
  roles: readonly ("owner" | "editor" | "viewer")[],
): Promise<void> {
  const role = await businessRole(database, input);
  if (!roles.includes(role)) throw DomainError.forbidden();
}

async function findProfile(
  database: Kysely<AppDatabase>,
  input: BusinessScope & { taxYear: number },
): Promise<Selectable<BusinessTaxProfileTable>> {
  const profile = await database
    .selectFrom("app.business_tax_profiles")
    .selectAll()
    .where("tenant_id", "=", input.tenantId)
    .where("business_id", "=", input.businessId)
    .where("tax_year", "=", input.taxYear)
    .executeTakeFirst();
  if (!profile) throw DomainError.notFound();
  return profile;
}

export function createTaxDomain(database: Kysely<AppDatabase>): TaxDomain {
  return {
    async listTaxonomies() {
      const rows = await database
        .selectFrom("app.taxonomy_versions")
        .selectAll()
        .orderBy("tax_year", "desc")
        .execute();
      return rows.map(toTaxonomy);
    },
    async listTaxCategories(taxonomyVersionId) {
      const rows = await database
        .selectFrom("app.tax_category_definitions")
        .selectAll()
        .where("taxonomy_version_id", "=", taxonomyVersionId)
        .where("status", "=", "active")
        .orderBy("sort_order", "asc")
        .execute();
      return rows.map(toTaxCategory);
    },
    async createProfile(input) {
      await requireRole(database, input, ["owner"]);
      try {
        return await database.transaction().execute(async (transaction) => {
          const taxonomy = await transaction
            .selectFrom("app.taxonomy_versions")
            .select("id")
            .where("tax_year", "=", input.request.taxYear)
            .where("status", "=", "active")
            .executeTakeFirst();
          if (!taxonomy) throw DomainError.validation();
          const now = new Date();
          const created = await transaction
            .insertInto("app.business_tax_profiles")
            .values({
              id: randomUUID(),
              tenant_id: input.tenantId,
              business_id: input.businessId,
              tax_year: input.request.taxYear,
              taxonomy_version_id: taxonomy.id,
              tax_form: "schedule_c",
              accounting_method: input.request.accountingMethod,
              status: "draft",
              version: 1,
              created_at: now,
              updated_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await recordAuditEvent(transaction, {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            action: "tax_profile.created",
            outcome: "success",
            resourceType: "business_tax_profile",
            resourceId: created.id,
            requestId: input.requestId,
          });
          return toProfile(created);
        });
      } catch (error: unknown) {
        if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23505") {
          throw DomainError.conflict();
        }
        throw error;
      }
    },
    async getProfile(input) {
      await requireRole(database, input, ["owner", "editor", "viewer"]);
      return toProfile(await findProfile(database, input));
    },
    async updateProfile(input) {
      await requireRole(database, input, ["owner"]);
      return database.transaction().execute(async (transaction) => {
        // Lock the profile row
        const current = await transaction
          .selectFrom("app.business_tax_profiles")
          .select(["id", "version", "status"])
          .where("tenant_id", "=", input.tenantId)
          .where("business_id", "=", input.businessId)
          .where("tax_year", "=", input.taxYear)
          .forUpdate()
          .executeTakeFirst();
        if (!current) throw DomainError.notFound();
        if (current.version !== input.request.expectedVersion) throw DomainError.conflict();

        const updated = await transaction
          .updateTable("app.business_tax_profiles")
          .set({
            ...(input.request.accountingMethod === undefined
              ? {}
              : { accounting_method: input.request.accountingMethod }),
            ...(input.request.status === undefined ? {} : { status: input.request.status }),
            version: sql<number>`version + 1`,
            updated_at: new Date(),
          })
          .where("tenant_id", "=", input.tenantId)
          .where("business_id", "=", input.businessId)
          .where("tax_year", "=", input.taxYear)
          .where("version", "=", input.request.expectedVersion)
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();

        // Supersede pending tax suggestions whose stored snapshot matches this profile
        // (profile version has changed, so snapshot is stale)
        const now = new Date();
        await transaction
          .updateTable("app.expense_enrichment_suggestions")
          .set({
            status: "superseded",
            resolved_at: now,
            resolved_by_user_id: null,
          })
          .where("tenant_id", "=", input.tenantId)
          .where("kind", "=", "tax_category")
          .where("business_tax_profile_id", "=", current.id)
          .where("business_tax_profile_version", "=", input.request.expectedVersion)
          .where("status", "=", "pending")
          .execute();

        return toProfile(updated);
      });
    },
    async closeProfile(input) {
      await requireRole(database, input, ["owner"]);
      return database.transaction().execute(async (transaction) => {
        // Lock the profile row
        const current = await transaction
          .selectFrom("app.business_tax_profiles")
          .select(["id", "version", "status"])
          .where("tenant_id", "=", input.tenantId)
          .where("business_id", "=", input.businessId)
          .where("tax_year", "=", input.taxYear)
          .forUpdate()
          .executeTakeFirst();
        if (!current || current.status === "closed") throw DomainError.conflict();
        if (current.version !== input.expectedVersion) throw DomainError.conflict();

        const updated = await transaction
          .updateTable("app.business_tax_profiles")
          .set({ status: "closed", version: sql<number>`version + 1`, updated_at: new Date() })
          .where("tenant_id", "=", input.tenantId)
          .where("business_id", "=", input.businessId)
          .where("tax_year", "=", input.taxYear)
          .where("version", "=", input.expectedVersion)
          .where("status", "!=", "closed")
          .returning("id")
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();

        // Supersede pending tax suggestions for this profile
        const now = new Date();
        await transaction
          .updateTable("app.expense_enrichment_suggestions")
          .set({
            status: "superseded",
            resolved_at: now,
            resolved_by_user_id: null,
          })
          .where("tenant_id", "=", input.tenantId)
          .where("kind", "=", "tax_category")
          .where("business_tax_profile_id", "=", current.id)
          .where("status", "=", "pending")
          .execute();
      });
    },
    async getTreatment(input) {
      await requireRole(database, input, ["owner", "editor", "viewer"]);
      const row = await database
        .selectFrom("app.expense_tax_treatments")
        .selectAll()
        .where("expense_id", "=", input.expenseId)
        .where("tenant_id", "=", input.tenantId)
        .where("business_id", "=", input.businessId)
        .executeTakeFirst();
      if (!row) throw DomainError.notFound();
      return toTreatment(row);
    },
    async upsertTreatment(input) {
      await requireRole(database, input, ["owner", "editor"]);
      return database.transaction().execute(async (transaction) => {
        const expense = await transaction
          .selectFrom("app.expenses")
          .select(["tax_year", "business_id", "personal_profile_id"])
          .where("id", "=", input.expenseId)
          .where("tenant_id", "=", input.tenantId)
          .where("status", "!=", "archived")
          .forUpdate()
          .executeTakeFirst();
        if (!expense || expense.business_id !== input.businessId || expense.personal_profile_id !== null) {
          throw DomainError.notFound();
        }
        const profile = await transaction
          .selectFrom("app.business_tax_profiles")
          .selectAll()
          .where("id", "=", input.request.businessTaxProfileId)
          .where("tenant_id", "=", input.tenantId)
          .where("business_id", "=", input.businessId)
          .where("tax_year", "=", expense.tax_year)
          .where("status", "=", "active")
          .forUpdate()
          .executeTakeFirst();
        if (!profile || profile.taxonomy_version_id !== input.request.taxonomyVersionId) {
          throw DomainError.validation();
        }
        const category = await transaction
          .selectFrom("app.tax_category_definitions")
          .select("id")
          .where("id", "=", input.request.taxCategoryDefinitionId)
          .where("taxonomy_version_id", "=", input.request.taxonomyVersionId)
          .where("status", "=", "active")
          .executeTakeFirst();
        if (!category) throw DomainError.validation();
        const now = new Date();
        const row = await transaction
          .insertInto("app.expense_tax_treatments")
          .values({
            expense_id: input.expenseId,
            tenant_id: input.tenantId,
            business_id: input.businessId,
            tax_year: expense.tax_year,
            business_tax_profile_id: profile.id,
            taxonomy_version_id: input.request.taxonomyVersionId,
            tax_category_definition_id: category.id,
            deductible_percent: input.request.deductiblePercent,
            review_status: input.request.reviewStatus,
            note: input.request.note ?? null,
            version: 1,
            created_by_user_id: input.actorUserId,
            updated_by_user_id: input.actorUserId,
            created_at: now,
            updated_at: now,
          })
          .onConflict((conflict) =>
            conflict.column("expense_id").doUpdateSet({
              business_tax_profile_id: profile.id,
              taxonomy_version_id: input.request.taxonomyVersionId,
              tax_category_definition_id: category.id,
              deductible_percent: input.request.deductiblePercent,
              review_status: input.request.reviewStatus,
              note: input.request.note ?? null,
              version: sql<number>`expense_tax_treatments.version + 1`,
              updated_by_user_id: input.actorUserId,
              updated_at: now,
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();

        // Supersede pending tax suggestions for this expense (treatment update invalidates them)
        await transaction
          .updateTable("app.expense_enrichment_suggestions")
          .set({
            status: "superseded",
            resolved_at: now,
            resolved_by_user_id: null,
          })
          .where("tenant_id", "=", input.tenantId)
          .where("expense_id", "=", input.expenseId)
          .where("kind", "=", "tax_category")
          .where("status", "=", "pending")
          .execute();

        return toTreatment(row);
      });
    },
    async deleteTreatment(input) {
      await requireRole(database, input, ["owner", "editor"]);
      return database.transaction().execute(async (transaction) => {
        // Lock expense for treatment delete
        await transaction
          .selectFrom("app.expenses")
          .select("id")
          .where("id", "=", input.expenseId)
          .where("tenant_id", "=", input.tenantId)
          .forUpdate()
          .executeTakeFirst();

        const deleted = await transaction
          .deleteFrom("app.expense_tax_treatments")
          .where("expense_id", "=", input.expenseId)
          .where("tenant_id", "=", input.tenantId)
          .where("business_id", "=", input.businessId)
          .returning("expense_id")
          .executeTakeFirst();
        if (!deleted) throw DomainError.notFound();

        // Supersede pending tax suggestions for this expense
        const now = new Date();
        await transaction
          .updateTable("app.expense_enrichment_suggestions")
          .set({
            status: "superseded",
            resolved_at: now,
            resolved_by_user_id: null,
          })
          .where("tenant_id", "=", input.tenantId)
          .where("expense_id", "=", input.expenseId)
          .where("kind", "=", "tax_category")
          .where("status", "=", "pending")
          .execute();
      });
    },
  };
}
