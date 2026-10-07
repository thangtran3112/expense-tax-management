#!/usr/bin/env bash
# Fails closed unless $CLERK_PUBLISHABLE_KEY is a PRODUCTION Clerk
# publishable key for this app's own Frontend API domain. Shared by the
# production image build (ai-trading-deploy.yml's "build" job) and the hub
# static upload (ai-trading-deploy.yml's "hub-static-upload" job) so both
# reject the same way instead of drifting: an absent, test-mode
# (`pk_test_`), malformed, or other-Clerk-instance key must never reach a
# Docker push or a GCS upload.
#
# A Clerk publishable key is `pk_(test|live)_` followed by the base64
# encoding of `<frontend-api-domain>$`. This only accepts `pk_live_` (no
# test-mode key is ever "production", regardless of which Clerk instance it
# names) and requires the decoded domain to be exactly this app's own
# instance -- never prints the key or its decoded payload, on success or
# failure, so a misconfigured value cannot leak into CI logs.
#
# Usage: CLERK_PUBLISHABLE_KEY=pk_live_... check-clerk-publishable-key.sh
set -Eeuo pipefail

# This app's one production Clerk instance (ai-trading/clerk Firestore
# profile's PUBLISHABLE_KEY). A domain rotation needs a reviewed update here.
EXPECTED_FRONTEND_API_DOMAIN='clerk.tobytran.dev$'
PREFIX='pk_live_'

fail() {
  echo "check-clerk-publishable-key: $1" >&2
  exit 1
}

key="${CLERK_PUBLISHABLE_KEY:-}"
[[ -n "$key" ]] || fail "CLERK_PUBLISHABLE_KEY is empty; a production key is required"
[[ "$key" == "$PREFIX"* ]] || fail "key does not start with $PREFIX (a test-mode or malformed key cannot be used in production)"

payload="${key#"$PREFIX"}"
[[ -n "$payload" ]] || fail "key has no payload after $PREFIX"

# Tolerate a base64url-encoded payload (Clerk's dashboard-issued keys use
# standard base64 with '+'/'/'; accept '-'/'_' too and restore padding) --
# reject anything that still isn't valid base64 after that normalization.
b64="${payload//-/+}"
b64="${b64//_/\/}"
case $(( ${#b64} % 4 )) in
  0) ;;
  2) b64+="==" ;;
  3) b64+="=" ;;
  *) fail "key payload is not valid base64url" ;;
esac

decoded="$(printf '%s' "$b64" | base64 -d 2>/dev/null)" || fail "key payload does not decode as base64"
[[ "$decoded" == "$EXPECTED_FRONTEND_API_DOMAIN" ]] \
  || fail "key does not decode to this app's expected Clerk Frontend API domain"

echo "check-clerk-publishable-key: ok (production key for the expected Clerk instance)"
