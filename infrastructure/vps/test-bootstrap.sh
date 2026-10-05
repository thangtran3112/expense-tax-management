#!/usr/bin/env bash
# Fast, Docker-free, no-real-SSH checks for bootstrap.sh. Stubs `ssh`/`scp`
# on PATH to record every invocation's argv and stdin, then asserts the
# backup writer key's secret CONTENT never appears in any argv (local or
# "remote" -- i.e. never embedded in a command string) while proving it
# DOES get piped as stdin to the one install invocation responsible for
# writing it to its final root-only file. Wired into pnpm ci:test via
# check:vps-backup-infrastructure.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT

stub_dir="$d/stubs"
mkdir -p "$stub_dir"
secret='AGE-SECRET-LOOKING-WRITER-KEY-CONTENT-DO-NOT-LEAK-7f3a9c'
echo "{\"type\":\"service_account\",\"private_key\":\"$secret\"}" > "$d/writer-key.json"

# Stub ssh: records argv (one invocation per line) and captures each
# invocation's stdin to its own numbered file. Exits 0 unconditionally --
# this proves the bootstrap.sh ORCHESTRATION/transport, not real SSH.
cat > "$stub_dir/ssh" <<'SH'
#!/usr/bin/env bash
count_file="$STUB_CAPTURE_DIR/ssh-call-count"
n=0
[[ -f "$count_file" ]] && n=$(cat "$count_file")
n=$((n + 1))
echo "$n" > "$count_file"
printf '%s\n' "$*" >> "$STUB_CAPTURE_DIR/ssh-argv.log"
# Non-interactive stdin only: avoids ever blocking on a real terminal.
timeout 2 cat > "$STUB_CAPTURE_DIR/ssh-stdin-$n.log" 2>/dev/null || true
exit 0
SH
chmod +x "$stub_dir/ssh"

cat > "$stub_dir/scp" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_CAPTURE_DIR/scp-argv.log"
exit 0
SH
chmod +x "$stub_dir/scp"

capture_dir="$d/capture"
mkdir -p "$capture_dir"

PATH="$stub_dir:$PATH" STUB_CAPTURE_DIR="$capture_dir" \
  bash "$SCRIPT_DIR/bootstrap.sh" \
  --host 198.51.100.1 --ssh-user ubuntu --ssh-key /dev/null \
  --app "$SCRIPT_DIR/apps/expense-tax-management.conf" \
  --only backup \
  --backup-gcs-uri gs://fake-bucket \
  --backup-host-id fake-host \
  --age-recipient age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p \
  --receipt-volume fake-receipt-volume \
  --backup-image ghcr.io/example/family-app-backup@sha256:deadbeef \
  --backup-writer-key-file "$d/writer-key.json" \
  >"$d/bootstrap.log" 2>&1 || { cat "$d/bootstrap.log" >&2; fail "bootstrap.sh --only backup exited nonzero against stubbed ssh/scp"; }
ok "bootstrap.sh --only backup completes against stubbed ssh/scp"

[[ -s "$capture_dir/ssh-argv.log" ]] || fail "ssh was never invoked"
if grep -qF "$secret" "$capture_dir/ssh-argv.log"; then
  fail "the writer key's secret content appeared in an ssh command's argv"
fi
ok "the writer key's secret content never appears in any ssh invocation's argv"

if [[ -s "$capture_dir/scp-argv.log" ]] && grep -qF "$secret" "$capture_dir/scp-argv.log"; then
  fail "the writer key's secret content appeared in an scp command's argv"
fi
ok "the writer key's secret content never appears in any scp invocation's argv"

grep -qF "BACKUP_WRITER_KEY_JSON" "$capture_dir/ssh-argv.log" \
  && fail "BACKUP_WRITER_KEY_JSON must never be passed as a remote env var on the command line"
ok "BACKUP_WRITER_KEY_JSON is never passed as a remote command-line env var"

grep -qF "install -m 0400 /dev/stdin /etc/family-app/backup-writer-key.json" "$capture_dir/ssh-argv.log" \
  || fail "expected an ssh invocation running 'sudo install -m 0400 /dev/stdin .../backup-writer-key.json'"
ok "the writer key is installed via 'install -m 0400 /dev/stdin ...', not argv"

secret_found_in_stdin=0
for f in "$capture_dir"/ssh-stdin-*.log; do
  [[ -f "$f" ]] || continue
  grep -qF "$secret" "$f" && secret_found_in_stdin=1
done
[[ "$secret_found_in_stdin" == 1 ]] || fail "the writer key's secret content was never found in any ssh invocation's stdin"
ok "the writer key's secret content was transferred via ssh stdin, as intended"

printf '\n%d checks passed (bootstrap.sh writer-key transport)\n' "$PASS"
