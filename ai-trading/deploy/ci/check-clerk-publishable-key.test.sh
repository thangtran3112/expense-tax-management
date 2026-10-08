#!/usr/bin/env bash
# Offline test for check-clerk-publishable-key.sh (F1 fix round 1). Every key
# below is an obviously-fake marker string; none is a real Clerk key. No
# network call, GCP credential, or live Clerk instance is used anywhere.
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TARGET="$SCRIPT_DIR/check-clerk-publishable-key.sh"

PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

# This app's expected domain (same constant check-clerk-publishable-key.sh
# validates against) and an obviously-fake sibling instance, both encoded
# the same way a real Clerk publishable key would be.
EXPECTED_DOMAIN='clerk.tobytran.dev$'
VALID_KEY="pk_live_$(printf '%s' "$EXPECTED_DOMAIN" | base64)"
VALID_KEY_NO_PADDING="pk_live_$(printf '%s' "$EXPECTED_DOMAIN" | base64 | tr -d '=')"
WRONG_DOMAIN_KEY="pk_live_$(printf '%s' 'clerk.some-other-app.dev$' | base64)"
TEST_MODE_KEY="pk_test_$(printf '%s' "$EXPECTED_DOMAIN" | base64)"

run_check() {
  CLERK_PUBLISHABLE_KEY="${1-}" "$TARGET"
}

# --- Accept: a correct production key for this app's own instance ---
out="$(run_check "$VALID_KEY" 2>&1)" || fail "must accept a valid pk_live_ key for the expected domain; got: $out"
ok "accepts a valid pk_live_ key decoding to the expected domain"

out="$(run_check "$VALID_KEY_NO_PADDING" 2>&1)" || fail "must accept the same key with base64 padding stripped; got: $out"
ok "accepts the same valid key with '=' padding stripped (base64url style)"

# --- Reject: empty ---
if run_check "" >/tmp/clerk_check_out.$$ 2>&1; then
  cat /tmp/clerk_check_out.$$ >&2; rm -f /tmp/clerk_check_out.$$
  fail "must reject an empty key"
fi
rm -f /tmp/clerk_check_out.$$
ok "rejects an empty key"

# --- Reject: test-mode key, even for the correct domain ---
if run_check "$TEST_MODE_KEY" >/tmp/clerk_check_out.$$ 2>&1; then
  cat /tmp/clerk_check_out.$$ >&2; rm -f /tmp/clerk_check_out.$$
  fail "must reject a pk_test_ key even when it decodes to the expected domain"
fi
if grep -qF "$EXPECTED_DOMAIN" /tmp/clerk_check_out.$$; then
  cat /tmp/clerk_check_out.$$ >&2; rm -f /tmp/clerk_check_out.$$
  fail "rejection output must never print the decoded domain"
fi
rm -f /tmp/clerk_check_out.$$
ok "rejects a pk_test_ (test-mode) key and never prints the decoded domain"

# --- Reject: wrong Clerk instance ---
if run_check "$WRONG_DOMAIN_KEY" >/tmp/clerk_check_out.$$ 2>&1; then
  cat /tmp/clerk_check_out.$$ >&2; rm -f /tmp/clerk_check_out.$$
  fail "must reject a valid pk_live_ key for a different Clerk instance"
fi
if grep -qF "some-other-app" /tmp/clerk_check_out.$$; then
  cat /tmp/clerk_check_out.$$ >&2; rm -f /tmp/clerk_check_out.$$
  fail "rejection output must never print the (wrong) decoded domain"
fi
rm -f /tmp/clerk_check_out.$$
ok "rejects a pk_live_ key for a different Clerk instance, without printing the decoded domain"

# --- Reject: malformed base64 payload ---
if run_check "pk_live_!!!not-base64!!!" >/tmp/clerk_check_out.$$ 2>&1; then
  cat /tmp/clerk_check_out.$$ >&2; rm -f /tmp/clerk_check_out.$$
  fail "must reject a payload that is not valid base64"
fi
rm -f /tmp/clerk_check_out.$$
ok "rejects a malformed (non-base64) payload"

# --- Reject: no pk_live_/pk_test_ shape at all ---
if run_check "not-a-clerk-key-at-all" >/tmp/clerk_check_out.$$ 2>&1; then
  cat /tmp/clerk_check_out.$$ >&2; rm -f /tmp/clerk_check_out.$$
  fail "must reject a value with no pk_live_ prefix"
fi
rm -f /tmp/clerk_check_out.$$
ok "rejects a value with no pk_live_ prefix"

# --- No success-path output leaks the key or its payload either ---
success_out="$(run_check "$VALID_KEY" 2>&1)"
if grep -qF "$VALID_KEY" <<<"$success_out" || grep -qF "$EXPECTED_DOMAIN" <<<"$success_out"; then
  fail "success output must never print the key or its decoded payload: $success_out"
fi
ok "success output never prints the key or its decoded payload"

printf '\n%d checks passed (check-clerk-publishable-key.sh)\n' "$PASS"
