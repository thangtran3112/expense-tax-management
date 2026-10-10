#!/usr/bin/env bash
# Deploys one image tag of the ai-trading stack. Runs on the VPS as root.
#   IMAGE_TAG                commit SHA built by .github/workflows/ai-trading-deploy.yml
#                             (required)
#   DOCKER_CONFIG             registry credentials prepared by the workflow (optional)
#   ENV_STAGING_DIR           directory CI staged with exactly one freshly rendered file,
#                             cloudflared.env (required -- every deploy renders the other
#                             four SECRET_FILES entries VPS-side, straight from Firestore
#                             family-config (ai-trading/plans/handoffs/2026-10-05-family-config.md);
#                             there is no mode that skips rendering and reuses whatever
#                             already sits in $SECRETS_DIR). CI never sees
#                             tradingagents/ai-hedge-fund/vibe-trading/gateway values.
#   FAMILY_CONFIG_CREDENTIALS path to the family-config-reader service account key used for
#                             that render (default /etc/family-app/config-reader.json).
#   DEPLOY_SH_SKIP_CHOWN      test-only: skip the root:root chown on installed/restored
#                             secret files, so stage_secrets/rollback can be dry-run as a
#                             non-root user. Never set this in production.
#   DEPLOY_SH_FAIL_AFTER      test-only: name of a SECRET_FILES entry (e.g. auth.env);
#                             stage_secrets aborts right after installing that file, to
#                             dry-run rollback without needing a real install failure. Never
#                             set this in production.
#   MIROFISH_ACTIVATE        operator opt-in: set to 1 to render the optional
#                             ai-trading/mirofish Firestore profile and enable its Compose
#                             profile for this deploy; `keep` (push deploys) does the same
#                             only if a mirofish container is running right now. Unset/any
#                             other value leaves MiroFish disabled; the other three apps are unaffected
#                             either way. A missing profile, missing required key, or render
#                             failure never fails this deploy -- it only leaves MiroFish
#                             disabled and logs why.
#   AI_TRADING_RUNTIME_ENV_DIR directory MIROFISH_ACTIVATE=1 renders mirofish.env into
#                             (default /run/family-app/ai-trading); an ephemeral runtime
#                             location outside this repository, never $SECRETS_DIR.
#   DEPLOY_SH_MIROFISH_CHMOD_SCRATCH_AFTER_INSTALL test-only: a chmod mode (e.g. 0500)
#                             applied to activate_mirofish's render scratch directory
#                             right after a successful install, to dry-run its post-install
#                             cleanup failing for real. Never set this in production.
#   DEPLOY_SH_COMPOSE_PROJECT test-only: overrides compose()'s hardcoded
#                             `--project-name ai-trading`, so a test can point the real
#                             compose()/ensure_mirofish_stopped() code at a disposable,
#                             uniquely-named scratch Compose project instead of the real
#                             one. Never set this in production.
#   AI_TRADING_MIN_FREE_GB    free GiB required (after old images are pruned) before this
#                             release is pulled; a whole number 0-999999, default 30. One
#                             release unpacks to ~17 GB and needs ~5 GB more of compressed
#                             layers while pulling.
#   AI_TRADING_DOCKER_DATA_DIR directory whose filesystem that free space is read from
#                             (default /var/lib/docker; on this single-disk VPS Docker's
#                             data and containerd's image store share it).
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
SECRETS_DIR="${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}"
REGISTRY="${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}"
ENV_STAGING_DIR="${ENV_STAGING_DIR:-}"
RUNTIME_ENV_DIR="${AI_TRADING_RUNTIME_ENV_DIR:-/run/family-app/ai-trading}"
MIROFISH_REQUIRED_KEYS=(ZEP_API_KEY LLM_API_KEY)
# Prior/new-state tracking for mirofish.env, mirrors PRIOR_EXISTED/.previous/
# below but for the one optional MiroFish runtime file: MIROFISH_INSTALLED_THIS_RUN
# is only ever 1 between a successful install and either activate_mirofish's
# own post-install checks or restore_or_remove_mirofish() consuming it (both
# reset it to 0), so a later, unrelated pipeline failure's rollback() never
# redoes work activate_mirofish already finished or already self-healed.
MIROFISH_RUNTIME_ENV_FILE=""
MIROFISH_PRIOR_EXISTED=0
MIROFISH_INSTALLED_THIS_RUN=0
MIN_FREE_GB="${AI_TRADING_MIN_FREE_GB:-30}"
DOCKER_DATA_DIR="${AI_TRADING_DOCKER_DATA_DIR:-/var/lib/docker}"
STATE_FILE="$APP_DIR/last-good-tag"
IMAGES_ENV="$APP_DIR/images.env"
SECRET_FILES=(tradingagents.env ai-hedge-fund.env vibe-trading.env vibe-gateway.env auth.env cloudflared.env)
# Tracks, per secret file, whether it existed before this run's staging so
# rollback can tell "restore the backup" from "delete what we just created".
declare -A PRIOR_EXISTED=()
# Root-only scratch directory this run's render_profiles() writes
# tradingagents.env/ai-hedge-fund.env/vibe-trading.env/auth.env into, straight from
# Firestore. Empty until render_profiles runs; cleanup_render_dir removes it on every exit.
RENDER_SRC_DIR=""
# A full commit SHA: the only shape a deployed image tag (and last-good-tag) ever has.
SHA_RE='^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'

