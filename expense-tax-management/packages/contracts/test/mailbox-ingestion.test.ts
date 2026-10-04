import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MAX_CANDIDATE_ATTACHMENTS } from "../src/index.js";
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

describe("mailbox ingestion contracts – attachment caps match existing contracts, not a third magic number", () => {
  // Spec: "at most 5 accepted attachments, each at most 25 MiB." The grant
  // carries these as numeric literal types (26214400 / 5); this proves
  // those literals, not just their source text, equal the existing
  // MAX_UPLOAD_BYTES/MAX_CANDIDATE_ATTACHMENTS constants.
  it("MailboxBrokerUploadGrantV1.maxBytes/maxAttachments literal types equal MAX_UPLOAD_BYTES/MAX_CANDIDATE_ATTACHMENTS", () => {
    expect(MAX_UPLOAD_BYTES).toBe(26_214_400);
    expect(MAX_CANDIDATE_ATTACHMENTS).toBe(5);
    const body = interfaceBody("MailboxBrokerUploadGrantV1");
    expect(body).toContain("readonly maxBytes: 26214400;");
    expect(body).toContain("readonly maxAttachments: 5;");
  });
});

describe("mailbox ingestion contracts – no raw content crosses any boundary payload", () => {
  // Global Constraint: Temporal/broker-boundary payloads here carry only
  // opaque IDs, counts, typed errors, and (for the structured-receipt
  // result) parsed scalar fields -- never raw bytes/HTML/MIME content.
  const forbidden = /\bbytes\b|rawHtml|rawMime|attachmentData|fileContent|buffer:/i;

  it("MailboxBrokerUploadGrantRequestV1/MailboxBrokerAttachmentUploadV1/MailboxAttachmentUploadResultV1 carry no raw content field", () => {
    expect(interfaceBody("MailboxBrokerUploadGrantRequestV1")).not.toMatch(forbidden);
    expect(interfaceBody("MailboxBrokerAttachmentUploadV1")).not.toMatch(forbidden);
    expect(interfaceBody("MailboxAttachmentUploadResultV1")).not.toMatch(forbidden);
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
  it("MailboxMaterializationResultV1 carries exactly the documented status union", () => {
    const body = interfaceBody("MailboxMaterializationResultV1");
    expect(body).toMatch(
      /status: "queued" \| "processed" \| "duplicate" \| "review" \| "failed";/,
    );
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
