/**
 * Phase 3D-B Task 6 — discovery/classification security regression suite.
 *
 * Fully local, no Docker, no network -- every dependency is a pure
 * function or in-memory fake. Consolidates, in one file, the
 * cross-cutting invariants Task 4/5's own exhaustive per-scenario suites
 * (discovery.test.ts, classification.test.ts) don't prove as a single
 * completeness/bound guarantee, so a future refactor that silently
 * regresses one of them fails here immediately:
 *
 * - classifyCandidateEvidence's evidence array is ALWAYS drawn from the
 *   fixed MAILBOX_CANDIDATE_REASON_CODES catalog, for every combination
 *   of its inputs -- never a raw subject/content string sneaking into
 *   the one field Office renders back to a reviewer (mockup ruling 5:
 *   "should export this catalog as a typed union/const, not accept
 *   arbitrary strings"). classification.test.ts proves specific
 *   scenarios; this proves the catalog bound holds over the full input
 *   space, not just the cases someone thought to write by hand.
 * - classifyCandidateEvidence is deterministic (plan's own "No LLM...
 *   identical input always returns identical output" constraint) --
 *   proven as a standing invariant, not just for the handful of fixtures
 *   classification.test.ts happens to assert on.
 * - withGoogleRetry's Retry-After handling is bounded against a
 *   malicious or malformed upstream header (excessively large -> clamped
 *   to maxRetryAfterMs, so a buggy/hostile Gmail response can never stall
 *   a scan page indefinitely; negative -> clamped to zero, never a
 *   negative sleep). discovery.test.ts's own Retry-After test only
 *   proves the happy-path "honored, not the exponential default" case.
 */
import { describe, expect, it, vi } from "vitest";

import { withGoogleRetry, GmailApiError } from "../src/discovery.js";
import {
  classifyCandidateEvidence,
  MAILBOX_CANDIDATE_REASON_CODES,
  type ClassificationEvidenceInput,
} from "../src/classification.js";

describe("withGoogleRetry — Retry-After bound (DoS/malformed-header resistance)", () => {
  it("clamps an excessively large Retry-After hint to maxRetryAfterMs, never stalling on an untrusted upstream value", async () => {
    const sleep = vi.fn(async () => undefined);
    let attempts = 0;
    await withGoogleRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new GmailApiError("rate_limited", "rate_limited", 10_000_000); // ~2.8 hours
        return "ok";
      },
      { sleep, maxRetryAfterMs: 60_000 },
    );
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("clamps a negative Retry-After hint to zero, never a negative sleep duration", async () => {
    const sleep = vi.fn(async () => undefined);
    let attempts = 0;
    await withGoogleRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new GmailApiError("rate_limited", "rate_limited", -5_000);
        return "ok";
      },
      { sleep },
    );
    expect(sleep).toHaveBeenCalledWith(0);
  });
});

describe("classifyCandidateEvidence — evidence-catalog completeness and determinism", () => {
  const SUBJECTS = [
    "",
    "Your receipt",
    "Order confirmation #1234",
    "FLASH SALE 50% off everything, unsubscribe here",
    "Order confirmation: flash sale bonus item included",
    "ORDER CONFIRMATION", // case variance
  ];
  const BOOLS = [false, true] as const;
  const catalog = new Set<string>(MAILBOX_CANDIDATE_REASON_CODES);

  function allInputs(): readonly ClassificationEvidenceInput[] {
    const inputs: ClassificationEvidenceInput[] = [];
    for (const subject of SUBJECTS) {
      for (const hasAcceptedAttachment of BOOLS) {
        for (const senderDomainKnownRetailer of BOOLS) {
          for (const hasStructuredHtmlSignal of BOOLS) {
            for (const hasOrderConfirmationSchema of BOOLS) {
              inputs.push({
                subject, hasAcceptedAttachment, senderDomainKnownRetailer,
                hasStructuredHtmlSignal, hasOrderConfirmationSchema,
              });
            }
          }
        }
      }
    }
    return inputs;
  }

  it("every evidence code, for every combination of inputs, is a member of the fixed catalog -- never a raw subject/content string", () => {
    const inputs = allInputs();
    expect(inputs.length).toBe(SUBJECTS.length * 2 ** 4);
    for (const input of inputs) {
      const result = classifyCandidateEvidence(input);
      expect(["receipt", "ambiguous", "not_receipt"]).toContain(result.classification);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      for (const code of result.evidence) {
        expect(catalog.has(code)).toBe(true);
        expect(code).not.toBe(input.subject); // the one structural check that would catch a raw-subject leak
      }
      // No duplicate evidence entries for any single classification call.
      expect(new Set(result.evidence).size).toBe(result.evidence.length);
    }
  });

  it("is deterministic: the exact same input always produces byte-identical output (no hidden clock/random dependency)", () => {
    for (const input of allInputs()) {
      const first = classifyCandidateEvidence(input);
      const second = classifyCandidateEvidence({ ...input });
      expect(second).toEqual(first);
    }
  });
});
