import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MailboxConnectionRecordV1Schema,
  MailboxConnectionStatusSchema,
  MailboxConnectionV1Schema,
  MailboxErrorCodeV1Schema,
  MailboxOAuthAttemptV1Schema,
  MailboxProviderSchema,
  MailboxReviewerGrantV1Schema,
  MailboxScopeSchema,
  ScopeSchema,
  mailboxIdempotencyKey,
} from "../src/index.js";

const mailboxSource = readFileSync(
  fileURLToPath(new URL("../src/mailbox.ts", import.meta.url)),
  "utf8",
);

const ids = {
  connectionId: "00000000-0000-4000-8000-000000000001",
  tenantId: "00000000-0000-4000-8000-000000000002",
  ownerUserId: "00000000-0000-4000-8000-000000000003",
  profileId: "00000000-0000-4000-8000-000000000004",
  actorUserId: "00000000-0000-4000-8000-000000000005",
  attemptId: "00000000-0000-4000-8000-000000000006",
  userId: "00000000-0000-4000-8000-000000000007",
};

const digest = "a".repeat(64);

const publicConnection = {
  schemaVersion: 1 as const,
  id: ids.connectionId,
  tenantId: ids.tenantId,
  ownerUserId: ids.ownerUserId,
  provider: "gmail" as const,
  providerAccountId: "109876543210",
  accountEmail: "owner@example.com",
  scope: { kind: "personal" as const, profileId: ids.profileId },
  status: "active" as const,
  grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  timezone: "America/Los_Angeles",
  localScanTime: "06:30",
  scanEnabled: true,
  lastScanAt: null,
  nextScheduleAt: null,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
  revokedAt: null,
};

