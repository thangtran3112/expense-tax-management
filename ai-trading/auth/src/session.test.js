import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { sign, verify } from "./session.js";

const KEY = "a".repeat(64); // 32 bytes hex, same shape as a real SESSION_SIGNING_KEY

test("a freshly signed token verifies and returns its payload", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = sign({ email: "family@tobytran.dev", exp }, KEY);
  const payload = verify(token, KEY);
  assert.equal(payload.email, "family@tobytran.dev");
  assert.equal(payload.exp, exp);
});

test("a tampered payload fails verification", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = sign({ email: "family@tobytran.dev", exp }, KEY);
  const [body, mac] = token.split(".");
  const tampered = `${Buffer.from('{"email":"attacker@evil.com","exp":9999999999}').toString("base64url")}.${mac}`;
  assert.equal(verify(tampered, KEY), null);
  assert.equal(verify(`${body}.wrongmac`, KEY), null);
});

test("an expired token fails verification even with a correct signature", () => {
  const exp = Math.floor(Date.now() / 1000) - 10;
  const token = sign({ email: "family@tobytran.dev", exp }, KEY);
  assert.equal(verify(token, KEY), null);
});

test("a token signed with a different key fails verification", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = sign({ email: "family@tobytran.dev", exp }, KEY);
  assert.equal(verify(token, "b".repeat(64)), null);
});

test("malformed tokens fail closed, not throw", () => {
  assert.equal(verify("", KEY), null);
  assert.equal(verify("not-a-token", KEY), null);
  assert.equal(verify(null, KEY), null);
});

// --- Round 1 fixes: strict key length (High) ---

test("sign throws when the secret key is not exactly 64 hex characters", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = { email: "family@tobytran.dev", exp };
  assert.throws(() => sign(payload, "deadbeef")); // valid hex, wrong length
  assert.throws(() => sign(payload, ""));
  assert.throws(() => sign(payload, "g".repeat(64))); // right length, non-hex chars
  assert.throws(() => sign(payload, "a".repeat(63))); // one short
  assert.throws(() => sign(payload, "a".repeat(65))); // one long
});

test("verify fails closed on a malformed secret key, even if the MAC was computed with that same malformed key", () => {
  // Pre-fix, Buffer.from(badKey, "hex") silently truncates to whatever bytes
  // parse, so a consistently-wrong key round-trips undetected. A malformed
  // key must never be accepted, regardless of whether its MAC matches.
  const badKey = "deadbeef";
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const body = Buffer.from(JSON.stringify({ email: "family@tobytran.dev", exp }), "utf8").toString(
    "base64url",
  );
  const mac = createHmac("sha256", Buffer.from(badKey, "hex")).update(body).digest("base64url");
  const forgedToken = `${body}.${mac}`;
  assert.equal(verify(forgedToken, badKey), null);
});

test("verify returns null (not throw) for assorted malformed secret keys", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = sign({ email: "family@tobytran.dev", exp }, KEY);
  assert.equal(verify(token, "deadbeef"), null);
  assert.equal(verify(token, ""), null);
  assert.equal(verify(token, "g".repeat(64)), null);
  assert.equal(verify(token, null), null);
  assert.equal(verify(token, undefined), null);
});

// --- Round 1 fixes: malformed token shapes (Medium) ---

test("a token missing its MAC segment fails closed", () => {
  assert.equal(verify("somebody.", KEY), null);
});

test("a token missing its body segment fails closed", () => {
  assert.equal(verify(".somemac", KEY), null);
});

test("a token with an extra segment fails closed", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = sign({ email: "family@tobytran.dev", exp }, KEY);
  assert.equal(verify(`${token}.extra`, KEY), null);
});

test("a token with invalid base64url characters fails closed, not throws", () => {
  assert.equal(verify("not valid base64url!!.alsonotvalid!!", KEY), null);
});

// --- Round 1 fixes: expiry boundary coverage (Low) ---

test("a token whose exp equals the current time fails (boundary is exclusive)", () => {
  const exp = Math.floor(Date.now() / 1000);
  const token = sign({ email: "family@tobytran.dev", exp }, KEY);
  assert.equal(verify(token, KEY), null);
});

test("a token missing the exp field entirely fails closed", () => {
  const body = Buffer.from(JSON.stringify({ email: "family@tobytran.dev" }), "utf8").toString(
    "base64url",
  );
  const mac = createHmac("sha256", Buffer.from(KEY, "hex")).update(body).digest("base64url");
  assert.equal(verify(`${body}.${mac}`, KEY), null);
});
