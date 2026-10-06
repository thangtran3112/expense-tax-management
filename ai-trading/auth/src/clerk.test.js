// Tests use an injected `verify` fake in place of the real network-calling
// `@clerk/backend` verifyToken. The fake only replaces the network dependency;
// every claim check below (iss, aud, azp, email, sub) is this module's own
// code, exercised directly against the shapes a real decoded Clerk token
// would have. Payload shapes mirror @clerk/backend's documented decoded
// example (azp, exp, iat, iss, nbf, sid, sub) plus the two operator-added
// custom claims (email, aud) that this hub's design requires.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { verifyToken } from "@clerk/backend";
import { TokenVerificationErrorReason } from "@clerk/backend/errors";
import { verifyClerkToken, CLERK_ISSUER, CLERK_AUDIENCE } from "./clerk.js";

const AUTHORIZED_PARTIES = ["https://trading.tobytran.dev"];

const FULL_CLAIMS = {
  sub: "user_123",
  email: "Family@Tobytran.dev",
  iss: CLERK_ISSUER,
  aud: CLERK_AUDIENCE,
  azp: AUTHORIZED_PARTIES[0],
  exp: 1987906422,
  iat: 1987906362,
  nbf: 1987906352,
  sid: "sess_2Ro7e2IxrffdqBboq8KfB6eGbIy",
};

function withClaims(overrides) {
  const data = { ...FULL_CLAIMS, ...overrides };
  return { data };
}

test("a valid token with all required claims returns a normalized identity", async () => {
  const result = await verifyClerkToken("tok", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () => withClaims({}),
  });
  assert.deepEqual(result, { sub: "user_123", email: "family@tobytran.dev" });
});

test("verify() is called with secretKey, authorizedParties, and the fixed audience", async () => {
  let seenToken;
  let seenOptions;
  await verifyClerkToken("tok", {
    secretKey: "sk_test_abc",
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async (token, options) => {
      seenToken = token;
      seenOptions = options;
      return withClaims({});
    },
  });
  assert.equal(seenToken, "tok");
  assert.deepEqual(seenOptions, {
    secretKey: "sk_test_abc",
    authorizedParties: AUTHORIZED_PARTIES,
    audience: CLERK_AUDIENCE,
  });
});

test("a result shaped as { errors } is rejected", async () => {
  const result = await verifyClerkToken("tok", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () => ({ errors: [{ message: "bad" }] }),
  });
  assert.equal(result, null);
});

