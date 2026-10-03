// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfficeSession } from "./session";
import { connectMailboxGoogle, mailboxStatusDisplay } from "./mailbox";

const personalSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal", profileId: "profile-1" },
  label: "Personal",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("mailboxStatusDisplay — connection status rendering", () => {
  it.each([
    ["pending", "warn"],
    ["active", "ok"],
    ["paused", "warn"],
    ["reauth_required", "warn"],
    ["disconnecting", "warn"],
    ["revocation_pending", "warn"],
    ["revoked", "bad"],
  ] as const)("maps status %s to tone %s", (status, tone) => {
    const display = mailboxStatusDisplay(status);
    expect(display.tone).toBe(tone);
    expect(display.label.length).toBeGreaterThan(0);
  });
});

describe("connectMailboxGoogle", () => {
  it("never touches localStorage, and returns the broker's begin URL unchanged", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const client = {
      POST: vi.fn().mockResolvedValue({
        data: {
          connection: { id: "connection-1", status: "pending" },
          attempt: { id: "attempt-1" },
          authorizationUrl: "https://expense-mailbox.test/oauth/google/begin?authorizationUrl=...&nonce=...",
        },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    const result = await connectMailboxGoogle(personalSession, getToken, "org_123", {
      client: client as never,
      redirectOrigin: "https://expense-office.test",
      requestId: "request-1",
    });

    expect(result.authorizationUrl).toBe(
      "https://expense-mailbox.test/oauth/google/begin?authorizationUrl=...&nonce=...",
    );
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("sends no sessionNonce field -- App API generates it server-side", async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({
        data: { connection: {}, attempt: {}, authorizationUrl: "https://expense-mailbox.test/oauth/google/begin" },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await connectMailboxGoogle(personalSession, getToken, "org_123", {
      client: client as never,
      redirectOrigin: "https://expense-office.test",
      requestId: "request-2",
      localScanTime: "07:30",
    });

    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/mailbox-connections/google/start",
      expect.objectContaining({
        params: { path: { tenantId: "tenant-1" } },
        body: {
          scope: { kind: "personal", profileId: "profile-1" },
          redirectOrigin: "https://expense-office.test",
          timezone: expect.any(String),
          localScanTime: "07:30",
          requestId: "request-2",
        },
      }),
    );
  });
});
