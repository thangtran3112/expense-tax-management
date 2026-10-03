import { describe, expect, it } from "vitest";

import {
  consumeOAuthState,
  createOAuthState,
  decodeOAuthStatePayload,
  OAuthStateInvalidError,
} from "../src/oauth-state.js";
import { createVaultKeyMap } from "../src/test-doubles.js";

const ALLOWED_ORIGIN = "https://expense-office.test";

function baseInput(overrides: Partial<Parameters<typeof createOAuthState>[0]> = {}) {
  return {
    connectionId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    sessionNonce: "session-nonce-abc",
    redirectOrigin: ALLOWED_ORIGIN,
    ttlSeconds: 600,
    vaultKeys: createVaultKeyMap(),
    ...overrides,
  };
}

describe("oauth-state", () => {
  it("round-trips connectionId/attemptId/redirectOrigin through an encrypted state", () => {
    const vaultKeys = createVaultKeyMap();
    const created = createOAuthState(baseInput({ vaultKeys }));

    const consumed = consumeOAuthState({
      state: created.state,
      sessionNonce: "session-nonce-abc",
      allowedRedirectOrigins: [ALLOWED_ORIGIN],
      vaultKeys,
    });

    expect(consumed.connectionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(consumed.attemptId).toBe("22222222-2222-4222-8222-222222222222");
    expect(consumed.redirectOrigin).toBe(ALLOWED_ORIGIN);
    expect(consumed.stateDigest).toBe(created.stateDigest);
  });

  it("derives codeChallenge as base64url(sha256(pkceVerifier)) (S256)", async () => {
    const vaultKeys = createVaultKeyMap();
    const created = createOAuthState(baseInput({ vaultKeys }));
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(created.pkceVerifier).digest("base64url");
    expect(created.codeChallenge).toBe(expected);
  });

  it("produces a fresh nonce (different state/stateDigest) on every call, even for the same connection/attempt", () => {
    const vaultKeys = createVaultKeyMap();
    const first = createOAuthState(baseInput({ vaultKeys }));
    const second = createOAuthState(baseInput({ vaultKeys }));
    expect(first.state).not.toBe(second.state);
    expect(first.stateDigest).not.toBe(second.stateDigest);
    expect(first.pkceVerifier).not.toBe(second.pkceVerifier);
  });

  it("rejects a tampered ciphertext (GCM auth-tag mismatch)", () => {
    const vaultKeys = createVaultKeyMap();
    const created = createOAuthState(baseInput({ vaultKeys }));
    const parts = created.state.split(".");
    // Flip a character in the ciphertext/tag segment.
    const tampered = [...parts];
    tampered[3] = tampered[3]!.slice(0, -1) + (tampered[3]!.at(-1) === "A" ? "B" : "A");

    expect(() =>
      consumeOAuthState({
        state: tampered.join("."),
        sessionNonce: "session-nonce-abc",
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        vaultKeys,
      }),
    ).toThrow(OAuthStateInvalidError);
  });

  it("rejects a state encrypted under a key no longer loaded", () => {
    const vaultKeys = createVaultKeyMap({ activeKeyId: "retired-key" });
    const created = createOAuthState(baseInput({ vaultKeys }));
    const currentKeys = createVaultKeyMap({ activeKeyId: "new-key" }); // no "retired-key" entry

    expect(() =>
      consumeOAuthState({
        state: created.state,
        sessionNonce: "session-nonce-abc",
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        vaultKeys: currentKeys,
      }),
    ).toThrow(OAuthStateInvalidError);
  });

  it("decrypts under either key during a dual-key rotation window", () => {
    const retiringMaterial = createVaultKeyMap({ activeKeyId: "old" });
    const created = createOAuthState(baseInput({ vaultKeys: retiringMaterial }));

    const dualKeyWindow = createVaultKeyMap({
      activeKeyId: "new",
      extraKeys: { old: retiringMaterial.keys.get("old")! },
    });

    const consumed = consumeOAuthState({
      state: created.state,
      sessionNonce: "session-nonce-abc",
      allowedRedirectOrigins: [ALLOWED_ORIGIN],
      vaultKeys: dualKeyWindow,
    });
    expect(consumed.attemptId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("rejects an expired state", () => {
    const vaultKeys = createVaultKeyMap();
    const start = new Date("2026-01-01T00:00:00.000Z");
    const created = createOAuthState(
      baseInput({ vaultKeys, ttlSeconds: 60, now: () => start }),
    );

    expect(() =>
      consumeOAuthState({
        state: created.state,
        sessionNonce: "session-nonce-abc",
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        vaultKeys,
        now: () => new Date(start.getTime() + 61_000),
      }),
    ).toThrow(OAuthStateInvalidError);
  });

  it("rejects a mismatched session nonce (nonce transport)", () => {
    const vaultKeys = createVaultKeyMap();
    const created = createOAuthState(baseInput({ vaultKeys }));

    expect(() =>
      consumeOAuthState({
        state: created.state,
        sessionNonce: "wrong-session-nonce",
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        vaultKeys,
      }),
    ).toThrow(OAuthStateInvalidError);
  });

  it("rejects a redirect origin outside the allowlist", () => {
    const vaultKeys = createVaultKeyMap();
    const created = createOAuthState(
      baseInput({ vaultKeys, redirectOrigin: "https://evil.test" }),
    );

    expect(() =>
      consumeOAuthState({
        state: created.state,
        sessionNonce: "session-nonce-abc",
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        vaultKeys,
      }),
    ).toThrow(OAuthStateInvalidError);
  });

  it("rejects a malformed state string", () => {
    const vaultKeys = createVaultKeyMap();
    expect(() =>
      consumeOAuthState({
        state: "not-a-valid-state",
        sessionNonce: "session-nonce-abc",
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
        vaultKeys,
      }),
    ).toThrow(OAuthStateInvalidError);
  });

  describe("decodeOAuthStatePayload (no session-nonce/origin check, used by exchangeAuthorizationCode)", () => {
    it("decodes pkceVerifier/connectionId/attemptId without a session nonce", () => {
      const vaultKeys = createVaultKeyMap();
      const created = createOAuthState(baseInput({ vaultKeys }));

      const decoded = decodeOAuthStatePayload(created.state, vaultKeys);
      expect(decoded.pkceVerifier).toBe(created.pkceVerifier);
      expect(decoded.connectionId).toBe("11111111-1111-4111-8111-111111111111");
    });

    it("still enforces expiry", () => {
      const vaultKeys = createVaultKeyMap();
      const start = new Date("2026-01-01T00:00:00.000Z");
      const created = createOAuthState(
        baseInput({ vaultKeys, ttlSeconds: 60, now: () => start }),
      );

      expect(() =>
        decodeOAuthStatePayload(created.state, vaultKeys, () => new Date(start.getTime() + 61_000)),
      ).toThrow(OAuthStateInvalidError);
    });
  });
});