die() {
  echo "deploy: $*" >&2
  exit 1
}

[[ "${IMAGE_TAG:-}" =~ $SHA_RE ]] || die "IMAGE_TAG must be a full commit SHA"

# validate_staged_file FILE: blank lines, # comments, or KEY=value with a
# non-empty value; never a NUL or CR byte anywhere in the file.
validate_staged_file() {
  local file="$1" line
  [[ -f "$file" ]] || die "missing staged $file"
  if ! cmp -s <(LC_ALL=C tr -d '\000' <"$file") "$file"; then
    die "$file contains a NUL byte"
  fi
  if LC_ALL=C grep -q $'\r' "$file"; then
    die "$file contains a CR byte"
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == '#'* ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=.+$ ]] || die "$file: invalid line: $line"
  done <"$file"
}

# install_secret_file SRC DEST: writes DEST atomically (a root:root 0600 temp
# file on DEST's filesystem, then `mv -f` over DEST) so a reader never sees a
# partially-written file and a failure never leaves DEST truncated.
install_secret_file() {
  local src="$1" dest="$2" tmp
  tmp="$(mktemp "$(dirname "$dest")/.$(basename "$dest").XXXXXX")"
  if [[ -n "${DEPLOY_SH_SKIP_CHOWN:-}" ]]; then
    install -m 0600 "$src" "$tmp"
  else
    install -o root -g root -m 0600 "$src" "$tmp"
  fi
  mv -f "$tmp" "$dest"
}

compose() {
  local mirofish_compose=() env_file_args=()
  [[ -f "$APP_DIR/docker-compose.mirofish.yml" ]] && mirofish_compose=(-f "$APP_DIR/docker-compose.mirofish.yml")
  # On a genuinely first-ever deploy, $IMAGES_ENV (deploy_tag's own output)
  # doesn't exist yet -- `docker compose --env-file <missing>` hard-fails
  # immediately ("couldn't find env file"), before even parsing the compose
  # file. ensure_mirofish_stopped() below needs a working `compose` call
  # *before* deploy_tag ever runs, so fall back to passing the same three
  # variables images.env would hold directly as environment -- ps/rm only
  # match existing containers by project+service label, never by resolving
  # the image reference, so any valid-looking tag works equally well here
  # (verified empirically; see task-9-report.md).
  if [[ -f "$IMAGES_ENV" ]]; then
    env_file_args=(--env-file "$IMAGES_ENV")
  fi
  # The gateway bind-mounts this single file; the workflow's `install` swaps in
  # a new inode, which a running container never sees. Its sha256 is a gateway
  # label, so Compose recreates the gateway exactly when the Caddyfile changes.
  local caddyfile_sha=unset
  [[ -f "$APP_DIR/Caddyfile" ]] && caddyfile_sha="$(sha256sum "$APP_DIR/Caddyfile")" && caddyfile_sha="${caddyfile_sha%% *}"
  AI_TRADING_CADDYFILE_SHA256="$caddyfile_sha" \
  AI_TRADING_REGISTRY="$REGISTRY" \
  AI_TRADING_IMAGE_TAG="$IMAGE_TAG" \
  AI_TRADING_SECRETS_DIR="$SECRETS_DIR" \
    docker compose --project-name "${DEPLOY_SH_COMPOSE_PROJECT:-ai-trading}" "${env_file_args[@]}" -f "$APP_DIR/docker-compose.yml" "${mirofish_compose[@]}" "$@"
}

# cleanup_render_dir: removes this run's root-only Firestore-render scratch
# directory on every exit -- success, a render/validation failure, or a later
# mid-stage install failure -- so no partial or final secret value ever lingers
# anywhere outside $SECRETS_DIR itself. Armed by render_profiles once the
# directory actually exists; a bash EXIT trap always fires exactly once, no
# matter how the script terminates, so this never depends on which later step
# fails.
cleanup_render_dir() {
  [[ -n "$RENDER_SRC_DIR" ]] && rm -rf "$RENDER_SRC_DIR"
}

