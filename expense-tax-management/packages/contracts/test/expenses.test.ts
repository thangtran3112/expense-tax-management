import { describe, expect, it } from "vitest";

import { ExpenseMailboxProvenanceV1Schema } from "../src/index.js";

const baseProvenance = {
  senderAddress: "merchant@example.com",
  receivedAt: "2026-09-12T00:00:00.000Z",
  mailboxAccountEmail: "owner@example.com",
  pendingDuplicateReview: false,
};

describe("ExpenseMailboxProvenanceV1Schema", () => {
  it("parses a well-formed provenance record", () => {
    expect(ExpenseMailboxProvenanceV1Schema.parse(baseProvenance)).toEqual(baseProvenance);
  });

  it("fix round 6: serializes an RFC-5322-valid sender address zod's strict z.email() would have rejected", () => {
    // Same underlying column (app.mailbox_candidates.sender_address) as
    // MailboxCandidateV1Schema.senderAddress -- the expense-detail "Source"
    // block's provenance is exposed to the same external-From-header risk.
    expect(
      ExpenseMailboxProvenanceV1Schema.safeParse({
        ...baseProvenance,
        senderAddress: "bounce+x=y@example.com",
      }).success,
    ).toBe(true);
  });

  it("keeps mailboxAccountEmail strictly validated (Google-OAuth-verified, not external-sender-controlled)", () => {
    expect(
      ExpenseMailboxProvenanceV1Schema.safeParse({
        ...baseProvenance,
        mailboxAccountEmail: "Display Name <owner@example.com>",
      }).success,
    ).toBe(false);
  });
});
