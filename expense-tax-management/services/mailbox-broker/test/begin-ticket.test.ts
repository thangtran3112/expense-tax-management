/**
 * Phase 3D-A Task 4, fix round 2 — begin-ticket.ts unit coverage.
 */
import { describe, expect, it } from "vitest";

import { BeginTicketInvalidError, consumeBeginTicket, createBeginTicket } from "../src/begin-ticket.js";
import { createVaultKeyMap } from "../src/test-doubles.js";

describe("begin-ticket", () => {
  it("round-trips state/sessionNonce through an encrypted ticket", () => {
    const vaultKeys = createVaultKeyMap();
    const ticket = createBeginTicket({ state: "the-state-blob", sessionNonce: "nonce-value", vaultKeys });

    const consumed = consumeBeginTicket(ticket, vaultKeys);

    expect(consumed).toEqual({ state: "the-state-blob", sessionNonce: "nonce-value" });
  });

  it("rejects malformed tickets", () => {
    const vaultKeys = createVaultKeyMap();
    expect(() => consumeBeginTicket("garbage", vaultKeys)).toThrow(BeginTicketInvalidError);
    expect(() => consumeBeginTicket("bt1.only.two", vaultKeys)).toThrow(BeginTicketInvalidError);
  });

  it("rejects a ticket encrypted under an unknown/different key", () => {
    const vaultKeys = createVaultKeyMap();
    const otherVaultKeys = createVaultKeyMap();
    const ticket = createBeginTicket({ state: "s", sessionNonce: "n", vaultKeys: otherVaultKeys });
    expect(() => consumeBeginTicket(ticket, vaultKeys)).toThrow(BeginTicketInvalidError);
  });

  it("rejects a tampered ciphertext (GCM auth-tag mismatch)", () => {
    const vaultKeys = createVaultKeyMap();
    const ticket = createBeginTicket({ state: "s", sessionNonce: "n", vaultKeys });
    const parts = ticket.split(".");
    const tampered = [...parts.slice(0, 3), `${parts[3]?.slice(0, -2)}zz`].join(".");
    expect(() => consumeBeginTicket(tampered, vaultKeys)).toThrow(BeginTicketInvalidError);
  });

  it("defaults to a 60-second expiry and rejects once past it", () => {
    const vaultKeys = createVaultKeyMap();
    const now = new Date("2026-10-04T00:00:00.000Z");
    const ticket = createBeginTicket({ state: "s", sessionNonce: "n", vaultKeys, now: () => now });

    // Still valid just before the 60s window closes.
    expect(() =>
      consumeBeginTicket(ticket, vaultKeys, () => new Date(now.getTime() + 59_000)),
    ).not.toThrow();
    // Expired once the window has fully elapsed.
    expect(() =>
      consumeBeginTicket(ticket, vaultKeys, () => new Date(now.getTime() + 60_000)),
    ).toThrow(BeginTicketInvalidError);
  });

  it("honors a custom ttlSeconds (tight-expiry replay bound)", () => {
    const vaultKeys = createVaultKeyMap();
    const now = new Date("2026-10-04T00:00:00.000Z");
    const ticket = createBeginTicket({ state: "s", sessionNonce: "n", vaultKeys, ttlSeconds: 5, now: () => now });

    expect(() => consumeBeginTicket(ticket, vaultKeys, () => new Date(now.getTime() + 4_000))).not.toThrow();
    expect(() => consumeBeginTicket(ticket, vaultKeys, () => new Date(now.getTime() + 5_000))).toThrow(
      BeginTicketInvalidError,
    );
  });

  it("is tolerant of same-window reuse (tight expiry, not single-use, by design)", () => {
    const vaultKeys = createVaultKeyMap();
    const ticket = createBeginTicket({ state: "s", sessionNonce: "n", vaultKeys });
    // Consuming it twice in a row, both within the window, both succeed --
    // this is the documented design tradeoff (Ruling), not a bug.
    expect(consumeBeginTicket(ticket, vaultKeys)).toEqual({ state: "s", sessionNonce: "n" });
    expect(consumeBeginTicket(ticket, vaultKeys)).toEqual({ state: "s", sessionNonce: "n" });
  });
});
