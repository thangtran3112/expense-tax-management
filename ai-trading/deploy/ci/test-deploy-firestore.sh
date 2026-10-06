#!/usr/bin/env bash
# Offline test for production/deploy.sh's Firestore-render + atomic-staging
# contract (A9a1): render_profiles() + stage_secrets() + rollback, with a
# fake family_config.py standing in for the real CLI (which lives only on
# origin/dev's main checkout, not this worktree -- see
# .superpowers/sdd/01h-static-hub-clerk-implementation/task-9-preflight.md).
# No real Firestore, Secret Manager, gcloud, or VPS credential is used
# anywhere in this file. Everything runs under one mktemp -d root outside the
# repository (matches ai-trading/AGENTS.md's "never put env files under
# ai-trading/" rule) and that root is removed on exit.
#
# Cases 10-14 (A9b) additionally cover activate_mirofish() -- the opt-in
# MiroFish Firestore-profile activation path: default-disabled, enabled with
# a fake CLI, and a missing-profile activation failure that must never fail
# the other three apps' deploy -- plus `docker compose config --quiet`
# against the real production/mirofish compose files with the profile off
# and on, using a fake mirofish.env outside the repository.
#
# Cases 15-22 (A9b fix rounds 1-2, review P1/P2) additionally cover: an
# inherited COMPOSE_PROFILES=mirofish plus a stale file with MIROFISH_ACTIVATE
# unset; a genuine install failure (RUNTIME_ENV_DIR under a non-directory
# parent); mirofish.env's own prior/new state in deploy rollback
# (remove-if-new, restore-if-prior); a previously-activated-then-disabled
# redeploy; and health-check.sh's mirofish_enabled() selecting purely on
# COMPOSE_PROFILES=mirofish (never a stale file or container state), with
# Cases 16-17 proving service_ok() -- not mirofish_enabled() -- is what
# correctly fails an exited container and passes a healthy one.
#
# Cases 23-24 (fix round 2, review P2) force a genuine (not faked) restore
# failure and remove failure in restore_or_remove_mirofish() via a real
# chmod 0500 on the runtime dir, asserting the error is reported and the
# five SECRET_FILES still roll back regardless.
#
# Cases 25-27 (fix round 3, review P2) additionally cover: a direct
# stop_remove_mirofish_container() check (its own best-effort "compose rm
# -s -f mirofish", both outcomes); a genuine post-install scratch-cleanup
# failure in activate_mirofish() escalating into a full, self-healing
# activation failure instead of exporting COMPOSE_PROFILES over a leftover
# secret-bearing scratch copy; and a process-level, fake-Docker scenario
# combining a real post-Compose health-check failure with rollback's own
# mirofish.env removal also failing, asserting the best-effort
# stop_remove_mirofish_container call actually ran.
#
# Cases 28-31 (whole-branch review reopen) additionally cover the new
# ensure_mirofish_stopped() forward-path gate: a normal disabled redeploy
# after an earlier activation actually stops a stale container (fake
# compose); a failed new activation (missing Firestore profile) still
# stops a stale container (fake compose); a genuine stop-command failure
# FAILS THE WHOLE DEPLOY, process-level, before stage_secrets/deploy_tag
# ever run (fake Docker); and a REAL Docker Compose fixture (dummy busybox
# services, unique disposable project, no real ai-trading images/secrets)
# proving the fix against actual Docker, not just fakes -- see
# task-9-report.md for the real-Compose reproduction this round started
# from (an already-running profile-gated container survives
# `up -d --remove-orphans` alone).
#
# Usage: ai-trading/deploy/ci/test-deploy-firestore.sh
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SH="$SCRIPT_DIR/../production/deploy.sh"
HEALTH_SH="$SCRIPT_DIR/../production/health-check.sh"
COMPOSE_FILE="$SCRIPT_DIR/../production/docker-compose.yml"
MIROFISH_COMPOSE_FILE="$SCRIPT_DIR/../production/docker-compose.mirofish.yml"
[[ -f "$DEPLOY_SH" ]] || { echo "test-deploy-firestore: missing $DEPLOY_SH" >&2; exit 1; }
[[ -f "$HEALTH_SH" ]] || { echo "test-deploy-firestore: missing $HEALTH_SH" >&2; exit 1; }

TEST_ROOT="$(mktemp -d)"
# cleanup is called explicitly at the very end (below) for the two normal
# exit paths, and also registered on EXIT so it still runs for every abnormal
# one (an early `die`/`exit` inside a scenario's subshell, a failed
# assertion, etc.) -- both call sites share the same idempotent body, so
# running it twice on a normal exit is harmless.
cleanup() { rm -rf "$TEST_ROOT"; }
trap cleanup EXIT

FAIL_COUNT=0
CASE_COUNT=0

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "    FAIL: $*" >&2
}

# source_lib: deploy.sh's own function definitions, with its main-flow block
# (everything after the "--- main flow below this line" marker) excluded, so
# sourcing it only loads functions -- render_profiles, stage_secrets,
# rollback, etc. -- without also running a real deploy. IMAGE_TAG must
# already be a valid-looking commit SHA before this is sourced: the one
# top-level validation line above that marker runs immediately on source.
source_lib() {
  awk '/^# --- main flow below this line;/{exit} {print}' "$DEPLOY_SH"
}
LIB_FILE="$TEST_ROOT/deploy-lib.sh"
source_lib >"$LIB_FILE"

# source_health_lib: health-check.sh's own function definitions (same
# marker-based technique as source_lib above), so a case can call
# mirofish_enabled() directly -- with its own COMPOSE_PROFILES and a stubbed
# compose() -- without running health-check.sh's real polling loop or
# touching a real Docker daemon.
source_health_lib() {
  awk '/^# --- main flow below this line;/{exit} {print}' "$HEALTH_SH"
}
HEALTH_LIB_FILE="$TEST_ROOT/health-lib.sh"
source_health_lib >"$HEALTH_LIB_FILE"

# fake_family_config: writes a stand-in family_config.py into DEST that
# implements only what render_profiles() depends on -- `render
# <app>/<profile>... --out-dir DIR`, resolving every requested target before
# writing any file (so FAKE_FC_MISSING_PROFILE can simulate a real "profile
# not found" ConfigError failing closed, before install), then writing
# DIR/<profile>.env (0600) atomically (temp file + rename, like the real
# cmd_render) with deterministic fake content. It also asserts
# FAMILY_CONFIG_CREDENTIALS was passed, matching the real CLI's VPS auth
# path. Never touches gcloud, Firestore, or Secret Manager.
fake_family_config() {
  local dest="$1"
  cat >"$dest" <<'FAKE_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == render ]] || { echo "fake family_config.py: only render is implemented" >&2; exit 2; }
shift
targets=()
out_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir) out_dir="$2"; shift 2 ;;
    *) targets+=("$1"); shift ;;
  esac
done
[[ -n "$out_dir" ]] || { echo "fake family_config.py: render needs --out-dir" >&2; exit 2; }
[[ -n "${FAMILY_CONFIG_CREDENTIALS:-}" ]] || { echo "fake family_config.py: FAMILY_CONFIG_CREDENTIALS not set" >&2; exit 2; }
for target in "${targets[@]}"; do
  if [[ "$target" == "${FAKE_FC_MISSING_PROFILE:-}" ]]; then
    echo "family-config: profile not found: $target" >&2
    exit 1
  fi
done
umask 077
for target in "${targets[@]}"; do
  profile="${target##*/}"
  tmp="$(mktemp "$out_dir/.$profile.env.XXXXXX")"
  if [[ "$profile" == mirofish ]]; then
    # Fake stand-in for the real ai-trading/mirofish profile's two required
    # names (A9b's activate_mirofish() contract) -- fake values only, never
    # real Zep/LLM credentials.
    printf 'ZEP_API_KEY=fake-zep-not-real\nLLM_API_KEY=fake-llm-not-real\n' >"$tmp"
  else
    printf 'FAKE_VALUE=fake-not-real-%s\n' "$profile" >"$tmp"
  fi
  mv -f "$tmp" "$out_dir/$profile.env"
done
FAKE_EOF
  chmod 0700 "$dest"
}

# new_scratch NAME: a fresh, isolated APP_DIR/SECRETS_DIR/ENV_STAGING_DIR
# triple under $TEST_ROOT for one scenario, with a fake family_config.py
# already installed alongside deploy.sh's expected path ($APP_DIR/family_config.py).
new_scratch() {
  local name="$1" base="$TEST_ROOT/$1"
  mkdir -p "$base/app" "$base/secrets" "$base/ci-staging"
  fake_family_config "$base/app/family_config.py"
  printf '%s\n' "$base"
}

