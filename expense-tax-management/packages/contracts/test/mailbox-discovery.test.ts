import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AttachmentManifestV1Schema,
  MAX_CANDIDATE_ATTACHMENTS,
  MailboxCandidateClassificationSchema,
  MailboxCandidateRecordV1Schema,
  MailboxCandidateStatusSchema,
  MailboxCandidateV1Schema,
  MailboxScanRunStatusSchema,
  MailboxScanRunV1Schema,
  mailboxIdempotencyKey,
} from "../src/index.js";

const discoverySource = readFileSync(
  fileURLToPath(new URL("../src/mailbox-discovery.ts", import.meta.url)),
  "utf8",
);

const ids = {
  id: "00000000-0000-4000-8000-000000000001",
  connectionId: "00000000-0000-4000-8000-000000000002",
  tenantId: "00000000-0000-4000-8000-000000000003",
  scanRunId: "00000000-0000-4000-8000-000000000004",
  profileId: "00000000-0000-4000-8000-000000000005",
  userId: "00000000-0000-4000-8000-000000000006",
};

const digest = "a".repeat(64);
const timestamp = "2026-09-12T00:00:00.000Z";

const attachment = {
  name: "receipt.pdf",
  mimeType: "application/pdf" as const,
  sizeBytes: 1024,
  sha256: digest,
};

const scanRun = {
  schemaVersion: 1 as const,
  id: ids.id,
  connectionId: ids.connectionId,
  tenantId: ids.tenantId,
  initiatedBy: ids.userId,
  entitlementVersion: 1,
  connectionVersion: 1,
  status: "pending" as const,
  discoveredCount: 0,
  stagedCount: 0,
  reviewCount: 0,
  duplicateCount: 0,
  skippedCount: 0,
  failedCount: 0,
  errorCode: null,
  idempotencyKey: mailboxIdempotencyKey(ids.connectionId, "scan", "daily", 1),
  createdAt: timestamp,
  startedAt: null,
  completedAt: null,
};

