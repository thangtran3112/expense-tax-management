import {
  BusinessMembershipListSchema,
  BusinessMembershipSchema,
  PersonalMembershipListSchema,
  PersonalMembershipSchema,
  TenantInvitationCreatedSchema,
  TenantInvitationSchema,
  TenantMembershipListSchema,
  TenantMembershipSchema,
  type AuthenticatedUser,
  type BusinessMembership,
  type PersonalMembership,
  type TenantInvitation,
  type TenantMembership,
} from "@expense-tax/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";
import { DomainError } from "../src/errors.js";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
};
const IDS = {
  tenant: "11111111-1111-4111-8111-111111111111",
  profile: "22222222-2222-4222-8222-222222222222",
  owner: "33333333-3333-4333-8333-333333333333",
  admin: "44444444-4444-4444-8444-444444444444",
  member: "55555555-5555-4555-8555-555555555555",
  viewer: "66666666-6666-4666-8666-666666666666",
  invitation: "77777777-7777-4777-8777-777777777777",
  business: "88888888-8888-4888-8888-888888888888",
} as const;
const TIMESTAMP = "2026-09-08T00:00:00.000Z";
const RAW_TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1";
const TENANT_MEMBERSHIP: TenantMembership = {
  tenantId: IDS.tenant,
  userId: IDS.owner,
  role: "owner",
  status: "active",
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const PERSONAL_MEMBERSHIP: PersonalMembership = {
  personalProfileId: IDS.profile,
  tenantId: IDS.tenant,
  userId: IDS.owner,
  role: "owner",
  status: "active",
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const BUSINESS_MEMBERSHIP: BusinessMembership = {
  businessId: IDS.business,
  tenantId: IDS.tenant,
  userId: IDS.owner,
  role: "owner",
  status: "active",
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const INVITATION: TenantInvitation = {
  id: IDS.invitation,
  tenantId: IDS.tenant,
  email: "member@example.test",
  tenantRole: "member",
  grant: { type: "none" },
  expiresAt: "2026-09-15T00:00:00.000Z",
  acceptedAt: null,
  revokedAt: null,
  createdByUserId: IDS.admin,
  acceptedByUserId: null,
  createdAt: TIMESTAMP,
};

function user(subject: string): AuthenticatedUser | null {
  if (
    !(subject in IDS) ||
    subject === "tenant" ||
    subject === "profile" ||
    subject === "invitation" ||
    subject === "business"
  ) {
    return null;
  }
  return {
    id: IDS[subject as "owner" | "admin" | "member" | "viewer"],
    primaryEmail: `${subject}@example.test`,
    displayName: subject,
    status: "active",
  };
}

function principal(subject: string): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject,
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.test",
    roles: [],
    scopes: [],
    tokenId: `${subject}-token-id`,
    email: `${subject}@example.test`,
    emailVerified: true,
    displayName: subject,
  };
}

describe("App API membership routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const createInvitation = vi.fn(async (input: {
      actorUserId: string;
      request: { grant: { type: string } };
    }) => {
      if (input.request.grant.type !== "none" && input.actorUserId === IDS.admin) {
        throw DomainError.forbidden();
      }
      return { invitation: INVITATION, invitationToken: RAW_TOKEN };
    });
    const acceptInvitation = vi.fn(async (input: {
      actorUserId: string;
      request: { token: string };
    }) => {
      if (input.request.token === "x".repeat(32)) throw DomainError.forbidden();
      if (["e", "r", "u"].some((prefix) => input.request.token === prefix.repeat(32))) {
        throw DomainError.conflict();
      }
      return { statusCode: 200 as const, body: INVITATION, replayed: false };
    });
    const listTenantMemberships = vi.fn(async () => [TENANT_MEMBERSHIP]);
    const updateTenantMembership = vi.fn(async (input: {
      targetUserId: string;
      request: { role?: string; status?: string };
    }) => {
      if (
        input.targetUserId === IDS.owner &&
        (input.request.role !== undefined || input.request.status === "inactive")
      ) {
        throw DomainError.conflict();
      }
      return TENANT_MEMBERSHIP;
    });
    const listPersonalMemberships = vi.fn(async (input: { actorUserId: string; profileId: string }) => {
      if (input.profileId !== IDS.profile) throw DomainError.notFound();
      if (input.actorUserId !== IDS.owner) throw DomainError.forbidden();
      return [PERSONAL_MEMBERSHIP];
    });
    const createPersonalMembership = vi.fn(async (input: { actorUserId: string }) => {
      if (input.actorUserId !== IDS.owner) throw DomainError.forbidden();
      return PERSONAL_MEMBERSHIP;
    });
    const updatePersonalMembership = vi.fn(async (input: {
      actorUserId: string;
      targetUserId: string;
      request: { role?: string; status?: string };
    }) => {
      if (input.actorUserId !== IDS.owner) throw DomainError.forbidden();
      if (
        input.targetUserId === IDS.owner &&
        (input.request.role !== undefined || input.request.status === "inactive")
      ) {
        throw DomainError.conflict();
      }
      return PERSONAL_MEMBERSHIP;
    });
    const listBusinessMemberships = vi.fn(async (input: { actorUserId: string }) => {
      if (input.actorUserId !== IDS.owner) throw DomainError.forbidden();
      return [BUSINESS_MEMBERSHIP];
    });
    const createBusinessMembership = vi.fn(async (input: {
      actorUserId: string;
      request: { userId: string };
    }) => {
      if (input.actorUserId !== IDS.owner) throw DomainError.forbidden();
      if (input.request.userId === IDS.owner) throw DomainError.conflict();
      return { ...BUSINESS_MEMBERSHIP, userId: input.request.userId, role: "viewer" as const };
    });
    const updateBusinessMembership = vi.fn(async (input: {
      actorUserId: string;
      targetUserId: string;
      request: { role?: string; status?: string };
    }) => {
      if (input.actorUserId !== IDS.owner) throw DomainError.forbidden();
      if (
        input.targetUserId === IDS.owner &&
        (input.request.role !== undefined || input.request.status === "inactive")
      ) {
        throw DomainError.conflict();
      }
      return BUSINESS_MEMBERSHIP;
    });
    const getOwnPersonalProfile = vi.fn(async (input: { actorUserId: string }) =>
      input.actorUserId === IDS.owner
        ? { id: "99999999-9999-4999-8999-999999999999", name: "Mine" }
        : null,
    );
    const resolve = vi.fn(async (_issuer: string, subject: string) => user(subject));
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => principal(token)),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: tenantVerifier,
        service: { verify: vi.fn(async () => { throw new Error("not used"); }) },
      },
      identityDomain: { provision: vi.fn(), resolve },
      membershipDomain: {
        createInvitation,
        acceptInvitation,
        listTenantMemberships,
        updateTenantMembership,
        listPersonalMemberships,
        createPersonalMembership,
        updatePersonalMembership,
        listBusinessMemberships,
        createBusinessMembership,
        updateBusinessMembership,
        getOwnPersonalProfile,
      },
    });
    apps.add(app);
    return {
      app,
      createBusinessMembership,
      createInvitation,
      listBusinessMemberships,
      listPersonalMemberships,
      updateBusinessMembership,
      getOwnPersonalProfile,
    };
  }

  const auth = (subject: string) => ({ authorization: `Bearer ${subject}` });

  it("lets tenant admin create a tenant-only invitation", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${IDS.tenant}/invitations`,
      headers: auth("admin"),
      payload: { email: "MEMBER@EXAMPLE.TEST", tenantRole: "member", grant: { type: "none" } },
    });

    expect(response.statusCode).toBe(201);
    expect(TenantInvitationCreatedSchema.parse(response.json())).toEqual({
      invitation: INVITATION,
      invitationToken: RAW_TOKEN,
    });
  });

  it("requires Personal ownership before attaching a Personal grant", async () => {
    const { app } = createTestApp();
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${IDS.tenant}/invitations`,
      headers: auth("admin"),
      payload: {
        email: "member@example.test",
        tenantRole: "member",
        grant: { type: "personal", profileId: IDS.profile, role: "viewer" },
      },
    });
    const allowed = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${IDS.tenant}/invitations`,
      headers: auth("owner"),
      payload: {
        email: "member@example.test",
        tenantRole: "member",
        grant: { type: "personal", profileId: IDS.profile, role: "viewer" },
      },
    });

    expect(denied.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(201);
  });

  it.each([
    ["x".repeat(32), 403],
    ["e".repeat(32), 409],
    ["r".repeat(32), 409],
    ["u".repeat(32), 409],
  ] as const)("enforces invitation acceptance state for %s", async (token, status) => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      headers: auth("member"),
      payload: { token },
    });

    expect(response.statusCode).toBe(status);
  });

  it("returns accepted invitation without exposing its raw token", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/invitations/accept",
      headers: auth("member"),
      payload: { token: "v".repeat(32) },
    });

    expect(response.statusCode).toBe(200);
    expect(TenantInvitationSchema.parse(response.json())).toEqual(INVITATION);
    expect(response.body).not.toContain(RAW_TOKEN);
  });

  it("does not grant tenant admin access to Personal membership records", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${IDS.tenant}/personal-profiles/${IDS.profile}/memberships`,
      headers: auth("admin"),
    });

    expect(response.statusCode).toBe(403);
  });

  it("lists and updates memberships through explicit tenant scope", async () => {
    const { app } = createTestApp();
    const tenantList = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${IDS.tenant}/memberships`,
      headers: auth("admin"),
    });
    const personalList = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${IDS.tenant}/personal-profiles/${IDS.profile}/memberships`,
      headers: auth("owner"),
    });
    const createPersonal = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${IDS.tenant}/personal-profiles/${IDS.profile}/memberships`,
      headers: auth("owner"),
      payload: { userId: IDS.member, role: "viewer" },
    });

    expect(TenantMembershipListSchema.parse(tenantList.json())).toEqual({ items: [TENANT_MEMBERSHIP] });
    expect(PersonalMembershipListSchema.parse(personalList.json())).toEqual({ items: [PERSONAL_MEMBERSHIP] });
    expect(PersonalMembershipSchema.parse(createPersonal.json())).toEqual(PERSONAL_MEMBERSHIP);
  });

  it("protects final tenant and Personal owners", async () => {
    const { app } = createTestApp();
    const tenantResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${IDS.tenant}/memberships/${IDS.owner}`,
      headers: auth("owner"),
      payload: { expectedVersion: 1, status: "inactive" },
    });
    const personalResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${IDS.tenant}/personal-profiles/${IDS.profile}/memberships/${IDS.owner}`,
      headers: auth("owner"),
      payload: { expectedVersion: 1, role: "viewer" },
    });

    expect(tenantResponse.statusCode).toBe(409);
    expect(personalResponse.statusCode).toBe(409);
  });

  it("forbids viewers from mutation and hides foreign profiles", async () => {
    const { app } = createTestApp();
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${IDS.tenant}/personal-profiles/${IDS.profile}/memberships`,
      headers: auth("viewer"),
      payload: { userId: IDS.member, role: "viewer" },
    });
    const hidden = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${IDS.tenant}/personal-profiles/88888888-8888-4888-8888-888888888888/memberships`,
      headers: auth("owner"),
    });

    expect(forbidden.statusCode).toBe(403);
    expect(hidden.statusCode).toBe(404);
  });

  it("serializes successful membership updates with contract schemas", async () => {
    const { app } = createTestApp();
    const tenantResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${IDS.tenant}/memberships/${IDS.member}`,
      headers: auth("admin"),
      payload: { expectedVersion: 1, status: "inactive" },
    });
    const personalResponse = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${IDS.tenant}/personal-profiles/${IDS.profile}/memberships/${IDS.member}`,
      headers: auth("owner"),
      payload: { expectedVersion: 1, role: "editor" },
    });

    expect(TenantMembershipSchema.parse(tenantResponse.json())).toEqual(TENANT_MEMBERSHIP);
    expect(PersonalMembershipSchema.parse(personalResponse.json())).toEqual(PERSONAL_MEMBERSHIP);
  });

  it("lists and creates business memberships for business owners", async () => {
    const { app, createBusinessMembership, listBusinessMemberships } =
      createTestApp();
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${IDS.tenant}/businesses/${IDS.business}/memberships`,
      headers: auth("owner"),
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${IDS.tenant}/businesses/${IDS.business}/memberships`,
      headers: auth("owner"),
      payload: { userId: IDS.member, role: "viewer" },
    });

    expect(BusinessMembershipListSchema.parse(listed.json())).toEqual({
      items: [BUSINESS_MEMBERSHIP],
    });
    expect(BusinessMembershipSchema.parse(created.json())).toMatchObject({
      businessId: IDS.business,
      userId: IDS.member,
      role: "viewer",
    });
    expect(listBusinessMemberships).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: IDS.business, tenantId: IDS.tenant }),
    );
    expect(createBusinessMembership).toHaveBeenCalledWith(
      expect.objectContaining({ request: { userId: IDS.member, role: "viewer" } }),
    );
  });

  it("restricts business membership administration to business owners", async () => {
    const { app } = createTestApp();
    const tenantAdmin = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${IDS.tenant}/businesses/${IDS.business}/memberships`,
      headers: auth("admin"),
      payload: { userId: IDS.member, role: "viewer" },
    });
    const finalOwner = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${IDS.tenant}/businesses/${IDS.business}/memberships/${IDS.owner}`,
      headers: auth("owner"),
      payload: { expectedVersion: 1, status: "inactive" },
    });

    expect(tenantAdmin.statusCode).toBe(403);
    expect(finalOwner.statusCode).toBe(409);
  });

  // Phase 3D-A Task 4, fix round 3 -- the mailbox scope-picker's lookup.
  describe("GET /api/v1/tenants/:tenantId/personal-profiles/mine", () => {
    it("returns the caller's own Personal profile", async () => {
      const { app, getOwnPersonalProfile } = createTestApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/${IDS.tenant}/personal-profiles/mine`,
        headers: auth("owner"),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        profile: { id: "99999999-9999-4999-8999-999999999999", name: "Mine" },
      });
      expect(getOwnPersonalProfile).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: IDS.owner, tenantId: IDS.tenant }),
      );
    });

    it("returns profile: null (not a 404) for a caller with no Personal-profile access", async () => {
      const { app } = createTestApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/${IDS.tenant}/personal-profiles/mine`,
        headers: auth("member"),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ profile: null });
    });

    it("rejects a request with no token", async () => {
      const { app } = createTestApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/${IDS.tenant}/personal-profiles/mine`,
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
