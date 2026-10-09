import { describe, expect, it } from "vitest";

import { normalizeMailboxSenderAddress } from "../src/domain/mailbox-sender-address.js";

describe("normalizeMailboxSenderAddress", () => {
  it("extracts the bare address from a display-name From header", () => {
    expect(normalizeMailboxSenderAddress("Display Name <user@example.com>")).toBe(
      "user@example.com",
    );
  });

  it("passes a bare address through unchanged (aside from trim)", () => {
    expect(normalizeMailboxSenderAddress("  user@example.com  ")).toBe("user@example.com");
  });

  it("extracts the address from an angle-only value", () => {
    expect(normalizeMailboxSenderAddress("<user@example.com>")).toBe("user@example.com");
  });

  it("extracts the trailing address past a quoted display name containing a comma", () => {
    expect(normalizeMailboxSenderAddress('"Doe, Jane" <jane@example.com>')).toBe(
      "jane@example.com",
    );
  });

  it("extracts the trailing address past a quoted display name containing angle-like characters", () => {
    expect(normalizeMailboxSenderAddress('"Jane <Not-An-Address>" <jane@example.com>')).toBe(
      "jane@example.com",
    );
  });

  it("lowercases only the domain part, keeping the local part's case", () => {
    expect(normalizeMailboxSenderAddress("User@EXAMPLE.COM")).toBe("User@example.com");
  });

  it("lowercases the domain when extracted from a display-name form", () => {
    expect(normalizeMailboxSenderAddress("Display Name <User@EXAMPLE.COM>")).toBe(
      "User@example.com",
    );
  });

  it("keeps the original trimmed value when nothing address-like can be extracted (garbage)", () => {
    expect(normalizeMailboxSenderAddress("  Mail Delivery Subsystem  ")).toBe(
      "Mail Delivery Subsystem",
    );
  });

  it("keeps the original trimmed value for an empty angle-bracket pair", () => {
    expect(normalizeMailboxSenderAddress("Display Name <>")).toBe("Display Name <>");
  });

  it("preserves RFC-valid special characters App API never treated as unsafe", () => {
    expect(normalizeMailboxSenderAddress("Billing <bounce+x=y@example.com>")).toBe(
      "bounce+x=y@example.com",
    );
  });
});
