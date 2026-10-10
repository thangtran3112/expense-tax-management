import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { isApiPath, hasFileExtension } from "./mirofish-static.js";

test("isApiPath recognizes /api and /api/* only", () => {
  assert.equal(isApiPath("/api"), true);
  assert.equal(isApiPath("/api/graph"), true);
  assert.equal(isApiPath("/apifoo"), false);
  assert.equal(isApiPath("/"), false);
});

test("hasFileExtension recognizes hashed assets and not SPA routes", () => {
  assert.equal(hasFileExtension("/assets/index-DVY-GYHM.js"), true);
  assert.equal(hasFileExtension("/icon.png"), true);
  assert.equal(hasFileExtension("/index.html"), true);
  assert.equal(hasFileExtension("/"), false);
  assert.equal(hasFileExtension("/projects/42"), false);
});

// --- Behavioral fetch tests -------------------------------------------------
// Stub global fetch (undici, built into Node) per test and restore it after,
// so these run offline against no real GCS bucket or tunnel origin.

const ENV = { STATIC_BUCKET: "test-mirofish-bucket", ORIGIN_HOSTNAME: "mirofish-origin.tobytran.dev" };

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

test("GET /api/graph forwards the Request unchanged to the origin hostname", async () => {
  await withStubFetch(
    () => new Response(JSON.stringify({ nodes: [] }), { status: 200 }),
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/api/graph?project=1", {
        headers: { cookie: "__ai_trading_session=abc" },
      });
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://mirofish-origin.tobytran.dev/api/graph?project=1");
      assert.equal(calls[0].init, req);
    },
  );
});

test("POST /api/upload forwards method, multipart body, and headers unchanged", async () => {
  await withStubFetch(
    () => new Response("ok", { status: 200 }),
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/api/upload", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=x", cookie: "__ai_trading_session=abc" },
        body: "--x\r\ncontent\r\n--x--",
      });
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://mirofish-origin.tobytran.dev/api/upload");
      const forwarded = calls[0].init;
      assert.equal(forwarded, req);
      assert.equal(forwarded.method, "POST");
      assert.equal(forwarded.headers.get("content-type"), "multipart/form-data; boundary=x");
      assert.equal(forwarded.headers.get("cookie"), "__ai_trading_session=abc");
      assert.equal(await forwarded.text(), "--x\r\ncontent\r\n--x--");
    },
  );
});

test("WebSocket Upgrade request to /api/* forwards Upgrade headers unchanged (101 pass-through)", async () => {
  // A real 101 Switching Protocols response (with a live `webSocket` pair) is
  // a Workers-runtime construct Node's own Response() rejects outside that
  // runtime; this test proves the Worker hands Upgrade/Sec-WebSocket-*
  // headers through to origin unchanged via `fetch(originUrl, request)`'s
  // pass-through, same discipline as worker/hub-router.test.js.
  await withStubFetch(
    () => new Response("not a real socket", { status: 200 }),
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/api/ws", {
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

test("non-GET/HEAD request to a non-api path is rejected without any fetch", async () => {
  await withStubFetch(
    () => {
      throw new Error("fetch should not be called for a rejected method");
    },
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/", { method: "POST" });
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 405);
      assert.equal(await res.text(), "Method Not Allowed");
      assert.equal(calls.length, 0);
    },
  );
});

test("GET on a hashed asset path serves directly from the bucket, no auth check, strips GCS headers", async () => {
  await withStubFetch(
    (url) => {
      assert.equal(url, "https://storage.googleapis.com/test-mirofish-bucket/assets/index-DVY-GYHM.js");
      return new Response("console.log(1)", {
        status: 200,
        headers: { "content-type": "application/javascript", "x-goog-hash": "crc32c=abcd" },
      });
    },
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/assets/index-DVY-GYHM.js");
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "console.log(1)");
      assert.equal(res.headers.get("x-goog-hash"), null);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(calls.length, 1); // no auth-check call for a public static asset
    },
  );
});

