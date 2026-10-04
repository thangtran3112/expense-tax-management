import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MAX_CANDIDATE_ATTACHMENTS,
  MailboxAttachmentUploadResultV1Schema,
  MailboxBrokerUploadGrantV1Schema,
  MailboxMaterializationResultV1Schema,
} from "../src/index.js";
import { MAX_UPLOAD_BYTES } from "../src/files.js";

const ingestionSource = readFileSync(
  fileURLToPath(new URL("../src/mailbox-ingestion.ts", import.meta.url)),
  "utf8",
);

function interfaceBody(name: string): string {
  const match = ingestionSource.match(
    new RegExp(`export interface ${name}[\\s\\S]*?\\{[\\s\\S]*?\\n\\}`),
  );
  expect(match, `interface ${name} not found`).not.toBeNull();
  return match![0];
}

const uuid = "00000000-0000-4000-8000-000000000001";
const uuid2 = "00000000-0000-4000-8000-000000000002";

describe("mailbox ingestion contracts – attachment caps match existing contracts, not a third magic number", () => {
  // Spec: "at most 5 accepted attachments, each at most 25 MiB." The grant
  // carries these as numeric literal types (26214400 / 5); this proves
  // those literals, not just their source text, equal the existing
  // MAX_UPLOAD_BYTES/MAX_CANDIDATE_ATTACHMENTS constants, and that the
  // runtime schema actually rejects any other value.
  it("MailboxBrokerUploadGrantV1Schema.maxBytes/maxAttachments equal MAX_UPLOAD_BYTES/MAX_CANDIDATE_ATTACHMENTS and reject other values", () => {
    expect(MAX_UPLOAD_BYTES).toBe(26_214_400);
    expect(MAX_CANDIDATE_ATTACHMENTS).toBe(5);
    const valid = {
      candidateId: uuid,
      connectionId: uuid2,
      uploadGrantId: "grant-token-1",
      expiresAt: "2026-01-01T00:00:00.000Z",
      maxBytes: 26_214_400,
      maxAttachments: 5,
    };
    expect(MailboxBrokerUploadGrantV1Schema.safeParse(valid).success).toBe(true);
    expect(
      MailboxBrokerUploadGrantV1Schema.safeParse({ ...valid, maxBytes: 52_428_800 }).success,
    ).toBe(false);
    expect(
      MailboxBrokerUploadGrantV1Schema.safeParse({ ...valid, maxAttachments: 10 }).success,
    ).toBe(false);
  });

  it("rejects a non-UUID candidateId/connectionId and an opaque token containing whitespace (fix round 2: strict Zod contract on write)", () => {
    const valid = {
      candidateId: uuid,
      connectionId: uuid2,
      uploadGrantId: "grant-token-1",
      expiresAt: "2026-01-01T00:00:00.000Z",
      maxBytes: 26_214_400,
      maxAttachments: 5,
    };
    expect(MailboxBrokerUploadGrantV1Schema.safeParse({ ...valid, candidateId: "not-a-uuid" }).success).toBe(false);
    expect(
      MailboxBrokerUploadGrantV1Schema.safeParse({ ...valid, uploadGrantId: "has a space" }).success,
    ).toBe(false);
  });
});

describe("mailbox ingestion contracts – no raw content crosses any boundary payload", () => {
  // Global Constraint: Temporal/broker-boundary payloads here carry only
  // opaque IDs, counts, typed errors, and (for the structured-receipt
  // result) parsed scalar fields -- never raw bytes/HTML/MIME content.
  const forbidden = /\bbytes\b|rawHtml|rawMime|attachmentData|fileContent|buffer:/i;

  it("MailboxBrokerUploadGrantRequestV1/MailboxBrokerAttachmentUploadV1 carry no raw content field", () => {
    expect(interfaceBody("MailboxBrokerUploadGrantRequestV1")).not.toMatch(forbidden);
    expect(interfaceBody("MailboxBrokerAttachmentUploadV1")).not.toMatch(forbidden);
  });

  it("MailboxAttachmentUploadResultV1Schema rejects a raw-content string masquerading as errorCode, and rejects a free-form fileId with whitespace/newlines", () => {
    const valid = {
      candidateId: uuid,
      attachmentIndex: 0,
      fileId: "file-token-1",
      status: "READY" as const,
      errorCode: null,
      idempotencyKey: "idem-token-1",
    };
    expect(MailboxAttachmentUploadResultV1Schema.safeParse(valid).success).toBe(true);
    expect(
      MailboxAttachmentUploadResultV1Schema.safeParse({
        ...valid,
        status: "FAILED",
        errorCode: "<html>raw body</html>",
      }).success,
    ).toBe(false);
    expect(
      MailboxAttachmentUploadResultV1Schema.safeParse({
        ...valid,
        fileId: "line one\nline two with raw content",
      }).success,
    ).toBe(false);
    expect(MailboxAttachmentUploadResultV1Schema.safeParse({ ...valid, attachmentIndex: 5 }).success).toBe(false);
    expect(MailboxAttachmentUploadResultV1Schema.safeParse({ ...valid, status: "pending" }).success).toBe(false);
  });

  it("StructuredReceiptResultV1 carries only parsed scalar fields and evidence strings, no raw HTML/MIME", () => {
    const body = interfaceBody("StructuredReceiptResultV1");
    expect(body).not.toMatch(forbidden);
    expect(body).toContain("merchant");
    expect(body).toContain("amount");
    expect(body).toContain("evidence");
  });

  it("MailboxWorkerMaterializationInputV1 (Temporal-crossing) carries only scanRunId/candidateId", () => {
    const body = interfaceBody("MailboxWorkerMaterializationInputV1");
    expect(body).not.toMatch(forbidden);
    expect(body).toContain("scanRunId");
    expect(body).toContain("candidateId");
    expect(body).not.toMatch(/provider|history|cursor|sender|subject/i);
  });
});