# render_profiles: VPS-side render of the four ai-trading Firestore profiles
# (tradingagents, ai-hedge-fund, vibe-trading, gateway) into a fresh root-only
# scratch directory on every deploy
# (ai-trading/plans/handoffs/2026-10-05-family-config.md). CI no longer stages
# these -- only cloudflared.env still arrives via ENV_STAGING_DIR; everything
# else is read from Firestore here, by the VPS itself, with the shared,
# database-wide family-config-reader key -- a completely different mechanism
# from the CI-staged file. The profile is named "gateway" in Firestore for
# interface continuity, but the file family_config.py writes (always named
# after the profile) is renamed here to auth.env to match the compose service
# that actually reads it -- "gateway" itself is Caddy and needs no secrets at
# all. family_config.py resolves every target before writing any file, so a
# missing profile fails this call before a single byte is written -- the
# install loop below never starts.
render_profiles() {
  local family_config="$APP_DIR/family_config.py"
  [[ -x "$family_config" ]] || die "missing $family_config; copy it alongside deploy.sh first"
  install -d -m 0700 "$SECRETS_DIR"
  RENDER_SRC_DIR="$(mktemp -d "$SECRETS_DIR/.render-XXXXXX")"
  trap cleanup_render_dir EXIT
  FAMILY_CONFIG_CREDENTIALS="${FAMILY_CONFIG_CREDENTIALS:-/etc/family-app/config-reader.json}" \
    "$family_config" render ai-trading/tradingagents ai-trading/ai-hedge-fund ai-trading/vibe-trading ai-trading/gateway \
      --out-dir "$RENDER_SRC_DIR"
  mv -f "$RENDER_SRC_DIR/gateway.env" "$RENDER_SRC_DIR/auth.env"
  # Caddy injects Vibe's API key after the Clerk check, so browsers never hold
  # it; the gateway gets only this one value, never Vibe's provider keys.
  local vibe_key
  vibe_key="$(sed -n 's/^API_AUTH_KEY=//p' "$RENDER_SRC_DIR/vibe-trading.env")"
  [[ -n "$vibe_key" ]] || die "ai-trading/vibe-trading has no API_AUTH_KEY; the gateway could not authenticate to Vibe-Trading"
  (umask 077 && printf 'VIBE_API_AUTH_KEY=%s\n' "$vibe_key" >"$RENDER_SRC_DIR/vibe-gateway.env")
}

# secret_source_dir NAME: the directory holding one SECRET_FILES entry before
# stage_secrets validates/installs it. cloudflared.env is the only entry CI
# still stages into ENV_STAGING_DIR; the other four come from this run's own
# render_profiles output in RENDER_SRC_DIR.
secret_source_dir() {
  if [[ "$1" == cloudflared.env ]]; then
    printf '%s\n' "$ENV_STAGING_DIR"
  else
    printf '%s\n' "$RENDER_SRC_DIR"
  fi
}

# mirofish_env_valid FILE: soft (non-dying) sibling of validate_staged_file,
# for the optional MiroFish profile only. A malformed or incomplete
# ai-trading/mirofish profile must leave MiroFish disabled, never abort the
# whole deploy -- so this returns 1 instead of calling die(). Checks the
# same NUL/CR/KEY=value shape as validate_staged_file, plus presence of
# every MIROFISH_REQUIRED_KEYS name (never echoes a value).
mirofish_env_valid() {
  local file="$1" line key
  [[ -f "$file" ]] || return 1
  cmp -s <(LC_ALL=C tr -d '\000' <"$file") "$file" || return 1
  if LC_ALL=C grep -q $'\r' "$file"; then
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == '#'* ]] && continue
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*=.+$ ]] || return 1
  done <"$file"
  for key in "${MIROFISH_REQUIRED_KEYS[@]}"; do
    grep -q "^${key}=.\+$" "$file" || return 1
  done
}

# file_mode_octal FILE: this file's permission bits as a 3-digit octal
# string (e.g. "600"), GNU stat first (the real VPS), BSD/macOS stat as a
# fallback (this repo's own offline tests).
file_mode_octal() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null
}

