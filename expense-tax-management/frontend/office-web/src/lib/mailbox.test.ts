// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfficeSession } from "./session";
import {
  connectMailboxGoogle,
  mailboxCandidateReviewActionLabel,
  mailboxReasonCodeLabel,
  mailboxStatusDisplay,
  MAILBOX_CANDIDATE_CLASSIFICATION_GROUPS,
} from "./mailbox";

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

    const result = await connectMailboxGoogle(personalSession, personalSession.scope, getToken, "org_123", {
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
    const businessScope = { kind: "business" as const, businessId: "business-9" };

    await connectMailboxGoogle(personalSession, businessScope, getToken, "org_123", {
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
          scope: businessScope,
          redirectOrigin: "https://expense-office.test",
          timezone: expect.any(String),
          localScanTime: "07:30",
          requestId: "request-2",
        },
      }),
    );
  });
});

describe("MAILBOX_CANDIDATE_CLASSIFICATION_GROUPS", () => {
  it("has exactly the three groups the approved mockup requires, in display order", () => {
    expect(MAILBOX_CANDIDATE_CLASSIFICATION_GROUPS.map((group) => group.classification)).toEqual([
      "receipt",
      "ambiguous",
      "not_receipt",
    ]);
    for (const group of MAILBOX_CANDIDATE_CLASSIFICATION_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.emptyMessage.length).toBeGreaterThan(0);
    }
  });
});

describe("mailboxReasonCodeLabel", () => {
  it("maps every fixed catalog code to a non-empty, human label", () => {
    const codes = [
      "pdf_attachment_detected",
      "order_confirmation_schema",
      "structured_html_invoice",
      "sender_domain_known_retailer",
      "sender_domain_unverified",
      "subject_keyword_order",
      "free_text_only_low_confidence",
      "marketing_keyword_match",
      "no_structured_or_attachment_evidence",
    ];
    for (const code of codes) {
      const label = mailboxReasonCodeLabel(code);
      expect(label).not.toBe(code);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the raw code for an unknown/future reason code, never throwing", () => {
    expect(mailboxReasonCodeLabel("a_future_3d_c_reason_code")).toBe("a_future_3d_c_reason_code");
  });
});

describe("mailboxCandidateReviewActionLabel", () => {
  it.each([
    ["ingest", "Approve for ingestion"],
    ["skip", "Skip"],
    ["not_receipt", "Not a receipt"],
    ["retry", "Retry"],
  ] as const)("labels %s as %s", (action, label) => {
    expect(mailboxCandidateReviewActionLabel(action)).toBe(label);
  });
});