# run_scenario NAME: sources the lib (re-validating IMAGE_TAG) and calls
# render_profiles + stage_secrets in one subshell, isolated per scenario so
# each gets its own EXIT trap / RENDER_SRC_DIR / PRIOR_EXISTED state. Prints
# the resolved exit status on stdout as the final line.
run_scenario() {
  local base="$1"
  (
    APP_DIR="$base/app"
    AI_TRADING_SECRETS_DIR="$base/secrets"
    ENV_STAGING_DIR="$base/ci-staging"
    FAMILY_CONFIG_CREDENTIALS="$base/fake-reader-key.json"
    DEPLOY_SH_SKIP_CHOWN=1
    IMAGE_TAG=0000000000000000000000000000000000000000
    export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
    # shellcheck source=/dev/null
    source "$LIB_FILE"
    render_profiles
    stage_secrets
  )
  echo "$?"
}

# run_scenario_mirofish NAME: like run_scenario, but also calls
# activate_mirofish() in the same order main flow uses --
# render_profiles, activate_mirofish, stage_secrets (A9b's opt-in MiroFish
# activation path) -- and additionally sets AI_TRADING_RUNTIME_ENV_DIR to an
# isolated scratch dir under $base, and writes the resolved COMPOSE_PROFILES
# (or the literal string "unset") to $base/compose-profiles.out so a case
# can assert it without parsing deploy.sh's own stdout/stderr. Inherits
# MIROFISH_ACTIVATE/FAKE_FC_MISSING_PROFILE from the caller's exported
# environment, same as run_scenario already does for its own test-only
# knobs. The `|| true` mirrors main flow exactly: a failed/absent MiroFish
# activation must never fail the rest of this scenario.
#
# TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE (test-only, this file's own knob,
# never read by deploy.sh itself): if set, chmod's AI_TRADING_RUNTIME_ENV_DIR
# to that mode right after activate_mirofish returns, before stage_secrets
# runs -- used to inject a *real* later restore/remove failure (review P2)
# into restore_or_remove_mirofish() without a fake knob inside deploy.sh
# itself. Deliberately injected here, inside this already-proven function
# wrapper, rather than in a second hand-rolled top-level `( ... )`: a bare
# top-level subshell whose own first statement is `cmd || true` was found,
# empirically, to stop propagating a later command's failure to a `trap ...
# ERR` armed further down in that same subshell (not true when the same
# body runs as a function's body called normally, as this one is) -- a bash
# quirk, not a deploy.sh bug; routing every scenario through this one
# function avoids it entirely.
run_scenario_mirofish() {
  local base="$1"
  (
    APP_DIR="$base/app"
    AI_TRADING_SECRETS_DIR="$base/secrets"
    ENV_STAGING_DIR="$base/ci-staging"
    AI_TRADING_RUNTIME_ENV_DIR="$base/runtime"
    FAMILY_CONFIG_CREDENTIALS="$base/fake-reader-key.json"
    DEPLOY_SH_SKIP_CHOWN=1
    IMAGE_TAG=0000000000000000000000000000000000000000
    export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR AI_TRADING_RUNTIME_ENV_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
    # shellcheck source=/dev/null
    source "$LIB_FILE"
    render_profiles
    activate_mirofish || true
    if [[ -n "${TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE:-}" ]]; then
      chmod "$TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE" "$AI_TRADING_RUNTIME_ENV_DIR"
    fi
    stage_secrets
    printf '%s\n' "${COMPOSE_PROFILES:-unset}" >"$base/compose-profiles.out"
  )
  echo "$?"
}

echo "=== Case 1 (GREEN): first-time deploy, cloudflared.env staged by CI, four profiles rendered VPS-side ==="
CASE_COUNT=$((CASE_COUNT + 1))
s1="$(new_scratch case1)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s1/ci-staging/cloudflared.env"
status="$(run_scenario "$s1")"
if [[ "$status" != 0 ]]; then
  fail "case1: expected exit 0, got $status"
