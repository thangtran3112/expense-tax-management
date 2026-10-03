import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  BusinessMembership,
  BusinessMembershipCreateRequest,
  BusinessRole,
  BusinessMembershipUpdateRequest,
  PersonalMembership,
  PersonalMembershipCreateRequest,
  PersonalMembershipUpdateRequest,
  TenantInvitation,
  TenantInvitationAcceptRequest,
  TenantInvitationCreateRequest,
  TenantMembership,
  TenantMembershipUpdateRequest,
  TenantRole,
} from "@expense-tax/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type {
  AppDatabase,
  BusinessMembershipTable,
  PersonalMembershipTable,
  TenantInvitationTable,
  TenantMembershipTable,
} from "../database/types.js";
import { DomainError } from "../errors.js";
import { recordAuditEvent } from "./audit.js";
import type { MutationResult } from "./idempotency.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface SecurityLogger {
  error(bindings: Readonly<Record<string, unknown>>, message: string): void;
}

export interface CreateInvitationCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly request: TenantInvitationCreateRequest;
  readonly requestId: string;
}

export interface AcceptInvitationCommand {
  readonly actorUserId: string;
  readonly request: TenantInvitationAcceptRequest;
  readonly requestId: string;
}

export interface UpdateTenantMembershipCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly targetUserId: string;
  readonly request: TenantMembershipUpdateRequest;
  readonly requestId: string;
}

export interface PersonalScopeCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly profileId: string;
}

export interface CreatePersonalMembershipCommand extends PersonalScopeCommand {
  readonly request: PersonalMembershipCreateRequest;
  readonly requestId: string;
}

export interface UpdatePersonalMembershipCommand extends PersonalScopeCommand {
  readonly targetUserId: string;
  readonly request: PersonalMembershipUpdateRequest;
  readonly requestId: string;
}

export interface BusinessScopeCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly businessId: string;
}

export interface CreateBusinessMembershipCommand extends BusinessScopeCommand {
  readonly request: BusinessMembershipCreateRequest;
  readonly requestId: string;
}

export interface UpdateBusinessMembershipCommand extends BusinessScopeCommand {
  readonly targetUserId: string;
  readonly request: BusinessMembershipUpdateRequest;
  readonly requestId: string;
}

export interface GetOwnPersonalProfileCommand {
  readonly actorUserId: string;
  readonly tenantId: string;
}

export interface OwnPersonalProfile {
  readonly id: string;
  readonly name: string;
}

export interface MembershipDomain {
  createInvitation(input: CreateInvitationCommand): Promise<{
    readonly invitation: TenantInvitation;
    readonly invitationToken: string;
  }>;
  acceptInvitation(
    input: AcceptInvitationCommand,
  ): Promise<MutationResult<TenantInvitation, 200>>;
  listTenantMemberships(
    actorUserId: string,
    tenantId: string,
    requestId?: string,
  ): Promise<readonly TenantMembership[]>;
  updateTenantMembership(
    input: UpdateTenantMembershipCommand,
  ): Promise<TenantMembership>;
  listPersonalMemberships(
    input: PersonalScopeCommand & { readonly requestId?: string },
  ): Promise<readonly PersonalMembership[]>;
  /**
   * Phase 3D-A Task 4, fix round 3 (Important) — the minimal, scope-
   * authorized read the Office mailbox scope-picker needs to offer the
   * caller's own Personal profile. Returns the tenant's one personal
   * profile (migration 002's `personal_profiles_tenant_unique`) only when
   * the caller has an *active personal_membership on it* -- tenant role
   * alone (tenant_membership) never qualifies, and there is no parameter
   * through which a caller could ever request a *different* member's
   * profile. Returns null when the caller has no personal-profile access
   * in this tenant at all.
   */
  getOwnPersonalProfile(
    input: GetOwnPersonalProfileCommand,
  ): Promise<OwnPersonalProfile | null>;
  createPersonalMembership(
    input: CreatePersonalMembershipCommand,
  ): Promise<PersonalMembership>;
  updatePersonalMembership(
    input: UpdatePersonalMembershipCommand,
  ): Promise<PersonalMembership>;
  listBusinessMemberships(
    input: BusinessScopeCommand & { readonly requestId?: string },
  ): Promise<readonly BusinessMembership[]>;
  createBusinessMembership(
    input: CreateBusinessMembershipCommand,
  ): Promise<BusinessMembership>;
  updateBusinessMembership(
    input: UpdateBusinessMembershipCommand,
  ): Promise<BusinessMembership>;
}

