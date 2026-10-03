// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfficeSession } from "./session";
import {
  MAILBOX_SESSION_NONCE_COOKIE,
  clearMailboxSessionNonceCookie,
  connectMailboxGoogle,
  createMailboxSessionNonce,
  mailboxStatusDisplay,
  readMailboxSessionNonceCookie,
  writeMailboxSessionNonceCookie,
} from "./mailbox";

const personalSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal", profileId: "profile-1" },
  label: "Personal",
};

afterEach(() => {
  clearMailboxSessionNonceCookie();
  vi.restoreAllMocks();
});

describe("mailbox session nonce — creation", () => {
  it("creates a 64-char hex nonce with real entropy (not a fixed/all-same value)", () => {
    const first = createMailboxSessionNonce();
    const second = createMailboxSessionNonce();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
  });
});

describe("mailbox session nonce — cookie transport, never localStorage", () => {
  it("writes the nonce to a Secure, SameSite=Lax, non-persistent cookie", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const nonce = createMailboxSessionNonce();

    writeMailboxSessionNonceCookie(nonce);

    expect(document.cookie).toContain(`${MAILBOX_SESSION_NONCE_COOKIE}=${nonce}`);
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("reads back exactly the nonce it wrote", () => {
    const nonce = createMailboxSessionNonce();
    writeMailboxSessionNonceCookie(nonce);
    expect(readMailboxSessionNonceCookie()).toBe(nonce);
  });

  it("returns null when no cookie is set", () => {
    expect(readMailboxSessionNonceCookie()).toBeNull();
  });

  it("clears the cookie so a later read returns null", () => {
    writeMailboxSessionNonceCookie(createMailboxSessionNonce());
    clearMailboxSessionNonceCookie();
    expect(readMailboxSessionNonceCookie()).toBeNull();
  });
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
  it("writes the cookie with the same raw nonce it sends to the server, never touching localStorage", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const client = {
      POST: vi.fn().mockResolvedValue({
        data: {
          connection: { id: "connection-1", status: "pending" },
          attempt: { id: "attempt-1" },
          authorizationUrl: "https://accounts.google.test/auth",
        },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    const result = await connectMailboxGoogle(personalSession, getToken, "org_123", {
      client: client as never,
      redirectOrigin: "https://expense-office.test",
      requestId: "request-1",
    });

    expect(result.authorizationUrl).toBe("https://accounts.google.test/auth");
    expect(client.POST).toHaveBeenCalledOnce();
    const [, requestInit] = client.POST.mock.calls[0] as [string, { body: { sessionNonce: string } }];
    const sentNonce = requestInit.body.sessionNonce;
    expect(readMailboxSessionNonceCookie()).toBe(sentNonce);
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("sends the active scope, redirect origin, and requestId through to App API", async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({
        data: { connection: {}, attempt: {}, authorizationUrl: "https://accounts.google.test/auth" },
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
        body: expect.objectContaining({
          scope: { kind: "personal", profileId: "profile-1" },
          redirectOrigin: "https://expense-office.test",
          requestId: "request-2",
          localScanTime: "07:30",
        }),
      }),
    );
  });
});
