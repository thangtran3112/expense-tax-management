import {
  TenantBootstrapSchema,
  TenantListSchema,
  TenantScopesSchema,
  TenantSchema,
  type AuthenticatedUser,
  type SmallBusiness,
  type Tenant,
  type TenantBootstrap,
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
const USER_IDS = {
  owner: "11111111-1111-4111-8111-111111111111",
  admin: "22222222-2222-4222-8222-222222222222",
  member: "33333333-3333-4333-8333-333333333333",
} as const;
const TENANT_ID = "44444444-4444-4444-8444-444444444444";
const PROFILE_ID = "55555555-5555-4555-8555-555555555555";
const BUSINESS_ID = "77777777-7777-4777-8777-777777777777";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

const TENANT: Tenant = {
  id: TENANT_ID,
  name: "Family",
  slug: "family-44444444",
  status: "active",
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const BOOTSTRAP: TenantBootstrap = {
  tenant: TENANT,
  tenantMembership: {
    tenantId: TENANT_ID,
    userId: USER_IDS.owner,
    role: "owner",
    status: "active",
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
  personalProfile: {
    id: PROFILE_ID,
    tenantId: TENANT_ID,
    name: "Personal",
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
  personalMembership: {
    personalProfileId: PROFILE_ID,
    tenantId: TENANT_ID,
    userId: USER_IDS.owner,
    role: "owner",
    status: "active",
    version: 1,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
};
const BUSINESS: SmallBusiness = {
  id: BUSINESS_ID,
  tenantId: TENANT_ID,
  name: "Corner Cafe",
  industryCode: "restaurant",
  timezone: "America/New_York",
  baseCurrency: "USD",
  status: "active",
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function authenticatedUser(subject: string): AuthenticatedUser | null {
  if (!(subject in USER_IDS)) return null;
  const role = subject as keyof typeof USER_IDS;
  return {
    id: USER_IDS[role],
    primaryEmail: `${role}@example.test`,
    displayName: role,
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

describe("App API tenant routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const idempotencyRecords = new Map<string, string>();
    const create = vi.fn(async (input: {
      idempotencyKey: string;
      request: { name: string };
    }) => {
      const priorName = idempotencyRecords.get(input.idempotencyKey);
      if (priorName !== undefined && priorName !== input.request.name) {
        throw DomainError.conflict();
      }
      idempotencyRecords.set(input.idempotencyKey, input.request.name);
      return { statusCode: 201 as const, body: BOOTSTRAP, replayed: priorName !== undefined };
    });
    const list = vi.fn(async () => [TENANT]);
    const get = vi.fn(async (_actorUserId: string, tenantId: string) => {
      if (tenantId !== TENANT_ID) throw DomainError.notFound();
      return TENANT;
    });
    const update = vi.fn(async (input: {
      actorUserId: string;
      request: { name: string; expectedVersion: number };
    }) => {
      if (input.actorUserId === USER_IDS.member) throw DomainError.forbidden();
      return {
        ...TENANT,
        name: input.request.name,
        version: input.request.expectedVersion + 1,
      };
    });
    const listOwnPersonalProfiles = vi.fn(async (actorUserId: string, tenantId: string) => {
      if (tenantId !== TENANT_ID) throw DomainError.notFound();
      if (actorUserId === USER_IDS.member) return [];
      return [BOOTSTRAP.personalProfile];
    });
    const businessList = vi.fn(async (_actorUserId: string, tenantId: string) => {
      if (tenantId !== TENANT_ID) return [];
      return [BUSINESS];
    });
    const resolve = vi.fn(async (_issuer: string, subject: string) =>
      authenticatedUser(subject),
    );
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => principal(token)),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async () => {
        throw new Error("service token not accepted");
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: { tenant: tenantVerifier, service: serviceVerifier },
      identityDomain: { provision: vi.fn(), resolve },
      tenantDomain: { create, list, get, update, listOwnPersonalProfiles },
      businessDomain: {
        archive: vi.fn(),
        create: vi.fn(),
        get: vi.fn(),
        list: businessList,
        listIndustries: vi.fn(),
        update: vi.fn(),
      },
    });
    apps.add(app);
    return { app, create, get, list, listOwnPersonalProfiles, businessList, resolve, update };
  }

  function auth(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  it("rejects tenant creation for an unprovisioned identity", async () => {
    const { app, create } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tenants",
      headers: { ...auth("unknown"), "idempotency-key": "create-1" },
      payload: { name: "Family" },
    });

    expect(response.statusCode).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it("requires an idempotency key for tenant creation", async () => {
    const { app, create } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tenants",
      headers: auth("owner"),
      payload: { name: "Family" },
    });

    expect(response.statusCode).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("creates tenant and Personal owner state atomically", async () => {
    const { app, create } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tenants",
      headers: { ...auth("owner"), "idempotency-key": "create-1" },
      payload: { name: " Family " },
    });

    expect(response.statusCode).toBe(201);
    expect(TenantBootstrapSchema.parse(response.json())).toEqual(BOOTSTRAP);
    expect(create).toHaveBeenCalledWith({
      actorUserId: USER_IDS.owner,
      request: { name: "Family" },
      idempotencyKey: "create-1",
      requestId: expect.any(String),
    });
  });

  it("replays the same key and rejects reuse with different input", async () => {
    const { app, create } = createTestApp();
    const request = {
      method: "POST" as const,
      url: "/api/v1/tenants",
      headers: { ...auth("owner"), "idempotency-key": "create-1" },
      payload: { name: "Family" },
    };
    const first = await app.inject(request);
    const replay = await app.inject(request);
    const conflict = await app.inject({ ...request, payload: { name: "Other" } });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(conflict.statusCode).toBe(409);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("lists only tenants returned by active membership lookup", async () => {
    const { app, list } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/tenants",
      headers: auth("owner"),
    });

    expect(response.statusCode).toBe(200);
    expect(TenantListSchema.parse(response.json())).toEqual({ items: [TENANT] });
    expect(list).toHaveBeenCalledWith(USER_IDS.owner);
  });

  it("returns not found for a foreign tenant", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/tenants/66666666-6666-4666-8666-666666666666",
      headers: auth("owner"),
    });

    expect(response.statusCode).toBe(404);
  });

  it("allows an admin to update with an expected version", async () => {
    const { app, update } = createTestApp();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${TENANT_ID}`,
      headers: auth("admin"),
      payload: { name: "Household", expectedVersion: 1 },
    });

    expect(response.statusCode).toBe(200);
    expect(TenantSchema.parse(response.json())).toMatchObject({
      name: "Household",
      version: 2,
    });
    expect(update).toHaveBeenCalledWith({
      actorUserId: USER_IDS.admin,
      tenantId: TENANT_ID,
      request: { name: "Household", expectedVersion: 1 },
      requestId: expect.any(String),
    });
  });

  it("forbids a member from updating tenant settings", async () => {
    const { app } = createTestApp();
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${TENANT_ID}`,
      headers: auth("member"),
      payload: { name: "Household", expectedVersion: 1 },
    });

    expect(response.statusCode).toBe(403);
  });

  describe("GET /api/v1/tenants/:tenantId/scopes", () => {
    it("returns the caller's own personal profile and member businesses", async () => {
      const { app, listOwnPersonalProfiles, businessList } = createTestApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/${TENANT_ID}/scopes`,
        headers: auth("owner"),
      });

      expect(response.statusCode).toBe(200);
      expect(TenantScopesSchema.parse(response.json())).toEqual({
        personalProfiles: [BOOTSTRAP.personalProfile],
        businesses: [BUSINESS],
      });
      expect(listOwnPersonalProfiles).toHaveBeenCalledWith(USER_IDS.owner, TENANT_ID);
      expect(businessList).toHaveBeenCalledWith(USER_IDS.owner, TENANT_ID);
    });

    it("omits the personal profile for a tenant member without a personal membership", async () => {
      const { app } = createTestApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/${TENANT_ID}/scopes`,
        headers: auth("member"),
      });

      expect(response.statusCode).toBe(200);
      expect(TenantScopesSchema.parse(response.json())).toEqual({
        personalProfiles: [],
        businesses: [BUSINESS],
      });
    });

    it("denies a non-member the same way GET /api/v1/tenants/:tenantId does", async () => {
      const { app } = createTestApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/66666666-6666-4666-8666-666666666666/scopes`,
        headers: auth("owner"),
      });

      expect(response.statusCode).toBe(404);
    });

    it("rejects an unprovisioned/service identity, same as every other tenant route", async () => {
      const { app, listOwnPersonalProfiles, businessList } = createTestApp();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/tenants/${TENANT_ID}/scopes`,
        headers: auth("unknown"),
      });

      expect(response.statusCode).toBe(401);
      expect(listOwnPersonalProfiles).not.toHaveBeenCalled();
      expect(businessList).not.toHaveBeenCalled();
    });
  });
});
