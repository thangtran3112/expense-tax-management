/**
 * Phase 3D-B Task 5 — services/mailbox-broker/src/classification.ts.
 *
 * Own design decision (ruling, see task-5-report.md): this module is
 * standalone and is NOT wired into discovery.ts in this task.
 * discovery.ts's own `classifyMessage` (Phase 3D-B Task 4, commit
 * `34999f0`) is under concurrent re-review and already ships a working
 * classifier on the live Gmail discovery path; the task-5-brief.md file
 * list never names discovery.ts, and the orchestrator's explicit
 * instruction is not to modify Task 4 broker discovery files without
 * need. This module instead provides the approved Office mockup's fixed,
 * documented reason-code catalog (plans/mockups/office-mailbox-review/
 * NOTES.md "Decisions made consistent with the 3D-B plan/spec and the
 * duplicates page", ruling 5: "Task 5's classifier module should export
 * this catalog as a typed union/const, not accept arbitrary strings") and
 * a pure, self-contained classifier over the signals available to 3D-B
 * (attachment acceptance, sender-domain reputation, subject keywords).
 *
 * No real Gmail/network access -- pure function tests only.
 */
import { describe, expect, it } from "vitest";

import {
  classifyCandidateEvidence,
  MAILBOX_CANDIDATE_REASON_CODES,
  type MailboxCandidateReasonCode,
} from "../src/classification.js";

describe("MAILBOX_CANDIDATE_REASON_CODES — fixed catalog", () => {
  it("matches the approved mockup's exact nine reason codes", () => {
    expect([...MAILBOX_CANDIDATE_REASON_CODES].sort()).toEqual(
      [
        "pdf_attachment_detected",
        "order_confirmation_schema",
        "structured_html_invoice",
        "sender_domain_known_retailer",
        "sender_domain_unverified",
        "subject_keyword_order",
        "free_text_only_low_confidence",
        "marketing_keyword_match",
        "no_structured_or_attachment_evidence",
      ].sort(),
    );
  });
});

describe("classifyCandidateEvidence — deterministic attachment/structured evidence", () => {
  it("classifies an accepted attachment from a known retailer as a high-confidence receipt", () => {
    const result = classifyCandidateEvidence({
      subject: "Receipt — Northline Hardware order #88213",
      hasAcceptedAttachment: true,
      senderDomainKnownRetailer: true,
    });
    expect(result.classification).toBe("receipt");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.evidence).toContain("pdf_attachment_detected");
    expect(result.evidence).toContain("sender_domain_known_retailer");
  });

  it("classifies a structured order-confirmation schema signal as receipt, even with no attachment", () => {
    const result = classifyCandidateEvidence({
      subject: "Your CloudBooks invoice is ready",
      hasAcceptedAttachment: false,
      senderDomainKnownRetailer: false,
      hasOrderConfirmationSchema: true,
    });
    expect(result.classification).toBe("receipt");
    expect(result.evidence).toContain("order_confirmation_schema");
  });

  it("is deterministic: identical input always returns identical output", () => {
    const input = {
      subject: "Your order #48213 from ShopWave Co.",
      hasAcceptedAttachment: false,
      senderDomainKnownRetailer: false,
    };
    const first = classifyCandidateEvidence(input);
    const second = classifyCandidateEvidence(input);
    expect(second).toEqual(first);
  });

  it("every returned evidence code is a member of the fixed catalog", () => {
    const cases = [
      { subject: "Receipt attached", hasAcceptedAttachment: true, senderDomainKnownRetailer: true },
      { subject: "Your order confirmation", hasAcceptedAttachment: false, senderDomainKnownRetailer: false },
      { subject: "🔥 Flash sale: 30% off everything", hasAcceptedAttachment: false, senderDomainKnownRetailer: false },
      { subject: "Weekly digest", hasAcceptedAttachment: false, senderDomainKnownRetailer: false },
    ];
    for (const input of cases) {
      const result = classifyCandidateEvidence(input);
      for (const code of result.evidence) {
        expect(MAILBOX_CANDIDATE_REASON_CODES).toContain(code as MailboxCandidateReasonCode);
      }
    }
  });
});

