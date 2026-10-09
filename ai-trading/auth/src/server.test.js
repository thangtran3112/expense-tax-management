import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthServer } from "./server.js";
import { sign } from "./session.js";
import { CLERK_ISSUER, CLERK_AUDIENCE } from "./clerk.js";

const SECRET = "a".repeat(64);
const ALLOWED_ORIGIN = "https://trading.tobytran.dev";
const ENV = {
  SESSION_SIGNING_KEY: SECRET,
  ALLOWED_EMAILS: "family@tobytran.dev",
  ALLOWED_ORIGINS: ALLOWED_ORIGIN,
};

function validCookie(email = "family@tobytran.dev", expOffsetSeconds = 3600) {
  return `__ai_trading_session=${sign({ email, exp: Math.floor(Date.now() / 1000) + expOffsetSeconds }, SECRET)}`;
}

function fullClaims(overrides = {}) {
  return {
    sub: "user_123",
    email: "family@tobytran.dev",
    iss: CLERK_ISSUER,
    aud: CLERK_AUDIENCE,
    azp: ALLOWED_ORIGIN,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

async function withAuthServer(env, run) {
  const server = createAuthServer(env);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await run(port);
  } finally {
    server.close();
  }
}

// --- Startup validation: fail closed before ever listening ---

test("createAuthServer throws on a SESSION_SIGNING_KEY that is not 64 hex characters", () => {
  assert.throws(() => createAuthServer({ ...ENV, SESSION_SIGNING_KEY: "short" }));
});

test("createAuthServer throws on a missing SESSION_SIGNING_KEY", () => {
  const { SESSION_SIGNING_KEY, ...rest } = ENV;
  assert.throws(() => createAuthServer(rest));
});

test("createAuthServer throws on an empty ALLOWED_ORIGINS", () => {
  assert.throws(() => createAuthServer({ ...ENV, ALLOWED_ORIGINS: "" }));
});

test("createAuthServer throws on an empty ALLOWED_EMAILS", () => {
  assert.throws(() => createAuthServer({ ...ENV, ALLOWED_EMAILS: "" }));
});

// --- GET /__auth/check ---

test("GET /__auth/check is 401 with no cookie", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`);
    assert.equal(res.status, 401);
  });
});

test("GET /__auth/check is 204 with X-Verified-Email for a valid cookie", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, { headers: { cookie: validCookie() } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("x-verified-email"), "family@tobytran.dev");
  });
});

test("GET /__auth/check is 401 for an expired cookie", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, {
      headers: { cookie: validCookie("family@tobytran.dev", -10) },
    });
    assert.equal(res.status, 401);
  });
});

test("GET /__auth/check is 401 for a forged cookie (tampered signature)", async () => {
  await withAuthServer(ENV, async (port) => {
    const forged = validCookie().replace(/\.[^.]+$/, ".forgedmac");
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, { headers: { cookie: forged } });
    assert.equal(res.status, 401);
  });
});

test("GET /__auth/check is 401 for a cookie signed with a different key", async () => {
  await withAuthServer(ENV, async (port) => {
    const otherKey = "b".repeat(64);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const forged = `__ai_trading_session=${sign({ email: "family@tobytran.dev", exp }, otherKey)}`;
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, { headers: { cookie: forged } });
    assert.equal(res.status, 401);
  });
});

test("POST /__auth/check is 405 (wrong method)", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, { method: "POST" });
    assert.equal(res.status, 405);
  });
});

// --- POST /__auth/session: Origin-before-everything ---

test("POST /__auth/session rejects a disallowed Origin before examining the Authorization header", async () => {
  await withAuthServer(ENV, async (port) => {
    // No Authorization header at all -- if the header were checked first this
    // would be 400, not 403. Proves Origin is the first gate.
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: "https://evil.example.test" },
    });
    assert.equal(res.status, 403);
  });
});

test("POST /__auth/session rejects a missing Origin header", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, { method: "POST" });
    assert.equal(res.status, 403);
  });
});

// --- POST /__auth/session: Authorization header parsing ---

test("POST /__auth/session is 400 for a missing Authorization header (allowed Origin)", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN },
    });
    assert.equal(res.status, 400);
  });
});

test("POST /__auth/session is 400 for an Authorization header without the Bearer scheme", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Token abc123" },
    });
    assert.equal(res.status, 400);
  });
});

test("POST /__auth/session is 400 for a Bearer header with no token", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer " },
    });
    assert.equal(res.status, 400);
  });
});

// P2 regression: a single token must be exactly one whitespace-free segment.
// A naive `/^Bearer\s+(.+)$/i` happily captures "token extra" (with the
// embedded space) as the "token", which only fails later -- 401 from
// `verifyClerkToken`, not 400 for a malformed header as the binding ledger
// requires. These assert 400 directly over real HTTP, not just regex shape.
test("POST /__auth/session is 400 for a Bearer header with two space-separated tokens", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer token extra" },
    });
    assert.equal(res.status, 400);
  });
});

test("POST /__auth/session is 400 for a Bearer header with a tab-separated second token", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer token\textra" },
    });
    assert.equal(res.status, 400);
  });
});

test("POST /__auth/session is 400 for a Bearer header with an embedded tab inside one token", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer tok\ten" },
    });
    assert.equal(res.status, 400);
  });
});

test("POST /__auth/session accepts a single token with extra inter-field whitespace", async () => {
  const env = { ...ENV, verifyToken: async () => ({ data: fullClaims() }) };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer   real-looking-clerk-token  " },
    });
    assert.equal(res.status, 204);
  });
});

// --- POST /__auth/session: verification outcomes ---

test("POST /__auth/session issues a cookie for a verified, allowed Clerk user", async () => {
  const env = { ...ENV, verifyToken: async () => ({ data: fullClaims() }) };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer real-looking-clerk-token" },
    });
    assert.equal(res.status, 204);
    const setCookie = res.headers.get("set-cookie");
    assert.match(setCookie, /^__ai_trading_session=/);
    assert.match(setCookie, /Domain=tobytran\.dev/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Max-Age=3600/);
  });
});

test("POST /__auth/session rejects a verified user who is not on the allowlist", async () => {
  const env = {
    ...ENV,
    verifyToken: async () => ({ data: fullClaims({ sub: "user_2", email: "stranger@example.com" }) }),
  };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer real-looking-clerk-token" },
    });
    assert.equal(res.status, 401);
  });
});

test("POST /__auth/session rejects an unverifiable token (e.g. bad signature upstream)", async () => {
  const env = { ...ENV, verifyToken: async () => ({ errors: [{ message: "bad signature" }] }) };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer whatever" },
    });
    assert.equal(res.status, 401);
  });
});

test("POST /__auth/session rejects a token missing the operator-provisioned email claim", async () => {
  const env = {
    ...ENV,
    verifyToken: async () => {
      const claims = fullClaims();
      delete claims.email;
      return { data: claims };
    },
  };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, authorization: "Bearer real-looking-clerk-token" },
    });
    assert.equal(res.status, 401);
  });
});

test("GET /__auth/session is 405 (wrong method)", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`);
    assert.equal(res.status, 405);
  });
});