test("GET / with an allowed session (204 from /__auth/check) serves index.html from the bucket", async () => {
  await withStubFetch(
    (url, init) => {
      if (url === "https://mirofish-origin.tobytran.dev/__auth/check") {
        assert.equal(new Headers(init.headers).get("cookie"), "__ai_trading_session=abc");
        return new Response(null, { status: 204 });
      }
      if (url === "https://storage.googleapis.com/test-mirofish-bucket/index.html") {
        return new Response("<html>mirofish</html>", {
          status: 200,
          headers: { "content-type": "text/html", "x-goog-hash": "crc32c=abcd" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/", {
        headers: { cookie: "__ai_trading_session=abc" },
      });
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "<html>mirofish</html>");
      assert.equal(res.headers.get("x-goog-hash"), null);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, "https://mirofish-origin.tobytran.dev/__auth/check");
      assert.equal(calls[1].url, "https://storage.googleapis.com/test-mirofish-bucket/index.html");
    },
  );
});

test("GET /projects/42 (Vue history-mode deep link) with an allowed session serves index.html, not a 404", async () => {
  await withStubFetch(
    (url) => {
      if (url === "https://mirofish-origin.tobytran.dev/__auth/check") return new Response(null, { status: 204 });
      if (url === "https://storage.googleapis.com/test-mirofish-bucket/index.html") {
        return new Response("<html>mirofish</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/projects/42");
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "<html>mirofish</html>");
      // Never fetched /projects/42 itself from the bucket: Vue history-mode
      // fallback goes straight to index.html, it does not probe-then-fallback.
      assert.equal(calls.every((c) => !c.url.endsWith("/projects/42")), true);
    },
  );
});

test("GET / with no session (non-204 from /__auth/check) relays the gate response, never reaches the bucket", async () => {
  await withStubFetch(
    (url) => {
      if (url === "https://mirofish-origin.tobytran.dev/__auth/check") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://trading-hub.tobytran.dev/login?returnTo=%2F" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/");
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "https://trading-hub.tobytran.dev/login?returnTo=%2F");
      assert.equal(calls.length, 1); // auth check only, bucket never touched without a session
    },
  );
});

// --- Fix round 1 -------------------------------------------------------------
// Reviewer finding / progress.md ruling: a 401 from `/__auth/check` was being
// relayed to the visitor unchanged. Approved 01e requires the Worker itself
// synthesize a 302 to the static hub's `/login?returnTo=<encoded original
// MiroFish request URL>`. 403/5xx must still relay unchanged. No change to
// the auth server, main.tf, or the sibling hub-router.js Worker.

test("RED/GREEN: GET / with 401 from /__auth/check synthesizes a 302 to the hub login with an encoded returnTo, no GCS fetch", async () => {
  await withStubFetch(
    (url) => {
      if (url === "https://mirofish-origin.tobytran.dev/__auth/check") {
        return new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/");
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 302);
      assert.equal(
        res.headers.get("location"),
        `https://trading-hub.tobytran.dev/login?returnTo=${encodeURIComponent("https://mirofish-static.tobytran.dev/")}`,
      );
      assert.equal(calls.length, 1); // auth check only, bucket never touched on a 401
    },
  );
});