describe("classifyCandidateEvidence — free-text review (never auto-ingest)", () => {
  it("classifies an order keyword with no attachment or structured signal as ambiguous, not receipt", () => {
    const result = classifyCandidateEvidence({
      subject: "Order confirmed — thanks for shopping with us",
      hasAcceptedAttachment: false,
      senderDomainKnownRetailer: false,
    });
    expect(result.classification).toBe("ambiguous");
    expect(result.evidence).toContain("free_text_only_low_confidence");
    expect(result.evidence).toContain("subject_keyword_order");
  });

  it("marks sender domain unverified when an order keyword matches but the domain is not a known retailer", () => {
    const result = classifyCandidateEvidence({
      subject: "Your order #48213 from ShopWave Co.",
      hasAcceptedAttachment: false,
      senderDomainKnownRetailer: false,
    });
    expect(result.evidence).toContain("sender_domain_unverified");
  });

  it("never auto-classifies plain free text (no attachment, no structured signal) as a receipt", () => {
    const result = classifyCandidateEvidence({
      subject: "Order confirmed — thanks for shopping with us",
      hasAcceptedAttachment: false,
      senderDomainKnownRetailer: true,
    });
    expect(result.classification).not.toBe("receipt");
  });
});

describe("classifyCandidateEvidence — marketing / no-signal not_receipt", () => {
  it("classifies a marketing-keyword subject with no attachment/structured evidence as not_receipt", () => {
    const result = classifyCandidateEvidence({
      subject: "🔥 Flash sale: 30% off everything this weekend",
      hasAcceptedAttachment: false,
      senderDomainKnownRetailer: false,
    });
    expect(result.classification).toBe("not_receipt");
    expect(result.evidence).toContain("marketing_keyword_match");
    expect(result.evidence).toContain("no_structured_or_attachment_evidence");
  });

  it("classifies a subject with no recognizable signal at all as not_receipt", () => {
    const result = classifyCandidateEvidence({
      subject: "Weekly digest",
      hasAcceptedAttachment: false,
      senderDomainKnownRetailer: false,
    });
    expect(result.classification).toBe("not_receipt");
    expect(result.evidence).toContain("no_structured_or_attachment_evidence");
  });
});

describe("classifyCandidateEvidence — precedence: attachment/structured evidence outranks a marketing subject", () => {
  it("fix round 1 (review Minor): an accepted attachment plus a marketing-keyword subject is ambiguous (conflicting evidence), never not_receipt", () => {
    const result = classifyCandidateEvidence({
      subject: "🔥 Flash sale: your receipt for 30% off everything",
      hasAcceptedAttachment: true,
      senderDomainKnownRetailer: true,
    });
    expect(result.classification).toBe("ambiguous");
    expect(result.evidence).toContain("pdf_attachment_detected");
    expect(result.evidence).toContain("marketing_keyword_match");
    // Real structured/attachment evidence is present -- asserting
    // "no_structured_or_attachment_evidence" here would be factually wrong.
    expect(result.evidence).not.toContain("no_structured_or_attachment_evidence");
  });

  it("a structured order-confirmation schema signal plus a marketing-keyword subject is also ambiguous, not auto-receipt and not not_receipt", () => {
    const result = classifyCandidateEvidence({
      subject: "Flash sale order confirmation — 30% off",
      hasAcceptedAttachment: false,
      senderDomainKnownRetailer: false,
      hasOrderConfirmationSchema: true,
    });
    expect(result.classification).toBe("ambiguous");
    expect(result.evidence).toContain("order_confirmation_schema");
    expect(result.evidence).toContain("marketing_keyword_match");
  });
});

describe("classifyCandidateEvidence — no raw body", () => {
  it("accepts only bounded subject text and booleans, never a body/html/content field", () => {
    const input: Record<string, unknown> = {
      subject: "Receipt attached",
      hasAcceptedAttachment: true,
      senderDomainKnownRetailer: true,
      // A caller mistakenly passing raw content must not change behavior --
      // the function's own signature has no such field, and extra keys are
      // ignored (structural proof there is no raw-body parameter to feed).
      body: "<html>secret message content</html>",
    };
    const result = classifyCandidateEvidence(input as never);
    const withoutBody = classifyCandidateEvidence({
      subject: "Receipt attached",
      hasAcceptedAttachment: true,
      senderDomainKnownRetailer: true,
    });
    expect(result).toEqual(withoutBody);
  });
});
