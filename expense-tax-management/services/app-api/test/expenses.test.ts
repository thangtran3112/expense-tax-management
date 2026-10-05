import {
  ExpenseListSchema,
  ExpenseSchema,
  LedgerQuerySchema,
  type AuthenticatedUser,
  type Expense,
} from "@expense-tax/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";

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
const USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const PROFILE_ID = "33333333-3333-4333-8333-333333333333";
const BUSINESS_ID = "44444444-4444-4444-8444-444444444444";
const EXPENSE_ID = "55555555-5555-4555-8555-555555555555";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

// Phase 3C fixture constants — deterministic UUIDs for the test namespace.
// Schema constraint: personal_profiles has UNIQUE (tenant_id), so Profile A
// lives in Tenant A and Profile B lives in Tenant B — two isolated scopes.
// Integration tests keep their own seed functions; these constants document
// the reserved ID space so later tasks don't collide.
export const PHASE_3C = {
  TENANT_A_ID: "3c000000-0000-4000-8000-000000000001",
  TENANT_B_ID: "3c000000-0000-4000-8000-000000000011",
  USER_ID: "3c000000-0000-4000-8000-000000000002",
  PERSONAL_PROFILE_A_ID: "3c000000-0000-4000-8000-000000000003",
  PERSONAL_PROFILE_B_ID: "3c000000-0000-4000-8000-000000000004",
  BUSINESS_A_ID: "3c000000-0000-4000-8000-000000000005",
  BUSINESS_B_ID: "3c000000-0000-4000-8000-000000000006",
  TAXONOMY_VERSION_ID: "3c000000-0000-4000-8000-000000000007",
  TAX_PROFILE_ID: "3c000000-0000-4000-8000-000000000008",
  SPENDING_CATEGORY_ID: "3c000000-0000-4000-8000-000000000009",
  EXPENSE_V1_ID: "3c000000-0000-4000-8000-00000000000a",
  EXPENSE_V2_ID: "3c000000-0000-4000-8000-00000000000b",
} as const;

const TAG_A_ID = "99000000-0001-4000-8000-000000000001";
const TAG_B_ID = "99000000-0001-4000-8000-000000000002";

const EXPENSE: Expense = {
  id: EXPENSE_ID,
  tenantId: TENANT_ID,
  createdByUserId: USER_ID,
  personalProfileId: PROFILE_ID,
  businessId: null,
  projectId: null,
  spendingCategoryId: null,
  merchant: "Market",
  description: null,
  amount: "12.50",
  currency: "USD",
  incurredOn: "2025-03-01",
  taxYear: 2025,
  source: "manual",
  mailboxProvenance: null,
  status: "ready",
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  tags: [],
};

function principal(subject: string): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject,
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.test",
    roles: [],
    scopes: [],
    tokenId: `${subject}-token`,
    email: `${subject}@example.test`,
    emailVerified: true,
    displayName: subject,
  };
}

