#!/usr/bin/env bash
# Uploads MiroFish's unmodified Vue static build (Task 3's
# ai-trading/frontend-artifacts/mirofish/) to its dedicated, versioned GCS
# bucket (Task 6's infrastructure/gcp/ai-trading/mirofish-bucket.tf), with
# per-object MIME type and Cache-Control, generation-tracked rollback on any
# failure, and real post-upload content verification. This bucket holds only
# public UI assets -- never keys, reports, project files, or backend uploads
# (progress.md ruling: the static asset allowlist is enforced HERE, not in
# Terraform IAM, because GCS cannot enforce object content through bucket
# IAM).
#
# Usage: upload-mirofish-static.sh OUT_DIR BUCKET
#
# Authentication: the caller authenticates as the dedicated
# ai-trading-mirofish-upload service account (bucket-scoped
# roles/storage.objectAdmin only -- never the broad deploy identity) via
# Workload Identity Federation BEFORE invoking this script (see the
# "Upload MiroFish static build" workflow step, itself gated to an explicit
# manual workflow_dispatch input plus a dedicated GitHub Environment -- a
# push to main never reaches this script). This script assumes
# `gcloud storage` is already authenticated; it never prints or requires a
# credential value.
#
# Rollback contract (progress.md B7 scope; hardened in fix round 1): the
# bucket has object versioning enabled (Task 6). Before replacing any
# existing object, this script records its current live generation --
# distinguishing a genuine "object does not exist yet" 404 from any other
# describe failure (permission, network, ...), because misclassifying the
# latter as "new object" would make a later rollback DELETE a real existing
# object instead of restoring it. Once an object may have been mutated this
# attempt, EVERY subsequent failure (upload, download, hashing, metadata
# describe, or any other unexpected command failure) routes through the
# same rollback path, preserving the original failure's exit status and
# message: a previously-existing object is restored from its recorded prior
# generation (`gcloud storage cp "gs://bucket/object#GEN" "gs://bucket/object"`
# -- Google's documented way to restore a noncurrent version, see
# https://cloud.google.com/storage/docs/using-object-versioning); a
# brand-new object (no prior generation) is deleted (`gcloud storage rm`,
# which on a versioned bucket only clears the live pointer -- it never
# purges history). Objects not yet reached when the failure occurred were
# never touched and need no action. No prior release object or noncurrent
# generation is ever deleted. If rollback itself fails partway, that failure
# is reported explicitly alongside the original error -- this script never
# reports success, and never silently swallows a rollback failure.
set -Eeuo pipefail

OUT_DIR="${1:?usage: upload-mirofish-static.sh OUT_DIR BUCKET}"
BUCKET="${2:?usage: upload-mirofish-static.sh OUT_DIR BUCKET}"

fail() {
  echo "upload-mirofish-static: $*" >&2
  exit 1
}

[[ -d "$OUT_DIR" ]] || fail "missing $OUT_DIR"

# --- Allowlist: only these extensions are public MiroFish UI assets -------
# No .json/.map: this bucket never serves project files or source maps.
declare -A MIME_FOR=(
  [html]="text/html; charset=utf-8"
  [css]="text/css; charset=utf-8"
  [js]="application/javascript"
  [mjs]="application/javascript"
  [png]="image/png"
  [jpg]="image/jpeg"
  [jpeg]="image/jpeg"
  [gif]="image/gif"
  [svg]="image/svg+xml"
  [webp]="image/webp"
  [ico]="image/x-icon"
  [woff]="font/woff"
  [woff2]="font/woff2"
  [ttf]="font/ttf"
  [otf]="font/otf"
)

lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }

# content_type_for REL_PATH: MIME by extension, failing on anything not in
# the allowlist above (caught earlier by validate_build, this is the
# second, authoritative gate actually used for the upload header).
content_type_for() {
  local rel="$1" ext
  ext="$(lower "${rel##*.}")"
  [[ -n "${MIME_FOR[$ext]:-}" ]] || fail "no MIME mapping for $rel"
  echo "${MIME_FOR[$ext]}"
}

# cache_control_for REL_PATH: HTML is revalidated every request (progress.md
# ruling pattern mirrors the hub's own HTML Cache-Control); Vite's
# content-hashed files under assets/ are immutable forever; any other
# non-HTML root file (e.g. a non-hashed favicon) gets a short cache so a
# changed icon is not stuck behind a year-long cache.
cache_control_for() {
  local rel="$1" ext
  ext="$(lower "${rel##*.}")"
  if [[ "$ext" == "html" ]]; then
    echo "no-cache, max-age=0, must-revalidate"
  elif [[ "$rel" == assets/* ]]; then
    echo "public, max-age=31536000, immutable"
  else
    echo "public, max-age=3600"
  fi
}

# sha256_of PATH: works on both GNU coreutils (CI, Linux) and macOS (local
# dev) without adding a new dependency.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# validate_build: fails closed, before any gcloud call, on anything that is
# not a safe public static asset. Mirrors and re-runs Task 3's own
# localhost/secret checks (this script is MiroFish's own upload gate, it
# cannot assume Task 3's build step ran correctly or was not tampered with
# since).
validate_build() {
  [[ -f "$OUT_DIR/index.html" ]] || fail "missing index.html"
  [[ -d "$OUT_DIR/assets" ]] || fail "missing assets/ directory"

  # At least one Vite content-hashed file under assets/ (e.g.
  # index-DVY-GYHM.js); the hash itself may contain internal hyphens.
  local hashed_found=0 f base
  while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    if [[ "$base" =~ ^.+-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$ ]]; then
      hashed_found=1
      break
    fi
  done < <(find "$OUT_DIR/assets" -maxdepth 1 -type f -print0)
  ((hashed_found)) || fail "no hash-named asset found under assets/"

  # No symlinks anywhere in the build: a symlink could point outside OUT_DIR
  # and silently upload (or read, for hashing) an unintended file.
  if find "$OUT_DIR" -type l | grep -q .; then
    fail "symlink found in build output (not a valid static asset)"
  fi

  # Path allowlist (fix round 1 High finding): the extension allowlist
  # alone let an arbitrary nested file through (e.g. reports/data.html,
  # project/code.js) as long as its extension matched. Only three shapes
  # are a public MiroFish UI asset:
  #   - exactly OUT_DIR/index.html
  #   - a hash-named file directly under OUT_DIR/assets/
  #   - an approved root-level icon (icon.png/favicon.ico/... -- the real
  #     build's non-hashed icon.png is exactly this shape)
  # Anything else -- any other nested path, any other root file, any
  # dotfile, any unrecognized extension -- is refused.
  local rel ext
  while IFS= read -r -d '' f; do
    rel="${f#"$OUT_DIR"/}"
    base="$(basename "$f")"
    [[ "$base" == .* ]] && fail "unexpected dotfile: $rel"
    ext="$(lower "${base##*.}")"
    [[ "$ext" != "$base" ]] || fail "unexpected extensionless file: $rel"
    [[ -n "${MIME_FOR[$ext]:-}" ]] || fail "unexpected extension on $rel"

    case "$rel" in
      index.html) : ;; # the one allowed HTML file
      assets/*)
        [[ "$base" =~ ^.+-[A-Za-z0-9_-]{6,}\.[A-Za-z0-9]+$ ]] ||
          fail "unexpected non-hashed file under assets/: $rel"
        ;;
      */*)
        fail "unexpected path outside assets/ (only index.html and approved root icons may sit outside assets/): $rel"
        ;;
      *)
        [[ "$base" =~ ^(icon|favicon)[A-Za-z0-9_.-]*\.(png|ico|svg|webp|jpe?g)$ ]] ||
          fail "unexpected root file (only index.html and approved icons are allowed): $rel"
        ;;
    esac
  done < <(find "$OUT_DIR" -type f -print0)

  # Dev-only backend URL must never leak into a build meant for the public
  # bucket (Task 3 already asserts this at build time; re-asserted here
  # because this script does not trust the caller skipped that step).
  #
  # Binary-safe (fix round 2 finding): this still used `-I`, which SKIPS any
  # file grep heuristically classifies as binary -- every image/font asset
  # in this build. `-a` scans every file's raw bytes as text instead, same
  # fix already applied to the secret scan below.
  if grep -Ral "localhost:5001" "$OUT_DIR" >/dev/null 2>&1; then
    fail "found localhost:5001 reference in build output"
  fi

  # Real secret-shaped strings only (an assignment or a long high-entropy
  # token body) -- deliberately NOT matched: the benign, unmodified upstream
  # i18n label "ZEP_API_KEY not configured" / "ZEP_API_KEY未配置"
  # (no '=' and no following token value, so no pattern below touches it).
  #
  # Binary-safe (fix round 1 Medium finding): grep's own binary-file
  # detection (`-I`) SKIPS any file it heuristically classifies as binary --
  # which is every image/font asset in this build. A secret-shaped string
  # smuggled into an otherwise-binary file (e.g. appended bytes, embedded
  # metadata) would previously never be scanned at all. `-a` forces grep to
  # scan every file's raw bytes as text instead of skipping it.
  if grep -RalE 'sk_(live|test)_|sk-[A-Za-z0-9_-]{20,}|zep_[A-Za-z0-9]{10,}|CLERK_SECRET_KEY=|ZEP_API_KEY=|SESSION_SIGNING_KEY=|LLM_API_KEY=' \
    "$OUT_DIR" >/dev/null 2>&1; then
    fail "a real secret-shaped string was found in the build output"
  fi
}

# --- Rollback bookkeeping ---------------------------------------------------
# Parallel arrays: one entry per object this *attempt* has begun processing
# -- journaled BEFORE its upload is even issued (fix round 2 Critical
# finding), not only after it succeeds. DONE_PRIOR_GEN[i] is empty for a
# brand-new object. An entry may therefore represent an object whose own
# upload command failed outright (nothing actually mutated) as well as one
# that was fully uploaded and verified; rollback() below treats both
# idempotently.
DONE_OBJECTS=()
DONE_PRIOR_GEN=()

# rollback_current_generation OBJ: sets ROLLBACK_CUR_STATE to "present"
# (with ROLLBACK_CUR_GEN set) or "absent", describing OBJ's ACTUAL live
# state right now -- not what the journal expected. Fix round 3 High
# finding: rollback() previously acted on the journal alone, unconditionally
# issuing a restore-copy for every existing-object entry even when that
# object's own upload had failed outright and nothing was ever mutated --
# creating a pointless extra generation. This describe-first check is what
# lets rollback() skip a no-op restore/delete. On an AMBIGUOUS describe
# failure (not a confirmed 404, e.g. 403/network) this sets
# ROLLBACK_CUR_STATE to "ambiguous" -- the caller must treat that as "we
# genuinely do not know, do not guess", never as "absent". This function
# never calls report_failure_and_rollback: it runs FROM INSIDE rollback()
# itself, and that would recurse into a second rollback() pass.
#
# Fix round 4 Medium finding: `cat "$err_file"` and `rm -f "$err_file"`
# below were bare, unguarded commands -- the exact bug class fix round 2
# fixed for mktemp/sha256_of, reintroduced here in fix round 3's new
# function. Because this function runs FROM INSIDE rollback() (itself
# reached via report_failure_and_rollback, with the ERR trap still armed
# whenever that was entered through an explicit `if !` guard rather than
# through on_unexpected_err), a bare command failing here would let the
# still-armed trap fire `on_unexpected_err` -> `report_failure_and_rollback`
# -> `rollback()` a SECOND time, re-entrantly, mid-way through the first
# rollback() call's own for-loop -- the identical double-rollback hazard
# fix round 2 eliminated for mktemp/sha256_of, now closed here too. Both
# commands are explicitly guarded: a failed READ (`cat`) means this
# object's current state genuinely cannot be determined -- mark it
# "ambiguous" (never guess) the same as any other indeterminate describe
# outcome. A failed temp-file cleanup (`rm`) is reported as a warning but
# does not change the state already determined -- a leftover scratch file
# is not a reason to treat an otherwise-successful classification as
# unsafe, and must never recurse into rollback() to "handle" it.
ROLLBACK_CUR_STATE=""
ROLLBACK_CUR_GEN=""
rollback_current_generation() {
  local obj="$1" out err_file err_text
  if ! err_file="$(mktemp)"; then
    # Can't even check safely -- same "refuse to guess" stance as a
    # genuinely ambiguous describe failure below.
    ROLLBACK_CUR_STATE="ambiguous"
    ROLLBACK_CUR_GEN=""
    return
  fi
  if out="$(gcloud storage objects describe "gs://$BUCKET/$obj" --format="value(generation)" 2>"$err_file")"; then
    ROLLBACK_CUR_STATE="present"
    ROLLBACK_CUR_GEN="$out"
    if ! rm -f "$err_file"; then
      echo "  (warning: could not remove temporary file $err_file while checking $obj -- continuing)" >&2
    fi
    return
  fi
  if ! err_text="$(cat "$err_file" 2>&1)"; then
    echo "  (warning: could not read describe error output for $obj -- treating its current state as ambiguous, not absent)" >&2
    if ! rm -f "$err_file"; then
      echo "  (warning: could not remove temporary file $err_file while checking $obj -- continuing)" >&2
    fi
    ROLLBACK_CUR_STATE="ambiguous"
    ROLLBACK_CUR_GEN=""
    return
  fi
  if ! rm -f "$err_file"; then
    echo "  (warning: could not remove temporary file $err_file while checking $obj -- continuing)" >&2
  fi
  if is_genuine_404 "$err_text"; then
    ROLLBACK_CUR_STATE="absent"
    ROLLBACK_CUR_GEN=""
    return
  fi
  ROLLBACK_CUR_STATE="ambiguous"
  ROLLBACK_CUR_GEN=""
}

# rollback: restores/deletes every object this attempt touched, continuing
# past an individual failure (so one bad restore does not abandon the rest
# of the release), but returns non-zero if ANY step failed -- callers must
# check this and never report success when it does (fix round 1 Critical
# finding: the previous version always returned success here).
#
# Idempotent by design (fix round 2 finding, sharpened in fix round 3):
# DONE_OBJECTS/DONE_PRIOR_GEN are journaled BEFORE the upload is even
# attempted, so an entry here may represent an object that was never
# actually mutated this attempt (its own upload command failed outright,
# or a later object's failure interrupted the attempt before this one was
# even reached). Fix round 3 High finding: unconditionally restoring such
# an object from "its own current generation" still issued a real
# `gcloud storage cp` that created an unnecessary new generation, even
# though nothing had changed. Before acting, this now describes the
# object's ACTUAL current live generation and compares it to the journaled
# PRIOR generation:
#   - existing object (prior gen recorded), current == prior -> UNCHANGED:
#     skip the restore entirely, no gcloud call, no new generation.
#   - existing object, current != prior (or the object is currently
#     absent, an anomaly) -> CHANGED: restore from the prior generation,
#     same as before.
#   - brand-new object (no prior gen), currently absent -> nothing was
#     ever created: skip the delete entirely.
#   - brand-new object, currently present -> it WAS created: delete it,
#     same as before.
#   - the describe itself fails AMBIGUOUSLY (not a confirmed 404) -> never
#     guess. Report that object's rollback step as FAILED (so the overall
#     rollback is reported incomplete, non-zero) and take NO action on it
#     -- neither restoring nor deleting -- rather than risk silently
#     deleting a real existing object or silently skipping a real cleanup.
rollback() {
  local i obj gen had_failure=0 err_text
  echo "upload-mirofish-static: rolling back ${#DONE_OBJECTS[@]} object(s) changed by this attempt" >&2
  for ((i = ${#DONE_OBJECTS[@]} - 1; i >= 0; i--)); do
    obj="${DONE_OBJECTS[i]}"
    gen="${DONE_PRIOR_GEN[i]}"

    rollback_current_generation "$obj"

    if [[ "$ROLLBACK_CUR_STATE" == "ambiguous" ]]; then
      echo "  ROLLBACK STEP FAILED: could not determine $obj's current state (describe failed, not a confirmed 404) -- refusing to guess whether to restore or delete it" >&2
      had_failure=1
      continue
    fi

    if [[ -n "$gen" ]]; then
      if [[ "$ROLLBACK_CUR_STATE" == "present" && "$ROLLBACK_CUR_GEN" == "$gen" ]]; then
        echo "  $obj is still at its prior generation ($gen) -- its own upload never actually mutated it, nothing to restore" >&2
      else
        echo "  restoring gs://$BUCKET/$obj to its prior generation" >&2
        if ! gcloud storage cp --quiet "gs://$BUCKET/$obj#$gen" "gs://$BUCKET/$obj"; then
          echo "  ROLLBACK STEP FAILED: could not restore $obj to its prior generation" >&2
          had_failure=1
        fi
      fi
    else
      if [[ "$ROLLBACK_CUR_STATE" == "absent" ]]; then
        echo "  $obj was never actually created -- nothing to delete" >&2
      else
        echo "  deleting newly created gs://$BUCKET/$obj" >&2
        if ! err_text="$(gcloud storage rm --quiet "gs://$BUCKET/$obj" 2>&1)"; then
          if is_genuine_404 "$err_text"; then
            echo "  (already absent -- nothing to delete)" >&2
          else
            echo "  ROLLBACK STEP FAILED: could not delete newly created $obj: $err_text" >&2
            had_failure=1
          fi
        fi
      fi
    fi
  done
  return "$had_failure"
}

# report_failure_and_rollback MESSAGE [EXIT_CODE]: prints the ORIGINAL
# failure first (never overwritten by rollback's own outcome), attempts
# rollback, and -- if rollback itself fails -- says so explicitly instead of
# ever reporting success. Always exits non-zero (fix round 1 Critical
# finding: this is the single path every mutating failure now funnels
# through, replacing several places that previously called `rollback; exit 1`
# without checking whether the rollback itself actually succeeded).
report_failure_and_rollback() {
  local msg="$1" code="${2:-1}"
  echo "upload-mirofish-static: $msg" >&2
  if ! rollback; then
    echo "upload-mirofish-static: ROLLBACK FAILED -- release may be in a mixed state; manual recovery required" >&2
  fi
  exit "$code"
}

# Unexpected-failure safety net, LAST-RESORT ONLY (fix round 1 Critical
# finding, narrowed in fix round 2). Every REACHABLE mktemp/sha256_of call
# below is now explicitly guarded with `if ! ... ; then report_failure_...`
# -- not left to this trap -- because fix round 2 found that relying on the
# ERR trap for a bare `var="$(external_cmd)"` assignment double-fires: `-E`
# (errtrace) forces bash to keep a real subshell alive for that command
# substitution (instead of its usual exec-replace optimization) so the trap
# CAN run inside it; that inner firing pollutes the captured output with
# the trap's own messages and performs a full (redundant) rollback, and the
# outer assignment's own now-failed exit status then fires this same trap
# a SECOND time in the parent shell. Reproduced and confirmed directly:
#   PATH=<fake-mktemp-that-fails>:$PATH bash -c '
#     set -Eeuo pipefail; trap on_err ERR
#     for i in 1 2; do x="$(echo ok)"; tmp="$(mktemp)"; done'
#   # -> the trap fires twice (+++ then ++ in `bash -x`), both times
#   # running the full handler, before the explicit-guard fix below.
# This trap now only remains as defense-in-depth for a genuinely
# UNREACHABLE command-substitution failure (e.g. content_type_for/
# cache_control_for's internal `fail()`, which validate_build's own
# allowlist already guarantees never happens) -- if one of those
# essentially-impossible paths were ever hit, the same double-fire could
# recur, but rollback() and the delete-path's absent-is-fine handling are
# both idempotent, so a redundant second pass is wasteful, not unsafe.
on_unexpected_err() {
  local code=$?
  trap - ERR
  report_failure_and_rollback "unexpected failure (exit $code) during upload" "$code"
}

# TMP_DOWNLOAD cleanup is a plain EXIT trap, independent of the ERR trap
# above: it fires no matter how the script exits (success, an explicit
# `exit 1`, or the ERR trap's own `exit`), and never re-arms anything.
TMP_DOWNLOAD=""
cleanup_tmp_download() {
  # `if`, not `[[ ]] && rm`: under `set -e`, an EXIT trap's own final exit
  # status overrides a successful script's exit status, and a bare `&&`
  # whose left side is false (the common case: TMP_DOWNLOAD already
  # cleared) itself returns 1 -- which would turn a fully successful run
  # into a false non-zero exit. An `if` with no matching branch is always 0.
  if [[ -n "$TMP_DOWNLOAD" && -f "$TMP_DOWNLOAD" ]]; then
    rm -f "$TMP_DOWNLOAD"
  fi
}
trap cleanup_tmp_download EXIT

# PRIOR_GEN is set by describe_prior_generation (bash functions cannot
# return strings; this mirrors the DONE_* globals' pattern).
PRIOR_GEN=""

# is_genuine_404 TEXT: true only for an UNAMBIGUOUS "object does not exist"
# signal. Fix round 2 finding: the round 1 classifier accepted any message
# containing the bare substring "not found" -- which also matches an
# ambiguous message like a 403 whose body happens to mention "not found"
# for an unrelated reason (e.g. "HTTPError 403: Forbidden (bucket policy
# not found for this principal)"). Any permission/forbidden signal present
# now disqualifies the message outright, REGARDLESS of what else it says;
# only then do we look for a confirmed zero-match shape: gcloud storage's
# own exact zero-match phrasing, a NotFoundException, or a standalone 404
# status code (word-boundary, so "1404"/"4040" can never match).
is_genuine_404() {
  local text="$1"
  if grep -qiE '\b(403|forbidden|permissiondenied|accessdenied)\b' <<<"$text"; then
    return 1
  fi
  grep -qE 'matched no objects or files|NotFoundException|No such object or bucket' <<<"$text" ||
    grep -qE '(^|[^0-9])404([^0-9]|$)' <<<"$text"
}

# describe_prior_generation REL: sets PRIOR_GEN to the object's current live
# generation, or "" if it genuinely does not exist yet (fix round 1 High
# finding: a blanket `|| true` previously treated EVERY describe failure --
# including a 403 permission error or a transient network failure -- as "the
# object does not exist", which would make a later rollback DELETE a real
# existing object instead of restoring it). Only a confirmed 404
# (is_genuine_404 above) is treated as absence; anything else -- including
# an ambiguous message -- aborts (rolling back whatever this attempt
# already touched) rather than guessing.
describe_prior_generation() {
  local rel="$1" out err_file err_text
  # Explicitly guarded (fix round 2): see on_unexpected_err's comment for
  # why a bare `err_file="$(mktemp)"` here would double-fire the ERR trap.
  if ! err_file="$(mktemp)"; then
    report_failure_and_rollback "mktemp failed while checking prior state of $rel"
  fi
  if out="$(gcloud storage objects describe "gs://$BUCKET/$rel" --format="value(generation)" 2>"$err_file")"; then
    PRIOR_GEN="$out"
    rm -f "$err_file"
    return
  fi
  err_text="$(cat "$err_file")"
  rm -f "$err_file"
  if is_genuine_404 "$err_text"; then
    PRIOR_GEN=""
    return
  fi
  report_failure_and_rollback "could not determine prior state of $rel (describe failed, and not with a confirmed 404 -- refusing to assume it is a new object): $err_text"
}

validate_build
echo "upload-mirofish-static: build validated ($OUT_DIR)"

# Keep upload/rollback order identical on macOS and Linux regardless of locale.
mapfile -d '' -t FILES < <(find "$OUT_DIR" -type f -print0 | LC_ALL=C sort -z)

# Armed only for the mutation-risking region below: a preflight failure
# above never needs rollback (nothing was ever touched), and nothing after
# the loop performs a GCS call either.
trap on_unexpected_err ERR

for f in "${FILES[@]}"; do
  rel="${f#"$OUT_DIR"/}"
  content_type="$(content_type_for "$rel")"
  cache_control="$(cache_control_for "$rel")"
  # Explicitly guarded (fix round 2): see on_unexpected_err's comment above
  # for why a bare `local_sha="$(sha256_of "$f")"` here would double-fire.
  if ! local_sha="$(sha256_of "$f")"; then
    report_failure_and_rollback "could not hash local file for $rel"
  fi

  describe_prior_generation "$rel"
  prior_gen="$PRIOR_GEN"

  # Pending rollback journal entry, recorded BEFORE the upload is even
  # issued (fix round 2 Critical finding): previously this was only
  # appended AFTER the upload succeeded and was later re-appended in each
  # failure branch below. That left a gap -- if `gcloud storage cp`
  # (upload) succeeded but the very next statement (`mktemp`, `sha256_of`)
  # failed via the ERR trap before any explicit branch ran, THIS object was
  # not yet journaled and rollback() restored every OTHER object but
  # silently skipped the one actually left in a mutated state. Journaling
  # first makes rollback cover every subsequent failure for this object --
  # including the upload command itself failing outright, which rollback
  # now handles idempotently (see rollback()'s own comment).
  DONE_OBJECTS+=("$rel")
  DONE_PRIOR_GEN+=("$prior_gen")

  if ! gcloud storage cp --quiet \
    --content-type="$content_type" --cache-control="$cache_control" \
    "$f" "gs://$BUCKET/$rel"; then
    report_failure_and_rollback "upload failed for $rel"
  fi

  # Explicitly guarded (fix round 2): see on_unexpected_err's comment above
  # for why a bare `tmp_download="$(mktemp)"` here would double-fire.
  if ! tmp_download="$(mktemp)"; then
    report_failure_and_rollback "mktemp failed while preparing to verify $rel"
  fi
  TMP_DOWNLOAD="$tmp_download"
  if ! gcloud storage cp --quiet "gs://$BUCKET/$rel" "$tmp_download"; then
    report_failure_and_rollback "post-upload verification download failed for $rel"
  fi
  if ! remote_sha="$(sha256_of "$tmp_download")"; then
    report_failure_and_rollback "could not hash downloaded content for $rel"
  fi
  rm -f "$tmp_download"
  TMP_DOWNLOAD=""
  if [[ "$remote_sha" != "$local_sha" ]]; then
    report_failure_and_rollback "SHA-256 mismatch for $rel: uploaded content does not match the source file"
  fi

  if ! remote_ct="$(gcloud storage objects describe "gs://$BUCKET/$rel" --format="value(content_type)" 2>&1)"; then
    report_failure_and_rollback "metadata verification failed for $rel (content-type describe): $remote_ct"
  fi
  if ! remote_cc="$(gcloud storage objects describe "gs://$BUCKET/$rel" --format="value(cache_control)" 2>&1)"; then
    report_failure_and_rollback "metadata verification failed for $rel (cache-control describe): $remote_cc"
  fi
  if [[ "$remote_ct" != "$content_type" || "$remote_cc" != "$cache_control" ]]; then
    report_failure_and_rollback "metadata mismatch for $rel (content-type or cache-control)"
  fi

  echo "ok   $rel (${prior_gen:+replaced, was gen $prior_gen}${prior_gen:-new object})"
done

trap - ERR
echo "upload-mirofish-static: uploaded ${#FILES[@]} object(s) from $OUT_DIR to gs://$BUCKET"