# cleanup_mirofish_scratch DIR: removes activate_mirofish's one-shot render
# scratch directory, which may still contain the rendered ai-trading/mirofish
# profile's plaintext values (review P2, round 3: a bare, unchecked `rm -rf`
# here could fail silently and leave that secret-bearing directory sitting
# on disk even on an otherwise fully successful activation). Explicitly
# checked everywhere it's used: a failure on an already-failing path just
# gets an extra path-only warning logged (the activation is being aborted
# either way); a failure on the post-install-success path is escalated by
# the caller into a hard activation failure instead of silently exporting
# COMPOSE_PROFILES over a leftover copy of the rendered secret. Never prints
# a key's value, only the scratch directory's own path.
cleanup_mirofish_scratch() {
  if ! rm -rf "$1"; then
    echo "deploy: mirofish: failed to remove render scratch $1; it may still contain the rendered profile's values on disk" >&2
    return 1
  fi
}

# stop_remove_mirofish_container: best-effort stop+remove of a running
# mirofish container (review P2, round 3). A container a *successful*
# `compose up` already started earlier in this same deploy attempt does not
# stop itself just because this process later decides, during rollback,
# that mirofish.env can't be restored or deleted -- COMPOSE_PROFILES and
# mirofish.env are this script's own bookkeeping, not a live signal the
# container reacts to, so "MiroFish left disabled" in the log would
# otherwise be false: the container could still be running, unmonitored,
# with no corresponding env file on disk. `compose rm -s -f` stops it first
# (if still running) then force-removes it, no confirmation prompt. Always
# best-effort: never lets a failure here change the caller's own outcome,
# only logs that manual intervention may be needed (service name only,
# nothing else to log).
stop_remove_mirofish_container() {
  if ! compose rm -s -f mirofish >/dev/null 2>&1; then
    echo "deploy: mirofish: best-effort stop/remove of the mirofish container failed; it may still be running -- check manually" >&2
    return 1
  fi
}

# restore_or_remove_mirofish: undoes activate_mirofish's one mutation this
# run -- the mirofish.env it just installed -- the same prior/new-state
# discipline restore_or_remove_secrets already applies to the five
# SECRET_FILES. A no-op unless this run actually installed a new
# mirofish.env (MIROFISH_INSTALLED_THIS_RUN); resets that flag immediately
# so a second call (activate_mirofish's own post-install self-heal, then
# later rollback() for an unrelated later failure) never re-applies it
# twice. PRIOR_EXISTED=1 restores the pre-run backup and keeps
# COMPOSE_PROFILES=mirofish (the previous good deploy had MiroFish active,
# so a rollback to it should too); PRIOR_EXISTED=0 deletes the file this run
# created and unsets COMPOSE_PROFILES (MiroFish was never active before
# this run, so nothing should start it).
#
# Every restore/delete step is explicitly checked (review P2): a missing
# backup, a failed install_secret_file, or a failed rm is never silently
# ignored. On any such failure this returns 1 and -- the safe default when
# the on-disk state can no longer be confirmed -- always unsets
# COMPOSE_PROFILES rather than risk re-enabling MiroFish against a file
# that was never actually restored. Never prints a key's value, only paths.
#
# Review P2, round 3: when restore/delete itself fails, a container this
# same deploy already started (a successful `compose up` before a later
# health-check/post-Compose failure triggered rollback) would otherwise
# keep running with no corresponding mirofish.env and no COMPOSE_PROFILES
# -- "MiroFish left disabled" in the log, but not in reality. Each of these
# three failure branches also makes a best-effort
# stop_remove_mirofish_container call; its own result is logged by that
# function and never changes this function's outcome (already returning 1
# either way) -- this is defense in depth on top of the file-state fix, not
# a replacement for it.
restore_or_remove_mirofish() {
  [[ "$MIROFISH_INSTALLED_THIS_RUN" == 1 ]] || return 0
  MIROFISH_INSTALLED_THIS_RUN=0
  if [[ "$MIROFISH_PRIOR_EXISTED" == 1 ]]; then
    if [[ ! -f "$RUNTIME_ENV_DIR/.previous/mirofish.env" ]]; then
      echo "deploy: mirofish: rollback: missing backup $RUNTIME_ENV_DIR/.previous/mirofish.env; cannot restore, leaving MiroFish disabled" >&2
      unset COMPOSE_PROFILES
      stop_remove_mirofish_container || true
      return 1
    fi
    if ! install_secret_file "$RUNTIME_ENV_DIR/.previous/mirofish.env" "$MIROFISH_RUNTIME_ENV_FILE"; then
      echo "deploy: mirofish: rollback: failed to restore $MIROFISH_RUNTIME_ENV_FILE from backup; leaving MiroFish disabled" >&2
      unset COMPOSE_PROFILES
      stop_remove_mirofish_container || true
      return 1
    fi
    export COMPOSE_PROFILES=mirofish
  else
    if ! rm -f "$MIROFISH_RUNTIME_ENV_FILE"; then
      echo "deploy: mirofish: rollback: failed to remove $MIROFISH_RUNTIME_ENV_FILE; leaving MiroFish disabled" >&2
      unset COMPOSE_PROFILES
      stop_remove_mirofish_container || true
      return 1
    fi
    unset COMPOSE_PROFILES
    # Whole-branch review reopen: this run's own activate_mirofish may have
    # already started a mirofish container (a successful `compose up`
    # before some later, unrelated failure triggered this rollback) --
    # removing mirofish.env alone doesn't stop it. Best-effort here,
    # consistent with the three failure branches above and with rollback()'s
    # own established "report, never block the rest of recovery" discipline
    # -- the forward path's hard-fail gate is ensure_mirofish_stopped(),
    # not this recovery path.
    stop_remove_mirofish_container || true
  fi
}

