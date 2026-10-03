/**
 * Phase 3D-A Task 4, fix round 2 — google-authorization-url.ts unit coverage.
 */
import { describe, expect, it, vi } from "vitest";

import { createGoogleAuthorizationUrlBuilder, GMAIL_READONLY_SCOPE } from "../src/google-authorization-url.js";

describe("createGoogleAuthorizationUrlBuilder", () => {
  it("builds the URL via the injected client with the expected trusted params", () => {
    const generateAuthUrl = vi.fn(() => "https://accounts.google.test/auth?built=true");
    const build = createGoogleAuthorizationUrlBuilder({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://broker.test/oauth/google/callback",
      createOAuth2Client: () => ({ generateAuthUrl }),
    });

    const result = build({ state: "state-value", codeChallenge: "challenge-value" });

    expect(result).toBe("https://accounts.google.test/auth?built=true");
    expect(generateAuthUrl).toHaveBeenCalledWith({
      access_type: "offline",
      scope: [GMAIL_READONLY_SCOPE],
      include_granted_scopes: false,
      prompt: "consent",
      state: "state-value",
      code_challenge: "challenge-value",
      code_challenge_method: "S256",
    });
  });

  it("builds a fresh client per call (no shared mutable state across requests)", () => {
    const createOAuth2Client = vi.fn(() => ({ generateAuthUrl: () => "https://accounts.google.test/auth" }));
    const build = createGoogleAuthorizationUrlBuilder({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://broker.test/oauth/google/callback",
      createOAuth2Client,
    });

    build({ state: "s1", codeChallenge: "c1" });
    build({ state: "s2", codeChallenge: "c2" });

    expect(createOAuth2Client).toHaveBeenCalledTimes(2);
  });
});
