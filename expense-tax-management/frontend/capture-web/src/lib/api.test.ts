import { describe, expect, it, vi } from "vitest";

import { fetchTenantScopes } from "./api";
import type { CaptureSession } from "./session";

const session: CaptureSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal", profileId: "profile-1", label: "Personal" },
};

vi.mock("@expense-tax/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@expense-tax/contracts")>();
  return { ...actual, createAppApiClient: () => client };
});

const client = { GET: vi.fn() };

describe("fetchTenantScopes", () => {
  it("returns the scopes body for the Settings scope picker", async () => {
    const scopes = {
      personalProfiles: [{ id: "profile-1", tenantId: "tenant-1", name: "Personal", version: 1, createdAt: "t", updatedAt: "t" }],
      businesses: [],
    };
    client.GET.mockResolvedValue({ data: scopes });
    const getToken = vi.fn().mockResolvedValue("tok");

    const result = await fetchTenantScopes(session, getToken, "org_1");

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/scopes",
      expect.objectContaining({ params: { path: { tenantId: "tenant-1" } } }),
    );
    expect(result).toEqual(scopes);
  });

  it("throws when App API returns no body", async () => {
    client.GET.mockResolvedValue({ data: undefined });
    const getToken = vi.fn().mockResolvedValue("tok");

    await expect(fetchTenantScopes(session, getToken, "org_1")).rejects.toThrow(
      "Could not load profiles",
    );
  });
});
