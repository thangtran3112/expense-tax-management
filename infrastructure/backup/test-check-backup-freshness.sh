#!/usr/bin/env bash
# Fast, Docker-free checks for check-backup-freshness.sh. Wired into
# `pnpm ci:test` via check:vps-backup-infrastructure (see test-backup.sh).
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT

if bash "$SCRIPT_DIR/check-backup-freshness.sh" "$d/missing.json" >/tmp/freshness_out.$$ 2>&1; then
  cat /tmp/freshness_out.$$ >&2
  fail "a missing marker must be reported STALE"
fi
grep -q STALE /tmp/freshness_out.$$ || { cat /tmp/freshness_out.$$ >&2; fail "missing-marker message must say STALE"; }
rm -f /tmp/freshness_out.$$
ok "a missing marker is reported STALE"

jq -n --argjson c "$(($(date -u +%s) - 3600))" '{cutoff_epoch: $c}' > "$d/fresh.json"
if ! bash "$SCRIPT_DIR/check-backup-freshness.sh" "$d/fresh.json" >/tmp/freshness_out.$$ 2>&1; then
  cat /tmp/freshness_out.$$ >&2
  fail "a 1h-old marker must be reported FRESH"
fi
grep -q FRESH /tmp/freshness_out.$$ || { cat /tmp/freshness_out.$$ >&2; fail "fresh-marker message must say FRESH"; }
rm -f /tmp/freshness_out.$$
ok "a 1h-old marker is reported FRESH"

jq -n --argjson c "$(($(date -u +%s) - 23 * 3600))" '{cutoff_epoch: $c}' > "$d/almost-stale.json"
bash "$SCRIPT_DIR/check-backup-freshness.sh" "$d/almost-stale.json" >/dev/null 2>&1 \
  || fail "a 23h-old marker must still be FRESH (under the 24h RPO)"
ok "a 23h-old marker is still FRESH (one hour under the RPO)"

jq -n --argjson c "$(($(date -u +%s) - 25 * 3600))" '{cutoff_epoch: $c}' > "$d/stale.json"
if bash "$SCRIPT_DIR/check-backup-freshness.sh" "$d/stale.json" >/tmp/freshness_out.$$ 2>&1; then
  cat /tmp/freshness_out.$$ >&2
  fail "a 25h-old marker must be reported STALE"
fi
rm -f /tmp/freshness_out.$$
ok "a 25h-old marker is reported STALE"

echo '{"cutoff_epoch": null}' > "$d/null-cutoff.json"
bash "$SCRIPT_DIR/check-backup-freshness.sh" "$d/null-cutoff.json" >/dev/null 2>&1 && fail "a null cutoff_epoch must be STALE, not crash"
ok "a marker with a null cutoff_epoch is reported STALE, not a crash"

printf '\n%d checks passed (check-backup-freshness.sh)\n' "$PASS"
