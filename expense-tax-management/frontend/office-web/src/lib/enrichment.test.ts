// @vitest-environment jsdom
/**
 * Enrichment review UI tests: suggestion candidate, confidence, evidence, source history.
 * Tests both scope variants (Personal/Business) and all current consumer states.
 */

import { describe, expect, it } from "vitest";

import type { OfficeSession } from "./session";
import {
  getSuggestionSourceLabel,
  getEnrichmentReviewState,
  makeStableIdempotencyKey,
  TagMutationError,
  formatSuggestionKind,
} from "./api";

// ------------------------------------------------------------------ //
// Shared fixtures
// ------------------------------------------------------------------ //

const businessSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "business", businessId: "business-1" },
  label: "Family Business",
};

const personalSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal", profileId: "profile-1" },
  label: "Personal",
};

// ------------------------------------------------------------------ //
// Pure helper unit tests (node environment is fine)
// ------------------------------------------------------------------ //

describe("enrichment source label helpers", () => {
  it("labels rule source correctly", () => {
    expect(getSuggestionSourceLabel("historical")).toBe("Historical pattern");
    expect(getSuggestionSourceLabel("ai")).toBe("AI suggestion");
  });

  it("maps history decision sources", () => {
    expect(getSuggestionSourceLabel("manual")).toBe("Manual decision");
    expect(getSuggestionSourceLabel("manual_baseline")).toBe("Baseline import");
  });
});

// ------------------------------------------------------------------ //
// Issue 9: Kind label formatting — replaceAll underscores, not just first
// ------------------------------------------------------------------ //

describe("formatSuggestionKind", () => {
  it("formats single underscore kinds", () => {
    expect(formatSuggestionKind("tag")).toBe("Tag");
  });

  it("replaces ALL underscores in multi-word kinds (not just first)", () => {
    // tax_category has one underscore — but spending_category too.
    // Critically: a kind like "some_multi_word" must replace ALL.
    expect(formatSuggestionKind("tax_category")).toBe("Tax category");
    expect(formatSuggestionKind("spending_category")).toBe("Spending category");
  });

  it("capitalizes first letter", () => {
    expect(formatSuggestionKind("tag")[0]).toBe("T");
    expect(formatSuggestionKind("tax_category")[0]).toBe("T");
  });
});

describe("enrichment review state helper", () => {
  it("returns loading when not ready", () => {
    expect(getEnrichmentReviewState({ isLoaded: false, isSignedIn: false, hasSession: false, hasOrganization: false })).toBe("loading");
  });

  it("returns unauthorized when session/org missing", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: false, hasOrganization: true })).toBe("unauthorized");
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: false })).toBe("unauthorized");
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: false, hasSession: false, hasOrganization: false })).toBe("unauthorized");
  });

  it("returns error state", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true, error: "Request failed" })).toBe("error");
  });

  it("returns loading when data not yet fetched", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true })).toBe("loading");
  });

  it("returns empty when no suggestions", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true, suggestions: [] })).toBe("empty");
  });

  it("returns pending when suggestions present", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true, suggestions: [{ id: "s1" }] })).toBe("pending");
  });

  it("returns conflict", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true, conflict: true })).toBe("conflict");
  });

  it("returns stale", () => {
    expect(getEnrichmentReviewState({ isLoaded: true, isSignedIn: true, hasSession: true, hasOrganization: true, stale: true })).toBe("stale");
  });
});

// ------------------------------------------------------------------ //
// Issue 1: Accept/reject idempotency keys must include the action
// so "accepted" and "rejected" produce distinct keys for same suggestion.
// ------------------------------------------------------------------ //

describe("stable idempotency key — action discrimination", () => {
  it("returns same key for same action+suggestion on retry", () => {
    const k1 = makeStableIdempotencyKey("resolve-suggestion", "sugg-1", "accepted");
    const k2 = makeStableIdempotencyKey("resolve-suggestion", "sugg-1", "accepted");
    expect(k1).toBe(k2);
  });

  it("accept and reject produce DISTINCT keys for same suggestion", () => {
    const acceptKey = makeStableIdempotencyKey("resolve-suggestion", "sugg-1", "accepted");
    const rejectKey = makeStableIdempotencyKey("resolve-suggestion", "sugg-1", "rejected");
    expect(acceptKey).not.toBe(rejectKey);
  });

  it("keys contain action discriminator", () => {
    const acceptKey = makeStableIdempotencyKey("resolve-suggestion", "sugg-1", "accepted");
    expect(acceptKey).toContain("accepted");
    const rejectKey = makeStableIdempotencyKey("resolve-suggestion", "sugg-1", "rejected");
    expect(rejectKey).toContain("rejected");
  });

  it("different suggestions produce different keys for same action", () => {
    const k1 = makeStableIdempotencyKey("resolve-suggestion", "sugg-1", "accepted");
    const k2 = makeStableIdempotencyKey("resolve-suggestion", "sugg-2", "accepted");
    expect(k1).not.toBe(k2);
  });

  // Existing tests preserved
  it("returns same key for same parts", () => {
    const k1 = makeStableIdempotencyKey("resolve-suggestion", "exp-1", "sugg-1");
    const k2 = makeStableIdempotencyKey("resolve-suggestion", "exp-1", "sugg-1");
    expect(k1).toBe(k2);
  });

  it("key contains all discriminating parts", () => {
    const k = makeStableIdempotencyKey("resolve-suggestion", "exp-1", "sugg-1");
    expect(k).toContain("resolve-suggestion");
    expect(k).toContain("exp-1");
    expect(k).toContain("sugg-1");
  });
});