# activate_mirofish: operator opt-in (MIROFISH_ACTIVATE=1, or =keep while a
# mirofish container is already running). Renders the
# optional ai-trading/mirofish Firestore profile into a root-only scratch
# directory, validates it holds every MIROFISH_REQUIRED_KEYS name (never
# printing a value), backs up any mirofish.env this install is about to
# replace (so a later failure elsewhere in this deploy can roll it back,
# same as the five SECRET_FILES), and only on a *confirmed* install --
# required keys present and mode exactly 0600, re-checked against the
# installed file itself, not just the scratch copy -- exports
# COMPOSE_PROFILES=mirofish so deploy_tag's `compose up` actually starts the
# service.
#
# Every step below is its own explicit `if ! cmd; then ...; return 1; fi` (or
# equivalent) -- this function is always called as `activate_mirofish ||
# true` from main flow (a deliberate soft-failure contract: a failed/absent
# MiroFish activation must never fail the other three apps' deploy), and
# bash's errexit does not propagate out of *any* command run while
# evaluating the left side of a `||` list, including every command inside a
# function called that way. Relying on `set -e` here would mean a silently
# failed install could still fall through to exporting COMPOSE_PROFILES --
# never let that happen; every required step checks its own exit status.
#
# The very first thing this does, unconditionally, is unset any inherited
# COMPOSE_PROFILES (a parent shell/CI export, or a stale value left over
# from nothing at all in this process) so a prior run's activation -- or an
# operator's leftover export -- can never bypass this run's own decision;
# only a confirmed-good activation below ever re-sets it.
activate_mirofish() {
  unset COMPOSE_PROFILES
  case "${MIROFISH_ACTIVATE:-}" in
    1) ;;
    keep)
      [[ -n "$(compose ps -q --status running mirofish 2>/dev/null)" ]] || return 0
      echo "deploy: mirofish: running; keeping it enabled for this deploy" >&2
      ;;
    *) return 0 ;;
  esac
  local family_config="$APP_DIR/family_config.py" scratch
  if [[ ! -x "$family_config" ]]; then
    echo "deploy: mirofish: missing $family_config; leaving MiroFish disabled" >&2
    return 1
  fi
  if ! install -d -m 0700 "$RUNTIME_ENV_DIR"; then
    echo "deploy: mirofish: failed to create $RUNTIME_ENV_DIR; leaving MiroFish disabled" >&2
    return 1
  fi
  if ! scratch="$(mktemp -d "$RUNTIME_ENV_DIR/.mirofish-render-XXXXXX")"; then
    echo "deploy: mirofish: failed to create a render scratch directory; leaving MiroFish disabled" >&2
    return 1
  fi
  if ! FAMILY_CONFIG_CREDENTIALS="${FAMILY_CONFIG_CREDENTIALS:-/etc/family-app/config-reader.json}" \
       "$family_config" render ai-trading/mirofish --out-dir "$scratch"; then
    cleanup_mirofish_scratch "$scratch"
    echo "deploy: mirofish: render of ai-trading/mirofish failed; leaving MiroFish disabled" >&2
    return 1
  fi
  if ! mirofish_env_valid "$scratch/mirofish.env"; then
    cleanup_mirofish_scratch "$scratch"
    echo "deploy: mirofish: ai-trading/mirofish profile missing a required key (${MIROFISH_REQUIRED_KEYS[*]}) or malformed; leaving MiroFish disabled" >&2
    return 1
  fi

  MIROFISH_RUNTIME_ENV_FILE="$RUNTIME_ENV_DIR/mirofish.env"
  if [[ -f "$MIROFISH_RUNTIME_ENV_FILE" ]]; then
    if ! install -d -m 0700 "$RUNTIME_ENV_DIR/.previous" || ! cp -p "$MIROFISH_RUNTIME_ENV_FILE" "$RUNTIME_ENV_DIR/.previous/mirofish.env"; then
      cleanup_mirofish_scratch "$scratch"
      echo "deploy: mirofish: failed to back up the existing mirofish.env; leaving MiroFish disabled" >&2
      return 1
    fi
    MIROFISH_PRIOR_EXISTED=1
  else
    MIROFISH_PRIOR_EXISTED=0
  fi

  if ! install_secret_file "$scratch/mirofish.env" "$MIROFISH_RUNTIME_ENV_FILE"; then
    cleanup_mirofish_scratch "$scratch"
    echo "deploy: mirofish: failed to install $MIROFISH_RUNTIME_ENV_FILE; leaving MiroFish disabled" >&2
    return 1
  fi
  MIROFISH_INSTALLED_THIS_RUN=1

  # test-only: see header doc. Lets test-deploy-firestore.sh force the
  # cleanup immediately below to fail for real (a genuine permission-denied
  # rm), without needing a separate hand-rolled timing hack in the test
  # file. Never set this in production.
  [[ -n "${DEPLOY_SH_MIROFISH_CHMOD_SCRATCH_AFTER_INSTALL:-}" ]] && chmod "$DEPLOY_SH_MIROFISH_CHMOD_SCRATCH_AFTER_INSTALL" "$scratch"

  # Unlike every cleanup above (already aborting this activation regardless
  # of whether cleanup itself also succeeds), this one guards a file that
  # just got marked as successfully installed: a failed cleanup here must
  # not silently fall through to exporting COMPOSE_PROFILES over a leftover
  # scratch copy of the rendered secret (review P2, round 3) -- escalate it
  # into a full activation failure and self-heal (restore the prior file,
  # or remove what was just written) exactly like the two post-install
  # validation checks right below.
  if ! cleanup_mirofish_scratch "$scratch"; then
    echo "deploy: mirofish: post-install cleanup failed; leaving MiroFish disabled" >&2
    restore_or_remove_mirofish
    return 1
  fi

  # Confirm the actual installed file -- not just the scratch copy -- before
  # enabling anything. A failure here self-heals immediately (restores the
  # prior file, or removes what was just written) rather than leaving a
  # known-bad file for some later, unrelated failure's rollback to find.
  if ! mirofish_env_valid "$MIROFISH_RUNTIME_ENV_FILE"; then
    echo "deploy: mirofish: installed mirofish.env failed post-install validation; leaving MiroFish disabled" >&2
    restore_or_remove_mirofish
    return 1
  fi
  if [[ "$(file_mode_octal "$MIROFISH_RUNTIME_ENV_FILE")" != 600 ]]; then
    echo "deploy: mirofish: installed mirofish.env is not mode 600; leaving MiroFish disabled" >&2
    restore_or_remove_mirofish
    return 1
  fi

  export COMPOSE_PROFILES=mirofish
  echo "deploy: mirofish: ai-trading/mirofish profile rendered; MiroFish enabled for this deploy" >&2
}

