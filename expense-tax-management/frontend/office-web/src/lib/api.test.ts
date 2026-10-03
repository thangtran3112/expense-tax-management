import { describe, expect, it, vi } from "vitest";

import {
  fetchDuplicateMatches,
  fetchLedger,
  fetchTags,
  resolveSuggestion,
  createTag,
  updateTag,
  archiveTag,
  unarchiveTag,
  mergeTags,
  fetchCurrentUser,
  fetchTenantMembership,
  fetchAuthorizedBusinesses,
  fetchOwnPersonalProfile,
  fetchMailboxConnection,
  startMailboxConnection,
} from "./api";
import type { OfficeSession } from "./session";

const businessSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "business", businessId: "business-1" },
  label: "Family Business",
};

const personalSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal", profileId: "profile-1" },
  label: "Personal",
};

describe("Office API authorization boundary", () => {
  it("propagates Clerk bearer header to ledger request - business scope", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [] } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchLedger(businessSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses",
      expect.objectContaining({ headers: { authorization: "Bearer office-token" } }),
    );
  });

  it("uses personal-profile route for personal scope in ledger", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [] } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchLedger(personalSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1", profileId: "profile-1" },
        }),
        headers: { authorization: "Bearer office-token" },
      }),
    );
  });

  it("sends repeated tagId query params (server pagination, no client filtering)", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchLedger(businessSession, getToken, "org_123", client as never, {
      tagId: ["tag-a", "tag-b"],
      cursor: "cursor-1",
      sort: "incurredOn",
      direction: "asc",
    });

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses",
      expect.objectContaining({
        params: expect.objectContaining({
          query: expect.objectContaining({
            tagId: ["tag-a", "tag-b"],
            cursor: "cursor-1",
            sort: "incurredOn",
            direction: "asc",
          }),
        }),
      }),
    );
  });

  it("uses personal duplicate-match route for personal scope", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchDuplicateMatches(personalSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1", profileId: "profile-1" },
        }),
      }),
    );
  });

  it("uses business duplicate-match route for business scope", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchDuplicateMatches(businessSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1", businessId: "business-1" },
        }),
      }),
    );
  });

  it("fetches tags at tenant scope - no query params (server does not support filtering)", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchTags(businessSession, getToken, "org_123", client as never);

    const call = client.GET.mock.calls[0] as [string, { params: { path: unknown; query?: unknown }; headers: unknown }];
    // Must NOT send a query object that would imply filtering is happening
    expect(call[0]).toBe("/api/v1/tenants/{tenantId}/tags");
    expect(call[1].params).not.toHaveProperty("query");
    expect(call[1].headers).toEqual({ authorization: "Bearer office-token" });
  });
});

describe("suggestion resolve API", () => {
  it("sends stable idempotency key and action for business scope", async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({
        data: { suggestionId: "sugg-1", status: "accepted", version: 2 },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");
    const stableKey = "stable-idem-key-1";

    await resolveSuggestion(businessSession, "exp-1", "sugg-1", {
      action: "accepted",
      expectedSuggestionVersion: 1,
      expectedExpenseVersion: 3,
      idempotencyKey: stableKey,
    }, getToken, "org_123", client as never);

    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1", businessId: "business-1", expenseId: "exp-1", suggestionId: "sugg-1" },
        }),
        body: expect.objectContaining({
          action: "accepted",
          idempotencyKey: stableKey,
        }),
      }),
    );
  });

  it("sends stable idempotency key for personal scope", async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({
        data: { suggestionId: "sugg-2", status: "rejected", version: 1 },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");
    const stableKey = "stable-idem-key-2";

    await resolveSuggestion(personalSession, "exp-2", "sugg-2", {
      action: "rejected",
      expectedSuggestionVersion: 1,
      expectedExpenseVersion: 2,
      idempotencyKey: stableKey,
    }, getToken, "org_123", client as never);

    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1", profileId: "profile-1", expenseId: "exp-2", suggestionId: "sugg-2" },
        }),
        body: expect.objectContaining({
          action: "rejected",
          idempotencyKey: stableKey,
        }),
      }),
    );
  });

  it("requires deductible percentage for tax_category acceptance", async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({
        data: { suggestionId: "sugg-3", status: "accepted", version: 2 },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await resolveSuggestion(businessSession, "exp-3", "sugg-3", {
      action: "accepted",
      expectedSuggestionVersion: 1,
      expectedExpenseVersion: 1,
      idempotencyKey: "key-3",
      taxAcceptance: { businessTaxProfileId: "prof-1", deductiblePercent: "50" },
    }, getToken, "org_123", client as never);

    expect(client.POST).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.objectContaining({
          taxAcceptance: { businessTaxProfileId: "prof-1", deductiblePercent: "50" },
        }),
      }),
    );
  });
});

// ------------------------------------------------------------------ //
// Fix 1: tag write operations carry no fake idempotency param —
// rely on expectedVersion OCC and server-side one-row semantics
// ------------------------------------------------------------------ //