describe("mailbox ingestion contracts – exact canonical field shapes", () => {
  it("MailboxMaterializationResultV1Schema carries exactly the documented status union and rejects a raw-content idempotencyKey", () => {
    const valid = {
      schemaVersion: 1 as const,
      candidateId: uuid,
      status: "processed" as const,
      processingJobId: null,
      expenseId: null,
      sourceId: null,
      duplicateMatchId: null,
      idempotencyKey: "idem-token-1",
    };
    for (const status of ["queued", "processed", "duplicate", "review", "failed"] as const) {
      expect(MailboxMaterializationResultV1Schema.safeParse({ ...valid, status }).success).toBe(true);
    }
    expect(MailboxMaterializationResultV1Schema.safeParse({ ...valid, status: "pending" }).success).toBe(false);
    expect(
      MailboxMaterializationResultV1Schema.safeParse({
        ...valid,
        idempotencyKey: "raw html body\nwith a newline",
      }).success,
    ).toBe(false);
    expect(
      MailboxMaterializationResultV1Schema.safeParse({ ...valid, processingJobId: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("MailboxOcrJobActorV1 is a user/service discriminated union with the fixed service principal", () => {
    expect(ingestionSource).toMatch(
      /kind: "user"; readonly requestedByUserId: string/,
    );
    expect(ingestionSource).toMatch(
      /kind: "service"; readonly actorServicePrincipal: "mailbox-broker-app"/,
    );
  });

  it("Phase3CEnrichmentInputV1 pins source to the literal 'connected_mailbox'", () => {
    const body = interfaceBody("Phase3CEnrichmentInputV1");
    expect(body).toContain('readonly source: "connected_mailbox";');
  });
});

describe("mailbox ingestion contracts – client/adapter composition (Phase 3D-C ruling)", () => {
  it("MailboxIngestionAppClient extends both MailboxBrokerDiscoveryAppClient and MailboxBrokerMaterializeAppClient (keeps loadCandidateBinding)", () => {
    const body = interfaceBody("MailboxIngestionAppClient");
    expect(body).toMatch(/extends[\s\S]*MailboxBrokerDiscoveryAppClient[\s\S]*MailboxBrokerMaterializeAppClient/);
    expect(body).toContain("issueUploadGrant");
    expect(body).toContain("uploadAttachment");
    expect(body).toContain("submitStructuredResult");
  });

  it("MailboxIngestionProviderAdapter extends MailboxDiscoveryProviderAdapter and adds materialize", () => {
    const body = interfaceBody("MailboxIngestionProviderAdapter");
    expect(body).toMatch(/extends MailboxDiscoveryProviderAdapter/);
    expect(body).toContain("materialize");
  });
});

describe("mailbox discovery contracts – MailboxBrokerMaterializeAppClient is canonical (Phase 3D-C move)", () => {
  it("is exported from @expense-tax/contracts with loadCandidateBinding unchanged", async () => {
    const contracts = await import("../src/index.js");
    expect(typeof contracts).toBe("object");
    const discoverySource = readFileSync(
      fileURLToPath(new URL("../src/mailbox-discovery.ts", import.meta.url)),
      "utf8",
    );
    expect(discoverySource).toMatch(
      /export interface MailboxBrokerMaterializeAppClient \{\s*loadCandidateBinding\(candidateId: string\): Promise<MailboxBrokerCandidateBindingV1>;\s*\}/,
    );
  });
});