# ensure_mirofish_stopped: whole-branch review reopen. Whenever this deploy
# does NOT end with MiroFish active -- COMPOSE_PROFILES isn't "mirofish",
# whether because MIROFISH_ACTIVATE was never set (the normal disabled
# path) or because activate_mirofish just failed -- a container left
# running from an *earlier* successful activation is not stopped by this
# alone. Reproduced empirically against real Docker Compose (not assumed;
# see task-9-report.md): `docker compose up -d --remove-orphans` with the
# same sibling compose file loaded but the profile inactive does NOT stop
# or remove an already-running profile-gated container -- it is not
# "orphaned" (still defined in the merged project, just out of scope for
# this invocation), so it keeps running, un-monitored, with no
# corresponding mirofish.env. "MiroFish disabled" in the log would
# otherwise be false.
#
# This explicitly stops+removes any such container (reusing
# stop_remove_mirofish_container, the same best-effort primitive rollback
# already uses) and then independently VERIFIES its absence via `compose ps
# -q mirofish` -- never trusting a zero exit status alone. Either check
# failing is NOT best-effort here: it FAILS THIS DEPLOY outright (die(),
# before stage_secrets or deploy_tag ever runs), so the previously-deployed
# tag -- the other three apps, gateway, auth, cloudflared -- is left
# completely untouched rather than risk a newly-deployed "disabled" stack
# silently running next to an unverified, un-monitored MiroFish instance.
# A no-op when this run's own activation succeeded (COMPOSE_PROFILES is
# already "mirofish" -- deploy_tag's own `compose up` manages it normally).
ensure_mirofish_stopped() {
  [[ "${COMPOSE_PROFILES:-}" == mirofish ]] && return 0
  stop_remove_mirofish_container || die "mirofish: failed to stop/remove an existing mirofish container; aborting this deploy -- the previously-deployed tag stays running"
  [[ -z "$(compose ps -q mirofish 2>/dev/null)" ]] || die "mirofish: a mirofish container is still present after stop/remove; aborting this deploy -- the previously-deployed tag stays running"
}

