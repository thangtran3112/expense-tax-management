import { describe, expect, it } from "vitest";

import { mailboxIdempotencyKey, type MailboxProviderAdapter } from "../src/contracts.js";

describe("mailbox-broker contracts re-export", () => {
  it("imports the canonical idempotency-key helper from @expense-tax/contracts", () => {
    expect(mailboxIdempotencyKey("conn-1", "revoke", "op-1", 2)).toBe("conn-1:revoke:op-1:2");
  });

  it("re-exports MailboxProviderAdapter as a type the Gmail adapter will implement", () => {
    const fake: MailboxProviderAdapter = {
      createAuthorizationUrl: async () => ({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        stateDigest: "a".repeat(64),
        expiresAt: "2026-09-12T00:10:00.000Z",
      }),
      exchangeAuthorizationCode: async () => ({
        providerAccountId: "109876543210",
        email: "owner@example.com",
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        initialHistoryId: "12345",
        vaultReference: "vault:ref:1",
        tokenGeneration: 1,
      }),
      revoke: async () => undefined,
    };

    expect(typeof fake.createAuthorizationUrl).toBe("function");
  });
});
