/**
 * Phase 3D-B Task 5 — deterministic candidate reason-code catalog and a
 * standalone evidence classifier.
 *
 * Ruling (implementer, see task-5-report.md): discovery.ts (Phase 3D-B
 * Task 4, commit `34999f0`) already ships its own working
 * `classifyMessage`, wired into the live Gmail discovery path and under
 * concurrent re-review. This module does NOT replace or call into it --
 * modifying a Task 4 file is out of this task's brief (its "Files" list
 * names only this new file, never discovery.ts) and the orchestrator's
 * explicit instruction is not to touch Task 4 broker files without need.
 *
 * Instead this is the fixed, documented reason-code catalog the approved
 * Office mockup requires (plans/mockups/office-mailbox-review/NOTES.md,
 * "Decisions made consistent with the 3D-B plan/spec and the duplicates
 * page", ruling 5: "Task 5's classifier module should export this
 * catalog as a typed union/const, not accept arbitrary strings") plus a
 * pure, self-contained classifier over the signals available in 3D-B
 * (attachment acceptance, sender-domain reputation, subject keywords).
 *
 * JSON-LD/structured-HTML *detection* stays out of this module: the
 * plan's Global Constraints assign the "Structured HTML path" to Phase
 * 3D-C, not 3D-B. `hasStructuredHtmlSignal`/`hasOrderConfirmationSchema`
 * are optional inputs so a future 3D-C detector can feed this classifier
 * without another shape change; this module implements no HTML parsing
 * of its own and both flags default to absent/false.
 *
 * No LLM (plan's own global constraint). Deterministic: identical input
 * always returns identical output. Accepts only bounded subject text and
 * booleans -- never a message body/HTML/content field.
 */

export const MAILBOX_CANDIDATE_REASON_CODES = [
  "pdf_attachment_detected",
  "order_confirmation_schema",
  "structured_html_invoice",
  "sender_domain_known_retailer",
  "sender_domain_unverified",
  "subject_keyword_order",
  "free_text_only_low_confidence",
  "marketing_keyword_match",
  "no_structured_or_attachment_evidence",
] as const;
export type MailboxCandidateReasonCode = (typeof MAILBOX_CANDIDATE_REASON_CODES)[number];

const MARKETING_KEYWORDS = ["sale", "% off", "unsubscribe", "newsletter", "flash sale", "deal", "discount"];
const ORDER_KEYWORDS = ["receipt", "order", "invoice", "purchase", "confirmation"];

function matchesAny(subjectLower: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => subjectLower.includes(keyword));
}

export interface ClassificationEvidenceInput {
  readonly subject: string;
  readonly hasAcceptedAttachment: boolean;
  readonly senderDomainKnownRetailer: boolean;
  /** Reserved for a future 3D-C structured-HTML detector; absent/false in 3D-B. */
  readonly hasStructuredHtmlSignal?: boolean;
  readonly hasOrderConfirmationSchema?: boolean;
}

export interface ClassificationEvidenceResult {
  readonly classification: "receipt" | "ambiguous" | "not_receipt";
  readonly confidence: number;
  readonly evidence: readonly MailboxCandidateReasonCode[];
}

export function classifyCandidateEvidence(
  input: ClassificationEvidenceInput,
): ClassificationEvidenceResult {
  const subjectLower = input.subject.toLowerCase();
  const isMarketing = matchesAny(subjectLower, MARKETING_KEYWORDS);
  const hasOrderKeyword = matchesAny(subjectLower, ORDER_KEYWORDS);
  const hasStructuredSignal = input.hasOrderConfirmationSchema === true || input.hasStructuredHtmlSignal === true;

  const evidence: MailboxCandidateReasonCode[] = [];
  if (input.hasOrderConfirmationSchema) evidence.push("order_confirmation_schema");
  if (input.hasStructuredHtmlSignal) evidence.push("structured_html_invoice");
  if (input.hasAcceptedAttachment) evidence.push("pdf_attachment_detected");
  if (input.senderDomainKnownRetailer) evidence.push("sender_domain_known_retailer");
  if (hasOrderKeyword) evidence.push("subject_keyword_order");
  if (isMarketing) evidence.push("marketing_keyword_match");

  const hasStrongEvidence = input.hasAcceptedAttachment || hasStructuredSignal;

  // High-confidence: attachment or structured evidence only -- spec:
  // "Plain free text never creates an expense automatically."
  if (hasStrongEvidence && !isMarketing) {
    return { classification: "receipt", confidence: 0.9, evidence };
  }

  // Fix round 1 (review Minor): real structured/attachment evidence
  // alongside a marketing-keyword subject is genuinely *conflicting*
  // evidence, not an absence of evidence -- spec: "Ambiguous or
  // conflicting evidence enters review," never auto-receipt (the
  // marketing signal is reason enough to withhold auto-ingestion) and
  // never `not_receipt` (asserting "no structured or attachment
  // evidence" would be factually wrong when there plainly is some).
  if (hasStrongEvidence && isMarketing) {
    return { classification: "ambiguous", confidence: 0.5, evidence };
  }

  if (isMarketing) {
    evidence.push("no_structured_or_attachment_evidence");
    return { classification: "not_receipt", confidence: 0.05, evidence };
  }

  if (hasOrderKeyword) {
    if (!input.senderDomainKnownRetailer) evidence.push("sender_domain_unverified");
    evidence.push("free_text_only_low_confidence");
    return { classification: "ambiguous", confidence: 0.5, evidence };
  }

  evidence.push("no_structured_or_attachment_evidence");
  return { classification: "not_receipt", confidence: 0.1, evidence };
}
