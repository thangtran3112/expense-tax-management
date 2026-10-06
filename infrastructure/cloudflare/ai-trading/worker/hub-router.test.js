import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { resolveStaticObjectKey, isDynamicPath } from "./hub-router.js";

test("root maps to index.html", () => {
  assert.equal(resolveStaticObjectKey("/"), "index.html");
});
test("an app route maps to <slug>.html", () => {
  assert.equal(resolveStaticObjectKey("/apps/tradingagents"), "apps/tradingagents.html");
});
test("trailing slash is stripped before adding .html", () => {
  assert.equal(resolveStaticObjectKey("/apps/tradingagents/"), "apps/tradingagents.html");
});
test("a path with a file extension is served as-is", () => {
  assert.equal(resolveStaticObjectKey("/_next/static/chunks/app.a1b2c3.js"), "_next/static/chunks/app.a1b2c3.js");
  assert.equal(resolveStaticObjectKey("/favicon.ico"), "favicon.ico");
});
test("dynamic prefixes are recognized and everything else is not", () => {
  assert.equal(isDynamicPath("/u/tradingagents/"), true);
  assert.equal(isDynamicPath("/__auth/session"), true);
  assert.equal(isDynamicPath("/__control/apps"), true);
  assert.equal(isDynamicPath("/apps/tradingagents"), false);
  assert.equal(isDynamicPath("/"), false);
});

// --- Behavioral fetch tests -------------------------------------------------
// Stub global fetch (undici, built into Node) per test and restore it after,
// so these run offline against no real GCS bucket or tunnel origin.

const ENV = { STATIC_BUCKET: "test-hub-bucket", ORIGIN_HOSTNAME: "trading-origin.tobytran.dev" };

function withStubFetch(handler, run) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return Promise.resolve(run(calls)).finally(() => {
    globalThis.fetch = realFetch;
  });
}

test("GET / fetches index.html from the static bucket and strips GCS headers", async () => {
  await withStubFetch(
    (url) => {
      assert.equal(url, "https://storage.googleapis.com/test-hub-bucket/index.html");
      return new Response("<html>hub</html>", {
        status: 200,
        headers: { "content-type": "text/html", "x-goog-hash": "crc32c=abcd" },
      });
    },
    async (calls) => {
      const req = new Request("https://trading-static.tobytran.dev/");
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "<html>hub</html>");
      assert.equal(res.headers.get("x-goog-hash"), null);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(calls.length, 1);
    },
  );
});

test("unknown static path falls back to 404.html with status 404", async () => {
  await withStubFetch(
    (url) => {
      if (url.endsWith("/apps/missing.html")) {
        return new Response("gone", { status: 404 });
      }
      if (url.endsWith("/404.html")) {
        return new Response("<html>not found</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async (calls) => {
      const req = new Request("https://trading-static.tobytran.dev/apps/missing");
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 404);
      assert.equal(await res.text(), "<html>not found</html>");
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, "https://storage.googleapis.com/test-hub-bucket/apps/missing.html");
      assert.equal(calls[1].url, "https://storage.googleapis.com/test-hub-bucket/404.html");
    },
  );
});

test("dynamic path is forwarded to the origin hostname with method and query preserved", async () => {
  await withStubFetch(
    (url) => new Response("terminal data", { status: 200 }),
    async (calls) => {
      const req = new Request("https://trading-static.tobytran.dev/u/tradingagents/status?x=1", { method: "GET" });
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://trading-origin.tobytran.dev/u/tradingagents/status?x=1");
      assert.equal(calls[0].init, req);
    },
  );
});

test("non-GET/HEAD request to a static path is rejected without a bucket fetch", async () => {
  await withStubFetch(
    () => {
      throw new Error("fetch should not be called for a rejected method");
    },
    async (calls) => {
      const req = new Request("https://trading-static.tobytran.dev/apps/tradingagents", { method: "POST" });
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 405);
      assert.equal(await res.text(), "Method Not Allowed");
      assert.equal(calls.length, 0);
    },
  );
});

// --- Fix round 1 -------------------------------------------------------------
// Reviewer finding 1: a HEAD request must issue a HEAD to GCS and return an
// empty body, not a GET's body wrapped and silently kept. Reviewer finding 2:
// the dynamic-path forwarding test only covered GET; POST body/headers and a
// WebSocket Upgrade request were untested.

test("HEAD / issues a HEAD request to the bucket and returns status/headers with an empty body", async () => {
  await withStubFetch(
    (url, init) => {
      assert.equal(url, "https://storage.googleapis.com/test-hub-bucket/index.html");
      assert.equal(init?.method, "HEAD");
      // A real GCS HEAD response: headers describing the resource, no body.
      return new Response(null, {
        status: 200,
        headers: { "content-type": "text/html", "content-length": "17", "x-goog-hash": "crc32c=abcd" },
      });
    },
    async (calls) => {
      const req = new Request("https://trading-static.tobytran.dev/", { method: "HEAD" });
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/html");
      assert.equal(res.headers.get("content-length"), "17");
      assert.equal(res.headers.get("x-goog-hash"), null);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.body, null);
      assert.equal(await res.text(), "");
      assert.equal(calls.length, 1);
    },
  );
});

test("dynamic path forwarding preserves POST method, body, and cookie header", async () => {
  await withStubFetch(
    () => new Response("ok", { status: 200 }),
    async (calls) => {
      const req = new Request("https://trading-static.tobytran.dev/__auth/session", {
        method: "POST",
        headers: { authorization: "Bearer test-token", cookie: "session=abc123" },
        body: JSON.stringify({ hello: "world" }),
      });
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://trading-origin.tobytran.dev/__auth/session");
      const forwarded = calls[0].init;
      assert.equal(forwarded, req);
      assert.equal(forwarded.method, "POST");
      assert.equal(forwarded.headers.get("authorization"), "Bearer test-token");
      assert.equal(forwarded.headers.get("cookie"), "session=abc123");
      assert.equal(await forwarded.text(), JSON.stringify({ hello: "world" }));
    },
  );
});

test("dynamic path forwarding preserves WebSocket Upgrade headers", async () => {
  // A real 101 Switching Protocols response (with a live `webSocket` pair) is
  // a Workers-runtime construct Node's own Response() rejects outside that
  // runtime (status must be 200-599) and isn't exercised here; the staged
  // Task 10 browser spike is where a real upgrade/reconnect is probed. This
  // test only proves the Worker hands the Upgrade/Sec-WebSocket-* headers
  // through to origin unchanged, per `fetch(originUrl, request)`'s pass-through.
  await withStubFetch(
    () => new Response("not a real socket", { status: 200 }),
    async (calls) => {
      const req = new Request("https://trading-static.tobytran.dev/u/tradingagents/ws", {
        method: "GET",
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
        },
      });
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      const forwarded = calls[0].init;
      assert.equal(forwarded, req);
      assert.equal(forwarded.headers.get("upgrade"), "websocket");
      assert.equal(forwarded.headers.get("connection"), "Upgrade");
      assert.equal(forwarded.headers.get("sec-websocket-key"), "dGhlIHNhbXBsZSBub25jZQ==");
    },
  );
});