test("401 returnTo encodes the exact original path and query (deep link, multiple params)", async () => {
  await withStubFetch(
    (url) => {
      if (url === "https://mirofish-origin.tobytran.dev/__auth/check") {
        return new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async (calls) => {
      const originalUrl = "https://mirofish-static.tobytran.dev/projects/42?tab=report&x=1";
      const req = new Request(originalUrl);
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 302);
      const location = res.headers.get("location");
      assert.equal(location, `https://trading-hub.tobytran.dev/login?returnTo=${encodeURIComponent(originalUrl)}`);
      // Round-trip: decoding returnTo reproduces the exact original URL, byte for byte.
      const parsed = new URL(location);
      assert.equal(parsed.searchParams.get("returnTo"), originalUrl);
      assert.equal(calls.length, 1);
    },
  );
});

test("401 returnTo never produces an open redirect: Location host is always the hub, regardless of attacker-supplied path/query content", async () => {
  await withStubFetch(
    (url) => {
      if (url === "https://mirofish-origin.tobytran.dev/__auth/check") {
        return new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async (calls) => {
      // Attacker-controlled path/query trying to smuggle a second redirect
      // target or break out of the returnTo query value.
      const maliciousUrl =
        "https://mirofish-static.tobytran.dev/projects/evil?returnTo=https://evil.example&next=//evil.example";
      const req = new Request(maliciousUrl);
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 302);
      const location = res.headers.get("location");
      const parsed = new URL(location);
      // Location's own host is always the fixed hub login host — never
      // derived from the request — so no attacker input can redirect
      // off-domain at this hop.
      assert.equal(parsed.protocol, "https:");
      assert.equal(parsed.hostname, "trading-hub.tobytran.dev");
      assert.equal(parsed.pathname, "/login");
      // The entire attacker-controlled original URL, including its embedded
      // "returnTo=" and "//evil.example", is carried as one opaque,
      // fully-percent-encoded query value — not spliced into the query
      // string unescaped, so it cannot inject a second query param or a
      // raw scheme-relative URL Location-parseable on its own.
      assert.equal(location, `https://trading-hub.tobytran.dev/login?returnTo=${encodeURIComponent(maliciousUrl)}`);
      assert.equal(parsed.searchParams.get("returnTo"), maliciousUrl);
      assert.equal([...parsed.searchParams.keys()].length, 1); // no smuggled second query param
      assert.equal(calls.length, 1);
    },
  );
});

test("403 from /__auth/check relays unchanged, no GCS fetch", async () => {
  await withStubFetch(
    (url) => {
      if (url === "https://mirofish-origin.tobytran.dev/__auth/check") {
        return new Response("forbidden", { status: 403, headers: { "content-type": "text/plain" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/");
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 403);
      assert.equal(await res.text(), "forbidden");
      assert.equal(res.headers.get("location"), null);
      assert.equal(calls.length, 1);
    },
  );
});

test("503 from /__auth/check relays unchanged, no GCS fetch", async () => {
  await withStubFetch(
    (url) => {
      if (url === "https://mirofish-origin.tobytran.dev/__auth/check") {
        return new Response("unavailable", { status: 503 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/");
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 503);
      assert.equal(await res.text(), "unavailable");
      assert.equal(calls.length, 1);
    },
  );
});

test("HEAD / with 401 also synthesizes a 302, no GCS fetch, empty body", async () => {
  await withStubFetch(
    (url) => {
      if (url === "https://mirofish-origin.tobytran.dev/__auth/check") {
        return new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/", { method: "HEAD" });
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 302);
      assert.equal(
        res.headers.get("location"),
        `https://trading-hub.tobytran.dev/login?returnTo=${encodeURIComponent("https://mirofish-static.tobytran.dev/")}`,
      );
      assert.equal(await res.text(), "");
      assert.equal(calls.length, 1);
    },
  );
});

test("HEAD / issues a HEAD to the bucket's index.html after an allowed auth check", async () => {
  await withStubFetch(
    (url, init) => {
      if (url === "https://mirofish-origin.tobytran.dev/__auth/check") return new Response(null, { status: 204 });
      if (url === "https://storage.googleapis.com/test-mirofish-bucket/index.html") {
        assert.equal(init?.method, "HEAD");
        return new Response(null, { status: 200, headers: { "content-type": "text/html", "content-length": "20" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
    async (calls) => {
      const req = new Request("https://mirofish-static.tobytran.dev/", { method: "HEAD" });
      const res = await worker.fetch(req, ENV);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-length"), "20");
      assert.equal(await res.text(), "");
      assert.equal(calls.length, 2);
    },
  );
});