const candidate = {
  schemaVersion: 1 as const,
  id: ids.id,
  scanRunId: ids.scanRunId,
  connectionId: ids.connectionId,
  tenantId: ids.tenantId,
  receivedAt: timestamp,
  senderAddress: "merchant@example.com",
  senderDomain: "example.com",
  subject: "Your receipt",
  contentHash: digest,
  attachmentManifest: [attachment],
  classification: "receipt" as const,
  confidence: 0.9,
  evidence: ["pdf attachment"],
  scope: null,
  status: "staged" as const,
  processingJobId: null,
  expenseId: null,
  sourceId: null,
  duplicateMatchId: null,
  version: 1,
  idempotencyKey: mailboxIdempotencyKey(ids.connectionId, "candidate", "msg-1", 1),
  errorCode: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("mailbox discovery contracts – AttachmentManifestV1", () => {
  it("parses a valid attachment and rejects a disallowed MIME type", () => {
    expect(AttachmentManifestV1Schema.parse(attachment)).toEqual(attachment);
    expect(
      AttachmentManifestV1Schema.safeParse({ ...attachment, mimeType: "text/html" }).success,
    ).toBe(false);
  });

  it("caps candidate attachment manifests at five (spec: 'at most 5 accepted attachments')", () => {
    expect(MAX_CANDIDATE_ATTACHMENTS).toBe(5);
    const five = Array.from({ length: 5 }, (_, index) => ({
      ...attachment,
      name: `receipt-${index}.pdf`,
    }));
    const six = [...five, { ...attachment, name: "receipt-5.pdf" }];
    expect(MailboxCandidateV1Schema.safeParse({ ...candidate, attachmentManifest: five }).success).toBe(
      true,
    );
    expect(MailboxCandidateV1Schema.safeParse({ ...candidate, attachmentManifest: six }).success).toBe(
      false,
    );
  });
});

describe("mailbox discovery contracts – MailboxScanRunV1", () => {
  it("parses every documented status and the schedule/user initiator union", () => {
    expect(MailboxScanRunStatusSchema.options).toEqual([
      "pending",
      "running",
      "completed",
      "partial",
      "failed",
      "skipped",
    ]);
    expect(MailboxScanRunV1Schema.parse(scanRun)).toEqual(scanRun);
    expect(MailboxScanRunV1Schema.parse({ ...scanRun, initiatedBy: "schedule" }).initiatedBy).toBe(
      "schedule",
    );
    expect(MailboxScanRunV1Schema.safeParse({ ...scanRun, initiatedBy: "not-a-uuid-or-schedule" }).success).toBe(
      false,
    );
  });

  it("rejects unknown fields (strict object, no provider metadata leakage)", () => {
    expect(
      MailboxScanRunV1Schema.safeParse({ ...scanRun, providerMessageId: "x" }).success,
    ).toBe(false);
  });
});

describe("mailbox discovery contracts – MailboxCandidateV1 / MailboxCandidateRecordV1", () => {
  it("parses every documented classification and status", () => {
    expect(MailboxCandidateClassificationSchema.options).toEqual([
      "receipt",
      "ambiguous",
      "not_receipt",
    ]);
    expect(MailboxCandidateStatusSchema.options).toEqual([
      "staged",
      "review",
      "queued",
      "processed",
      "duplicate",
      "skipped",
      "failed",
    ]);
    expect(MailboxCandidateV1Schema.parse(candidate)).toEqual(candidate);
  });

  it("accepts an assigned Personal scope and a null (unassigned/review) scope", () => {
    expect(
      MailboxCandidateV1Schema.safeParse({
        ...candidate,
        scope: { kind: "personal", profileId: ids.profileId },
      }).success,
    ).toBe(true);
    expect(MailboxCandidateV1Schema.safeParse({ ...candidate, scope: null }).success).toBe(true);
  });

  it("public MailboxCandidateV1Schema carries no provider message/thread ID (strict, no unknown keys)", () => {
    expect(
      MailboxCandidateV1Schema.safeParse({
        ...candidate,
        providerMessageId: "msg-1",
      }).success,
    ).toBe(false);
  });

  it("MailboxCandidateRecordV1Schema adds provider message/thread ID (App-internal row only)", () => {
    const record = { ...candidate, providerMessageId: "msg-1", providerThreadId: "thread-1" };
    expect(MailboxCandidateRecordV1Schema.parse(record)).toEqual(record);
    expect(
      MailboxCandidateRecordV1Schema.safeParse({ ...candidate, providerThreadId: null }).success,
    ).toBe(false); // providerMessageId required
  });
});

describe("mailbox discovery contracts – no provider metadata in execution/batch/count contracts", () => {
  // Global Constraint: "Temporal inputs/results/heartbeats/errors contain
  // only scanRunId, candidateId, counts, page sequence, and typed errors.
  // No history ID, cursor, pre-fence token, message ID, thread ID, sender,
  // subject, or attachment metadata." Verified by source-text inspection of
  // each interface body (plain-interface, Temporal-crossing contracts).
  const forbidden = /provider|history|cursor|prefence|sender|subject|attachment/i;

  function interfaceBody(name: string): string {
    const match = discoverySource.match(
      new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`),
    );
    expect(match, `interface ${name} not found`).not.toBeNull();
    return match![0];
  }

  it("MailboxScanExecutionInputV1 carries only schemaVersion/scanRunId", () => {
    const body = interfaceBody("MailboxScanExecutionInputV1");
    expect(body).not.toMatch(forbidden);
    expect(body).toContain("scanRunId");
  });

  it("MailboxCandidateBatchV1 carries only IDs and counts", () => {
    const body = interfaceBody("MailboxCandidateBatchV1");
    expect(body).not.toMatch(forbidden);
    expect(body).toContain("candidateIds");
    expect(body).toContain("stagedCount");
  });

  it("MailboxScanCountResultV1 carries only IDs and counts", () => {
    const body = interfaceBody("MailboxScanCountResultV1");
    expect(body).not.toMatch(forbidden);
    expect(body).toContain("counts");
  });

  it("DiscoveryPageV1 and MailboxCandidateOutcomeV1 carry only opaque IDs/counts/typed errors", () => {
    expect(interfaceBody("DiscoveryPageV1")).not.toMatch(forbidden);
    expect(interfaceBody("MailboxCandidateOutcomeV1")).not.toMatch(forbidden);
  });
});

describe("mailbox discovery contracts – broker<->App boundary carries opaque cursor state (never through Temporal)", () => {
  it("MailboxBrokerScanBindingV1 and MailboxCandidateMetadataStagingV1 declare cursor/pre-fence fields", () => {
    const binding = discoverySource.match(/export interface MailboxBrokerScanBindingV1 \{[\s\S]*?\n\}/)![0];
    expect(binding).toContain("currentHistoryId");
    expect(binding).toContain("preFenceToken");
    expect(binding).toContain("nextPageSequence");

    const staging = discoverySource.match(
      /export interface MailboxCandidateMetadataStagingV1 \{[\s\S]*?\n\}/,
    )![0];
    expect(staging).toContain("cursorBeforeDigest");
    expect(staging).toContain("nextHistoryId");
    expect(staging).toContain("providerMessageId");
  });
});
