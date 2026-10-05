// @vitest-environment jsdom
/**
 * m-5: writeOfficeSession / clearOfficeSession round-trip + corrupt storage tests.
 */

import { afterEach, describe, expect, it, beforeEach } from "vitest";
import { readOfficeSession, writeOfficeSession, clearOfficeSession, type OfficeSession } from "./session";

const bizSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "t-1",
  scope: { kind: "business", businessId: "biz-1" },
  label: "Biz",
};

const personalSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "t-1",
  scope: { kind: "personal", profileId: "prof-1" },
  label: "Personal",
};

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe("writeOfficeSession / readOfficeSession round-trip", () => {
  it("writes and reads back a business session", () => {
    writeOfficeSession(bizSession);
    const result = readOfficeSession();
    expect(result).not.toBeNull();
    expect(result?.scope.kind).toBe("business");
    if (result?.scope.kind === "business") {
      expect(result.scope.businessId).toBe("biz-1");
    }
    expect(result?.tenantId).toBe("t-1");
    expect(result?.label).toBe("Biz");
    expect(result?.apiBaseUrl).toBe("http://app.test");
  });

  it("writes and reads back a personal session", () => {
    writeOfficeSession(personalSession);
    const result = readOfficeSession();
    expect(result?.scope.kind).toBe("personal");
    if (result?.scope.kind === "personal") {
      expect(result.scope.profileId).toBe("prof-1");
    }
    expect(result?.label).toBe("Personal");
  });

  it("clearOfficeSession removes the session", () => {
    writeOfficeSession(bizSession);
    expect(readOfficeSession()).not.toBeNull();
    clearOfficeSession();
    expect(readOfficeSession()).toBeNull();
  });

  it("clearOfficeSession is idempotent when no session stored", () => {
    expect(() => clearOfficeSession()).not.toThrow();
    expect(readOfficeSession()).toBeNull();
  });

  it("overwrites previous session on second write", () => {
    writeOfficeSession(bizSession);
    writeOfficeSession(personalSession);
    const result = readOfficeSession();
    expect(result?.scope.kind).toBe("personal");
  });
});

describe("readOfficeSession — corrupt storage fail-closed", () => {
  it("returns null for raw JSON parse failure", () => {
    sessionStorage.setItem("expense-tax-office-session", "not-json{{");
    expect(readOfficeSession()).toBeNull();
  });

  it("returns null for null stored value", () => {
    sessionStorage.setItem("expense-tax-office-session", "null");
    expect(readOfficeSession()).toBeNull();
  });

  it("returns null when scope kind is unknown", () => {
    sessionStorage.setItem("expense-tax-office-session", JSON.stringify({
      apiBaseUrl: "http://x.test",
      tenantId: "t-1",
      label: "X",
      scope: { kind: "organization", orgId: "o-1" },
    }));
    expect(readOfficeSession()).toBeNull();
  });

  it("returns null when business scope missing businessId", () => {
    sessionStorage.setItem("expense-tax-office-session", JSON.stringify({
      apiBaseUrl: "http://x.test",
      tenantId: "t-1",
      label: "X",
      scope: { kind: "business" },
    }));
    expect(readOfficeSession()).toBeNull();
  });

  it("returns null when personal scope missing profileId", () => {
    sessionStorage.setItem("expense-tax-office-session", JSON.stringify({
      apiBaseUrl: "http://x.test",
      tenantId: "t-1",
      label: "X",
      scope: { kind: "personal" },
    }));
    expect(readOfficeSession()).toBeNull();
  });

  it("returns null when apiBaseUrl is empty", () => {
    sessionStorage.setItem("expense-tax-office-session", JSON.stringify({
      apiBaseUrl: "",
      tenantId: "t-1",
      label: "X",
      scope: { kind: "business", businessId: "b-1" },
    }));
    expect(readOfficeSession()).toBeNull();
  });

  it("returns null when tenantId is missing", () => {
    sessionStorage.setItem("expense-tax-office-session", JSON.stringify({
      apiBaseUrl: "http://x.test",
      label: "X",
      scope: { kind: "business", businessId: "b-1" },
    }));
    expect(readOfficeSession()).toBeNull();
  });
});
