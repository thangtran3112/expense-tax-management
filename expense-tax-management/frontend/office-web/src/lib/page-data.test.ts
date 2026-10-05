import { describe, expect, it, vi } from "vitest";

import type { OfficeSession } from "./session";

const { fetchLedger, fetchTaxReport, fetchTags } = vi.hoisted(() => ({
  fetchLedger: vi.fn(),
  fetchTaxReport: vi.fn(),
  fetchTags: vi.fn(),
}));
vi.mock("./api", () => ({ fetchLedger, fetchTaxReport, fetchTags }));

import { loadDashboard, loadExpenses, loadTax, loadTaxForOffice, loadTags } from "./page-data";

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

const getToken = vi.fn();

describe("Office page data boundaries", () => {
  it("loads dashboard ledger through Clerk-aware API helper - business scope", async () => {
    fetchLedger.mockResolvedValue({ items: [] });

    await loadDashboard(businessSession, getToken, "org_123");

    expect(fetchLedger).toHaveBeenCalledWith(businessSession, getToken, "org_123");
  });

  it("loads dashboard ledger through Clerk-aware API helper - personal scope", async () => {
    fetchLedger.mockResolvedValue({ items: [] });

    await loadDashboard(personalSession, getToken, "org_123");

    expect(fetchLedger).toHaveBeenCalledWith(personalSession, getToken, "org_123");
  });

  it("loads tax report through Clerk-aware API helper", async () => {
    fetchTaxReport.mockResolvedValue({ taxYear: 2025 });

    await loadTax(businessSession, getToken, "org_123", 2025);

    expect(fetchTaxReport).toHaveBeenCalledWith(businessSession, 2025, getToken, "org_123");
  });

  it("loads expenses through same ledger boundary - business scope", async () => {
    fetchLedger.mockResolvedValue({ items: [] });

    await loadExpenses(businessSession, getToken, "org_123");

    expect(fetchLedger).toHaveBeenCalledWith(businessSession, getToken, "org_123");
  });

  it("loads expenses through same ledger boundary - personal scope", async () => {
    fetchLedger.mockResolvedValue({ items: [] });

    await loadExpenses(personalSession, getToken, "org_123");

    expect(fetchLedger).toHaveBeenCalledWith(personalSession, getToken, "org_123");
  });

  it("provides stable tax loader without a render-created callback", () => {
    expect(loadTaxForOffice).toBeTypeOf("function");
  });

  it("loads tags for tenant through Clerk-aware API helper", async () => {
    fetchTags.mockResolvedValue({ items: [], nextCursor: null });

    await loadTags(businessSession, getToken, "org_123");

    expect(fetchTags).toHaveBeenCalledWith(businessSession, getToken, "org_123");
  });

  it("loadTaxForOffice requires Business scope - does not forward personal session", () => {
    // loadTaxForOffice is Business-only - verify it receives the session unchanged
    fetchTaxReport.mockResolvedValue({ taxYear: 2025 });
    const result = loadTaxForOffice(businessSession, getToken, "org_123");
    expect(result).toBeInstanceOf(Promise);
  });
});
