import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedEmail } from "./allowlist.js";

test("an exact, case-insensitive match is allowed", () => {
  assert.equal(isAllowedEmail("Family@Tobytran.dev", "family@tobytran.dev,spouse@tobytran.dev"), true);
});
test("an email not on the list is rejected", () => {
  assert.equal(isAllowedEmail("stranger@example.com", "family@tobytran.dev,spouse@tobytran.dev"), false);
});
test("an empty or missing list rejects everything", () => {
  assert.equal(isAllowedEmail("family@tobytran.dev", ""), false);
  assert.equal(isAllowedEmail("family@tobytran.dev", undefined), false);
});

// --- Round 1 fix: non-string truthy email must deny, not throw (Low) ---
test("a non-string truthy email is rejected, not thrown", () => {
  assert.equal(isAllowedEmail(12345, "family@tobytran.dev"), false);
  assert.equal(isAllowedEmail({ toString: () => "family@tobytran.dev" }, "family@tobytran.dev"), false);
  assert.equal(isAllowedEmail(true, "family@tobytran.dev"), false);
});
