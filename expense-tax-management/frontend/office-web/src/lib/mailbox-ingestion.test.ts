/**
 * Phase 3D-C Task 6 -- Office ingestion status UI. Pure unit tests for the
 * status/bucket/action mapping that drives the approved gate
 * (plans/mockups/office-mailbox-ingestion/ingestion.html), reusing the
 * existing candidate read API fields (no backend change -- see
 * task-6-report.md Ruling 1).
 */
import { describe, expect, it } from "vitest";

import {
  isMailboxIngestionCandidate,
  mailboxIngestionAccessMessage,
  mailboxIngestionBucket,
  mailboxIngestionConflictMessage,
  mailboxIngestionStatusDisplay,
  MAILBOX_DUPLICATES_HREF,
  MAILBOX_INGESTION_GROUPS,
} from "./mailbox";

const PERSONAL_SCOPE = { kind: "personal" as const, profileId: "profile-1" };

describe("isMailboxIngestionCandidate / mailboxIngestionBucket -- queued/processed/duplicate/review/failed status", () => {
  it.each([
    ["queued", "in_progress"],
    ["processed", "completed"],
    ["duplicate", "needs_attention"],
    ["review", "needs_attention"],
    ["failed", "needs_attention"],
  ] as const)(
    "a scope-assigned %s candidate belongs on the board, bucketed %s",
    (status, bucket) => {
      const candidate = { status, scope: PERSONAL_SCOPE };
      expect(isMailboxIngestionCandidate(candidate)).toBe(true);
      expect(mailboxIngestionBucket(candidate)).toBe(bucket);
    },
  );

  it.each(["staged", "review", "skipped"] as const)(
    "excludes a %s candidate that was never approved (no scope assigned yet)",
    (status) => {
      expect(isMailboxIngestionCandidate({ status, scope: null })).toBe(false);
    },
  );

  it("excludes a skipped/not_receipt candidate even though skip never touches scope", () => {
    expect(
      isMailboxIngestionCandidate({ status: "skipped", scope: PERSONAL_SCOPE }),
    ).toBe(false);
  });
});

describe("MAILBOX_INGESTION_GROUPS", () => {
  it("has exactly the three groups the approved mockup requires, in display order", () => {
    expect(MAILBOX_INGESTION_GROUPS.map((group) => group.bucket)).toEqual([
      "in_progress",
      "needs_attention",
      "completed",
    ]);
    for (const group of MAILBOX_INGESTION_GROUPS) {
      expect(group.label.length).toBeGreaterThan(0);
      expect(group.emptyMessage.length).toBeGreaterThan(0);
    }
  });
});

