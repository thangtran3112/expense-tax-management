#!/usr/bin/env bash
# Focused, offline test for render-env.sh (A9a2). Runs the real script against
# a fake family_config.py CLI (common/config/family_config.py is not on this
# branch yet -- see .superpowers/sdd/01h-static-hub-clerk-implementation/
# task-9-preflight.md) and a fake Cloudflare API (fake curl shim). No real
# gcloud, Firestore, GCP credential, Cloudflare API key, or network call is
# used anywhere below; every value is an obviously-fake marker string.
#
# Asserts:
#   - render-env.sh calls family_config.py's "run" subcommand with exactly
#     one target, ai-trading/cloudflare -- never "render" (the three upstream
#     profiles render on the VPS now, not in CI) and never
#     infrastructure/secrets/env-bundle.py.
#   - OUT_DIR ends up mode 0700 (owner-only) and contains exactly one file,
#     cloudflared.env, mode 0600, with the exact fake tunnel token content.
#   - An empty/null token from the (fake) Cloudflare API fails the script
#     closed: nonzero exit, no cloudflared.env left behind.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
RENDER_ENV_SH="$SCRIPT_DIR/render-env.sh"

PASS=0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }

perm_octal() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

# --- Fake repo skeleton: render-env.sh resolves REPO_ROOT as three
# directories up from its own path, then calls
# "$REPO_ROOT/common/config/family_config.py" -- mirror that exact layout so
# the real script's path resolution is exercised unmodified.
fake_repo=$(mktemp -d)
fake_bin=$(mktemp -d)
trap 'rm -rf "$fake_repo" "$fake_bin"' EXIT

mkdir -p "$fake_repo/ai-trading/deploy/ci" "$fake_repo/common/config"
cp "$RENDER_ENV_SH" "$fake_repo/ai-trading/deploy/ci/render-env.sh"
chmod 0755 "$fake_repo/ai-trading/deploy/ci/render-env.sh"

# --- Static check: this script must never shell out to the retired tool
# (comments are free to name it when explaining what changed; only an actual
# invocation is disallowed).
if grep -qE '(python3|BUNDLE_TOOL).*env.bundle\.py' "$RENDER_ENV_SH"; then
  fail "render-env.sh must not invoke env-bundle.py"
fi
ok "render-env.sh never invokes the retired env-bundle tool"

# --- Fake family_config.py: a stand-in for the real CLI's "run" command
# (common/config/README.md), just enough to exercise render-env.sh's call
# contract -- not a reimplementation of Firestore resolution.
invocation_log="$fake_repo/invocations.log"
cat >"$fake_repo/common/config/family_config.py" <<PYEOF
#!/usr/bin/env python3
import os, sys, subprocess

args = sys.argv[1:]
with open(os.environ["FAKE_FAMILY_CONFIG_LOG"], "a") as handle:
    handle.write(" ".join(args) + "\n")
if not args or args[0] != "run":
    sys.stderr.write("fake family_config: only 'run' is supported by this test\\n")
    sys.exit(2)
if "--" not in args:
    sys.stderr.write("fake family_config: missing --\\n")
    sys.exit(2)
sep = args.index("--")
targets, command = args[1:sep], args[sep + 1:]
if targets != ["ai-trading/cloudflare"]:
    sys.stderr.write(f"fake family_config: expected exactly ['ai-trading/cloudflare'], got {targets!r}\\n")
    sys.exit(2)
if not command:
    sys.stderr.write("fake family_config: empty command\\n")
    sys.exit(2)
env = dict(os.environ)
env["CLOUDFLARE_API_TOKEN"] = "fake-cf-token-not-real"
env["TF_VAR_cloudflare_account_id"] = "fake-account-id"
sys.exit(subprocess.call(command, env=env))
PYEOF
chmod 0755 "$fake_repo/common/config/family_config.py"
ok "fake family_config.py written"

# --- Fake curl: the fetch script's only two Cloudflare API calls, matched by
# URL. Any other URL is a hard failure (catches an accidental real call).
cat >"$fake_bin/curl" <<'SHEOF'
#!/usr/bin/env bash
url="${@: -1}"
case "$url" in
  */cfd_tunnel\?name=ai-trading\&is_deleted=false)
    if [[ "${FAKE_CURL_FAIL_LOOKUP:-}" == "1" ]]; then
      # Mirrors real curl -fsS on a network/HTTP error: nothing on stdout,
      # nonzero exit, nothing on stderr either (-sS only prints on error,
      # which a connection failure/non-2xx still triggers quietly here).
      exit 7
    fi
    echo '{"result":[{"id":"fake-tunnel-id"}]}' ;;
  */cfd_tunnel/fake-tunnel-id/token)
    if [[ "${FAKE_CURL_EMPTY_TOKEN:-}" == "1" ]]; then
      echo '{"result":null}'
    else
      echo '{"result":"fake-very-secret-tunnel-token"}'
    fi ;;
  *)
    echo "fake curl: unexpected URL: $url" >&2
    exit 1 ;;
esac
SHEOF
chmod 0755 "$fake_bin/curl"
ok "fake curl written"

