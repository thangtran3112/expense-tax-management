// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bootstrapCaptureSession, pickScope, pickTenant } from "./session-bootstrap";
import { readSession, writeSession } from "./session";

const TENANT_A = {
  id: "tenant-a",
  name: "Family",
  slug: "family-a",
  status: "active" as const,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const TENANT_B = { ...TENANT_A, id: "tenant-b", slug: "family-b" };

const PROFILE = {
  id: "profile-1",
  tenantId: "tenant-a",
  name: "Personal",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const BUSINESS = {
  id: "business-1",
  tenantId: "tenant-a",
  name: "Corner Cafe",
  industryCode: "restaurant",
  timezone: "America/New_York",
  baseCurrency: "USD",
  status: "active" as const,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("pickTenant", () => {
  it("picks the remembered tenant when still listed", () => {
    expect(pickTenant([TENANT_A, TENANT_B], "tenant-b")).toEqual(TENANT_B);
  });

  it("picks the only tenant when there is no remembered match", () => {
    expect(pickTenant([TENANT_A], "tenant-missing")).toEqual(TENANT_A);
    expect(pickTenant([TENANT_A], null)).toEqual(TENANT_A);
  });

  it("returns null with no tenants", () => {
    expect(pickTenant([], null)).toBeNull();
  });

  it("returns null for multiple tenants with no remembered match (out of scope)", () => {
    expect(pickTenant([TENANT_A, TENANT_B], null)).toBeNull();
  });
});

describe("pickScope", () => {
  const scopes = { personalProfiles: [PROFILE], businesses: [BUSINESS] };

  it("picks the remembered personal scope when still listed", () => {
    expect(
      pickScope(scopes, { kind: "personal", profileId: "profile-1", label: "stale" }),
    ).toEqual({ kind: "personal", profileId: "profile-1", label: "Personal" });
  });

  it("picks the remembered business scope when still listed", () => {
    expect(
      pickScope(scopes, { kind: "business", businessId: "business-1", label: "stale" }),
    ).toEqual({ kind: "business", businessId: "business-1", label: "Corner Cafe" });
  });

  it("falls back to the personal profile when the remembered scope is gone", () => {
    expect(
      pickScope(scopes, { kind: "business", businessId: "missing", label: "x" }),
    ).toEqual({ kind: "personal", profileId: "profile-1", label: "Personal" });
  });

  it("falls back to the first business when there is no personal profile", () => {
    expect(pickScope({ personalProfiles: [], businesses: [BUSINESS] }, null)).toEqual({
      kind: "business",
      businessId: "business-1",
      label: "Corner Cafe",
    });
  });

  it("returns null when there is no scope at all", () => {
    expect(pickScope({ personalProfiles: [], businesses: [] }, null)).toBeNull();
  });
});

describe("bootstrapCaptureSession", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    sessionStorage.clear();
  });

  function fakeClient(options: {
    tenants?: typeof TENANT_A[];
    scopes?: { personalProfiles: typeof PROFILE[]; businesses: typeof BUSINESS[] };
    tenantsError?: boolean;
    scopesError?: boolean;
  }) {
    return {
      GET: vi.fn(async (path: string) => {
        if (path === "/api/v1/tenants") {
          return options.tenantsError
            ? { error: { message: "nope" } }
            : { data: { items: options.tenants ?? [] } };
        }
        return options.scopesError
          ? { error: { message: "nope" } }
          : { data: options.scopes ?? { personalProfiles: [], businesses: [] } };
      }),
    };
  }

  it("writes a session for the only tenant and the personal profile by default", async () => {
    const client = fakeClient({
      tenants: [TENANT_A],
      scopes: { personalProfiles: [PROFILE], businesses: [BUSINESS] },
    });
    const getToken = vi.fn().mockResolvedValue("tok");

    const result = await bootstrapCaptureSession(
      { getToken, organizationId: "org_1", apiBaseUrl: "http://app.test" },
      client as never,
    );

    expect(result).toEqual({
      status: "ok",
      session: {
        apiBaseUrl: "http://app.test",
        tenantId: "tenant-a",
        scope: { kind: "personal", profileId: "profile-1", label: "Personal" },
      },
    });
    expect(readSession()).toEqual(result.status === "ok" ? result.session : null);
  });

  it("reports a clear message with no tenant", async () => {
    const client = fakeClient({ tenants: [] });
    const result = await bootstrapCaptureSession(
      { getToken: vi.fn().mockResolvedValue("tok"), organizationId: "org_1", apiBaseUrl: "http://app.test" },
      client as never,
    );
    expect(result).toEqual({ status: "error", message: "No workspace is set up yet." });
    expect(readSession()).toBeNull();
  });

  it("reports a clear message with no scope available", async () => {
    const client = fakeClient({ tenants: [TENANT_A], scopes: { personalProfiles: [], businesses: [] } });
    const result = await bootstrapCaptureSession(
      { getToken: vi.fn().mockResolvedValue("tok"), organizationId: "org_1", apiBaseUrl: "http://app.test" },
      client as never,
    );
    expect(result).toEqual({
      status: "error",
      message: "No profile is available yet. Ask an owner for access.",
    });
  });

  it("remembers the previously written scope across a re-bootstrap", async () => {
    writeSession({
      apiBaseUrl: "http://app.test",
      tenantId: "tenant-a",
      scope: { kind: "business", businessId: "business-1", label: "Corner Cafe" },
    });
    const client = fakeClient({
      tenants: [TENANT_A],
      scopes: { personalProfiles: [PROFILE], businesses: [BUSINESS] },
    });

    const result = await bootstrapCaptureSession(
      { getToken: vi.fn().mockResolvedValue("tok"), organizationId: "org_1", apiBaseUrl: "http://app.test" },
      client as never,
    );

    expect(result).toEqual({
      status: "ok",
      session: {
        apiBaseUrl: "http://app.test",
        tenantId: "tenant-a",
        scope: { kind: "business", businessId: "business-1", label: "Corner Cafe" },
      },
    });
  });

  it("surfaces a tenant-load failure", async () => {
    const client = fakeClient({ tenantsError: true });
    const result = await bootstrapCaptureSession(
      { getToken: vi.fn().mockResolvedValue("tok"), organizationId: "org_1", apiBaseUrl: "http://app.test" },
      client as never,
    );
    expect(result).toEqual({ status: "error", message: "Could not load your workspace." });
  });

  it("surfaces a scopes-load failure", async () => {
    const client = fakeClient({ tenants: [TENANT_A], scopesError: true });
    const result = await bootstrapCaptureSession(
      { getToken: vi.fn().mockResolvedValue("tok"), organizationId: "org_1", apiBaseUrl: "http://app.test" },
      client as never,
    );
    expect(result).toEqual({ status: "error", message: "Could not load your profiles." });
  });
});