# prune_old_images: image retention. Every release unpacks to ~17 GB (MiroFish's
# backend alone is ~12 GB and shares no layers between tags), so unpruned tags
# filled the VPS disk on 2026-10-10: the pull died with ENOSPC and the rollback
# could not even restore the env files. Keeps only this release, the rollback
# target (last-good-tag), and whatever a container still uses -- `docker rmi`
# without -f refuses an image any container, running or stopped, still
# references, which is the safety net. Only commit-SHA-tagged images in this
# registry's ai-trading-* repos are ever considered; other apps' images,
# third-party images, and non-SHA tags are never touched. If last-good-tag
# exists but is not exactly one commit SHA, the rollback target is unknown, so
# nothing is pruned. Best-effort: a failure here surfaces through
# require_free_space, not by aborting on one stale tag.
prune_old_images() {
  local last_good="" ref tag
  if [[ -f "$STATE_FILE" ]]; then
    last_good="$(cat "$STATE_FILE")"
    if [[ ! "$last_good" =~ $SHA_RE ]]; then
      echo "deploy: $STATE_FILE is not a single commit SHA; skipping image pruning so the rollback target is never removed" >&2
      return 0
    fi
  fi
  while IFS= read -r ref; do
    case "$ref" in
      "$REGISTRY"/ai-trading-*:*) ;;
      *) continue ;;
    esac
    tag="${ref##*:}"
    [[ "$tag" =~ $SHA_RE ]] || continue
    [[ "$tag" == "$IMAGE_TAG" || "$tag" == "$last_good" ]] && continue
    docker rmi "$ref" >/dev/null 2>&1 || true
  done < <(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)
}

