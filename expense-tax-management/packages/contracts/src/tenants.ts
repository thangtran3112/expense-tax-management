import { z } from "zod";
import { SmallBusinessSchema } from "./businesses.js";
import {
  PersonalMembershipSchema,
  TenantMembershipSchema,
} from "./memberships.js";

const TimestampSchema = z.string().datetime({ offset: true });
const VersionSchema = z.number().int().positive();

export const TenantStatusSchema = z.enum(["active", "archived"]);

export type TenantStatus = z.infer<typeof TenantStatusSchema>;

export const TenantSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(120),
  status: TenantStatusSchema,
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type Tenant = z.infer<typeof TenantSchema>;

export const PersonalProfileSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  name: z.string().min(1).max(100),
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type PersonalProfile = z.infer<typeof PersonalProfileSchema>;

export const TenantCreateRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
});

export type TenantCreateRequest = z.infer<typeof TenantCreateRequestSchema>;

export const IdempotencyKeyHeaderSchema = z.object({
  "idempotency-key": z.string().trim().min(1).max(255),
});

export type IdempotencyKeyHeader = z.infer<
  typeof IdempotencyKeyHeaderSchema
>;

export const TenantIdParamsSchema = z.strictObject({
  tenantId: z.uuid(),
});

export type TenantIdParams = z.infer<typeof TenantIdParamsSchema>;

export const TenantUpdateRequestSchema = z.strictObject({
  expectedVersion: VersionSchema,
  name: z.string().trim().min(1).max(100),
});

export type TenantUpdateRequest = z.infer<typeof TenantUpdateRequestSchema>;

export const TenantBootstrapSchema = z.strictObject({
  tenant: TenantSchema,
  tenantMembership: TenantMembershipSchema,
  personalProfile: PersonalProfileSchema,
  personalMembership: PersonalMembershipSchema,
});

export type TenantBootstrap = z.infer<typeof TenantBootstrapSchema>;

export const TenantListSchema = z.strictObject({
  items: z.array(TenantSchema),
});

export type TenantList = z.infer<typeof TenantListSchema>;

/**
 * Web session wiring design (2026-10-06) -- the caller's authorized scope
 * choices in one tenant: personal profiles the caller has an active
 * personal-membership on (0 or 1 -- personal_profiles_tenant_unique), and
 * businesses the caller has an active business-membership on. Tenant role
 * alone never grants either (repository rule); a non-member gets the same
 * denial as GET /api/v1/tenants/{tenantId}, not an empty scopes body.
 */
export const TenantScopesSchema = z.strictObject({
  personalProfiles: z.array(PersonalProfileSchema),
  businesses: z.array(SmallBusinessSchema),
});

export type TenantScopes = z.infer<typeof TenantScopesSchema>;