test("a verify() that throws is rejected, not propagated", async () => {
  const result = await verifyClerkToken("tok", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(result, null);
});

test("an empty token short-circuits without calling verify", async () => {
  let called = false;
  const result = await verifyClerkToken("", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () => {
      called = true;
      return withClaims({});
    },
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("a missing authorizedParties list fails closed without calling verify", async () => {
  let called = false;
  const result = await verifyClerkToken("tok", {
    verify: async () => {
      called = true;
      return withClaims({});
    },
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("an empty authorizedParties list fails closed without calling verify", async () => {
  let called = false;
  const result = await verifyClerkToken("tok", {
    authorizedParties: [],
    verify: async () => {
      called = true;
      return withClaims({});
    },
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("a payload missing the custom email claim is rejected (Clerk Dashboard precondition unmet)", async () => {
  const { email, ...withoutEmail } = FULL_CLAIMS;
  const result = await verifyClerkToken("tok", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () => ({ data: withoutEmail }),
  });
  assert.equal(result, null);
});

test("a wrong issuer is rejected", async () => {
  const result = await verifyClerkToken("tok", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () =>
      withClaims({ iss: "https://attacker.example.clerk.accounts.dev" }),
  });
  assert.equal(result, null);
});

test("a missing issuer is rejected", async () => {
  const { iss, ...withoutIss } = FULL_CLAIMS;
  const result = await verifyClerkToken("tok", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () => ({ data: withoutIss }),
  });
  assert.equal(result, null);
});

test("a wrong audience is rejected (custom aud claim present but mismatched)", async () => {
  const result = await verifyClerkToken("tok", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () => withClaims({ aud: "https://some-other-app.example" }),
  });
  assert.equal(result, null);
});

test("a missing audience is rejected (Clerk Dashboard precondition unmet: default session token has no aud)", async () => {
  const { aud, ...withoutAud } = FULL_CLAIMS;
  const result = await verifyClerkToken("tok", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () => ({ data: withoutAud }),
  });
  assert.equal(result, null);
});

test("an azp not present in the authorizedParties allowlist is rejected", async () => {
  const result = await verifyClerkToken("tok", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () => withClaims({ azp: "https://not-allowed.example" }),
  });
  assert.equal(result, null);
});

test("a missing azp is rejected", async () => {
  const { azp, ...withoutAzp } = FULL_CLAIMS;
  const result = await verifyClerkToken("tok", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () => ({ data: withoutAzp }),
  });
  assert.equal(result, null);
});

test("a missing sub is rejected", async () => {
  const { sub, ...withoutSub } = FULL_CLAIMS;
  const result = await verifyClerkToken("tok", {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: async () => ({ data: withoutSub }),
  });
  assert.equal(result, null);
});

// --- Real SDK signature/claim path, no fake verifier, no network ---
//
// Every test above injects a fake `verify` that returns a plain object — it
// never exercises the real @clerk/backend `verifyToken`/`verifyJwt`
// pipeline (JWT decoding, RS256 signature check, or the SDK's own `aud`/`azp`
// assertions). This test mints a genuinely RS256-signed JWT with a locally
// generated keypair and calls the REAL `verifyToken`, networkless via its
// `jwtKey` option (a local PEM public key — no Clerk JWKS endpoint, no Clerk
// credentials). It proves `clerk.js` is compatible with the real installed
// `@clerk/backend@3.17.2` signature/claim-verification behavior, not just
// with a hand-shaped fake payload.
function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function mintRs256Jwt(claims, privateKey) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const signature = base64url(
    cryptoSign("RSA-SHA256", Buffer.from(signingInput), privateKey),
  );
  return `${signingInput}.${signature}`;
}

// One locally generated signing key and one signed token, reused by the
// success case and both SDK-rejection cases below: only the `verifyToken`
// call-site options (`audience`, `authorizedParties`) change between them,
// never the token or the key. This isolates what's actually under test — the
// real SDK's own audience/authorized-party enforcement at verify time — from
// any variation in the token itself.
const REAL_SDK_KEYPAIR = generateKeyPairSync("rsa", { modulusLength: 2048 });
const REAL_SDK_PUBLIC_KEY_PEM = REAL_SDK_KEYPAIR.publicKey.export({
  type: "spki",
  format: "pem",
});
const REAL_SDK_NOW = Math.floor(Date.now() / 1000);
const REAL_SDK_TOKEN = mintRs256Jwt(
  {
    sub: "user_real_sig",
    email: "Family@Tobytran.dev",
    iss: CLERK_ISSUER,
    aud: CLERK_AUDIENCE,
    azp: AUTHORIZED_PARTIES[0],
    iat: REAL_SDK_NOW - 10,
    nbf: REAL_SDK_NOW - 10,
    exp: REAL_SDK_NOW + 3600,
  },
  REAL_SDK_KEYPAIR.privateKey,
);

test("a genuinely RS256-signed token verifies end-to-end through the real @clerk/backend SDK", async () => {
  const result = await verifyClerkToken(REAL_SDK_TOKEN, {
    authorizedParties: AUTHORIZED_PARTIES,
    verify: (tok, options) =>
      verifyToken(tok, { ...options, jwtKey: REAL_SDK_PUBLIC_KEY_PEM }),
  });

  assert.deepEqual(result, {
    sub: "user_real_sig",
    email: "family@tobytran.dev",
  });
});

// `@clerk/backend`'s publicly exported `verifyToken` (the root `.` export;
// there is no public subpath to the lower-level `{ data } | { errors }`
// variant — `./tokens` is not in the package's `exports` map) is
// `withLegacyReturn`-wrapped: on success it resolves the payload directly: on
// a validation failure it THROWS the first `TokenVerificationError`, it does
// not return `{ errors }`. `clerk.js`'s `verify()` call site already wraps
// this in `try/catch` and falls back to `result.data ?? result` on success,
// so this throwing behavior is already handled — not a wrapper bug — but
// these two tests characterize it directly against the real SDK, calling
// `verifyToken` itself (not through `verifyClerkToken`), reusing the exact
// same signed token and key as the success test above.
test("the real @clerk/backend verifyToken throws on an audience mismatch, even for an otherwise-validly-signed token", async () => {
  await assert.rejects(
    () =>
      verifyToken(REAL_SDK_TOKEN, {
        jwtKey: REAL_SDK_PUBLIC_KEY_PEM,
        audience: "https://wrong-audience.example",
        authorizedParties: AUTHORIZED_PARTIES,
      }),
    (err) => {
      // The SDK has no dedicated "invalid audience" reason code (unlike
      // authorized parties, below) — an audience mismatch surfaces under the
      // same generic reason as other payload-assertion failures.
      assert.equal(err.reason, TokenVerificationErrorReason.TokenVerificationFailed);
      assert.match(err.message, /audience/i);
      return true;
    },
  );
});

test("the real @clerk/backend verifyToken throws on an authorizedParties mismatch, even for an otherwise-validly-signed token", async () => {
  await assert.rejects(
    () =>
      verifyToken(REAL_SDK_TOKEN, {
        jwtKey: REAL_SDK_PUBLIC_KEY_PEM,
        audience: CLERK_AUDIENCE,
        authorizedParties: ["https://not-allowed.example"],
      }),
    (err) => {
      assert.equal(
        err.reason,
        TokenVerificationErrorReason.TokenInvalidAuthorizedParties,
      );
      return true;
    },
  );
});