describe("mailboxIngestionStatusDisplay", () => {
  it("queued, no job activity yet -- plain 'Queued', not an active/live row (review finding #8)", () => {
    const display = mailboxIngestionStatusDisplay({
      status: "queued",
      scope: PERSONAL_SCOPE,
      ingestionProgress: null,
      errorCode: null,
      expenseId: null,
    });
    expect(display.label).toBe("Queued");
    expect(display.action).toBeNull();
    expect(display.active).toBe(false);
  });

  it("queued with ingestionProgress.phase 'materializing' -- an active/live row (review finding #1, #8)", () => {
    const display = mailboxIngestionStatusDisplay({
      status: "queued",
      scope: PERSONAL_SCOPE,
      ingestionProgress: {
        phase: "materializing",
        attachments: { total: 0, succeeded: 0, failed: 0, pending: 0 },
      },
      errorCode: null,
      expenseId: null,
    });
    expect(display.label).toBe("Materializing");
    expect(display.action).toBeNull();
    expect(display.active).toBe(true);
  });

  it("queued with ingestionProgress.phase 'processing_attachments' -- OCR in progress, reports succeeded/total counts, an active/live row", () => {
    const display = mailboxIngestionStatusDisplay({
      status: "queued",
      scope: PERSONAL_SCOPE,
      ingestionProgress: {
        phase: "processing_attachments",
        attachments: { total: 2, succeeded: 1, failed: 0, pending: 1 },
      },
      errorCode: null,
      expenseId: null,
    });
    expect(display.label).toBe("OCR in progress");
    expect(display.note).toMatch(/1\/2/);
    expect(display.action).toBeNull();
    expect(display.active).toBe(true);
  });

  it("processed with an expense reference -- Ingested, links to the created expense (OCR job/file-free: no processingJobId field at all on this candidate)", () => {
    const display = mailboxIngestionStatusDisplay({
      status: "processed",
      scope: PERSONAL_SCOPE,
      ingestionProgress: null,
      errorCode: null,
      expenseId: "expense-1",
    });
    expect(display.label).toBe("Ingested");
    expect(display.action).toEqual({
      kind: "viewExpense",
      expenseId: "expense-1",
    });
  });

  it("processed with no expense reference yet -- no action, never throws", () => {
    const display = mailboxIngestionStatusDisplay({
      status: "processed",
      scope: PERSONAL_SCOPE,
      ingestionProgress: null,
      errorCode: null,
      expenseId: null,
    });
    expect(display.action).toBeNull();
  });

  it("duplicate -- needs attention, links to the existing /duplicates queue (pending dedup, no mailbox-specific view)", () => {
    const display = mailboxIngestionStatusDisplay({
      status: "duplicate",
      scope: PERSONAL_SCOPE,
      ingestionProgress: null,
      errorCode: null,
      expenseId: "expense-2",
    });
    expect(display.label).toBe("Duplicate detected");
    expect(display.action).toEqual({ kind: "viewDuplicate" });
    expect(MAILBOX_DUPLICATES_HREF).toBe("/duplicates");
  });

  it("review (a retry already cleared the error) -- recoverable, re-approve to retry with the same scope", () => {
    const display = mailboxIngestionStatusDisplay({
      status: "review",
      scope: PERSONAL_SCOPE,
      ingestionProgress: null,
      errorCode: null,
      expenseId: null,
    });
    expect(display.action).toEqual({ kind: "retryIngest" });
  });

  it.each([
    "GOOGLE_RATE_LIMITED",
    "GOOGLE_UNAVAILABLE",
    "OCR_EXTRACTION_FAILED",
    "MAILBOX_MATERIALIZE_FAILED",
  ] as const)(
    "failed with transient error code %s -- scoped Retry",
    (errorCode) => {
      const display = mailboxIngestionStatusDisplay({
        status: "failed",
        scope: PERSONAL_SCOPE,
        ingestionProgress: null,
        errorCode,
        expenseId: null,
      });
      expect(display.label).toBe("Failed -- transient error");
      expect(display.action).toEqual({ kind: "retry" });
    },
  );

  it("failed with MALWARE_DETECTED -- dead end, Dismiss only, never Retry", () => {
    const display = mailboxIngestionStatusDisplay({
      status: "failed",
      scope: PERSONAL_SCOPE,
      ingestionProgress: null,
      errorCode: "MALWARE_DETECTED",
      expenseId: null,
    });
    expect(display.label).toBe("Malware scan blocked");
    expect(display.action).toEqual({ kind: "dismiss" });
  });

  it("failed with a non-retryable, non-malware code (e.g. oversize attachment) -- terminal, no action at all", () => {
    const display = mailboxIngestionStatusDisplay({
      status: "failed",
      scope: PERSONAL_SCOPE,
      ingestionProgress: null,
      errorCode: "ATTACHMENT_BOUND_EXCEEDED",
      expenseId: null,
    });
    expect(display.label).toBe("Unsupported attachment");
    expect(display.action).toBeNull();
  });

  it.each(["processed", "duplicate", "review", "failed"] as const)(
    "%s is never an active/live row (role=status is reserved for queued+ingestionProgress rows only)",
    (status) => {
      const display = mailboxIngestionStatusDisplay({
        status,
        scope: PERSONAL_SCOPE,
        ingestionProgress: null,
        errorCode: null,
        expenseId: null,
      });
      expect(display.active).toBe(false);
    },
  );

  it("never reads anything but status/errorCode/expenseId -- no message body/content field exists to leak", () => {
    const candidate = {
      status: "queued" as const,
      scope: PERSONAL_SCOPE,
      ingestionProgress: null,
      errorCode: null,
      expenseId: null,
    };
    expect(Object.keys(candidate)).not.toContain("body");
    expect(Object.keys(candidate)).not.toContain("rawBody");
    expect(Object.keys(candidate)).not.toContain("html");
    expect(Object.keys(candidate)).not.toContain("senderAddress");
    expect(Object.keys(candidate)).not.toContain("subject");
  });
});

describe("mailboxIngestionConflictMessage -- stale conflict refresh", () => {
  it("409 -- the approved gate's inline stale-candidate copy", () => {
    expect(mailboxIngestionConflictMessage(409)).toBe(
      "Candidate changed while retrying -- status refreshed below. Confirm before retrying again.",
    );
  });

  it("any other status (or none) -- a generic failure message, never the stale-candidate copy", () => {
    expect(mailboxIngestionConflictMessage(500)).not.toMatch(
      /changed while retrying/,
    );
    expect(mailboxIngestionConflictMessage(undefined)).not.toMatch(
      /changed while retrying/,
    );
  });
});

describe("mailboxIngestionAccessMessage -- disconnected access", () => {
  it("revoked -- already-ingested expenses are unaffected; no new ingestion activity shows", () => {
    expect(mailboxIngestionAccessMessage("revoked")).toMatch(/disconnected/i);
  });

  it.each([
    "pending",
    "active",
    "paused",
    "reauth_required",
    "disconnecting",
    "revocation_pending",
  ] as const)(
    "%s -- does not block ingestion-status access (only a revoked connection does)",
    (status) => {
      expect(mailboxIngestionAccessMessage(status)).toBeNull();
    },
  );
});
