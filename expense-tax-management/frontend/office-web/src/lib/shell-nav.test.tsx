// @vitest-environment jsdom
/**
 * Issue 8: OfficeShell nav — disabled items for Personal/null scope must not render
 * as href="#" links. Business-only nav items render as inert <span>.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Session mock — hoisted so it applies to all imports in this file
const { readOfficeSession } = vi.hoisted(() => ({ readOfficeSession: vi.fn() }));
vi.mock("@/lib/session", () => ({ readOfficeSession }));

// Minimal mocks for Clerk hooks, Next.js Link/navigation, and api
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn(), isLoaded: true, isSignedIn: true }),
  useOrganization: () => ({ organization: { id: "org_1" }, isLoaded: true }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode; [k: string]: unknown }) =>
    <a href={typeof href === "string" ? href : "/"} {...props}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("@/lib/api", () => ({
  DUPLICATE_REVIEW_UPDATED_EVENT: "test-event",
  fetchDuplicateMatches: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  formatPendingDuplicateCount: () => "0",
  shouldApplyPendingDuplicateCount: () => false,
}));

import { OfficeShell } from "@/components/office-shell";
import React from "react";

describe("OfficeShell nav — disabled items for Personal scope", () => {
  afterEach(() => cleanup());

  it("renders unavailable business-only nav items as span (no role=link), not href='#'", () => {
    readOfficeSession.mockReturnValue({
      scope: { kind: "personal", profileId: "prof-1" },
      tenantId: "t-1",
      apiBaseUrl: "http://x.test",
      label: "Personal",
    });
    render(<OfficeShell><div /></OfficeShell>);

    // No anchor with href="#"
    const hashLinks = screen.queryAllByRole("link").filter(
      (el) => (el as HTMLAnchorElement).getAttribute("href") === "#",
    );
    expect(hashLinks).toHaveLength(0);

    // Business-only items not navigable links
    const allLinkHrefs = screen.getAllByRole("link").map((el) => (el as HTMLAnchorElement).getAttribute("href"));
    expect(allLinkHrefs).not.toContain("/businesses");
    expect(allLinkHrefs).not.toContain("/tax");
    expect(allLinkHrefs).not.toContain("/exports");
    expect(allLinkHrefs).not.toContain("/projects");
  });

  it("renders all nav items as links when session is business scope", () => {
    readOfficeSession.mockReturnValue({
      scope: { kind: "business", businessId: "biz-1" },
      tenantId: "t-1",
      apiBaseUrl: "http://x.test",
      label: "Biz",
    });
    render(<OfficeShell><div /></OfficeShell>);
    const allLinkHrefs = screen.getAllByRole("link").map((el) => (el as HTMLAnchorElement).getAttribute("href"));
    expect(allLinkHrefs).toContain("/businesses");
    expect(allLinkHrefs).toContain("/tax");
  });

  it("renders null session without href='#' links for business-only items", () => {
    readOfficeSession.mockReturnValue(null);
    render(<OfficeShell><div /></OfficeShell>);
    const hashLinks = screen.queryAllByRole("link").filter(
      (el) => (el as HTMLAnchorElement).getAttribute("href") === "#",
    );
    expect(hashLinks).toHaveLength(0);
    // Business-only items absent from links
    const allLinkHrefs = screen.getAllByRole("link").map((el) => (el as HTMLAnchorElement).getAttribute("href"));
    expect(allLinkHrefs).not.toContain("/businesses");
  });

  it("unavailable nav items contain label text (accessible to screen readers)", () => {
    readOfficeSession.mockReturnValue({
      scope: { kind: "personal", profileId: "prof-1" },
      tenantId: "t-1",
      apiBaseUrl: "http://x.test",
      label: "Personal",
    });
    render(<OfficeShell><div /></OfficeShell>);
    // Verify label is accessible (getByLabelText or textContent on span)
    // The inert spans have aria-label attributes
    const navSpans = document.querySelectorAll("nav .nav-unavailable, nav span[aria-label]");
    expect(navSpans.length).toBeGreaterThan(0);
  });
});
