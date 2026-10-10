/**
 * Production bug fix -- `createRealGmailDiscoveryClient` (google-mailbox.ts)
 * is the actual `googleapis`-backed implementation; every other test in
 * this suite (discovery.test.ts, google-mailbox.test.ts) only exercises
 * the injectable `GmailDiscoveryClientLike` fake path, so the real
 * wrapper's own error handling had no coverage. `googleapis` itself is
 * mocked here (no real Google network access) so `getMessage`'s Gmail-API
 * call can be forced to resolve with malformed data or reject with a
 * Gmail-shaped error, independent of `createGmailMailboxProvider`'s own
 * OAuth2Client fakes (test-doubles.ts), which this file never touches.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GmailApiError } from "../src/discovery.js";

const { messagesGet, attachmentsGet, getProfile } = vi.hoisted(() => ({
  messagesGet: vi.fn(),
  attachmentsGet: vi.fn(),
  getProfile: vi.fn(),
}));

// vi.mock calls are hoisted above every import in this file (including the
// one below), so google-mailbox.ts's own `import { google } from
// "googleapis"` resolves to this fake -- no real Google network access.
vi.mock("googleapis", () => ({
  google: {
    gmail: () => ({
      users: {
        messages: { get: messagesGet, attachments: { get: attachmentsGet } },
        getProfile,
      },
    }),
  },
}));

import { createRealGmailDiscoveryClient } from "../src/google-mailbox.js";

function fakeOAuth2Client() {
  // google.gmail() is fully mocked above, so this is never actually used
  // to sign/authorize a request.
  return {} as never;
}

describe("createRealGmailDiscoveryClient", () => {
  beforeEach(() => {
    messagesGet.mockReset();
    attachmentsGet.mockReset();
    getProfile.mockReset();
  });

  it("getMessage: the poison-message bug -- an unparseable Date header no longer fails the whole message", async () => {
    messagesGet.mockResolvedValue({
      data: {
        id: "msg-1",
        threadId: null,
        internalDate: String(Date.UTC(2026, 9, 10, 12, 0, 0)),
        payload: { headers: [{ name: "Date", value: "garbage, not a real date" }], parts: [] },
      },
    });
    const client = createRealGmailDiscoveryClient(fakeOAuth2Client());

    const detail = await client.getMessage("msg-1");

    expect(detail.receivedAt).toBe(new Date(Date.UTC(2026, 9, 10, 12, 0, 0)).toISOString());
  });

  it("getMessage: a Gmail 404 still maps to GmailApiError not_found (unchanged)", async () => {
    messagesGet.mockRejectedValue({ response: { status: 404 } });
    const client = createRealGmailDiscoveryClient(fakeOAuth2Client());

    await expect(client.getMessage("missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("getMessage: a Gmail 500 still maps to GmailApiError unavailable (unchanged)", async () => {
    messagesGet.mockRejectedValue({ response: { status: 500 } });
    const client = createRealGmailDiscoveryClient(fakeOAuth2Client());

    await expect(client.getMessage("broken")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("getMessage: a parsing bug AFTER a successful Gmail call is never turned into a GmailApiError", async () => {
    // Malformed response shape (headers is not an array) forces a real
    // TypeError in header lookup -- this must surface as-is, not get
    // mapped to a Gmail API "unknown" by a catch that was never meant to
    // see it.
    messagesGet.mockResolvedValue({
      data: { id: "msg-1", threadId: null, payload: { headers: "not-an-array" } },
    });
    const client = createRealGmailDiscoveryClient(fakeOAuth2Client());

    const rejection = client.getMessage("msg-1");
    await expect(rejection).rejects.toThrow(TypeError);
    await expect(rejection).rejects.not.toBeInstanceOf(GmailApiError);
  });

  it("getProfileHistoryId: a Gmail 401 still maps to GmailApiError reauth_required (unchanged)", async () => {
    getProfile.mockRejectedValue({ response: { status: 401 } });
    const client = createRealGmailDiscoveryClient(fakeOAuth2Client());

    await expect(client.getProfileHistoryId()).rejects.toMatchObject({ code: "reauth_required" });
  });
});
