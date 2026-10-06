import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin } from "./origin.js";

const ALLOWED = "https://trading.tobytran.dev,https://trading-static.tobytran.dev";

test("an exact allowed Origin passes", () => {
  assert.equal(isAllowedOrigin("https://trading.tobytran.dev", ALLOWED), true);
});
test("a missing Origin header is rejected", () => {
  assert.equal(isAllowedOrigin(undefined, ALLOWED), false);
  assert.equal(isAllowedOrigin(null, ALLOWED), false);
});
test("a cross-site Origin is rejected even when it looks similar", () => {
  assert.equal(isAllowedOrigin("https://trading.tobytran.dev.evil.com", ALLOWED), false);
  assert.equal(isAllowedOrigin("http://trading.tobytran.dev", ALLOWED), false); // scheme must match too
});