run_render_env() {
  local out_dir="$1"
  FAKE_FAMILY_CONFIG_LOG="$invocation_log" \
  PATH="$fake_bin:$PATH" \
    bash "$fake_repo/ai-trading/deploy/ci/render-env.sh" "$out_dir"
}

# --- Happy path ---
out_dir="$(mktemp -u)/ai-trading-env"
: >"$invocation_log"
run_render_env "$out_dir" || fail "render-env.sh exited nonzero on the happy path"
ok "render-env.sh exits 0 against the fake CLI and fake Cloudflare API"

[[ "$(perm_octal "$out_dir")" == "700" ]] || fail "OUT_DIR must be mode 0700, got $(perm_octal "$out_dir")"
ok "OUT_DIR is created mode 0700 (owner-only)"

mapfile -t entries < <(ls -A "$out_dir")
[[ "${#entries[@]}" -eq 1 && "${entries[0]}" == "cloudflared.env" ]] \
  || fail "OUT_DIR must contain exactly cloudflared.env, found: ${entries[*]:-<empty>}"
ok "OUT_DIR contains exactly cloudflared.env -- no upstream profile is rendered in CI"

[[ "$(perm_octal "$out_dir/cloudflared.env")" == "600" ]] \
  || fail "cloudflared.env must be mode 0600, got $(perm_octal "$out_dir/cloudflared.env")"
ok "cloudflared.env is mode 0600"

expected_content=$'TUNNEL_TOKEN=fake-very-secret-tunnel-token\n'
actual_content="$(cat "$out_dir/cloudflared.env")"$'\n'
[[ "$actual_content" == "$expected_content" ]] \
  || fail "cloudflared.env content mismatch: got ${actual_content@Q}"
ok "cloudflared.env holds exactly TUNNEL_TOKEN=<the fake token>"

grep -q '^run ai-trading/cloudflare -- bash ' "$invocation_log" \
  || fail "family_config.py must be called as: run ai-trading/cloudflare -- bash <script>; log: $(cat "$invocation_log")"
[[ "$(wc -l <"$invocation_log" | tr -d ' ')" == "1" ]] \
  || fail "family_config.py must be invoked exactly once; log:\n$(cat "$invocation_log")"
ok "family_config.py is invoked exactly once, as: run ai-trading/cloudflare -- bash <fetch script>"

rm -rf "$out_dir"

# --- Fail-closed path: an empty/null tunnel token must not write a file. ---
out_dir2="$(mktemp -u)/ai-trading-env-empty"
if FAKE_CURL_EMPTY_TOKEN=1 run_render_env "$out_dir2" 2>/tmp/render_env_err.$$; then
  cat /tmp/render_env_err.$$ >&2
  rm -f /tmp/render_env_err.$$
  fail "render-env.sh must fail when the Cloudflare API returns an empty/null token"
fi
rm -f /tmp/render_env_err.$$
ok "render-env.sh fails closed on an empty/null tunnel token"

[[ ! -e "$out_dir2/cloudflared.env" ]] \
  || fail "a failed fetch must not leave cloudflared.env behind"
ok "no cloudflared.env is left behind after a failed fetch"

rm -rf "$out_dir2"

# --- Fail-closed path: the FIRST Cloudflare call (tunnel lookup) fails
# (nonzero exit, empty stdout -- the real curl -fsS behavior on a
# network/HTTP error). This must abort before the token fetch ever runs, so
# no token value exists to leak and no cloudflared.env is written.
out_dir3="$(mktemp -u)/ai-trading-env-lookup-fail"
if FAKE_CURL_FAIL_LOOKUP=1 run_render_env "$out_dir3" >/tmp/render_env_out.$$ 2>/tmp/render_env_err.$$; then
  cat /tmp/render_env_out.$$ /tmp/render_env_err.$$ >&2
  rm -f /tmp/render_env_out.$$ /tmp/render_env_err.$$
  fail "render-env.sh must fail when the tunnel-lookup Cloudflare call fails"
fi
if grep -qi 'fake-very-secret-tunnel-token\|fake-cf-token-not-real' /tmp/render_env_out.$$ /tmp/render_env_err.$$; then
  cat /tmp/render_env_out.$$ /tmp/render_env_err.$$ >&2
  rm -f /tmp/render_env_out.$$ /tmp/render_env_err.$$
  fail "no fake secret value may appear in render-env.sh's own stdout/stderr"
fi
rm -f /tmp/render_env_out.$$ /tmp/render_env_err.$$
ok "render-env.sh fails closed when the tunnel-lookup call itself fails, with no value leaked"

[[ "$(perm_octal "$out_dir3")" == "700" ]] \
  || fail "OUT_DIR must still be mode 0700 after a lookup failure, got $(perm_octal "$out_dir3")"
ok "OUT_DIR is still created mode 0700 even when the lookup call fails"

mapfile -t entries3 < <(ls -A "$out_dir3")
[[ "${#entries3[@]}" -eq 0 ]] \
  || fail "OUT_DIR must stay empty after a lookup failure, found: ${entries3[*]}"
ok "OUT_DIR stays empty (no cloudflared.env, no partial file) after a lookup failure"

rm -rf "$out_dir3"

printf '\n%d checks passed (render-env.sh)\n' "$PASS"
