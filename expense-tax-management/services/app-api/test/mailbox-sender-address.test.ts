import { describe, expect, it } from "vitest";

import {
  MAILBOX_SENDER_ADDRESS_DB_LIMIT,
  normalizeMailboxSenderAddress,
} from "../src/domain/mailbox-sender-address.js";

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

  it("fix round 1 (review Important): truncates an over-limit bare address to exactly the DB limit", () => {
    const longLocal = "a".repeat(200);
    const longDomain = `${"b".repeat(200)}.com`;
    const input = `${longLocal}@${longDomain}`;
    const result = normalizeMailboxSenderAddress(input);
    expect(result.length).toBe(MAILBOX_SENDER_ADDRESS_DB_LIMIT);
    expect(result).toBe(input.slice(0, MAILBOX_SENDER_ADDRESS_DB_LIMIT));
  });

  it("fix round 1 (review Important): truncates an over-limit address extracted from a display-name From to exactly the DB limit", () => {
    const longLocal = "a".repeat(200);
    const longDomain = `${"b".repeat(200)}.COM`;
    const input = `Billing Department <${longLocal}@${longDomain}>`;
    const result = normalizeMailboxSenderAddress(input);
    const fullyNormalized = `${longLocal}@${longDomain.toLowerCase()}`;
    expect(result.length).toBe(MAILBOX_SENDER_ADDRESS_DB_LIMIT);
    expect(result).toBe(fullyNormalized.slice(0, MAILBOX_SENDER_ADDRESS_DB_LIMIT));
  });

  it("fix round 1 (review Important): never throws and still bounds output for a pathologically large garbage header", () => {
    const huge = "x".repeat(2_000_000); // 2 MB, no @ and no angle brackets
    expect(() => normalizeMailboxSenderAddress(huge)).not.toThrow();
    expect(normalizeMailboxSenderAddress(huge).length).toBe(MAILBOX_SENDER_ADDRESS_DB_LIMIT);
  });

  it("fix round 1 (review Important): never throws for a pathologically large display-name From with a short trailing address", () => {
    const huge = `${"Name ".repeat(1_000_000)}<user@example.com>`;
    expect(() => normalizeMailboxSenderAddress(huge)).not.toThrow();
    expect(normalizeMailboxSenderAddress(huge)).toBe("user@example.com");
  });
});