function iso(value: Date): string {
  return value.toISOString();
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

function toBusinessMembership(
  row: Selectable<BusinessMembershipTable>,
): BusinessMembership {
  return {
    businessId: row.business_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    version: row.version,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toInvitation(row: Selectable<TenantInvitationTable>): TenantInvitation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.normalized_email,
    tenantRole: row.tenant_role,
    grant: row.personal_profile_id
      ? {
            type: "personal",
            profileId: row.personal_profile_id,
            role: row.personal_role!,
          }
      : row.business_id
        ? {
            type: "business",
            businessId: row.business_id,
            role: row.business_role!,
          }
        : { type: "none" },
    expiresAt: iso(row.expires_at),
    acceptedAt: row.accepted_at ? iso(row.accepted_at) : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    createdByUserId: row.created_by_user_id,
    acceptedByUserId: row.accepted_by_user_id,
    createdAt: iso(row.created_at),
  };
}

async function tenantAdministrationAccess(
  transaction: Transaction<AppDatabase>,
  actorUserId: string,
  tenantId: string,
): Promise<"owner" | "admin"> {
  const access = await transaction
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
  if (access.role !== "owner" && access.role !== "admin") {
    throw DomainError.forbidden();
  }
  return access.role;
}

async function personalOwnerAccess(
  transaction: Transaction<AppDatabase>,
  input: PersonalScopeCommand,
): Promise<void> {
  const profile = await transaction
    .selectFrom("app.personal_profiles as profile")
    .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
      join
        .onRef("tenant_membership.tenant_id", "=", "profile.tenant_id")
        .on("tenant_membership.user_id", "=", input.actorUserId)
        .on("tenant_membership.status", "=", "active"),
    )
    .leftJoin("app.personal_memberships as personal_membership", (join) =>
      join
        .onRef("personal_membership.personal_profile_id", "=", "profile.id")
        .on("personal_membership.user_id", "=", input.actorUserId)
        .on("personal_membership.status", "=", "active"),
    )
    .select(["profile.id", "personal_membership.role"])
    .where("profile.id", "=", input.profileId)
    .where("profile.tenant_id", "=", input.tenantId)
    .executeTakeFirst();
  if (!profile) throw DomainError.notFound();
  if (profile.role !== "owner") throw DomainError.forbidden();
}

async function businessOwnerAccess(
  transaction: Transaction<AppDatabase>,
  input: BusinessScopeCommand,
): Promise<void> {
  const business = await transaction
    .selectFrom("app.businesses as business")
    .innerJoin("app.tenants as tenant", (join) =>
      join
        .onRef("tenant.id", "=", "business.tenant_id")
        .on("tenant.status", "=", "active"),
    )
    .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
      join
        .onRef("tenant_membership.tenant_id", "=", "business.tenant_id")
        .on("tenant_membership.user_id", "=", input.actorUserId)
        .on("tenant_membership.status", "=", "active"),
    )
    .leftJoin("app.business_memberships as business_membership", (join) =>
      join
        .onRef("business_membership.business_id", "=", "business.id")
        .onRef("business_membership.tenant_id", "=", "business.tenant_id")
        .on("business_membership.user_id", "=", input.actorUserId)
        .on("business_membership.status", "=", "active"),
    )
    .select(["business.id", "business_membership.role"])
    .where("business.id", "=", input.businessId)
    .where("business.tenant_id", "=", input.tenantId)
    .where("business.status", "=", "active")
    .executeTakeFirst();
  if (!business) throw DomainError.notFound();
  if (business.role !== "owner") throw DomainError.forbidden();
}

function tenantRoleRank(role: TenantRole): number {
  return role === "owner" ? 3 : role === "admin" ? 2 : 1;
}

function businessRoleRank(role: BusinessRole): number {
  return role === "owner" ? 3 : role === "editor" ? 2 : 1;
}

