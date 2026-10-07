import { randomUUID } from "node:crypto";

import {
  TenantBootstrapSchema,
  type PersonalMembership,
  type PersonalProfile,
  type Tenant,
  type TenantBootstrap,
  type TenantCreateRequest,
  type TenantMembership,
  type TenantUpdateRequest,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable } from "kysely";

import type {
  AppDatabase,
  PersonalMembershipTable,
  PersonalProfileTable,
  TenantMembershipTable,
  TenantTable,
} from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import {
  executeIdempotentMutation,
  hashNormalizedRequest,
  type MutationResult,
} from "./idempotency.js";

export interface TenantDomain {
  create(input: {
    readonly actorUserId: string;
    readonly request: TenantCreateRequest;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<MutationResult<TenantBootstrap, 201>>;
  list(actorUserId: string): Promise<readonly Tenant[]>;
  get(actorUserId: string, tenantId: string): Promise<Tenant>;
  /**
   * Web session wiring design (2026-10-06) -- the scopes route's personal
   * side: the tenant's one personal profile (personal_profiles_tenant_unique)
   * only when the caller has an active personal_membership on it. Tenant
   * role (tenant_membership) alone never qualifies -- same join shape as
   * domain/memberships.ts's getOwnPersonalProfile, returning the full
   * PersonalProfile (not just id/name) as a 0- or 1-item array.
   */
  listOwnPersonalProfiles(
    actorUserId: string,
    tenantId: string,
  ): Promise<readonly PersonalProfile[]>;
  update(input: {
    readonly actorUserId: string;
    readonly tenantId: string;
    readonly request: TenantUpdateRequest;
    readonly requestId: string;
  }): Promise<Tenant>;
}

function iso(value: Date): string {
  return value.toISOString();
}

function toTenant(row: Selectable<TenantTable>): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toTenantMembership(
  row: Selectable<TenantMembershipTable>,
): TenantMembership {
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toPersonalProfile(
  row: Selectable<PersonalProfileTable>,
): PersonalProfile {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toPersonalMembership(
  row: Selectable<PersonalMembershipTable>,
): PersonalMembership {
  return {
    personalProfileId: row.personal_profile_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function tenantSlug(name: string, tenantId: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "tenant";
  return `${base.slice(0, 100)}-${tenantId.replaceAll("-", "").slice(0, 8)}`;
}

export function createTenantDomain(database: Kysely<AppDatabase>): TenantDomain {
  return {
    async create(input) {
      return executeIdempotentMutation(database, {
        actorKey: `user:${input.actorUserId}`,
        operationKey: "tenant.create",
        idempotencyKey: input.idempotencyKey,
        requestHash: hashNormalizedRequest(input.request),
        statusCode: 201,
        parseBody: (value) => TenantBootstrapSchema.parse(value),
        execute: async (transaction) => {
          const now = new Date();
          const tenantId = randomUUID();
          const profileId = randomUUID();
          const tenantRow: Selectable<TenantTable> = {
            id: tenantId,
            clerk_org_id: null,
            name: input.request.name,
            slug: tenantSlug(input.request.name, tenantId),
            status: "active",
            version: 1,
            created_at: now,
            updated_at: now,
            archived_at: null,
          };
          const tenantMembershipRow: Selectable<TenantMembershipTable> = {
            tenant_id: tenantId,
            user_id: input.actorUserId,
            role: "owner",
            status: "active",
            version: 1,
            created_at: now,
            updated_at: now,
          };
          const personalProfileRow: Selectable<PersonalProfileTable> = {
            id: profileId,
            tenant_id: tenantId,
            name: "Personal",
            version: 1,
            created_at: now,
            updated_at: now,
          };
          const personalMembershipRow: Selectable<PersonalMembershipTable> = {
            personal_profile_id: profileId,
            tenant_id: tenantId,
            user_id: input.actorUserId,
            role: "owner",
            status: "active",
            version: 1,
            created_at: now,
            updated_at: now,
          };

          await transaction.insertInto("app.tenants").values(tenantRow).execute();
          await transaction
            .insertInto("app.tenant_memberships")
            .values(tenantMembershipRow)
            .execute();
          await transaction
            .insertInto("app.personal_profiles")
            .values(personalProfileRow)
            .execute();
          await transaction
            .insertInto("app.personal_memberships")
            .values(personalMembershipRow)
            .execute();
          await recordAuditEvent(transaction, {
            tenantId,
            actorUserId: input.actorUserId,
            action: "tenant.created",
            outcome: "success",
            resourceType: "tenant",
            resourceId: tenantId,
            requestId: input.requestId,
          });

          return {
            tenant: toTenant(tenantRow),
            tenantMembership: toTenantMembership(tenantMembershipRow),
            personalProfile: toPersonalProfile(personalProfileRow),
            personalMembership: toPersonalMembership(personalMembershipRow),
          };
        },
      });
    },

    async list(actorUserId) {
      const rows = await database
        .selectFrom("app.tenants as tenant")
        .innerJoin("app.tenant_memberships as membership", (join) =>
          join
            .onRef("membership.tenant_id", "=", "tenant.id")
            .on("membership.user_id", "=", actorUserId)
            .on("membership.status", "=", "active"),
        )
        .selectAll("tenant")
        .where("tenant.status", "=", "active")
        .orderBy("tenant.created_at", "asc")
        .execute();
      return rows.map(toTenant);
    },

    async get(actorUserId, tenantId) {
      const row = await database
        .selectFrom("app.tenants as tenant")
        .innerJoin("app.tenant_memberships as membership", (join) =>
          join
            .onRef("membership.tenant_id", "=", "tenant.id")
            .on("membership.user_id", "=", actorUserId)
            .on("membership.status", "=", "active"),
        )
        .selectAll("tenant")
        .where("tenant.id", "=", tenantId)
        .where("tenant.status", "=", "active")
        .executeTakeFirst();
      if (!row) throw DomainError.notFound();
      return toTenant(row);
    },

    async listOwnPersonalProfiles(actorUserId, tenantId) {
      const rows = await database
        .selectFrom("app.personal_profiles as profile")
        .innerJoin("app.tenants as tenant", (join) =>
          join
            .onRef("tenant.id", "=", "profile.tenant_id")
            .on("tenant.status", "=", "active"),
        )
        .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
          join
            .onRef("tenant_membership.tenant_id", "=", "profile.tenant_id")
            .on("tenant_membership.user_id", "=", actorUserId)
            .on("tenant_membership.status", "=", "active"),
        )
        // Active personal_membership is the actual grant -- tenant role
        // alone (tenant_membership above) never qualifies, same as
        // domain/memberships.ts's getOwnPersonalProfile.
        .innerJoin("app.personal_memberships as membership", (join) =>
          join
            .onRef("membership.personal_profile_id", "=", "profile.id")
            .onRef("membership.tenant_id", "=", "profile.tenant_id")
            .on("membership.user_id", "=", actorUserId)
            .on("membership.status", "=", "active"),
        )
        .selectAll("profile")
        .where("profile.tenant_id", "=", tenantId)
        .execute();
      return rows.map(toPersonalProfile);
    },

    async update(input) {
      return database.transaction().execute(async (transaction) => {
        const access = await transaction
          .selectFrom("app.tenants as tenant")
          .innerJoin("app.tenant_memberships as membership", (join) =>
            join
              .onRef("membership.tenant_id", "=", "tenant.id")
              .on("membership.user_id", "=", input.actorUserId)
              .on("membership.status", "=", "active"),
          )
          .select(["membership.role"])
          .where("tenant.id", "=", input.tenantId)
          .where("tenant.status", "=", "active")
          .executeTakeFirst();
        if (!access) throw DomainError.notFound();
        if (access.role !== "owner" && access.role !== "admin") {
          throw DomainError.forbidden();
        }

        const updated = await transaction
          .updateTable("app.tenants")
          .set({
            name: input.request.name,
            version: sql<number>`version + 1`,
            updated_at: new Date(),
          })
          .where("id", "=", input.tenantId)
          .where("version", "=", input.request.expectedVersion)
          .where("status", "=", "active")
          .returningAll()
          .executeTakeFirst();
        if (!updated) throw DomainError.conflict();
        await recordAuditEvent(transaction, {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          action: "tenant.updated",
          outcome: "success",
          resourceType: "tenant",
          resourceId: input.tenantId,
          requestId: input.requestId,
        });
        return toTenant(updated);
      });
    },
  };
}