# require_free_space: stop before any secret, container, or tag changes unless
# this release's pull is likely to fit. Fails closed: a malformed threshold or
# free space that cannot be read is an error, never a pass (bash arithmetic
# would read an empty, negative, or overflowed threshold as "enough"). 10# keeps
# a leading zero decimal instead of octal.
require_free_space() {
  local free_kb
  [[ "$MIN_FREE_GB" =~ ^[0-9]{1,6}$ ]] || die "AI_TRADING_MIN_FREE_GB must be a whole number of GiB (0-999999), got: $MIN_FREE_GB"
  free_kb="$(df -Pk "$DOCKER_DATA_DIR" 2>/dev/null | awk 'NR==2 {print $4}' || true)"
  [[ "$free_kb" =~ ^[0-9]+$ ]] || die "cannot read free disk space for $DOCKER_DATA_DIR"
  ((free_kb >= 10#$MIN_FREE_GB * 1024 * 1024)) || die "only $((free_kb / 1024 / 1024)) GiB free on $DOCKER_DATA_DIR after pruning old ai-trading images; need $MIN_FREE_GB GiB to pull this release -- free space and re-run (the running release is untouched)"
}

deploy_tag() {
  local tag="$1" tmp
  tmp="$(mktemp "$APP_DIR/images.env.XXXXXX")"
  printf 'AI_TRADING_REGISTRY=%s\nAI_TRADING_IMAGE_TAG=%s\nAI_TRADING_SECRETS_DIR=%s\n' "$REGISTRY" "$tag" "$SECRETS_DIR" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$IMAGES_ENV"
  compose pull
  compose up -d --remove-orphans --wait --wait-timeout 300
  "$APP_DIR/health-check.sh"
}

# restore_or_remove_secrets: used by rollback to undo a partially- or fully-
# applied stage_secrets. A file that existed before this run is restored from
# its backup; a file that did not (first deploy) is deleted, never left
# behind as a leftover new secret.
restore_or_remove_secrets() {
  local name
  for name in "${SECRET_FILES[@]}"; do
    if [[ "${PRIOR_EXISTED[$name]:-0}" == 1 ]]; then
      [[ -f "$SECRETS_DIR/.previous/$name" ]] && install_secret_file "$SECRETS_DIR/.previous/$name" "$SECRETS_DIR/$name"
    else
      rm -f "$SECRETS_DIR/$name"
    fi
  done
}

rollback() {
  local status="$1" previous=""
  trap - ERR
  if [[ -n "$ENV_STAGING_DIR" ]]; then
    restore_or_remove_secrets
  fi
  restore_or_remove_mirofish || echo "deploy: mirofish: rollback error above; MiroFish left disabled, the rest of rollback continues" >&2
  if [[ -f "$STATE_FILE" ]]; then
    previous="$(cat "$STATE_FILE")"
  fi
  if [[ -n "$previous" && "$previous" != "$IMAGE_TAG" ]]; then
    echo "deploy: failed with status $status; rolling back to $previous" >&2
    deploy_tag "$previous" || echo "deploy: rollback to $previous failed too" >&2
  else
    echo "deploy: failed with status $status; no earlier tag to roll back to" >&2
  fi
  exit "$status"
}

# stage_secrets: validates every staged file first (no side effects on
# failure). Only then does it record which target files already exist, back
# those up to .previous/, and arm the rollback trap -- all before installing
# anything -- so a failure partway through the four atomic installs below is
# always caught and always rolled back to exactly the prior state. `rollback`
# and everything it calls are defined above, before this function is ever
# invoked, so the trap it arms always resolves.
stage_secrets() {
  local name
  for name in "${SECRET_FILES[@]}"; do
    validate_staged_file "$(secret_source_dir "$name")/$name"
  done

  install -d -m 0700 "$SECRETS_DIR" "$SECRETS_DIR/.previous"

  for name in "${SECRET_FILES[@]}"; do
    if [[ -f "$SECRETS_DIR/$name" ]]; then
      PRIOR_EXISTED[$name]=1
      cp -p "$SECRETS_DIR/$name" "$SECRETS_DIR/.previous/$name"
    else
      PRIOR_EXISTED[$name]=0
    fi
  done
  trap 'rollback "$?"' ERR

  for name in "${SECRET_FILES[@]}"; do
    install_secret_file "$(secret_source_dir "$name")/$name" "$SECRETS_DIR/$name"
    # `return 1` here would not reliably trigger the ERR trap just armed
    # above (a function's own `return` does not fire a trap set during that
    # same call, only one already armed before the call) -- a real failing
    # command does, so use one.
    [[ "$name" != "${DEPLOY_SH_FAIL_AFTER:-}" ]] || false
  done
}

# --- main flow below this line; test-deploy-firestore.sh sources only the
# function definitions above it and calls them directly. ---
# Every successful deploy renders fresh Firestore profiles (no mode silently
# reuses a stale $SECRETS_DIR), so fail here -- before touching Firestore,
# Docker, or any secret file -- if CI never staged cloudflared.env at all,
# rather than let a manual/misconfigured run quietly skip rendering.
[[ -n "$ENV_STAGING_DIR" ]] || die "ENV_STAGING_DIR is required: CI must stage cloudflared.env first"
[[ -f "$ENV_STAGING_DIR/cloudflared.env" ]] || die "missing $ENV_STAGING_DIR/cloudflared.env; CI must stage it first"
# Make room, then prove the pull fits, before Firestore, any container, or any
# secret file is touched (a failed pull on a full disk also breaks rollback).
prune_old_images
require_free_space
render_profiles
# Opt-in only; a failed/absent MiroFish activation must not fail this
# deploy of the other three apps, and must run before stage_secrets touches
# any existing secret file or deploy_tag starts a single container.
activate_mirofish || true
# Whole-branch review reopen: whenever the line above didn't just activate
# MiroFish, prove it's actually stopped -- not just "unset" -- before
# anything else in this deploy proceeds. A stop/verify failure aborts here,
# before stage_secrets or deploy_tag touch anything.
ensure_mirofish_stopped
stage_secrets

for name in "${SECRET_FILES[@]}"; do
  file="$SECRETS_DIR/$name"
  [[ -f "$file" ]] || die "missing $file; render and stage env files first"
  [[ "$(stat -c '%u:%a' "$file")" == "0:600" ]] || die "$file must be owned by root with mode 600"
done

trap 'rollback "$?"' ERR

install -d -m 0755 "$APP_DIR"
deploy_tag "$IMAGE_TAG"
printf '%s\n' "$IMAGE_TAG" >"$STATE_FILE.tmp"
mv -f "$STATE_FILE.tmp" "$STATE_FILE"
echo "deploy: ai-trading is running $IMAGE_TAG"