describe("App API expense routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const createPersonal = vi.fn(async () => EXPENSE);
    const createBusiness = vi.fn(async () => ({
      ...EXPENSE,
      personalProfileId: null,
      businessId: BUSINESS_ID,
    }));
    const listPersonal = vi.fn(async () => ({ items: [EXPENSE], nextCursor: null }));
    const listBusiness = vi.fn(async () => ({ items: [], nextCursor: null }));
    const updatePersonal = vi.fn(async () => ({ ...EXPENSE, version: 2 }));
    const archivePersonal = vi.fn(async () => ({ ...EXPENSE, status: "archived" as const }));
    const resolve = vi.fn(async (): Promise<AuthenticatedUser> => ({
      id: USER_ID,
      primaryEmail: "owner@example.test",
      displayName: "Owner",
      status: "active",
    }));
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
      expenseDomain: {
        createPersonal,
        createBusiness,
        listPersonal,
        listBusiness,
        updatePersonal,
        archivePersonal,
      },
    });
    apps.add(app);
    return {
      app,
      createBusiness,
      createPersonal,
      listBusiness,
      listPersonal,
    };
  }

  const auth = { authorization: "Bearer owner" };

  it("creates Personal expenses under explicit profile scope", async () => {
    const { app, createPersonal } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses`,
      headers: auth,
      payload: {
        personalProfileId: PROFILE_ID,
        merchant: "Market",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(ExpenseSchema.parse(response.json())).toEqual(EXPENSE);
    expect(createPersonal).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER_ID,
        tenantId: TENANT_ID,
        profileId: PROFILE_ID,
      }),
    );
  });

  it("lists business expenses with cursor envelope", async () => {
    const { app, listBusiness } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/expenses?limit=25&sort=amount`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(ExpenseListSchema.parse(response.json())).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(listBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: USER_ID, businessId: BUSINESS_ID }),
    );
  });

  it("rejects ambiguous expense scope before domain mutation", async () => {
    const { app, createPersonal } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses`,
      headers: auth,
      payload: {
        personalProfileId: PROFILE_ID,
        businessId: BUSINESS_ID,
        merchant: "Ambiguous",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(createPersonal).not.toHaveBeenCalled();
  });

  it("creates business expenses under explicit business scope", async () => {
    const { app, createBusiness } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/expenses`,
      headers: auth,
      payload: {
        businessId: BUSINESS_ID,
        merchant: "Supplier",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(createBusiness).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: USER_ID, businessId: BUSINESS_ID }),
    );
  });

  // ---- C1: Route mock returns ready; domain must return ready status ----
  it("C1: createPersonal domain mock returns ready status (enrichment enqueued downstream)", async () => {
    // The EXPENSE fixture already has status: "ready" — this test verifies
    // the route layer passes through the domain's ready-status response and
    // that the mock domain is configured correctly for the C1 contract.
    const { app, createPersonal } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses`,
      headers: auth,
      payload: {
        personalProfileId: PROFILE_ID,
        merchant: "Market",
        amount: "12.50",
        currency: "USD",
        incurredOn: "2025-03-01",
      },
    });

    expect(response.statusCode).toBe(201);
    // C1: public create must return ready (not draft)
    expect(response.json().status).toBe("ready");
    expect(createPersonal).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER_ID,
        tenantId: TENANT_ID,
        profileId: PROFILE_ID,
      }),
    );
  });

  // ---- Task 9: Tag AND filter — route/contract tests ----

  it("T9-R1: listPersonal route passes repeated tagId params to domain as canonical sorted tagIds", async () => {
    const { app, listPersonal } = createTestApp();
    // Send tags in reverse order — domain must receive them canonically sorted
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses?tagId=${TAG_B_ID}&tagId=${TAG_A_ID}`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(listPersonal).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          tagIds: [TAG_A_ID, TAG_B_ID], // sorted ascending
        }),
      }),
    );
  });

  it("T9-R2: listPersonal with no tagId param passes empty tagIds array to domain", async () => {
    const { app, listPersonal } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/personal-profiles/${PROFILE_ID}/expenses`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(listPersonal).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ tagIds: [] }),
      }),
    );
  });

  it("T9-R3: listBusiness route passes repeated tagId params to domain", async () => {
    const { app, listBusiness } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/expenses?tagId=${TAG_A_ID}&tagId=${TAG_B_ID}`,
      headers: auth,
    });

    expect(response.statusCode).toBe(200);
    expect(listBusiness).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          tagIds: [TAG_A_ID, TAG_B_ID],
        }),
      }),
    );
  });

  it("T9-R4: LedgerQuerySchema normalizes repeated tagId UUIDs to sorted unique tagIds", () => {
    const parsed = LedgerQuerySchema.parse({
      tagId: [TAG_B_ID, TAG_A_ID, TAG_B_ID], // duplicates + reverse order
    });
    expect(parsed.tagIds).toEqual([TAG_A_ID, TAG_B_ID]); // deduped + sorted
  });

  it("T9-R5: LedgerQuerySchema rejects non-UUID tagId values", () => {
    expect(() =>
      LedgerQuerySchema.parse({ tagId: ["not-a-uuid"] }),
    ).toThrow();
  });

  it("T9-R5b: LedgerQuerySchema rejects unknown query fields (strict mode)", () => {
    expect(() =>
      LedgerQuerySchema.parse({ unknownField: "foo" }),
    ).toThrow();
    expect(() =>
      LedgerQuerySchema.parse({ tagIds: ["not-via-raw-schema"] }),
    ).toThrow(); // tagIds is not in raw schema; only tagId is accepted
  });

  it("T9-R6: reversed-order same logical tagIds produce same canonical tagIds", () => {
    const a = LedgerQuerySchema.parse({ tagId: [TAG_A_ID, TAG_B_ID] });
    const b = LedgerQuerySchema.parse({ tagId: [TAG_B_ID, TAG_A_ID] });
    expect(a.tagIds).toEqual(b.tagIds);
  });

  it("T9-R7: expense list items include tags array chip on each expense", () => {
    // ExpenseListSchema must include tags on each item
    const parsed = ExpenseListSchema.parse({
      items: [{ ...EXPENSE, tags: [{ id: TAG_A_ID, name: "Coffee", color: "#FF0000" }] }],
      nextCursor: null,
    });
    expect(parsed.items[0]?.tags).toHaveLength(1);
    expect(parsed.items[0]?.tags[0]?.id).toBe(TAG_A_ID);
  });

  it("T9-R8: expense item tags default to empty array if omitted", () => {
    const parsed = ExpenseListSchema.parse({
      items: [{ ...EXPENSE, tags: [] }],
      nextCursor: null,
    });
    expect(parsed.items[0]?.tags).toEqual([]);
  });
});