async function grantTenantMembership(
  transaction: Transaction<AppDatabase>,
  tenantId: string,
  userId: string,
  role: TenantRole,
  now: Date,
): Promise<void> {
  const existing = await transaction
    .selectFrom("app.tenant_memberships")
    .select(["role", "status"])
    .where("tenant_id", "=", tenantId)
    .where("user_id", "=", userId)
    .forUpdate()
    .executeTakeFirst();
  if (!existing) {
    await transaction
      .insertInto("app.tenant_memberships")
      .values({
        tenant_id: tenantId,
        user_id: userId,
        role,
        status: "active",
        version: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return;
  }

  const nextRole =
    tenantRoleRank(role) > tenantRoleRank(existing.role) ? role : existing.role;
  if (existing.status !== "active" || nextRole !== existing.role) {
    await transaction
      .updateTable("app.tenant_memberships")
      .set({
        role: nextRole,
        status: "active",
        version: sql<number>`version + 1`,
        updated_at: now,
      })
      .where("tenant_id", "=", tenantId)
      .where("user_id", "=", userId)
      .execute();
  }
}

async function grantBusinessMembership(
  transaction: Transaction<AppDatabase>,
  input: {
    businessId: string;
    tenantId: string;
    userId: string;
    role: BusinessRole;
    now: Date;
  },
): Promise<void> {
  const existing = await transaction
    .selectFrom("app.business_memberships")
    .select(["role", "status"])
    .where("business_id", "=", input.businessId)
    .where("tenant_id", "=", input.tenantId)
    .where("user_id", "=", input.userId)
    .forUpdate()
    .executeTakeFirst();
  if (!existing) {
    await transaction
      .insertInto("app.business_memberships")
      .values({
        business_id: input.businessId,
        tenant_id: input.tenantId,
        user_id: input.userId,
        role: input.role,
        status: "active",
        version: 1,
        created_at: input.now,
        updated_at: input.now,
      })
      .execute();
    return;
  }

  const nextRole =
    businessRoleRank(input.role) > businessRoleRank(existing.role)
      ? input.role
      : existing.role;
  if (existing.status !== "active" || nextRole !== existing.role) {
    await transaction
      .updateTable("app.business_memberships")
      .set({
        role: nextRole,
        status: "active",
        version: sql<number>`version + 1`,
        updated_at: input.now,
      })
      .where("business_id", "=", input.businessId)
      .where("tenant_id", "=", input.tenantId)
      .where("user_id", "=", input.userId)
      .execute();
  }
}

async function denialAudit(
  database: Kysely<AppDatabase>,
  logger: SecurityLogger,
  input: { actorUserId: string; action: string; requestId?: string },
): Promise<void> {
  const requestId = input.requestId ?? "unavailable";
  try {
    await database.transaction().execute(async (transaction) => {
      await recordAuditEvent(transaction, {
        actorUserId: input.actorUserId,
        action: input.action,
        outcome: "denied",
        resourceType: "authorization_scope",
        requestId,
      });
    });
  } catch {
    logger.error(
      { action: input.action, requestId },
      "denial audit persistence failed",
    );
  }
}

async function withDenialAudit<T>(
  database: Kysely<AppDatabase>,
  logger: SecurityLogger,
  input: { actorUserId: string; action: string; requestId?: string },
  execute: () => Promise<T>,
): Promise<T> {
  try {
    return await execute();
  } catch (error: unknown) {
    if (
      error instanceof DomainError &&
      (error.statusCode === 403 || error.statusCode === 404)
    ) {
      await denialAudit(database, logger, input);
    }
    throw error;
  }
}

async function lockScope(
  transaction: Transaction<AppDatabase>,
  scope: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`.execute(
    transaction,
  );
}

export function createMembershipDomain(
  database: Kysely<AppDatabase>,
  logger: SecurityLogger,
): MembershipDomain {
  return {
    async createInvitation(input) {
      return withDenialAudit(
        database,
        logger,
        { actorUserId: input.actorUserId, action: "invitation.create", requestId: input.requestId },
        () =>
          database.transaction().execute(async (transaction) => {
            const tenantRole = await tenantAdministrationAccess(
              transaction,
              input.actorUserId,
              input.tenantId,
            );
            if (tenantRole === "admin" && input.request.tenantRole === "owner") {
              throw DomainError.forbidden();
            }
            if (input.request.grant.type === "personal") {
              await personalOwnerAccess(transaction, {
                actorUserId: input.actorUserId,
                tenantId: input.tenantId,
                profileId: input.request.grant.profileId,
              });
            } else if (input.request.grant.type === "business") {
              await businessOwnerAccess(transaction, {
                actorUserId: input.actorUserId,
                tenantId: input.tenantId,
                businessId: input.request.grant.businessId,
              });
            }

            const now = new Date();
            const invitationToken = randomBytes(32).toString("base64url");
            const tokenHash = createHash("sha256")
              .update(invitationToken)
              .digest("hex");
            const invitationRow: Selectable<TenantInvitationTable> = {
              id: randomUUID(),
              tenant_id: input.tenantId,
              normalized_email: input.request.email,
              tenant_role: input.request.tenantRole,
              personal_profile_id:
                input.request.grant.type === "personal"
                  ? input.request.grant.profileId
                  : null,
              personal_role:
                input.request.grant.type === "personal"
                  ? input.request.grant.role
                  : null,
              business_id:
                input.request.grant.type === "business"
                  ? input.request.grant.businessId
                  : null,
              business_role:
                input.request.grant.type === "business"
                  ? input.request.grant.role
                  : null,
              token_hash: tokenHash,
              expires_at: new Date(now.getTime() + INVITATION_TTL_MS),
              accepted_at: null,
              revoked_at: null,
              created_by_user_id: input.actorUserId,
              accepted_by_user_id: null,
              created_at: now,
            };
            await transaction
              .insertInto("app.tenant_invitations")
              .values(invitationRow)
              .execute();
            await recordAuditEvent(transaction, {
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              action: "invitation.created",
              outcome: "success",
              resourceType: "tenant_invitation",
              resourceId: invitationRow.id,
              requestId: input.requestId,
            });
            return {
              invitation: toInvitation(invitationRow),
              invitationToken,
            };
          }),
      );
    },

    async acceptInvitation(input) {
      return withDenialAudit(
        database,
        logger,
        { actorUserId: input.actorUserId, action: "invitation.accept", requestId: input.requestId },
        () =>
          database.transaction().execute(async (transaction) => {
            const tokenHash = createHash("sha256")
              .update(input.request.token)
              .digest("hex");
            const invitation = await transaction
              .selectFrom("app.tenant_invitations")
              .selectAll()
              .where("token_hash", "=", tokenHash)
              .forUpdate()
              .executeTakeFirst();
            if (!invitation) throw DomainError.conflict();
            if (invitation.accepted_by_user_id === input.actorUserId) {
              return {
                statusCode: 200 as const,
                body: toInvitation(invitation),
                replayed: true,
              };
            }
            if (
              invitation.accepted_at !== null ||
              invitation.revoked_at !== null ||
              invitation.expires_at <= new Date()
            ) {
              throw DomainError.conflict();
            }

            const identities = await transaction
              .selectFrom("app.auth_identities")
              .select("verified_email")
              .where("user_id", "=", input.actorUserId)
              .where("email_verified", "=", true)
              .execute();
            if (
              !identities.some(
                (identity) =>
                  identity.verified_email === invitation.normalized_email,
              )
            ) {
              throw DomainError.forbidden();
            }

            const now = new Date();
            if (invitation.business_id) {
              const business = await transaction
                .selectFrom("app.businesses")
                .select("id")
                .where("id", "=", invitation.business_id)
                .where("tenant_id", "=", invitation.tenant_id)
                .where("status", "=", "active")
                .executeTakeFirst();
              if (!business) throw DomainError.conflict();
            }
            await grantTenantMembership(
              transaction,
              invitation.tenant_id,
              input.actorUserId,
              invitation.tenant_role,
              now,
            );
            if (invitation.personal_profile_id && invitation.personal_role) {
              await transaction
                .insertInto("app.personal_memberships")
                .values({
                  personal_profile_id: invitation.personal_profile_id,
                  tenant_id: invitation.tenant_id,
                  user_id: input.actorUserId,
                  role: invitation.personal_role,
                  status: "active",
                  version: 1,
                  created_at: now,
                  updated_at: now,
                })
                .onConflict((conflict) =>
                  conflict
                    .columns(["personal_profile_id", "user_id"])
                    .doUpdateSet({
                      role: invitation.personal_role!,
                      status: "active",
                      version: sql<number>`personal_memberships.version + 1`,
                      updated_at: now,
                    }),
                )
                .execute();
            }
            if (invitation.business_id && invitation.business_role) {
              await grantBusinessMembership(transaction, {
                businessId: invitation.business_id,
                tenantId: invitation.tenant_id,
                userId: input.actorUserId,
                role: invitation.business_role,
                now,
              });
            }
            const accepted = await transaction
              .updateTable("app.tenant_invitations")
              .set({ accepted_at: now, accepted_by_user_id: input.actorUserId })
              .where("id", "=", invitation.id)
              .returningAll()
              .executeTakeFirstOrThrow();
            await recordAuditEvent(transaction, {
              tenantId: invitation.tenant_id,
              actorUserId: input.actorUserId,
              action: "invitation.accepted",
              outcome: "success",
              resourceType: "tenant_invitation",
              resourceId: invitation.id,
              requestId: input.requestId,
            });
            return {
              statusCode: 200 as const,
              body: toInvitation(accepted),
              replayed: false,
            };
          }),
      );
    },

    async listTenantMemberships(actorUserId, tenantId, requestId) {
      return withDenialAudit(
        database,
        logger,
        {
          actorUserId,
          action: "tenant_membership.list",
          ...(requestId ? { requestId } : {}),
        },
        () =>
          database.transaction().execute(async (transaction) => {
            await tenantAdministrationAccess(transaction, actorUserId, tenantId);
            const rows = await transaction
              .selectFrom("app.tenant_memberships")
              .selectAll()
              .where("tenant_id", "=", tenantId)
              .orderBy("created_at", "asc")
              .execute();
            return rows.map(toTenantMembership);
          }),
      );
    },

    async updateTenantMembership(input) {
      return withDenialAudit(
        database,
        logger,
        { actorUserId: input.actorUserId, action: "tenant_membership.update", requestId: input.requestId },
        () =>
          database.transaction().execute(async (transaction) => {
            await lockScope(transaction, `tenant-membership:${input.tenantId}`);
            await tenantAdministrationAccess(
              transaction,
              input.actorUserId,
              input.tenantId,
            );
            const target = await transaction
              .selectFrom("app.tenant_memberships")
              .selectAll()
              .where("tenant_id", "=", input.tenantId)
              .where("user_id", "=", input.targetUserId)
              .forUpdate()
              .executeTakeFirst();
            if (!target) throw DomainError.notFound();
            const owners = await transaction
              .selectFrom("app.tenant_memberships")
              .select("user_id")
              .where("tenant_id", "=", input.tenantId)
              .where("role", "=", "owner")
              .where("status", "=", "active")
              .orderBy("user_id")
              .forUpdate()
              .execute();
            const nextRole = input.request.role ?? target.role;
            const nextStatus = input.request.status ?? target.status;
            if (
              target.role === "owner" &&
              target.status === "active" &&
              (nextRole !== "owner" || nextStatus !== "active") &&
              owners.length <= 1
            ) {
              throw DomainError.conflict();
            }
            const updated = await transaction
              .updateTable("app.tenant_memberships")
              .set({
                role: nextRole,
                status: nextStatus,
                version: sql<number>`version + 1`,
                updated_at: new Date(),
              })
              .where("tenant_id", "=", input.tenantId)
              .where("user_id", "=", input.targetUserId)
              .where("version", "=", input.request.expectedVersion)
              .returningAll()
              .executeTakeFirst();
            if (!updated) throw DomainError.conflict();
            await recordAuditEvent(transaction, {
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              action: "tenant_membership.updated",
              outcome: "success",
              resourceType: "tenant_membership",
              resourceId: input.targetUserId,
              requestId: input.requestId,
            });
            return toTenantMembership(updated);
          }),
      );
    },

    async listPersonalMemberships(input) {
      return withDenialAudit(
        database,
        logger,
        {
          actorUserId: input.actorUserId,
          action: "personal_membership.list",
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        () =>
          database.transaction().execute(async (transaction) => {
            await personalOwnerAccess(transaction, input);
            const rows = await transaction
              .selectFrom("app.personal_memberships")
              .selectAll()
              .where("personal_profile_id", "=", input.profileId)
              .where("tenant_id", "=", input.tenantId)
              .orderBy("created_at", "asc")
              .execute();
            return rows.map(toPersonalMembership);
          }),
      );
    },

    async createPersonalMembership(input) {
      return withDenialAudit(
        database,
        logger,
        { actorUserId: input.actorUserId, action: "personal_membership.create", requestId: input.requestId },
        () =>
          database.transaction().execute(async (transaction) => {
            await personalOwnerAccess(transaction, input);
            const targetUser = await transaction
              .selectFrom("app.users")
              .select("id")
              .where("id", "=", input.request.userId)
              .where("status", "=", "active")
              .executeTakeFirst();
            if (!targetUser) throw DomainError.notFound();
            const now = new Date();
            await grantTenantMembership(
              transaction,
              input.tenantId,
              input.request.userId,
              "member",
              now,
            );
            const created = await transaction
              .insertInto("app.personal_memberships")
              .values({
                personal_profile_id: input.profileId,
                tenant_id: input.tenantId,
                user_id: input.request.userId,
                role: input.request.role,
                status: "active",
                version: 1,
                created_at: now,
                updated_at: now,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            await recordAuditEvent(transaction, {
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              action: "personal_membership.created",
              outcome: "success",
              resourceType: "personal_membership",
              resourceId: input.request.userId,
              requestId: input.requestId,
            });
            return toPersonalMembership(created);
          }),
      ).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === "23505"
        ) {
          throw DomainError.conflict();
        }
        throw error;
      });
    },

    async updatePersonalMembership(input) {
      return withDenialAudit(
        database,
        logger,
        { actorUserId: input.actorUserId, action: "personal_membership.update", requestId: input.requestId },
        () =>
          database.transaction().execute(async (transaction) => {
            await lockScope(transaction, `personal-membership:${input.profileId}`);
            await personalOwnerAccess(transaction, input);
            const target = await transaction
              .selectFrom("app.personal_memberships")
              .selectAll()
              .where("personal_profile_id", "=", input.profileId)
              .where("tenant_id", "=", input.tenantId)
              .where("user_id", "=", input.targetUserId)
              .forUpdate()
              .executeTakeFirst();
            if (!target) throw DomainError.notFound();
            const owners = await transaction
              .selectFrom("app.personal_memberships")
              .select("user_id")
              .where("personal_profile_id", "=", input.profileId)
              .where("role", "=", "owner")
              .where("status", "=", "active")
              .orderBy("user_id")
              .forUpdate()
              .execute();
            const nextRole = input.request.role ?? target.role;
            const nextStatus = input.request.status ?? target.status;
            if (
              target.role === "owner" &&
              target.status === "active" &&
              (nextRole !== "owner" || nextStatus !== "active") &&
              owners.length <= 1
            ) {
              throw DomainError.conflict();
            }
            const updated = await transaction
              .updateTable("app.personal_memberships")
              .set({
                role: nextRole,
                status: nextStatus,
                version: sql<number>`version + 1`,
                updated_at: new Date(),
              })
              .where("personal_profile_id", "=", input.profileId)
              .where("tenant_id", "=", input.tenantId)
              .where("user_id", "=", input.targetUserId)
              .where("version", "=", input.request.expectedVersion)
              .returningAll()
              .executeTakeFirst();
            if (!updated) throw DomainError.conflict();
            await recordAuditEvent(transaction, {
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              action: "personal_membership.updated",
              outcome: "success",
              resourceType: "personal_membership",
              resourceId: input.targetUserId,
              requestId: input.requestId,
            });
            return toPersonalMembership(updated);
          }),
      );
    },

    async listBusinessMemberships(input) {
      return withDenialAudit(
        database,
        logger,
        {
          actorUserId: input.actorUserId,
          action: "business_membership.list",
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        () =>
          database.transaction().execute(async (transaction) => {
            await businessOwnerAccess(transaction, input);
            const rows = await transaction
              .selectFrom("app.business_memberships")
              .selectAll()
              .where("business_id", "=", input.businessId)
              .where("tenant_id", "=", input.tenantId)
              .orderBy("created_at", "asc")
              .execute();
            return rows.map(toBusinessMembership);
          }),
      );
    },

    async createBusinessMembership(input) {
      return withDenialAudit(
        database,
        logger,
        {
          actorUserId: input.actorUserId,
          action: "business_membership.create",
          requestId: input.requestId,
        },
        () =>
          database.transaction().execute(async (transaction) => {
            await businessOwnerAccess(transaction, input);
            const target = await transaction
              .selectFrom("app.users as user")
              .innerJoin("app.tenant_memberships as tenant_membership", (join) =>
                join
                  .on("tenant_membership.tenant_id", "=", input.tenantId)
                  .onRef("tenant_membership.user_id", "=", "user.id")
                  .on("tenant_membership.status", "=", "active"),
              )
              .select("user.id")
              .where("user.id", "=", input.request.userId)
              .where("user.status", "=", "active")
              .executeTakeFirst();
            if (!target) throw DomainError.notFound();
            const now = new Date();
            const created = await transaction
              .insertInto("app.business_memberships")
              .values({
                business_id: input.businessId,
                tenant_id: input.tenantId,
                user_id: input.request.userId,
                role: input.request.role,
                status: "active",
                version: 1,
                created_at: now,
                updated_at: now,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            await recordAuditEvent(transaction, {
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              action: "business_membership.created",
              outcome: "success",
              resourceType: "business_membership",
              resourceId: input.request.userId,
              requestId: input.requestId,
            });
            return toBusinessMembership(created);
          }),
      ).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          (error as { code?: unknown }).code === "23505"
        ) {
          throw DomainError.conflict();
        }
        throw error;
      });
    },

    async updateBusinessMembership(input) {
      return withDenialAudit(
        database,
        logger,
        {
          actorUserId: input.actorUserId,
          action: "business_membership.update",
          requestId: input.requestId,
        },
        () =>
          database.transaction().execute(async (transaction) => {
            await lockScope(transaction, `business-membership:${input.businessId}`);
            await businessOwnerAccess(transaction, input);
            const target = await transaction
              .selectFrom("app.business_memberships")
              .selectAll()
              .where("business_id", "=", input.businessId)
              .where("tenant_id", "=", input.tenantId)
              .where("user_id", "=", input.targetUserId)
              .forUpdate()
              .executeTakeFirst();
            if (!target) throw DomainError.notFound();
            const owners = await transaction
              .selectFrom("app.business_memberships")
              .select("user_id")
              .where("business_id", "=", input.businessId)
              .where("tenant_id", "=", input.tenantId)
              .where("role", "=", "owner")
              .where("status", "=", "active")
              .orderBy("user_id")
              .forUpdate()
              .execute();
            const nextRole = input.request.role ?? target.role;
            const nextStatus = input.request.status ?? target.status;
            if (
              target.role === "owner" &&
              target.status === "active" &&
              (nextRole !== "owner" || nextStatus !== "active") &&
              owners.length <= 1
            ) {
              throw DomainError.conflict();
            }
            const updated = await transaction
              .updateTable("app.business_memberships")
              .set({
                role: nextRole,
                status: nextStatus,
                version: sql<number>`version + 1`,
                updated_at: new Date(),
              })
              .where("business_id", "=", input.businessId)
              .where("tenant_id", "=", input.tenantId)
              .where("user_id", "=", input.targetUserId)
              .where("version", "=", input.request.expectedVersion)
              .returningAll()
              .executeTakeFirst();
            if (!updated) throw DomainError.conflict();
            await recordAuditEvent(transaction, {
              tenantId: input.tenantId,
              actorUserId: input.actorUserId,
              action: "business_membership.updated",
              outcome: "success",
              resourceType: "business_membership",
              resourceId: input.targetUserId,
              requestId: input.requestId,
            });
            return toBusinessMembership(updated);
          }),
      );
    },

    async getOwnPersonalProfile(input) {
      const row = await database
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
        // Active personal_membership is the actual grant -- tenant role
        // (tenant_membership above) alone never qualifies. This inner join
        // is also *why* this can never return a different member's
        // profile: it's scoped to input.actorUserId's own row, not a
        // caller-supplied target user.
        .innerJoin("app.personal_memberships as membership", (join) =>
          join
            .onRef("membership.personal_profile_id", "=", "profile.id")
            .onRef("membership.tenant_id", "=", "profile.tenant_id")
            .on("membership.user_id", "=", input.actorUserId)
            .on("membership.status", "=", "active"),
        )
        .select(["profile.id", "profile.name"])
        .where("profile.tenant_id", "=", input.tenantId)
        .executeTakeFirst();
      return row ? { id: row.id, name: row.name } : null;
    },
  };
}