describe("mailbox contracts – scope reuse", () => {
  it("MailboxScope round-trips through the canonical ScopeSchema", () => {
    expect(MailboxScopeSchema).toBe(ScopeSchema);
    const scope = { kind: "business" as const, businessId: ids.profileId };
    expect(MailboxScopeSchema.parse(scope)).toEqual(scope);
  });

  it("does not declare a second scope schema/duplicate union in mailbox.ts", () => {
    expect(mailboxSource).not.toMatch(/z\.union\(/);
    expect(mailboxSource).toContain('import { ScopeSchema, type Scope } from "./enrichment.js"');
    expect(mailboxSource).toContain("export const MailboxScopeSchema = ScopeSchema");
  });
});

describe("mailbox contracts – provider", () => {
  it("accepts gmail and outlook at the schema level", () => {
    expect(MailboxProviderSchema.parse("gmail")).toBe("gmail");
    expect(MailboxProviderSchema.parse("outlook")).toBe("outlook");
  });

  it("rejects an unsupported provider value", () => {
    expect(MailboxProviderSchema.safeParse("yahoo").success).toBe(false);
  });

  it("exposes PROVIDER_UNSUPPORTED as the domain-layer rejection code for outlook", () => {
    expect(MailboxErrorCodeV1Schema.parse("PROVIDER_UNSUPPORTED")).toBe("PROVIDER_UNSUPPORTED");
  });
});

describe("mailbox contracts – connection status and error codes", () => {
  it("accepts every documented connection status", () => {
    for (const status of [
      "pending",
      "active",
      "paused",
      "reauth_required",
      "disconnecting",
      "revocation_pending",
      "revoked",
    ]) {
      expect(MailboxConnectionStatusSchema.parse(status)).toBe(status);
    }
  });

  it("accepts every documented error code", () => {
    for (const code of [
      "ENTITLEMENT_DISABLED",
      "SCOPE_ACCESS_DENIED",
      "CONNECTION_NOT_FOUND",
      "PROVIDER_UNSUPPORTED",
      "OAUTH_ATTEMPT_EXPIRED",
      "OAUTH_STATE_INVALID",
      "OAUTH_REPLAY",
      "OAUTH_SCOPE_MISMATCH",
      "GOOGLE_REAUTH_REQUIRED",
      "GOOGLE_RATE_LIMITED",
      "GOOGLE_UNAVAILABLE",
      "VERSION_CONFLICT",
      "IDEMPOTENCY_CONFLICT",
      "REVOKE_PENDING",
      "ATTACHMENT_BOUND_EXCEEDED",
      "ATTACHMENT_SIGNATURE_REJECTED",
      "STRUCTURED_RECEIPT_BOUND_EXCEEDED",
      "STRUCTURED_RECEIPT_NOT_FOUND",
      "STRUCTURED_RECEIPT_INCOMPLETE",
    ]) {
      expect(MailboxErrorCodeV1Schema.parse(code)).toBe(code);
    }
  });
});

describe("mailbox contracts – public/internal record separation", () => {
  it("parses a valid public connection", () => {
    expect(MailboxConnectionV1Schema.parse(publicConnection)).toEqual(publicConnection);
  });

  it("rejects secret/internal fields on the public schema (strict, unknown keys forbidden)", () => {
    const withVaultReference = { ...publicConnection, vaultReference: "vault:ref:1" };
    expect(MailboxConnectionV1Schema.safeParse(withVaultReference).success).toBe(false);

    const withTokenGeneration = { ...publicConnection, tokenGeneration: 1 };
    expect(MailboxConnectionV1Schema.safeParse(withTokenGeneration).success).toBe(false);

    const withLease = { ...publicConnection, tokenOperationLeaseId: null };
    expect(MailboxConnectionV1Schema.safeParse(withLease).success).toBe(false);
  });

  it("the internal record schema requires the vault pointer and CAS/lease internals", () => {
    const record = {
      ...publicConnection,
      vaultReference: "vault:ref:1",
      tokenGeneration: 1,
      connectionVersion: 1,
      tokenOperationLeaseId: null,
      tokenOperationLeaseExpiresAt: null,
      activeScanRunId: null,
      activeScanLeaseExpiresAt: null,
    };
    expect(MailboxConnectionRecordV1Schema.parse(record)).toEqual(record);

    const missingVaultReference: Record<string, unknown> = { ...record };
    delete missingVaultReference.vaultReference;
    expect(MailboxConnectionRecordV1Schema.safeParse(missingVaultReference).success).toBe(false);
  });

  it("never stores a token, authorization code, or PKCE verifier field on either schema", () => {
    for (const forbidden of ["refreshToken", "accessToken", "authorizationCode", "pkceVerifier", "clientSecret"]) {
      expect(mailboxSource).not.toContain(forbidden);
    }
  });
});

describe("mailbox contracts – OAuth attempt lifecycle", () => {
  const base = {
    schemaVersion: 1 as const,
    id: ids.attemptId,
    connectionId: ids.connectionId,
    tenantId: ids.tenantId,
    actorUserId: ids.actorUserId,
    stateDigest: digest,
    sessionNonceDigest: digest,
    redirectOrigin: "https://expense-office.tobytran.dev",
    expiresAt: "2026-09-12T00:10:00.000Z",
    createdAt: "2026-09-12T00:00:00.000Z",
  };

  it("accepts a pending attempt with no consumed/completed timestamps", () => {
    expect(
      MailboxOAuthAttemptV1Schema.parse({
        ...base,
        status: "pending",
        consumedAt: null,
        completedAt: null,
      }),
    ).toMatchObject({ status: "pending" });
  });

  it("accepts a completed attempt with both timestamps set", () => {
    expect(
      MailboxOAuthAttemptV1Schema.parse({
        ...base,
        status: "completed",
        consumedAt: "2026-09-12T00:01:00.000Z",
        completedAt: "2026-09-12T00:02:00.000Z",
      }),
    ).toMatchObject({ status: "completed" });
  });

  it("rejects a pending attempt that already carries a consumedAt timestamp", () => {
    expect(
      MailboxOAuthAttemptV1Schema.safeParse({
        ...base,
        status: "pending",
        consumedAt: "2026-09-12T00:01:00.000Z",
        completedAt: null,
      }).success,
    ).toBe(false);
  });

  it("rejects a consumed attempt missing its consumedAt timestamp", () => {
    expect(
      MailboxOAuthAttemptV1Schema.safeParse({
        ...base,
        status: "consumed",
        consumedAt: null,
        completedAt: null,
      }).success,
    ).toBe(false);
  });
});

describe("mailbox contracts – reviewer grant", () => {
  it("parses an active reviewer grant", () => {
    const grant = {
      schemaVersion: 1 as const,
      connectionId: ids.connectionId,
      tenantId: ids.tenantId,
      userId: ids.userId,
      role: "reviewer" as const,
      version: 1,
      revokedAt: null,
    };
    expect(MailboxReviewerGrantV1Schema.parse(grant)).toEqual(grant);
  });

  it("rejects an unknown role", () => {
    expect(
      MailboxReviewerGrantV1Schema.safeParse({
        schemaVersion: 1,
        connectionId: ids.connectionId,
        tenantId: ids.tenantId,
        userId: ids.userId,
        role: "owner",
        version: 1,
        revokedAt: null,
      }).success,
    ).toBe(false);
  });
});

describe("mailbox contracts – permanent idempotency key / replay conflict", () => {
  it("is deterministic for the same inputs (permanent replay returns the same key)", () => {
    const key1 = mailboxIdempotencyKey(ids.connectionId, "advance_token_generation", "lease-1", 3);
    const key2 = mailboxIdempotencyKey(ids.connectionId, "advance_token_generation", "lease-1", 3);
    expect(key1).toBe(key2);
    expect(key1).toBe(`${ids.connectionId}:advance_token_generation:lease-1:3`);
  });

  it("differs when any one component (e.g. version) differs, producing a distinct key for a conflicting replay", () => {
    const key1 = mailboxIdempotencyKey(ids.connectionId, "advance_token_generation", "lease-1", 3);
    const key2 = mailboxIdempotencyKey(ids.connectionId, "advance_token_generation", "lease-1", 4);
    expect(key1).not.toBe(key2);
  });
});
