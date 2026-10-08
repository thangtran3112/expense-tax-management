import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticServer, resolveObjectPath, resolveUnderRoot } from "./static-server.mjs";

const root = await mkdtemp(join(tmpdir(), "ai-trading-static-server-"));
await writeFile(join(root, "404.html"), "<!doctype html><html>fixture 404</html>");
await writeFile(join(root, "login.txt"), "fixture-flight-payload");
after(() => rm(root, { recursive: true, force: true }));

test("root maps to index.html", () => {
  assert.equal(resolveObjectPath("/"), "index.html");
});
test("an app route maps to <slug>.html", () => {
  assert.equal(resolveObjectPath("/apps/tradingagents"), "apps/tradingagents.html");
});
test("a trailing slash is stripped before adding .html", () => {
  assert.equal(resolveObjectPath("/apps/tradingagents/"), "apps/tradingagents.html");
});
test("a path with a file extension is served as-is", () => {
  assert.equal(resolveObjectPath("/favicon.ico"), "favicon.ico");
  assert.equal(resolveObjectPath("/_next/static/chunks/app.abc123.js"), "_next/static/chunks/app.abc123.js");
});

test("resolveUnderRoot rejects a direct '..' escape", () => {
  assert.throws(() => resolveUnderRoot("/app/out", "../secret.txt"), /path escapes root/);
  assert.throws(() => resolveUnderRoot("/app/out/", "../secret.txt"), /path escapes root/);
});
test("resolveUnderRoot rejects a sibling-directory prefix escape (the risk a string startsWith check misses)", () => {
  // A root with no trailing separator is the exact shape where
  // `full.startsWith(root)` wrongly accepts a sibling directory whose name
  // happens to start with the root's name (e.g. "out-evil" vs "out").
  // Demonstrate the old pattern would have been fooled, then assert the
  // real boundary check is not.
  const root = "/app/out";
  const naiveFull = "/app/out-evil/secret.txt"; // resolve(root, "../out-evil/secret.txt")
  assert.ok(naiveFull.startsWith(root), "the naive string-prefix check is fooled by this fixture (as expected)");
  assert.throws(() => resolveUnderRoot(root, "../out-evil/secret.txt"), /path escapes root/);
});
test("resolveUnderRoot accepts a legitimate nested path", () => {
  assert.equal(resolveUnderRoot("/app/out", "apps/tradingagents.html"), "/app/out/apps/tradingagents.html");
  assert.equal(resolveUnderRoot("/app/out/", "apps/tradingagents.html"), "/app/out/apps/tradingagents.html");
});
test("resolveUnderRoot accepts a benign filename that merely starts with '..'", () => {
  // Regression: a prior fix used `rel.startsWith("..")`, which also matches
  // an in-root filename like "..foo.js" (not a parent-directory escape).
  // Only an exact ".." segment (or "..<sep>...") is an escape.
  assert.equal(resolveUnderRoot("/app/out", "..foo.js"), "/app/out/..foo.js");
  assert.equal(resolveUnderRoot("/app/out", "apps/..bar.css"), "/app/out/apps/..bar.css");
});

// Drive real HTTP requests through the real server, using a disposable
// static export fixture so `pnpm test` works before `pnpm build` in CI.
test("a 404 fallback serves 404.html's own content-type and cache-control, not the requested path's", async () => {
  const server = createStaticServer(root);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_next/static/chunks/missing-abc123.js`);
    const body = await res.text();
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(body, "<!doctype html><html>fixture 404</html>");
  } finally {
    server.close();
  }
});

test("an RSC Flight object has its component MIME type and no-store cache policy", async () => {
  const server = createStaticServer(root);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/login.txt?_rsc=fixture`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/x-component");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), "fixture-flight-payload");
  } finally {
    server.close();
  }
});

test("a traversal request through real HTTP input never serves resolveUnderRoot's thrown path", async () => {
  const server = createStaticServer(root);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/../../../../../../etc/passwd`);
    const body = await res.text();
    assert.equal(res.status, 404, "WHATWG URL parsing already collapses '..' before resolveObjectPath sees it");
    assert.ok(!body.includes("root:"), "response is not /etc/passwd content");
  } finally {
    server.close();
  }
});