// --- POST /__auth/logout: expire this browser's cookie, not copied tokens ---

test("POST /__auth/logout expires the shared HttpOnly cookie on an allowed origin", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/logout`, {
      method: "POST",
      headers: { origin: ALLOWED_ORIGIN, cookie: validCookie() },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("set-cookie"), "__ai_trading_session=; Domain=tobytran.dev; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const check = await fetch(`http://127.0.0.1:${port}/__auth/check`, {
      headers: { cookie: res.headers.get("set-cookie").split(";")[0] },
    });
    assert.equal(check.status, 401);
  });
});

test("POST /__auth/logout is idempotent and accepts the configured staging origin", async () => {
  const staging = "https://trading-static.tobytran.dev";
  await withAuthServer({ ...ENV, ALLOWED_ORIGINS: `${ALLOWED_ORIGIN},${staging}` }, async (port) => {
    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/__auth/logout`, { method: "POST", headers: { origin: staging } });
      assert.equal(res.status, 204);
      assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
    }
  });
});

test("POST /__auth/logout refuses missing or cross-site origins without clearing cookies", async () => {
  await withAuthServer(ENV, async (port) => {
    for (const origin of [undefined, "https://evil.example.test", `${ALLOWED_ORIGIN}.evil.example.test`]) {
      const res = await fetch(`http://127.0.0.1:${port}/__auth/logout`, {
        method: "POST",
        headers: { cookie: validCookie(), ...(origin ? { origin } : {}) },
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("set-cookie"), null);
    }
  });
});

test("GET /__auth/logout refuses the wrong method without clearing cookies", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/logout`, { headers: { origin: ALLOWED_ORIGIN, cookie: validCookie() } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("set-cookie"), null);
  });
});

// --- Unknown route ---

test("an unknown path is 404", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/not-a-route`);
    assert.equal(res.status, 404);
  });
});