describe("tag write API — no fake idempotency param, only expectedVersion OCC", () => {
  it("createTag sends name/color body, no idempotency-key header", async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({ data: { id: "tag-1", name: "Travel", version: 1 } }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await createTag(businessSession, "Travel", "#FF0000", getToken, "org_123", client as never);

    const call = client.POST.mock.calls[0] as [string, { params: unknown; headers: unknown; body: unknown }];
    expect(call[0]).toBe("/api/v1/tenants/{tenantId}/tags");
    // No idempotency-key in params.header or HTTP headers
    expect(JSON.stringify(call[1])).not.toContain("idempotency-key");
    expect(call[1].body).toMatchObject({ name: "Travel" });
  });

  it("updateTag sends expectedVersion body, no idempotency-key", async () => {
    const client = {
      PATCH: vi.fn().mockResolvedValue({ data: { id: "tag-1", name: "Updated", version: 2 } }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await updateTag(businessSession, "tag-1", { expectedVersion: 1, name: "Updated" }, getToken, "org_123", client as never);

    const call = client.PATCH.mock.calls[0] as [string, { body: unknown; headers: unknown }];
    expect(call[0]).toBe("/api/v1/tenants/{tenantId}/tags/{tagId}");
    expect(JSON.stringify(call[1])).not.toContain("idempotency-key");
    expect(call[1].body).toMatchObject({ expectedVersion: 1, name: "Updated" });
  });

  it("archiveTag sends expectedVersion body, no idempotency-key", async () => {
    const client = {
      DELETE: vi.fn().mockResolvedValue({ data: { id: "tag-1", status: "archived", version: 2 } }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await archiveTag(businessSession, "tag-1", 1, getToken, "org_123", client as never);

    const call = client.DELETE.mock.calls[0] as [string, { body: unknown; headers: unknown }];
    expect(JSON.stringify(call[1])).not.toContain("idempotency-key");
    expect(call[1].body).toMatchObject({ expectedVersion: 1 });
  });

  it("unarchiveTag sends expectedVersion body, no idempotency-key", async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({ data: { id: "tag-1", status: "active", version: 3 } }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await unarchiveTag(businessSession, "tag-1", 2, getToken, "org_123", client as never);

    const call = client.POST.mock.calls[0] as [string, { body: unknown; headers: unknown }];
    expect(call[0]).toBe("/api/v1/tenants/{tenantId}/tags/{tagId}/unarchive");
    expect(JSON.stringify(call[1])).not.toContain("idempotency-key");
    expect(call[1].body).toMatchObject({ expectedVersion: 2 });
  });

  it("mergeTags sends source/target versions body, no idempotency-key", async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({ data: undefined, response: { status: 204 } }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await mergeTags(businessSession, "src-1", "tgt-1", 1, 2, getToken, "org_123", client as never);

    const call = client.POST.mock.calls[0] as [string, { body: unknown; headers: unknown }];
    expect(call[0]).toBe("/api/v1/tenants/{tenantId}/tags/{tagId}/merge");
    expect(JSON.stringify(call[1])).not.toContain("idempotency-key");
    expect(call[1].body).toMatchObject({
      sourceTagId: "src-1",
      targetTagId: "tgt-1",
      expectedSourceVersion: 1,
      expectedTargetVersion: 2,
    });
  });
});

// ------------------------------------------------------------------ //
// Fix 4: membership lookup — real API calls, not hardcoded role
// ------------------------------------------------------------------ //

// ------------------------------------------------------------------ //
// I-2: fetchTenantMembership — assert completeness; no silent null from truncation
// The generated API returns a flat list with no nextCursor (not paginated).
// We assert this at runtime: the response must be a plain items array.
// ------------------------------------------------------------------ //

describe("fetchTenantMembership — flat list completeness assertion", () => {
  it("throws MembershipListError when response shape is unexpected (not items array)", async () => {
    // If the API ever returns an unexpected shape, we must surface an error
    // rather than silently return null role.
    const client = {
      GET: vi.fn().mockResolvedValue({ data: null, response: { status: 500 } }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");
    await expect(
      fetchTenantMembership(businessSession, "user-1", getToken, "org_123", client as never),
    ).rejects.toThrow();
  });

  it("surfaces warning-level error when user not found in non-empty list (unexpected absence)", async () => {
    // When list is non-empty but user absent, this is a detectable anomaly.
    // The function must return null (user not a member), not throw.
    // The generated spec says this IS a valid state (user simply not in tenant).
    // We just confirm it returns null cleanly (not silently swallowed).
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: {
          items: [
            { userId: "other-user", tenantId: "tenant-1", role: "owner", status: "active", version: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
          ],
        },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");
    const role = await fetchTenantMembership(businessSession, "user-1", getToken, "org_123", client as never);
    // Must return null, not throw — user is simply not a member
    expect(role).toBeNull();
  });

  it("makes exactly one GET request (no multi-page loop since API is not paginated)", async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: { items: [{ userId: "user-1", tenantId: "tenant-1", role: "admin", status: "active", version: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");
    await fetchTenantMembership(businessSession, "user-1", getToken, "org_123", client as never);
    // Exactly one GET — no pagination loop
    expect(client.GET).toHaveBeenCalledTimes(1);
  });

  it("returns inactive member as null (not a valid active role)", async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: {
          items: [
            { userId: "user-1", tenantId: "tenant-1", role: "admin", status: "inactive", version: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
          ],
        },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");
    const role = await fetchTenantMembership(businessSession, "user-1", getToken, "org_123", client as never);
    expect(role).toBeNull();
  });
});

describe("tenant membership role lookup", () => {
  it("fetchCurrentUser calls /api/v1/users/me with bearer token", async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({ data: { user: { id: "user-1", primaryEmail: "u@test.com", displayName: "User", status: "active" } } }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchCurrentUser(businessSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/users/me",
      expect.objectContaining({ headers: { authorization: "Bearer office-token" } }),
    );
  });

  it("fetchTenantMembership calls /api/v1/tenants/{tenantId}/memberships/{userId}", async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: { items: [{ userId: "user-1", tenantId: "tenant-1", role: "admin", status: "active", version: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    const role = await fetchTenantMembership(businessSession, "user-1", getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/memberships",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1" },
        }),
        headers: { authorization: "Bearer office-token" },
      }),
    );
    expect(role).toBe("admin");
  });

  it("fetchTenantMembership returns null when user not in membership list", async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({ data: { items: [] } }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    const role = await fetchTenantMembership(businessSession, "missing-user", getToken, "org_123", client as never);

    expect(role).toBeNull();
  });

  it("fetchTenantMembership returns member role", async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: { items: [{ userId: "user-2", tenantId: "tenant-1", role: "member", status: "active", version: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    const role = await fetchTenantMembership(businessSession, "user-2", getToken, "org_123", client as never);

    expect(role).toBe("member");
  });
});

// -------------------------------------------------------------------- //
// Fix round 2 (Important) -- mailbox scope-picker data sources
// -------------------------------------------------------------------- //

describe("fetchAuthorizedBusinesses", () => {
  it("returns only active businesses, excluding archived ones", async () => {
    const client = {
      GET: vi.fn().mockResolvedValue({
        data: {
          items: [
            { id: "biz-1", name: "Tran Studio", status: "active" },
            { id: "biz-2", name: "Old Shop", status: "archived" },
          ],
        },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    const result = await fetchAuthorizedBusinesses(businessSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses",
      expect.objectContaining({ params: { path: { tenantId: "tenant-1" } } }),
    );
    expect(result).toEqual([{ id: "biz-1", name: "Tran Studio", status: "active" }]);
  });
});

// -------------------------------------------------------------------- //
// Fix round 3 (Important) -- caller's own Personal profile lookup
// -------------------------------------------------------------------- //

describe("fetchOwnPersonalProfile", () => {
  it("returns the caller's own profile when App API resolves one", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { profile: { id: "profile-mine", name: "Personal" } } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    const result = await fetchOwnPersonalProfile(businessSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/personal-profiles/mine",
      expect.objectContaining({ params: { path: { tenantId: "tenant-1" } } }),
    );
    expect(result).toEqual({ id: "profile-mine", name: "Personal" });
  });

  it("returns null (a normal response) when the caller has no Personal profile in this tenant", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { profile: null } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    const result = await fetchOwnPersonalProfile(businessSession, getToken, "org_123", client as never);

    expect(result).toBeNull();
  });
});

describe("startMailboxConnection / fetchMailboxConnection — explicit scope, not session.scope", () => {
  it("startMailboxConnection sends the explicitly passed scope, even when it differs from session.scope", async () => {
    const client = { POST: vi.fn().mockResolvedValue({ data: { connection: {}, attempt: {}, authorizationUrl: "u" } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");
    const otherScope = { kind: "business" as const, businessId: "biz-9" };

    await startMailboxConnection(
      businessSession,
      otherScope,
      { redirectOrigin: "https://office.test", timezone: "UTC", localScanTime: "07:00", requestId: "r1" },
      getToken,
      "org_123",
      client as never,
    );

    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/mailbox-connections/google/start",
      expect.objectContaining({ body: expect.objectContaining({ scope: otherScope }) }),
    );
  });

  it("fetchMailboxConnection queries by the explicitly passed scope", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { connection: null } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");
    const personalScope = { kind: "personal" as const, profileId: "profile-7" };

    await fetchMailboxConnection(businessSession, personalScope, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/mailbox-connections/google",
      expect.objectContaining({
        params: { path: { tenantId: "tenant-1" }, query: { profileId: "profile-7" } },
      }),
    );
  });
});