else
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
    f="$s1/secrets/$name"
    [[ -f "$f" ]] || { fail "case1: missing $f"; continue; }
    [[ "$(stat -f '%p' "$f" 2>/dev/null || stat -c '%a' "$f")" == *600 ]] || fail "case1: $f not mode 600"
  done
  grep -q 'fake-not-real-gateway' "$s1/secrets/auth.env" 2>/dev/null || fail "case1: auth.env missing renamed gateway content"
  [[ -f "$s1/secrets/gateway.env" ]] && fail "case1: gateway.env should have been renamed to auth.env, not left behind"
  grep -q 'fake-tunnel-token' "$s1/secrets/cloudflared.env" 2>/dev/null || fail "case1: cloudflared.env content mismatch"
  shopt -s nullglob
  leftover=("$s1/secrets"/.render-*)
  shopt -u nullglob
  [[ ${#leftover[@]} -eq 0 ]] || fail "case1: root-only render scratch not cleaned: ${leftover[*]}"
fi
echo "    exit=$status"

echo "=== Case 2 (GREEN): redeploy over existing secrets -- new content wins, old content backed up to .previous/ ==="
CASE_COUNT=$((CASE_COUNT + 1))
s2="$(new_scratch case2)"
printf 'TUNNEL_TOKEN=fake-tunnel-token-v2\n' >"$s2/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s2/secrets/$name"
  chmod 0600 "$s2/secrets/$name"
done
status="$(run_scenario "$s2")"
if [[ "$status" != 0 ]]; then
  fail "case2: expected exit 0, got $status"
else
  grep -q 'fake-not-real-tradingagents' "$s2/secrets/tradingagents.env" 2>/dev/null || fail "case2: tradingagents.env not refreshed"
  grep -q 'fake-tunnel-token-v2' "$s2/secrets/cloudflared.env" 2>/dev/null || fail "case2: cloudflared.env not refreshed"
  grep -q 'old-tradingagents.env' "$s2/secrets/.previous/tradingagents.env" 2>/dev/null || fail "case2: .previous backup missing old content"
fi
echo "    exit=$status"

echo "=== Case 3 (RED): missing Firestore profile fails before any install, no partial files, scratch still cleaned ==="
CASE_COUNT=$((CASE_COUNT + 1))
s3="$(new_scratch case3)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s3/ci-staging/cloudflared.env"
export FAKE_FC_MISSING_PROFILE="ai-trading/ai-hedge-fund"
status="$(run_scenario "$s3")"
unset FAKE_FC_MISSING_PROFILE
if [[ "$status" == 0 ]]; then
  fail "case3: expected non-zero exit for a missing profile, got 0"
fi
shopt -s nullglob
installed=("$s3/secrets"/*.env)
leftover=("$s3/secrets"/.render-*)
shopt -u nullglob
[[ ${#installed[@]} -eq 0 ]] || fail "case3: files installed despite missing-profile failure: ${installed[*]}"
[[ ${#leftover[@]} -eq 0 ]] || fail "case3: root-only render scratch not cleaned after render failure: ${leftover[*]}"
echo "    exit=$status"

echo "=== Case 4 (RED): bad CI-staged cloudflared.env (CR byte) fails validation before any install ==="
CASE_COUNT=$((CASE_COUNT + 1))
s4="$(new_scratch case4)"
printf 'TUNNEL_TOKEN=bad\r\n' >"$s4/ci-staging/cloudflared.env"
status="$(run_scenario "$s4")"
if [[ "$status" == 0 ]]; then
  fail "case4: expected non-zero exit for a CR byte in staged cloudflared.env, got 0"
fi
shopt -s nullglob
installed=("$s4/secrets"/*.env)
leftover=("$s4/secrets"/.render-*)
shopt -u nullglob
[[ ${#installed[@]} -eq 0 ]] || fail "case4: files installed despite a validation failure: ${installed[*]}"
[[ ${#leftover[@]} -eq 0 ]] || fail "case4: root-only render scratch not cleaned after a validation failure: ${leftover[*]}"
echo "    exit=$status"

echo "=== Case 5 (RED->rollback): mid-stage install failure on a pre-existing deploy restores every prior file ==="
CASE_COUNT=$((CASE_COUNT + 1))
s5="$(new_scratch case5)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s5/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s5/secrets/$name"
  chmod 0600 "$s5/secrets/$name"
done
export DEPLOY_SH_FAIL_AFTER="vibe-trading.env"
status="$(run_scenario "$s5")"
unset DEPLOY_SH_FAIL_AFTER
if [[ "$status" == 0 ]]; then
  fail "case5: expected non-zero exit for a forced mid-stage failure, got 0"
fi
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s5/secrets/$name" 2>/dev/null || fail "case5: $name not restored to its prior content after rollback"
done
shopt -s nullglob
leftover=("$s5/secrets"/.render-*)
shopt -u nullglob
[[ ${#leftover[@]} -eq 0 ]] || fail "case5: root-only render scratch not cleaned after rollback: ${leftover[*]}"
echo "    exit=$status"

echo "=== Case 6 (RED->rollback): mid-stage failure on a first-time deploy deletes what was just created, leaves nothing partial ==="
CASE_COUNT=$((CASE_COUNT + 1))
s6="$(new_scratch case6)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s6/ci-staging/cloudflared.env"
export DEPLOY_SH_FAIL_AFTER="auth.env"
status="$(run_scenario "$s6")"
unset DEPLOY_SH_FAIL_AFTER
if [[ "$status" == 0 ]]; then
  fail "case6: expected non-zero exit for a forced mid-stage failure, got 0"
fi
shopt -s nullglob
leftover_secrets=("$s6/secrets"/*.env)
leftover_render=("$s6/secrets"/.render-*)
shopt -u nullglob
[[ ${#leftover_secrets[@]} -eq 0 ]] || fail "case6: first-time secret files left behind after rollback: ${leftover_secrets[*]}"
[[ ${#leftover_render[@]} -eq 0 ]] || fail "case6: root-only render scratch not cleaned after rollback: ${leftover_render[*]}"
echo "    exit=$status"

echo "=== Case 7 (GREEN): 'docker compose config' resolves the real production/mirofish compose files against case1's staged auth.env, no real keys ==="
CASE_COUNT=$((CASE_COUNT + 1))
if ! docker compose version >/dev/null 2>&1; then
  echo "    SKIP: docker compose not available in this environment"
else
  compose_out="$TEST_ROOT/case7-config.yml"
  if AI_TRADING_IMAGE_TAG=0000000000000000000000000000000000000000 \
     AI_TRADING_SECRETS_DIR="$s1/secrets" \
     docker compose --project-name ai-trading -f "$COMPOSE_FILE" -f "$MIROFISH_COMPOSE_FILE" config \
       >"$compose_out" 2>"$TEST_ROOT/case7-config.err"; then
    grep -q '0000000000000000000000000000000000000000' "$compose_out" || fail "case7: compose config output missing the fake image tag"
  else
    fail "case7: docker compose config failed: $(cat "$TEST_ROOT/case7-config.err")"
  fi
fi

echo "=== Case 8 (RED, process-level): the real deploy.sh, unsourced, fails closed before Docker/secrets when CI never set ENV_STAGING_DIR ==="
CASE_COUNT=$((CASE_COUNT + 1))
s8="$(new_scratch case8)"
status8=0
# Under `set -e`, a bare `( ... )` whose exit status we only read afterward
# would abort the whole test script on this case's *expected* non-zero exit
# -- the `||` below is what keeps that failure "checked" instead.
(
  APP_DIR="$s8/app"
  AI_TRADING_SECRETS_DIR="$s8/secrets"
  FAMILY_CONFIG_CREDENTIALS="$s8/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=0000000000000000000000000000000000000000
  unset ENV_STAGING_DIR
  export APP_DIR AI_TRADING_SECRETS_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG
  bash "$DEPLOY_SH" >"$s8/stdout.log" 2>"$s8/stderr.log"
) || status8=$?
if [[ "$status8" == 0 ]]; then
  fail "case8: expected non-zero exit when ENV_STAGING_DIR is unset, got 0"
fi
grep -q 'ENV_STAGING_DIR is required' "$s8/stderr.log" 2>/dev/null || fail "case8: missing the required-ENV_STAGING_DIR message: $(cat "$s8/stderr.log" 2>/dev/null)"
shopt -s nullglob
leftover=("$s8/secrets"/*)
shopt -u nullglob
[[ ${#leftover[@]} -eq 0 ]] || fail "case8: a file was created in \$SECRETS_DIR despite failing closed: ${leftover[*]}"
[[ -f "$s8/app/last-good-tag" ]] && fail "case8: last-good-tag written despite failing closed"
echo "    exit=$status8"

echo "=== Case 9 (GREEN, process-level): the real deploy.sh, unsourced, runs end-to-end with a fake Docker and fake root ownership ==="
CASE_COUNT=$((CASE_COUNT + 1))
s9="$(new_scratch case9)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s9/ci-staging/cloudflared.env"
cat >"$s9/app/health-check.sh" <<'HEALTH_EOF'
#!/usr/bin/env bash
exit 0
HEALTH_EOF
chmod +x "$s9/app/health-check.sh"
status9=0
(
  APP_DIR="$s9/app"
  AI_TRADING_SECRETS_DIR="$s9/secrets"
  ENV_STAGING_DIR="$s9/ci-staging"
  FAMILY_CONFIG_CREDENTIALS="$s9/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=1111111111111111111111111111111111111111
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG

  # Fake docker: deploy.sh only ever shells out to `docker compose ...`; no
  # real Docker daemon is contacted anywhere in this case. An exported bash
  # function shim is inherited by the `bash "$DEPLOY_SH"` child process
  # below and takes priority over any real `docker` on PATH. shellcheck
  # cannot see that indirect call (it only analyzes this file, not the child
  # process deploy.sh starts), so it looks unused here -- it is not.
  # shellcheck disable=SC2329
  docker() {
    if [[ "${1:-}" == compose ]]; then
      echo "fake docker $*" >>"$APP_DIR/docker.log"
      return 0
    fi
    command docker "$@"
  }
  export -f docker

  # Fake stat: deploy.sh's post-stage check asks for owner:mode as a GNU
  # `stat -c '%u:%a'` string, which does not exist on this BSD/macOS test
  # machine, and whose *owner* half no non-root test process could ever
  # satisfy anyway -- DEPLOY_SH_SKIP_CHOWN (already test-only, documented at
  # the top of deploy.sh) only skips the chown step, it does not make this
  # process root. This shim reports a fake uid 0 but computes the file's
  # *real* mode through the platform's real stat, so an actual wrong-mode
  # bug is still caught here -- only "owned by root" is faked. Same
  # indirect-call blind spot as the docker shim above.
  # shellcheck disable=SC2329
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      local mode
      mode="$(command stat -f '%Lp' "$3" 2>/dev/null || command stat -c '%a' "$3" 2>/dev/null)"
      printf '0:%s\n' "$mode"
    else
      command stat "$@"
    fi
  }
  export -f stat

  bash "$DEPLOY_SH" >"$s9/stdout.log" 2>"$s9/stderr.log"
) || status9=$?
if [[ "$status9" != 0 ]]; then
  fail "case9: expected exit 0, got $status9: $(cat "$s9/stderr.log" 2>/dev/null)"
else
  [[ -f "$s9/app/last-good-tag" ]] || fail "case9: last-good-tag not written"
  [[ "$(cat "$s9/app/last-good-tag" 2>/dev/null)" == "1111111111111111111111111111111111111111" ]] \
    || fail "case9: last-good-tag has the wrong content"
  # compose()'s own args (--project-name, --env-file, -f ...) sit between
  # "compose" and its subcommand, so match each call's trailing subcommand
  # word instead of a "compose pull"/"compose up" substring that never
  # appears contiguously in the logged command line.
  grep -q 'pull$' "$s9/app/docker.log" 2>/dev/null || fail "case9: fake docker never saw a 'compose ... pull' call"
  grep -q 'up -d' "$s9/app/docker.log" 2>/dev/null || fail "case9: fake docker never saw a 'compose ... up' call"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
    f="$s9/secrets/$name"
    [[ -f "$f" ]] || { fail "case9: missing $f"; continue; }
    real_mode="$(stat -f '%Lp' "$f" 2>/dev/null || stat -c '%a' "$f" 2>/dev/null)"
    [[ "$real_mode" == "600" ]] || fail "case9: $f's real mode is $real_mode, not 600"
  done
  grep -q 'fake-not-real-gateway' "$s9/secrets/auth.env" 2>/dev/null || fail "case9: auth.env missing renamed gateway content"
fi
echo "    exit=$status9"

echo "=== Case 10 (GREEN): MiroFish opt-in path, A9b -- default disabled (MIROFISH_ACTIVATE unset), other apps unaffected ==="
CASE_COUNT=$((CASE_COUNT + 1))
s10="$(new_scratch case10)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s10/ci-staging/cloudflared.env"
status="$(run_scenario_mirofish "$s10")"
if [[ "$status" != 0 ]]; then
  fail "case10: expected exit 0, got $status"
else
  [[ "$(cat "$s10/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case10: COMPOSE_PROFILES should stay unset when MIROFISH_ACTIVATE is unset"
  [[ -e "$s10/runtime/mirofish.env" ]] && fail "case10: mirofish.env should not be created when MIROFISH_ACTIVATE is unset"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
    [[ -f "$s10/secrets/$name" ]] || fail "case10: missing $name -- default-disabled MiroFish path broke an unrelated app"
  done
fi
echo "    exit=$status"

echo "=== Case 11 (GREEN): MiroFish opt-in path, A9b -- MIROFISH_ACTIVATE=1 with a fake CLI renders mirofish.env and enables the Compose profile ==="
CASE_COUNT=$((CASE_COUNT + 1))
s11="$(new_scratch case11)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s11/ci-staging/cloudflared.env"
export MIROFISH_ACTIVATE=1
status="$(run_scenario_mirofish "$s11")"
unset MIROFISH_ACTIVATE
if [[ "$status" != 0 ]]; then
  fail "case11: expected exit 0, got $status"
else
  [[ "$(cat "$s11/compose-profiles.out" 2>/dev/null)" == mirofish ]] || fail "case11: COMPOSE_PROFILES should be mirofish when activation succeeds"
  f="$s11/runtime/mirofish.env"
  [[ -f "$f" ]] || fail "case11: missing $f"
  [[ "$(stat -f '%Lp' "$f" 2>/dev/null || stat -c '%a' "$f" 2>/dev/null)" == "600" ]] || fail "case11: $f not mode 600"
  grep -q '^ZEP_API_KEY=' "$f" 2>/dev/null || fail "case11: mirofish.env missing ZEP_API_KEY"
  grep -q '^LLM_API_KEY=' "$f" 2>/dev/null || fail "case11: mirofish.env missing LLM_API_KEY"
  shopt -s nullglob
  leftover=("$s11/runtime"/.mirofish-render-*)
  shopt -u nullglob
  [[ ${#leftover[@]} -eq 0 ]] || fail "case11: root-only mirofish render scratch not cleaned: ${leftover[*]}"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
    [[ -f "$s11/secrets/$name" ]] || fail "case11: missing $name"
  done
fi
echo "    exit=$status"

echo "=== Case 12 (GREEN overall, RED for MiroFish only): A9b -- missing ai-trading/mirofish profile leaves MiroFish disabled but never fails the other three apps' deploy ==="
CASE_COUNT=$((CASE_COUNT + 1))
s12="$(new_scratch case12)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s12/ci-staging/cloudflared.env"
export MIROFISH_ACTIVATE=1
export FAKE_FC_MISSING_PROFILE="ai-trading/mirofish"
status="$(run_scenario_mirofish "$s12")"
unset MIROFISH_ACTIVATE FAKE_FC_MISSING_PROFILE
if [[ "$status" != 0 ]]; then
  fail "case12: expected overall exit 0 (a MiroFish activation failure must not fail the deploy), got $status"
else
  [[ "$(cat "$s12/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case12: COMPOSE_PROFILES should stay unset when the ai-trading/mirofish profile is missing"
  [[ -e "$s12/runtime/mirofish.env" ]] && fail "case12: mirofish.env should not exist after a missing-profile activation failure"
  shopt -s nullglob
  leftover=("$s12/runtime"/.mirofish-render-*)
  shopt -u nullglob
  [[ ${#leftover[@]} -eq 0 ]] || fail "case12: root-only mirofish render scratch not cleaned after a render failure: ${leftover[*]}"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
    [[ -f "$s12/secrets/$name" ]] || fail "case12: missing $name -- a MiroFish activation failure broke an unrelated app's deploy"
  done
fi
echo "    exit=$status"

echo "=== Case 13 (GREEN): 'docker compose ... config --quiet' with MiroFish's profile OFF (no mirofish.env, no COMPOSE_PROFILES) -- brief Task 9 Step 3 ==="
CASE_COUNT=$((CASE_COUNT + 1))
if ! docker compose version >/dev/null 2>&1; then
  echo "    SKIP: docker compose not available in this environment"
else
  if AI_TRADING_IMAGE_TAG=0000000000000000000000000000000000000000 \
     AI_TRADING_SECRETS_DIR="$s1/secrets" \
     AI_TRADING_RUNTIME_ENV_DIR="$TEST_ROOT/case13-runtime-absent" \
     docker compose --project-name ai-trading -f "$COMPOSE_FILE" -f "$MIROFISH_COMPOSE_FILE" config --quiet \
       >"$TEST_ROOT/case13.out" 2>"$TEST_ROOT/case13.err"; then
    :
  else
    fail "case13: docker compose config --quiet (profile off) failed: $(cat "$TEST_ROOT/case13.err")"
  fi
fi
echo "    (profile off checked)"

echo "=== Case 14 (GREEN): 'docker compose ... config --quiet' with MiroFish's profile ON and a fake mirofish.env outside the repo -- brief Task 9 Step 3 ==="
CASE_COUNT=$((CASE_COUNT + 1))
if ! docker compose version >/dev/null 2>&1; then
  echo "    SKIP: docker compose not available in this environment"
else
  runtime14="$TEST_ROOT/case14-runtime"
  mkdir -p "$runtime14"
  printf 'ZEP_API_KEY=fake-zep-not-real\nLLM_API_KEY=fake-llm-not-real\n' >"$runtime14/mirofish.env"
  chmod 0600 "$runtime14/mirofish.env"
  if COMPOSE_PROFILES=mirofish \
     AI_TRADING_IMAGE_TAG=0000000000000000000000000000000000000000 \
     AI_TRADING_SECRETS_DIR="$s1/secrets" \
     AI_TRADING_RUNTIME_ENV_DIR="$runtime14" \
     docker compose --project-name ai-trading -f "$COMPOSE_FILE" -f "$MIROFISH_COMPOSE_FILE" config --quiet \
       >"$TEST_ROOT/case14.out" 2>"$TEST_ROOT/case14.err"; then
    :
  else
    fail "case14: docker compose config --quiet (profile on) failed: $(cat "$TEST_ROOT/case14.err")"
  fi
fi
echo "    (profile on checked)"

echo "=== Case 15 (GREEN): health-check mirofish_enabled() -- disabled purely on COMPOSE_PROFILES being unset; no compose/docker call happens at all (review P1 round 2: container state is service_ok's job, not mirofish_enabled's) ==="
CASE_COUNT=$((CASE_COUNT + 1))
result15="$(
  unset COMPOSE_PROFILES
  # shellcheck source=/dev/null
  source "$HEALTH_LIB_FILE"
  mirofish_enabled && echo ENABLED || echo DISABLED
)"
[[ "$result15" == DISABLED ]] || fail "case15: expected DISABLED, got $result15"
echo "    result=$result15"

echo "=== Case 16 (GREEN, review P1 round 2 regression test): COMPOSE_PROFILES=mirofish with an EXITED mirofish container -- mirofish_enabled() still includes it, and service_ok() correctly FAILS instead of the old code silently excluding it ==="
CASE_COUNT=$((CASE_COUNT + 1))
result16="$(
  # Scoped to this command-substitution subshell only, by design.
  # shellcheck disable=SC2030,SC2031
  export COMPOSE_PROFILES=mirofish
  # shellcheck source=/dev/null
  source "$HEALTH_LIB_FILE"
  # Stub compose()/docker(): service_ok() calls them indirectly; shellcheck
  # only analyzes this file, not the sourced lib, so they look unused here.
  # shellcheck disable=SC2329
  compose() { echo fake-mirofish-container-id; }
  # shellcheck disable=SC2329
  docker() {
    if [[ "${1:-}" == inspect ]]; then
      echo exited
    else
      command docker "$@"
    fi
  }
  if mirofish_enabled; then
    service_ok mirofish && echo ENABLED-HEALTHY || echo ENABLED-FAILING
  else
    echo DISABLED
  fi
)"
[[ "$result16" == ENABLED-FAILING ]] || fail "case16: expected ENABLED-FAILING (profile set but container exited must fail service_ok, not be silently excluded), got $result16"
echo "    result=$result16"

echo "=== Case 17 (GREEN): COMPOSE_PROFILES=mirofish with a RUNNING, healthy mirofish container -- mirofish_enabled() includes it and service_ok() correctly passes ==="
CASE_COUNT=$((CASE_COUNT + 1))
result17="$(
  # Scoped to this command-substitution subshell only, by design.
  # shellcheck disable=SC2030,SC2031
  export COMPOSE_PROFILES=mirofish
  # shellcheck source=/dev/null
  source "$HEALTH_LIB_FILE"
  # shellcheck disable=SC2329
  compose() { echo fake-mirofish-container-id; }
  # shellcheck disable=SC2329
  docker() {
    if [[ "${1:-}" == inspect ]]; then
      case "${3:-}" in
        *State.Health*) echo healthy ;;
        *) echo running ;;
      esac
    else
      command docker "$@"
    fi
  }
  if mirofish_enabled; then
    service_ok mirofish && echo ENABLED-HEALTHY || echo ENABLED-FAILING
  else
    echo DISABLED
  fi
)"
[[ "$result17" == ENABLED-HEALTHY ]] || fail "case17: expected ENABLED-HEALTHY, got $result17"
echo "    result=$result17"

echo "=== Case 18 (GREEN): MIROFISH_ACTIVATE unset with an inherited COMPOSE_PROFILES=mirofish and a stale mirofish.env -- no bypass (review P1), stale file untouched, other apps deploy fine ==="
CASE_COUNT=$((CASE_COUNT + 1))
s18="$(new_scratch case18)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s18/ci-staging/cloudflared.env"
mkdir -p "$s18/runtime"
printf 'STALE_VALUE=from-a-prior-run\n' >"$s18/runtime/mirofish.env"
chmod 0600 "$s18/runtime/mirofish.env"
# Deliberately inherited by run_scenario_mirofish's real `(...)` subshell below
# (simulating a leftover/CI export) -- unset again right after, like the other
# test-only knobs in this file.
# shellcheck disable=SC2031
export COMPOSE_PROFILES=mirofish
status="$(run_scenario_mirofish "$s18")"
unset COMPOSE_PROFILES
if [[ "$status" != 0 ]]; then
  fail "case18: expected exit 0, got $status"
else
  [[ "$(cat "$s18/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case18: an inherited COMPOSE_PROFILES=mirofish must not survive when MIROFISH_ACTIVATE is unset"
  grep -q 'STALE_VALUE=from-a-prior-run' "$s18/runtime/mirofish.env" 2>/dev/null || fail "case18: stale mirofish.env must stay untouched when MIROFISH_ACTIVATE is unset"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
    [[ -f "$s18/secrets/$name" ]] || fail "case18: missing $name"
  done
fi
echo "    exit=$status"

echo "=== Case 19 (GREEN overall): a genuine MiroFish install failure (runtime path already exists as a plain file) leaves MiroFish disabled without failing the other three apps' deploy (review P1: explicit checks, not errexit-under-||) ==="
CASE_COUNT=$((CASE_COUNT + 1))
s19="$(new_scratch case19)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s19/ci-staging/cloudflared.env"
touch "$s19/runtime"
export MIROFISH_ACTIVATE=1
status="$(run_scenario_mirofish "$s19")"
unset MIROFISH_ACTIVATE
if [[ "$status" != 0 ]]; then
  fail "case19: expected exit 0 (an install failure must not fail the deploy), got $status"
else
  [[ "$(cat "$s19/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case19: COMPOSE_PROFILES should stay unset after an install failure"
  [[ -f "$s19/runtime" ]] || fail "case19: the pre-existing plain file at the runtime path should be left untouched, not replaced"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
    [[ -f "$s19/secrets/$name" ]] || fail "case19: missing $name -- an install failure broke an unrelated app's deploy"
  done
fi
echo "    exit=$status"

echo "=== Case 20 (RED->rollback): first-time MiroFish activation + a later stage_secrets failure REMOVES the just-installed mirofish.env (review P2: runtime env now in rollback) ==="
CASE_COUNT=$((CASE_COUNT + 1))
s20="$(new_scratch case20)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s20/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s20/secrets/$name"
  chmod 0600 "$s20/secrets/$name"
done
export MIROFISH_ACTIVATE=1
export DEPLOY_SH_FAIL_AFTER="vibe-trading.env"
status="$(run_scenario_mirofish "$s20")"
unset MIROFISH_ACTIVATE DEPLOY_SH_FAIL_AFTER
if [[ "$status" == 0 ]]; then
  fail "case20: expected non-zero exit for a forced mid-stage failure, got 0"
fi
[[ -e "$s20/runtime/mirofish.env" ]] && fail "case20: mirofish.env had no prior version -- rollback should have removed it, not left it behind"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s20/secrets/$name" 2>/dev/null || fail "case20: $name not restored to its prior content after rollback"
done
echo "    exit=$status"

echo "=== Case 21 (RED->rollback): MiroFish already active with PRIOR content; this run re-activates with NEW content, then a later stage_secrets failure RESTORES the prior mirofish.env, not the new render (review P2) ==="
CASE_COUNT=$((CASE_COUNT + 1))
s21="$(new_scratch case21)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s21/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s21/secrets/$name"
  chmod 0600 "$s21/secrets/$name"
done
mkdir -p "$s21/runtime"
printf 'ZEP_API_KEY=prior-zep\nLLM_API_KEY=prior-llm\n' >"$s21/runtime/mirofish.env"
chmod 0600 "$s21/runtime/mirofish.env"
export MIROFISH_ACTIVATE=1
export DEPLOY_SH_FAIL_AFTER="vibe-trading.env"
status="$(run_scenario_mirofish "$s21")"
unset MIROFISH_ACTIVATE DEPLOY_SH_FAIL_AFTER
if [[ "$status" == 0 ]]; then
  fail "case21: expected non-zero exit for a forced mid-stage failure, got 0"
fi
grep -q 'ZEP_API_KEY=prior-zep' "$s21/runtime/mirofish.env" 2>/dev/null || fail "case21: mirofish.env not restored to its PRIOR content after rollback"
grep -q 'LLM_API_KEY=prior-llm' "$s21/runtime/mirofish.env" 2>/dev/null || fail "case21: mirofish.env not restored to its PRIOR content after rollback"
grep -q 'fake-zep-not-real' "$s21/runtime/mirofish.env" 2>/dev/null && fail "case21: mirofish.env still holds this run's NEW (fake) render after rollback"
[[ "$(stat -f '%Lp' "$s21/runtime/mirofish.env" 2>/dev/null || stat -c '%a' "$s21/runtime/mirofish.env" 2>/dev/null)" == "600" ]] || fail "case21: restored mirofish.env is not mode 600"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s21/secrets/$name" 2>/dev/null || fail "case21: $name not restored to its prior content after rollback"
done
echo "    exit=$status"

echo "=== Case 22 (GREEN x2): MiroFish activated once, then a normal disabled redeploy over the same runtime dir still passes, stale file untouched (the exact 'later normal disabled deploy with stale file must still pass' requirement) ==="
CASE_COUNT=$((CASE_COUNT + 1))
s22="$(new_scratch case22)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s22/ci-staging/cloudflared.env"
export MIROFISH_ACTIVATE=1
status22a="$(run_scenario_mirofish "$s22")"
unset MIROFISH_ACTIVATE
if [[ "$status22a" != 0 ]]; then
  fail "case22: first (enabled) deploy expected exit 0, got $status22a"
elif [[ "$(cat "$s22/compose-profiles.out" 2>/dev/null)" != mirofish ]]; then
  fail "case22: first (enabled) deploy should have set COMPOSE_PROFILES=mirofish"
fi
first_content="$(cat "$s22/runtime/mirofish.env" 2>/dev/null || true)"
printf 'TUNNEL_TOKEN=fake-tunnel-token-v2\n' >"$s22/ci-staging/cloudflared.env"
status22b="$(run_scenario_mirofish "$s22")"
if [[ "$status22b" != 0 ]]; then
  fail "case22: second (disabled) redeploy expected exit 0, got $status22b"
else
  [[ "$(cat "$s22/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case22: second (disabled) redeploy must not carry over COMPOSE_PROFILES=mirofish"
  [[ "$(cat "$s22/runtime/mirofish.env" 2>/dev/null)" == "$first_content" ]] || fail "case22: a disabled redeploy must not touch the stale mirofish.env from the earlier activation"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
    [[ -f "$s22/secrets/$name" ]] || fail "case22: missing $name on the disabled redeploy"
  done
fi
echo "    exit1=$status22a exit2=$status22b"

echo "=== Case 23 (RED->rollback, review P2 injected failure): restore_or_remove_mirofish's RESTORE path fails for real (runtime dir made read-only) -- rollback reports the error and leaves MiroFish disabled instead of silently claiming success ==="
CASE_COUNT=$((CASE_COUNT + 1))
s23="$(new_scratch case23)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s23/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s23/secrets/$name"
  chmod 0600 "$s23/secrets/$name"
done
mkdir -p "$s23/runtime"
printf 'ZEP_API_KEY=prior-zep\nLLM_API_KEY=prior-llm\n' >"$s23/runtime/mirofish.env"
chmod 0600 "$s23/runtime/mirofish.env"
stderr23="$s23/stderr.log"
export MIROFISH_ACTIVATE=1
export DEPLOY_SH_FAIL_AFTER="vibe-trading.env"
# Make the restore path's own install_secret_file fail for real: no write
# permission on the directory it needs to mktemp a new temp file into.
# Reading the existing .previous/mirofish.env backup still works (r-x).
export TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE=0500
status="$(run_scenario_mirofish "$s23" 2>"$stderr23")"
unset MIROFISH_ACTIVATE DEPLOY_SH_FAIL_AFTER TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE
chmod 0700 "$s23/runtime" 2>/dev/null || true
if [[ "$status" == 0 ]]; then
  fail "case23: expected non-zero exit for a forced mid-stage failure, got 0"
fi
grep -q 'failed to restore .*mirofish.env' "$stderr23" 2>/dev/null || fail "case23: rollback must report the restore failure, not stay silent: $(cat "$stderr23" 2>/dev/null)"
grep -qE 'prior-(zep|llm)' "$stderr23" 2>/dev/null && fail "case23: rollback error output must never contain a key's value"
grep -q 'fake-zep-not-real' "$s23/runtime/mirofish.env" 2>/dev/null || fail "case23: a genuinely failed restore must leave the file exactly as activate_mirofish wrote it, not partially modified"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s23/secrets/$name" 2>/dev/null || fail "case23: $name not restored to its prior content after rollback"
done
echo "    exit=$status"

echo "=== Case 24 (RED->rollback, review P2 injected failure): restore_or_remove_mirofish's REMOVE path fails for real (runtime dir made read-only) -- rollback reports the error and leaves MiroFish disabled instead of silently claiming success ==="
CASE_COUNT=$((CASE_COUNT + 1))
s24="$(new_scratch case24)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s24/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s24/secrets/$name"
  chmod 0600 "$s24/secrets/$name"
done
stderr24="$s24/stderr.log"
export MIROFISH_ACTIVATE=1
export DEPLOY_SH_FAIL_AFTER="vibe-trading.env"
# Make the remove path's own `rm -f` fail for real: no write permission on
# the directory it needs to unlink mirofish.env from.
export TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE=0500
status="$(run_scenario_mirofish "$s24" 2>"$stderr24")"
unset MIROFISH_ACTIVATE DEPLOY_SH_FAIL_AFTER TEST_CHMOD_RUNTIME_DIR_AFTER_ACTIVATE
chmod 0700 "$s24/runtime" 2>/dev/null || true
if [[ "$status" == 0 ]]; then
  fail "case24: expected non-zero exit for a forced mid-stage failure, got 0"
fi
grep -q 'failed to remove .*mirofish.env' "$stderr24" 2>/dev/null || fail "case24: rollback must report the remove failure, not stay silent: $(cat "$stderr24" 2>/dev/null)"
[[ -f "$s24/runtime/mirofish.env" ]] || fail "case24: the file should still exist -- rm genuinely failed, it must not have vanished some other way"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s24/secrets/$name" 2>/dev/null || fail "case24: $name not restored to its prior content after rollback"
done
echo "    exit=$status"

echo "=== Case 25 (GREEN x2, review P2 round 3): stop_remove_mirofish_container() -- best-effort 'compose rm -s -f mirofish', both outcomes checked and reported, never raises ==="
CASE_COUNT=$((CASE_COUNT + 1))
err25a="$TEST_ROOT/case25a.err"
result25a="$(
  IMAGE_TAG=0000000000000000000000000000000000000000
  export IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  # shellcheck disable=SC2329
  compose() { return 0; }
  (stop_remove_mirofish_container && echo OK || echo FAILED) 2>"$err25a"
)"
[[ "$result25a" == OK ]] || fail "case25a: expected OK when compose succeeds, got $result25a"
[[ -s "$err25a" ]] && fail "case25a: no error should be logged when compose succeeds: $(cat "$err25a")"
echo "    result=$result25a"

err25b="$TEST_ROOT/case25b.err"
result25b="$(
  IMAGE_TAG=0000000000000000000000000000000000000000
  export IMAGE_TAG
  # shellcheck source=/dev/null
  source "$LIB_FILE"
  # shellcheck disable=SC2329
  compose() { return 1; }
  (stop_remove_mirofish_container && echo OK || echo FAILED) 2>"$err25b"
)"
[[ "$result25b" == FAILED ]] || fail "case25b: expected FAILED when compose fails, got $result25b"
grep -q 'best-effort stop/remove' "$err25b" 2>/dev/null || fail "case25b: expected a best-effort stop/remove failure message: $(cat "$err25b" 2>/dev/null)"
echo "    result=$result25b"

echo "=== Case 26 (GREEN overall, review P2 round 3): a genuine post-install scratch-cleanup failure escalates into a full activation failure and self-heals -- never exports COMPOSE_PROFILES over a leftover secret-bearing scratch copy ==="
CASE_COUNT=$((CASE_COUNT + 1))
s26="$(new_scratch case26)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s26/ci-staging/cloudflared.env"
export MIROFISH_ACTIVATE=1
export DEPLOY_SH_MIROFISH_CHMOD_SCRATCH_AFTER_INSTALL=0500
status="$(run_scenario_mirofish "$s26" 2>"$s26/stderr.log")"
unset MIROFISH_ACTIVATE DEPLOY_SH_MIROFISH_CHMOD_SCRATCH_AFTER_INSTALL
# A leftover read-only scratch dir from the forced failure would otherwise
# block this script's own final cleanup() -- fix it up regardless of outcome.
chmod -R 0700 "$s26/runtime" 2>/dev/null || true
if [[ "$status" != 0 ]]; then
  fail "case26: expected exit 0 (a MiroFish activation failure must not fail the deploy), got $status"
else
  [[ "$(cat "$s26/compose-profiles.out" 2>/dev/null)" == unset ]] || fail "case26: COMPOSE_PROFILES should stay unset after a post-install cleanup failure"
  [[ -e "$s26/runtime/mirofish.env" ]] && fail "case26: self-heal should have removed the newly-installed mirofish.env (no prior version existed)"
  grep -q 'post-install cleanup failed' "$s26/stderr.log" 2>/dev/null || fail "case26: expected the post-install cleanup failure to be logged: $(cat "$s26/stderr.log" 2>/dev/null)"
  grep -q 'failed to remove render scratch' "$s26/stderr.log" 2>/dev/null || fail "case26: expected cleanup_mirofish_scratch's own path-only error to be logged"
  grep -qE 'ZEP_API_KEY=|LLM_API_KEY=|fake-zep-not-real|fake-llm-not-real' "$s26/stderr.log" 2>/dev/null && fail "case26: cleanup/self-heal error output must never contain a key or its value"
  shopt -s nullglob
  leftover_scratch=("$s26/runtime"/.mirofish-render-*)
  shopt -u nullglob
  [[ ${#leftover_scratch[@]} -gt 0 ]] || fail "case26: expected the render scratch directory to still be present on disk (sanity check that cleanup genuinely failed, not skipped)"
  for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
    [[ -f "$s26/secrets/$name" ]] || fail "case26: missing $name -- a MiroFish cleanup failure broke an unrelated app's deploy"
  done
fi
echo "    exit=$status"

echo "=== Case 27 (RED->rollback, review P2 round 3, process-level, fake Docker): post-deploy health-check failure after a successful MiroFish activation, PLUS rollback's own mirofish.env removal failing -- best-effort stop_remove_mirofish_container is attempted and logged, and the other three apps still roll back correctly ==="
CASE_COUNT=$((CASE_COUNT + 1))
s27="$(new_scratch case27)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s27/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s27/secrets/$name"
  chmod 0600 "$s27/secrets/$name"
done
# A fake health-check.sh standing in for the real one (same technique Case 9
# already uses): simulates a post-Compose health failure, and -- as this
# case's own controlled precondition -- makes the runtime dir read-only so
# the rollback that follows hits a REAL (not faked) mirofish.env removal
# failure, exercising "rollback cannot restore/delete mirofish.env after a
# post-Compose/health failure" end to end.
cat >"$s27/app/health-check.sh" <<'HEALTH_EOF'
#!/usr/bin/env bash
chmod 0500 "${AI_TRADING_RUNTIME_ENV_DIR:-/run/family-app/ai-trading}"
exit 1
HEALTH_EOF
chmod +x "$s27/app/health-check.sh"
status27=0
(
  APP_DIR="$s27/app"
  AI_TRADING_SECRETS_DIR="$s27/secrets"
  ENV_STAGING_DIR="$s27/ci-staging"
  AI_TRADING_RUNTIME_ENV_DIR="$s27/runtime"
  FAMILY_CONFIG_CREDENTIALS="$s27/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=3333333333333333333333333333333333333333
  MIROFISH_ACTIVATE=1
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR AI_TRADING_RUNTIME_ENV_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG MIROFISH_ACTIVATE

  # Fake docker: deploy.sh/health-check.sh only ever shell out to `docker
  # compose ...`; no real Docker daemon is contacted anywhere in this case.
  # Logs every compose subcommand (pull/up/rm) so this case can assert the
  # best-effort stop_remove_mirofish_container call actually ran.
  # shellcheck disable=SC2329
  docker() {
    if [[ "${1:-}" == compose ]]; then
      echo "fake docker $*" >>"$APP_DIR/docker.log"
      return 0
    fi
    command docker "$@"
  }
  export -f docker

  # Fake stat: same BSD/macOS-vs-GNU shim Case 9 already documents and uses.
  # shellcheck disable=SC2329
  stat() {
    if [[ "${1:-}" == -c && "${2:-}" == '%u:%a' ]]; then
      local mode
      mode="$(command stat -f '%Lp' "$3" 2>/dev/null || command stat -c '%a' "$3" 2>/dev/null)"
      printf '0:%s\n' "$mode"
    else
      command stat "$@"
    fi
  }
  export -f stat

  bash "$DEPLOY_SH" >"$s27/stdout.log" 2>"$s27/stderr.log"
) || status27=$?
chmod -R 0700 "$s27/runtime" 2>/dev/null || true
if [[ "$status27" == 0 ]]; then
  fail "case27: expected non-zero exit (a real post-Compose health-check failure), got 0"
fi
grep -q 'ai-trading/mirofish profile rendered' "$s27/stderr.log" 2>/dev/null || fail "case27: MiroFish should have activated successfully before the health-check failure: $(cat "$s27/stderr.log" 2>/dev/null)"
grep -q 'rollback: failed to remove' "$s27/stderr.log" 2>/dev/null || fail "case27: expected rollback's own mirofish.env removal to fail and be reported"
grep -q 'rm -s -f mirofish' "$s27/app/docker.log" 2>/dev/null || fail "case27: expected the best-effort stop_remove_mirofish_container call ('compose rm -s -f mirofish') to have actually run: $(cat "$s27/app/docker.log" 2>/dev/null)"
grep -qE 'ZEP_API_KEY=|LLM_API_KEY=|fake-zep-not-real|fake-llm-not-real' "$s27/stderr.log" 2>/dev/null && fail "case27: rollback error output must never contain a key or its value"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s27/secrets/$name" 2>/dev/null || fail "case27: $name not restored to its prior content after rollback -- a MiroFish-specific rollback failure must not break the other three apps"
done
echo "    exit=$status27"

echo "=== Case 28 (GREEN, whole-branch review reopen): ensure_mirofish_stopped() -- a normal disabled redeploy after an earlier activation explicitly stops the stale container, not just unsets the profile ==="
CASE_COUNT=$((CASE_COUNT + 1))
s28="$(new_scratch case28)"
marker28="$TEST_ROOT/case28-container-marker"
touch "$marker28"
err28="$TEST_ROOT/case28.err"
result28="$(
  (
    IMAGE_TAG=0000000000000000000000000000000000000000
    APP_DIR="$s28/app"
    export IMAGE_TAG APP_DIR
    # shellcheck source=/dev/null
    source "$LIB_FILE"
    # Fake compose(): simulates a real Docker Compose project where the
    # mirofish service's container still exists (marker file present)
    # until explicitly stopped/removed. shellcheck only analyzes this
    # file, not the sourced lib that calls it, so it looks unused here.
    # shellcheck disable=SC2329
    compose() {
      case "$*" in
        *"rm -s -f mirofish"*)
          echo "fake compose $*" >>"$APP_DIR/docker.log"
          rm -f "$marker28"
          return 0
          ;;
        *"ps -q mirofish"*)
          [[ -f "$marker28" ]] && echo fake-mirofish-container-id
          return 0
          ;;
        *) return 0 ;;
      esac
    }
    activate_mirofish || true
    ensure_mirofish_stopped
    echo DEPLOY_PROCEEDED
  ) 2>"$err28"
)"
status28=$?
[[ "$status28" == 0 ]] || fail "case28: expected exit 0, got $status28: $(cat "$err28" 2>/dev/null)"
echo "$result28" | grep -q DEPLOY_PROCEEDED || fail "case28: expected ensure_mirofish_stopped to succeed and let the deploy proceed"
[[ -f "$marker28" ]] && fail "case28: the stale container marker should have been removed by the stop/remove call"
grep -q 'rm -s -f mirofish' "$s28/app/docker.log" 2>/dev/null || fail "case28: expected the stop/remove call to actually run: $(cat "$s28/app/docker.log" 2>/dev/null)"
echo "    exit=$status28"

echo "=== Case 29 (GREEN, whole-branch review reopen): ensure_mirofish_stopped() -- a FAILED new activation (missing Firestore profile) still explicitly stops a stale container left by an earlier successful activation ==="
CASE_COUNT=$((CASE_COUNT + 1))
s29="$(new_scratch case29)"
marker29="$TEST_ROOT/case29-container-marker"
touch "$marker29"
err29="$TEST_ROOT/case29.err"
result29="$(
  (
    IMAGE_TAG=0000000000000000000000000000000000000000
    APP_DIR="$s29/app"
    AI_TRADING_RUNTIME_ENV_DIR="$s29/runtime"
    FAMILY_CONFIG_CREDENTIALS="$s29/fake-reader-key.json"
    MIROFISH_ACTIVATE=1
    FAKE_FC_MISSING_PROFILE="ai-trading/mirofish"
    export IMAGE_TAG APP_DIR AI_TRADING_RUNTIME_ENV_DIR FAMILY_CONFIG_CREDENTIALS MIROFISH_ACTIVATE FAKE_FC_MISSING_PROFILE
    # shellcheck source=/dev/null
    source "$LIB_FILE"
    # shellcheck disable=SC2329
    compose() {
      case "$*" in
        *"rm -s -f mirofish"*)
          echo "fake compose $*" >>"$APP_DIR/docker.log"
          rm -f "$marker29"
          return 0
          ;;
        *"ps -q mirofish"*)
          [[ -f "$marker29" ]] && echo fake-mirofish-container-id
          return 0
          ;;
        *) return 0 ;;
      esac
    }
    activate_mirofish || true
    ensure_mirofish_stopped
    echo DEPLOY_PROCEEDED
  ) 2>"$err29"
)"
status29=$?
[[ "$status29" == 0 ]] || fail "case29: expected exit 0, got $status29: $(cat "$err29" 2>/dev/null)"
echo "$result29" | grep -q DEPLOY_PROCEEDED || fail "case29: expected ensure_mirofish_stopped to succeed and let the deploy proceed"
[[ -f "$marker29" ]] && fail "case29: the stale container marker should have been removed by the stop/remove call"
grep -q 'rm -s -f mirofish' "$s29/app/docker.log" 2>/dev/null || fail "case29: expected the stop/remove call to actually run: $(cat "$s29/app/docker.log" 2>/dev/null)"
grep -q 'render of ai-trading/mirofish failed' "$err29" 2>/dev/null || fail "case29: expected the failed activation itself to also be logged: $(cat "$err29" 2>/dev/null)"
echo "    exit=$status29"

echo "=== Case 30 (RED, process-level, whole-branch review reopen): a genuine stop-command failure FAILS THE DEPLOY before stage_secrets/deploy_tag ever run -- the previously-deployed tag's apps are left completely untouched ==="
CASE_COUNT=$((CASE_COUNT + 1))
s30="$(new_scratch case30)"
printf 'TUNNEL_TOKEN=fake-tunnel-token\n' >"$s30/ci-staging/cloudflared.env"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  printf 'OLD_VALUE=old-%s\n' "$name" >"$s30/secrets/$name"
  chmod 0600 "$s30/secrets/$name"
done
status30=0
(
  APP_DIR="$s30/app"
  AI_TRADING_SECRETS_DIR="$s30/secrets"
  ENV_STAGING_DIR="$s30/ci-staging"
  AI_TRADING_RUNTIME_ENV_DIR="$s30/runtime"
  FAMILY_CONFIG_CREDENTIALS="$s30/fake-reader-key.json"
  DEPLOY_SH_SKIP_CHOWN=1
  IMAGE_TAG=4444444444444444444444444444444444444444
  export APP_DIR AI_TRADING_SECRETS_DIR ENV_STAGING_DIR AI_TRADING_RUNTIME_ENV_DIR FAMILY_CONFIG_CREDENTIALS DEPLOY_SH_SKIP_CHOWN IMAGE_TAG

  # Fake docker: every compose subcommand is logged; 'rm -s -f mirofish'
  # (the stop/remove call ensure_mirofish_stopped makes) always fails here,
  # simulating a genuine Docker/daemon problem. MIROFISH_ACTIVATE stays
  # unset (the normal disabled path) -- this case's own controlled
  # precondition stands in for "an earlier activation left a container
  # running that this stop attempt cannot clear."
  # shellcheck disable=SC2329
  docker() {
    if [[ "${1:-}" == compose ]]; then
      echo "fake docker $*" >>"$APP_DIR/docker.log"
      case "$*" in
        *"rm -s -f mirofish"*) return 1 ;;
        *"ps -q mirofish"*)
          echo fake-mirofish-container-id
          return 0
          ;;
        *) return 0 ;;
      esac
    fi
    command docker "$@"
  }
  export -f docker

  bash "$DEPLOY_SH" >"$s30/stdout.log" 2>"$s30/stderr.log"
) || status30=$?
if [[ "$status30" == 0 ]]; then
  fail "case30: expected non-zero exit (a genuine stop-command failure must fail the deploy), got 0"
fi
grep -q 'failed to stop/remove an existing mirofish container; aborting this deploy' "$s30/stderr.log" 2>/dev/null || fail "case30: expected the specific abort message: $(cat "$s30/stderr.log" 2>/dev/null)"
grep -q 'rm -s -f mirofish' "$s30/app/docker.log" 2>/dev/null || fail "case30: expected the stop attempt to have actually run before failing: $(cat "$s30/app/docker.log" 2>/dev/null)"
grep -qE ' pull$| up -d' "$s30/app/docker.log" 2>/dev/null && fail "case30: deploy_tag must never run -- found a pull/up call: $(cat "$s30/app/docker.log")"
for name in tradingagents.env ai-hedge-fund.env vibe-trading.env auth.env cloudflared.env; do
  grep -q "old-$name" "$s30/secrets/$name" 2>/dev/null || fail "case30: $name must stay completely untouched -- stage_secrets must never have run"
done
[[ -f "$s30/app/last-good-tag" ]] && fail "case30: last-good-tag must never be written -- this deploy must abort before completing"
echo "    exit=$status30"

echo "=== Case 31 (GREEN, REAL Docker Compose fixture, whole-branch review reopen): ensure_mirofish_stopped() against a real disposable Compose project -- dummy busybox services, unique project name under a temp scratch dir, no real ai-trading images/secrets, no paid provider ==="
CASE_COUNT=$((CASE_COUNT + 1))
if ! docker compose version >/dev/null 2>&1; then
  echo "    SKIP: docker compose not available in this environment"
else
  s31="$TEST_ROOT/case31"
  mkdir -p "$s31/app"
  proj31="mirofish-task9-fixture-$$"
  cat >"$s31/app/docker-compose.yml" <<EOF
name: $proj31
services:
  web:
    image: busybox:1
    command: ["sleep", "infinity"]
EOF
  cat >"$s31/app/docker-compose.mirofish.yml" <<EOF
name: $proj31
services:
  mirofish:
    image: busybox:1
    command: ["sleep", "infinity"]
    profiles: ["mirofish"]
EOF
  ok31=1
  # Step 1: bring the project up WITH the mirofish profile active --
  # simulates "an earlier MIROFISH_ACTIVATE=1 deploy already ran."
  if ! COMPOSE_PROFILES=mirofish docker compose --project-name "$proj31" -f "$s31/app/docker-compose.yml" -f "$s31/app/docker-compose.mirofish.yml" up -d --wait --wait-timeout 30 >"$s31/up.log" 2>&1; then
    fail "case31: real 'docker compose up' (profile on) failed: $(cat "$s31/up.log" 2>/dev/null)"
    ok31=0
  fi
  if [[ "$ok31" == 1 ]] && ! docker ps -a --filter "label=com.docker.compose.project=$proj31" --filter "name=${proj31}-mirofish-1" --format '{{.Names}}' | grep -q mirofish; then
    fail "case31: real mirofish container did not actually start -- test setup itself is broken"
    ok31=0
  fi
  if [[ "$ok31" == 1 ]]; then
    # Step 2: this case's actual subject -- the REAL sourced library, with
    # NO --env-file images.env written yet (a genuinely first-ever deploy
    # against this scratch APP_DIR) and MIROFISH_ACTIVATE unset (normal
    # disabled path), calling the real ensure_mirofish_stopped() against
    # this real, already-running container. No fakes anywhere in this step.
    result31="$(
      (
        IMAGE_TAG=0000000000000000000000000000000000000000
        APP_DIR="$s31/app"
        DEPLOY_SH_COMPOSE_PROJECT="$proj31"
        export IMAGE_TAG APP_DIR DEPLOY_SH_COMPOSE_PROJECT
        # shellcheck source=/dev/null
        source "$LIB_FILE"
        activate_mirofish || true
        ensure_mirofish_stopped
        echo DEPLOY_PROCEEDED
      ) 2>"$s31/stderr.log"
    )"
    status31=$?
    if [[ "$status31" != 0 ]]; then
      fail "case31: expected exit 0 against a real, stoppable container, got $status31: $(cat "$s31/stderr.log" 2>/dev/null)"
    fi
    echo "$result31" | grep -q DEPLOY_PROCEEDED || fail "case31: expected ensure_mirofish_stopped to succeed and let the deploy proceed"
    if docker ps -a --filter "label=com.docker.compose.project=$proj31" --format '{{.Names}}' | grep -q "${proj31}-mirofish-1"; then
      fail "case31: the real mirofish container is still present after ensure_mirofish_stopped -- it should have been stopped and removed"
    fi
    if ! docker ps --filter "label=com.docker.compose.project=$proj31" --format '{{.Names}}' | grep -q "${proj31}-web-1"; then
      fail "case31: the real 'web' (core app stand-in) container should have been left running, untouched"
    fi
    echo "    exit=$status31"
  fi
  # Teardown: always attempt, regardless of pass/fail above, so no real
  # Docker resource from this test ever lingers. COMPOSE_PROFILES=mirofish
  # here too -- `down` selects services the same profile-scoped way `up`
  # does, so without it a still-running mirofish container (e.g. if the
  # assertion above already failed, meaning the fix under test didn't
  # actually stop it) would survive this teardown exactly like the bug
  # this whole round fixes. Force-remove unconditionally as a last resort.
  COMPOSE_PROFILES=mirofish docker compose --project-name "$proj31" -f "$s31/app/docker-compose.yml" -f "$s31/app/docker-compose.mirofish.yml" down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "${proj31}-web-1" "${proj31}-mirofish-1" >/dev/null 2>&1 || true
  docker network rm "${proj31}_default" >/dev/null 2>&1 || true
fi

echo
cleanup
if [[ "$FAIL_COUNT" -eq 0 ]]; then
  echo "RESULT: GREEN -- $CASE_COUNT cases, 0 failures"
  exit 0
else
  echo "RESULT: RED -- $CASE_COUNT cases, $FAIL_COUNT failure(s)"
  exit 1
fi
