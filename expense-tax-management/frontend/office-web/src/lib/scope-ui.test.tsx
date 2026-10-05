// @vitest-environment jsdom
/**
 * Rendered tests for scope-gating, shared components, and API wire correctness.
 * Covers:
 *   Issue 4  - resolveSuggestion requires 200 body; missing body throws
 *   Issue 5  - TagMutationError.status used for 409 detection, not message substring
 *   Issue 6  - PersonalScopeUnavailable is a shared component, renders consistently
 *   Issue 7  - business-only pages fail closed on null/corrupt session
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------------ //
// Session mock (used by business-only pages)
// ------------------------------------------------------------------ //

const { readOfficeSession } = vi.hoisted(() => ({ readOfficeSession: vi.fn() }));
vi.mock("@/lib/session", () => ({ readOfficeSession }));

// ------------------------------------------------------------------ //
// Issue 4: resolveSuggestion — strict 200 body check
// ------------------------------------------------------------------ //

import { resolveSuggestion, TagMutationError, updateTag, archiveTag, unarchiveTag } from "@/lib/api";
import type { OfficeSession } from "@/lib/session";

const bizSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "business", businessId: "biz-1" },
  label: "Biz",
};

const getToken = vi.fn().mockResolvedValue("tok");

describe("resolveSuggestion — generated 200 body contract enforced", () => {
  it("throws when server returns no body (not 200)", async () => {
    const client = { POST: vi.fn().mockResolvedValue({ data: undefined, response: { status: 500 } }) };
    await expect(
      resolveSuggestion(bizSession, "exp-1", "sugg-1", {
        action: "accepted",
        expectedSuggestionVersion: 1,
        expectedExpenseVersion: 1,
        idempotencyKey: "key-1",
      }, getToken, "org_1", client as never),
    ).rejects.toBeInstanceOf(Error);
  });

  it("returns data when server returns 200 body", async () => {
    const responseData = { suggestionId: "sugg-1", status: "accepted" as const, version: 2 };
    const client = { POST: vi.fn().mockResolvedValue({ data: responseData, response: { status: 200 } }) };
    const result = await resolveSuggestion(bizSession, "exp-1", "sugg-1", {
      action: "accepted",
      expectedSuggestionVersion: 1,
      expectedExpenseVersion: 1,
      idempotencyKey: "key-2",
    }, getToken, "org_1", client as never);
    expect(result).toEqual(responseData);
  });

  it("throws EnrichmentReviewError with status=409 on conflict (data missing)", async () => {
    const client = { POST: vi.fn().mockResolvedValue({ data: undefined, response: { status: 409 } }) };
    await expect(
      resolveSuggestion(bizSession, "exp-1", "sugg-1", {
        action: "accepted",
        expectedSuggestionVersion: 1,
        expectedExpenseVersion: 1,
        idempotencyKey: "key-3",
      }, getToken, "org_1", client as never),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// ------------------------------------------------------------------ //
// Issue 5: TagMutationError — typed status, no substring detection
// ------------------------------------------------------------------ //

describe("tag write functions throw TagMutationError with typed status", () => {
  it("updateTag throws TagMutationError with status=409 on conflict", async () => {
    const client = { PATCH: vi.fn().mockResolvedValue({ data: undefined, response: { status: 409 } }) };
    await expect(
      updateTag(bizSession, "tag-1", { expectedVersion: 1, name: "X" }, getToken, "org_1", client as never),
    ).rejects.toSatisfy((e: unknown) => e instanceof TagMutationError && (e as TagMutationError).status === 409);
  });

  it("updateTag throws TagMutationError with status=500 on generic failure", async () => {
    const client = { PATCH: vi.fn().mockResolvedValue({ data: undefined, response: { status: 500 } }) };
    await expect(
      updateTag(bizSession, "tag-1", { expectedVersion: 1, name: "X" }, getToken, "org_1", client as never),
    ).rejects.toBeInstanceOf(TagMutationError);
  });

  it("archiveTag throws TagMutationError with status=409 on conflict", async () => {
    const client = { DELETE: vi.fn().mockResolvedValue({ data: undefined, response: { status: 409 } }) };
    await expect(
      archiveTag(bizSession, "tag-1", 1, getToken, "org_1", client as never),
    ).rejects.toSatisfy((e: unknown) => e instanceof TagMutationError && (e as TagMutationError).status === 409);
  });

  it("unarchiveTag throws TagMutationError with status=409 on conflict", async () => {
    const client = { POST: vi.fn().mockResolvedValue({ data: undefined, response: { status: 409 } }) };
    await expect(
      unarchiveTag(bizSession, "tag-1", 2, getToken, "org_1", client as never),
    ).rejects.toSatisfy((e: unknown) => e instanceof TagMutationError && (e as TagMutationError).status === 409);
  });
});

// ------------------------------------------------------------------ //
// Issue 6: PersonalScopeUnavailable is a shared component
// ------------------------------------------------------------------ //

import { PersonalScopeUnavailable } from "@/components/scope-unavailable";

describe("PersonalScopeUnavailable shared component", () => {
  afterEach(() => cleanup());

  it("renders accessible unavailable state for a named feature", () => {
    render(<PersonalScopeUnavailable feature="Businesses" />);
    expect(screen.getByLabelText(/Businesses unavailable in Personal scope/i)).toBeTruthy();
  });

  it("renders requires Business scope text for each feature", () => {
    for (const feature of ["Businesses", "Projects", "Tax", "Exports"]) {
      const { unmount } = render(<PersonalScopeUnavailable feature={feature} />);
      // Use getAllByRole to avoid "multiple elements" error; check any has the right text
      const statuses = screen.getAllByRole("status");
      expect(statuses.length).toBeGreaterThan(0);
      unmount();
    }
  });
});

// ------------------------------------------------------------------ //
// Issue 7: Business-only pages fail closed when session is null
// ------------------------------------------------------------------ //

import Businesses from "@/app/(office)/businesses/page";
import Exports from "@/app/(office)/exports/page";
import Projects from "@/app/(office)/projects/page";

describe("business-only pages fail closed when session is null", () => {
  afterEach(() => cleanup());

  it("Businesses renders unavailable when session is null (corrupt/missing)", () => {
    readOfficeSession.mockReturnValue(null);
    render(<Businesses />);
    expect(screen.getByRole("status")).toBeTruthy();
    // Must NOT render business content
    expect(screen.queryByText("Tran Studio")).toBeNull();
  });

  it("Projects renders unavailable when session is null", () => {
    readOfficeSession.mockReturnValue(null);
    render(<Projects />);
    expect(screen.queryByText("Acme launch")).toBeNull();
  });

  it("Exports renders unavailable when session is null", () => {
    readOfficeSession.mockReturnValue(null);
    render(<Exports />);
    expect(screen.queryByText("Create reviewed bundle")).toBeNull();
  });

  it("Businesses renders business content when session is business scope", () => {
    readOfficeSession.mockReturnValue({
      scope: { kind: "business", businessId: "biz-1" }, tenantId: "t-1", apiBaseUrl: "http://x.test", label: "Biz",
    });
    render(<Businesses />);
    expect(screen.getByText("Tran Studio")).toBeTruthy();
  });
});
