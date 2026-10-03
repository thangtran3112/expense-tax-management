// @vitest-environment jsdom
/**
 * Phase 3D-A Task 4, fix round 2 — rendered tests for the Office mailbox
 * page covering two review findings:
 *
 * - [important] readOfficeSession() returns a fresh object every render;
 *   the page's status-fetch effect must not depend on that object
 *   directly (or it refetches forever). Proven here by forcing several
 *   re-renders (via unrelated state updates) and asserting the mocked
 *   loader was still only called once per distinct scope.
 * - [important] the scope picker must render every authorized option
 *   (Personal + active businesses from App API), none preselected, with
 *   Connect disabled until one is chosen.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  readOfficeSession: vi.fn(),
  loadMailboxConnection: vi.fn(),
  loadAuthorizedBusinesses: vi.fn(),
  loadOwnPersonalProfile: vi.fn(),
  connectMailboxGoogle: vi.fn(),
  clerk: {
    getToken: vi.fn().mockResolvedValue("office-token"),
    organization: { id: "org_123" },
  },
  searchParams: new URLSearchParams(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.clerk.getToken, isLoaded: true, isSignedIn: true }),
  useOrganization: () => ({ organization: harness.clerk.organization, isLoaded: true }),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => harness.searchParams,
}));
vi.mock("@/lib/session", () => ({ readOfficeSession: () => harness.readOfficeSession() }));
vi.mock("@/lib/page-data", () => ({
  loadMailboxConnection: (...args: unknown[]) => harness.loadMailboxConnection(...args),
  loadAuthorizedBusinesses: (...args: unknown[]) => harness.loadAuthorizedBusinesses(...args),
  loadOwnPersonalProfile: (...args: unknown[]) => harness.loadOwnPersonalProfile(...args),
}));
vi.mock("@/lib/mailbox", async () => {
  const actual = await vi.importActual<typeof import("./mailbox")>("./mailbox");
  return {
    ...actual,
    connectMailboxGoogle: (...args: unknown[]) => harness.connectMailboxGoogle(...args),
  };
});

import MailboxPage from "../app/(office)/mailbox/page";

const PERSONAL_SESSION = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal" as const, profileId: "profile-1" },
  label: "Personal",
};

function renderPage() {
  return render(<MailboxPage />);
}

describe("rendered Office mailbox page", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    harness.clerk.getToken.mockResolvedValue("office-token");
    harness.searchParams = new URLSearchParams();
    harness.readOfficeSession.mockImplementation(() => ({ ...PERSONAL_SESSION }));
    harness.loadMailboxConnection.mockResolvedValue(null);
    harness.loadAuthorizedBusinesses.mockResolvedValue([]);
    harness.loadOwnPersonalProfile.mockResolvedValue({ id: "profile-1", name: "Personal" });
  });

  // ------------------------------------------------------------------ //
  // Finding 2 -- stable session reference, no refetch loop
  // ------------------------------------------------------------------ //

  it("fetches mailbox status exactly once per scope, even across several unrelated re-renders", async () => {
    harness.loadAuthorizedBusinesses.mockResolvedValue([{ id: "biz-1", name: "Tran Studio" }]);
    renderPage();

    await waitFor(() => expect(harness.loadMailboxConnection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Personal")).toBeTruthy());

    // Each radio click triggers a setState -> re-render. readOfficeSession()
    // is called again on each render (it's not React state), returning a
    // *new* object every time -- if the status-fetch effect depended on
    // that object directly, this would refetch on every click.
    fireEvent.click(screen.getByRole("radio", { name: /Personal/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Tran Studio/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Personal/ }));

    // Give any (incorrect) additional effect runs a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.loadMailboxConnection).toHaveBeenCalledTimes(1);
    expect(harness.loadAuthorizedBusinesses).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------ //
  // Finding 3 -- real authorized scope options, none preselected
  // ------------------------------------------------------------------ //

  it("renders Personal plus every active business, none preselected, Connect disabled until chosen", async () => {
    harness.loadAuthorizedBusinesses.mockResolvedValue([
      { id: "biz-1", name: "Tran Studio" },
      { id: "biz-2", name: "Second Shop" },
    ]);
    renderPage();

    const personalRadio = await screen.findByRole("radio", { name: /Personal/ });
    const bizRadio1 = screen.getByRole("radio", { name: /Tran Studio/ });
    const bizRadio2 = screen.getByRole("radio", { name: /Second Shop/ });

    expect((personalRadio as HTMLInputElement).checked).toBe(false);
    expect((bizRadio1 as HTMLInputElement).checked).toBe(false);
    expect((bizRadio2 as HTMLInputElement).checked).toBe(false);

    const connectButton = screen.getByRole("button", { name: /Connect Gmail/ }) as HTMLButtonElement;
    expect(connectButton.disabled).toBe(true);

    fireEvent.click(bizRadio1);
    expect((bizRadio1 as HTMLInputElement).checked).toBe(true);
    expect(connectButton.disabled).toBe(false);
  });

  // ------------------------------------------------------------------ //
  // Finding 1 (fix round 3) -- Personal always offered, via the real
  // scope-authorized lookup, not derived from session.scope.kind
  // ------------------------------------------------------------------ //

  it("still shows Personal under a business-scoped session, when the lookup resolves a profile", async () => {
    harness.readOfficeSession.mockImplementation(() => ({
      apiBaseUrl: "http://app.test",
      tenantId: "tenant-1",
      scope: { kind: "business" as const, businessId: "biz-1" },
      label: "Tran Studio",
    }));
    harness.loadAuthorizedBusinesses.mockResolvedValue([{ id: "biz-1", name: "Tran Studio" }]);
    harness.loadOwnPersonalProfile.mockResolvedValue({ id: "profile-mine", name: "Personal" });
    renderPage();

    await screen.findByRole("radio", { name: /Tran Studio/ });
    expect(screen.getByRole("radio", { name: /^Personal$/ })).toBeTruthy();
  });

  it("shows no Personal option when the member has no Personal profile in this tenant", async () => {
    harness.readOfficeSession.mockImplementation(() => ({
      apiBaseUrl: "http://app.test",
      tenantId: "tenant-1",
      scope: { kind: "business" as const, businessId: "biz-1" },
      label: "Tran Studio",
    }));
    harness.loadAuthorizedBusinesses.mockResolvedValue([{ id: "biz-1", name: "Tran Studio" }]);
    harness.loadOwnPersonalProfile.mockResolvedValue(null);
    renderPage();

    await screen.findByRole("radio", { name: /Tran Studio/ });
    expect(screen.queryByRole("radio", { name: /^Personal$/ })).toBeNull();
  });

  it("looks up only the caller's own profile -- no member/profile id parameter that could request another member's", async () => {
    renderPage();

    await waitFor(() => expect(harness.loadOwnPersonalProfile).toHaveBeenCalledTimes(1));
    const call = harness.loadOwnPersonalProfile.mock.calls[0] as unknown[];
    // session, getToken, organizationId -- never a profileId/memberId/userId argument.
    expect(call).toHaveLength(3);
    expect(typeof call[1]).toBe("function");
    expect(call[2]).toBe("org_123");
  });

  it("connects using the explicitly selected scope, not necessarily session.scope", async () => {
    harness.loadAuthorizedBusinesses.mockResolvedValue([{ id: "biz-1", name: "Tran Studio" }]);
    harness.connectMailboxGoogle.mockResolvedValue({ authorizationUrl: "https://broker.test/begin" });
    renderPage();

    const bizRadio = await screen.findByRole("radio", { name: /Tran Studio/ });
    fireEvent.click(bizRadio);
    fireEvent.click(screen.getByRole("button", { name: /Connect Gmail/ }));

    await waitFor(() => expect(harness.connectMailboxGoogle).toHaveBeenCalledOnce());
    const [, selectedScope] = harness.connectMailboxGoogle.mock.calls[0] as [unknown, unknown];
    expect(selectedScope).toEqual({ kind: "business", businessId: "biz-1" });
  });
});