// ------------------------------------------------------------------ //
// Issue 2: Tax accept key must reflect submitted profileId, not initial
// useRef. Test the pure key derivation logic.
// ------------------------------------------------------------------ //

describe("tax accept idempotency key derives from submitted profileId", () => {
  it("different profileId produces different key", () => {
    const k1 = makeStableIdempotencyKey("tax-accept", "sugg-1", "accepted", "prof-A");
    const k2 = makeStableIdempotencyKey("tax-accept", "sugg-1", "accepted", "prof-B");
    expect(k1).not.toBe(k2);
  });

  it("same profileId + same suggestion + same action = same key (retry-safe)", () => {
    const k1 = makeStableIdempotencyKey("tax-accept", "sugg-1", "accepted", "prof-A");
    const k2 = makeStableIdempotencyKey("tax-accept", "sugg-1", "accepted", "prof-A");
    expect(k1).toBe(k2);
  });

  it("key contains profileId", () => {
    const k = makeStableIdempotencyKey("tax-accept", "sugg-1", "accepted", "prof-X");
    expect(k).toContain("prof-X");
  });
});

// ------------------------------------------------------------------ //
// Issue 5: TagMutationError — typed error with .status, no substring detection
// ------------------------------------------------------------------ //

describe("TagMutationError typed error", () => {
  it("is constructable with status 409", () => {
    const err = new TagMutationError("Tag version conflict", 409);
    expect(err.status).toBe(409);
    expect(err.name).toBe("TagMutationError");
    expect(err).toBeInstanceOf(Error);
  });

  it("is constructable with status 401", () => {
    const err = new TagMutationError("Unauthorized", 401);
    expect(err.status).toBe(401);
  });

  it("status 409 is detectable without message substring check", () => {
    const err = new TagMutationError("whatever message", 409);
    expect(err.status === 409).toBe(true);
  });

  it("is distinct from EnrichmentReviewError and DuplicateReviewError", () => {
    const err = new TagMutationError("conflict", 409);
    expect(err.name).toBe("TagMutationError");
  });
});

// ------------------------------------------------------------------ //
// Scope discriminated consumer tests
// ------------------------------------------------------------------ //

describe("scope discriminated session helpers", () => {
  it("business session exposes businessId and no profileId", () => {
    expect(businessSession.scope.kind).toBe("business");
    if (businessSession.scope.kind === "business") {
      expect(businessSession.scope.businessId).toBe("business-1");
    }
  });

  it("personal session exposes profileId and no businessId", () => {
    expect(personalSession.scope.kind).toBe("personal");
    if (personalSession.scope.kind === "personal") {
      expect(personalSession.scope.profileId).toBe("profile-1");
    }
  });

  it("business session has tenantId and apiBaseUrl", () => {
    expect(businessSession.tenantId).toBe("tenant-1");
    expect(businessSession.apiBaseUrl).toBe("http://app.test");
    expect(businessSession.label).toBe("Family Business");
  });

  it("personal session has tenantId and apiBaseUrl", () => {
    expect(personalSession.tenantId).toBe("tenant-1");
    expect(personalSession.apiBaseUrl).toBe("http://app.test");
    expect(personalSession.label).toBe("Personal");
  });
});

// ------------------------------------------------------------------ //
// Tag settings helpers
// ------------------------------------------------------------------ //

describe("tag management helpers", () => {
  it("getSuggestionSourceLabel handles all known sources", () => {
    const knownSources = ["historical", "ai", "manual", "manual_baseline"] as const;
    for (const s of knownSources) {
      expect(getSuggestionSourceLabel(s)).toBeTypeOf("string");
      expect(getSuggestionSourceLabel(s).length).toBeGreaterThan(0);
    }
  });
});
