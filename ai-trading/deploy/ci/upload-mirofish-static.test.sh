#!/usr/bin/env bash
# Offline test for upload-mirofish-static.sh: no real GCS/gcloud, no
# network, no real provider key anywhere. A fake `gcloud` binary on PATH
# models a *versioned* GCS bucket in a plain scratch directory tree (one
# subdirectory per object, one file per generation, a "live" pointer file),
# so this test can assert the real rollback contract end to end:
#   - a complete, valid MiroFish Vue build (the real dist/ shape from Task 3:
#     index.html, icon.png, assets/*-HASH.{js,css,jpeg}) uploads every file,
#     each with the right Content-Type and Cache-Control.
#   - the benign, unmodified upstream i18n literal "ZEP_API_KEY not
#     configured" / "ZEP_API_KEY未配置" (present verbatim in the real build)
#     never trips the secret scan.
#   - missing index.html, missing hashed assets/, a symlink, an unexpected
#     extension, a dev-only localhost:5001 reference, and a real
#     secret-shaped string (sk-..., ZEP_API_KEY=...) each fail BEFORE any
#     gcloud call.
#   - re-uploading over an existing release records the prior generation
#     (before/after generation tracking).
#   - a forced hard upload failure, and a forced silent-corruption failure
#     caught only by this script's own SHA-256 verification, both roll back
#     every object this attempt touched: existing objects are restored to
#     their prior generation's content, brand-new objects are deleted, and
#     the untouched prior release is byte-for-byte unchanged afterward.
# No real `gcloud`/`gsutil` binary is ever invoked: PATH is overridden to
# the mock only, and the mock never makes a network call.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/upload-mirofish-static.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

PASS_COUNT=0
pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "ok   $*"
}

# --- Fixture: the real Task 3 dist/ shape ----------------------------------
# Mirrors ai-trading/frontend-artifacts/mirofish/ exactly: index.html,
# icon.png, assets/index-<hash>.js (containing the real, unmodified i18n
# "ZEP_API_KEY not configured" label -- never a real key), assets/index-<hash>.css,
# assets/<name>-<hash>.jpeg.
build_valid_fixture() {
  local dir="$1"
  mkdir -p "$dir/assets"
  cat >"$dir/index.html" <<'HTML'
<!doctype html><html><head><link rel="stylesheet" href="/assets/index-7vLnMbyK.css"></head>
<body><div id="app"></div><script type="module" src="/assets/index-DVY-GYHM.js"></script></body></html>
HTML
  printf '\x89PNG\r\n\x1a\n-fake-icon-bytes-' >"$dir/icon.png"
  cat >"$dir/assets/index-DVY-GYHM.js" <<'JS'
const zepApiKeyMissing = "ZEP_API_KEY not configured";
const zepApiKeyMissingZh = "ZEP_API_KEY未配置";
console.log(zepApiKeyMissing, zepApiKeyMissingZh);
JS
  echo 'body{margin:0}' >"$dir/assets/index-7vLnMbyK.css"
  printf '\xff\xd8\xff\xe0-fake-jpeg-bytes-' >"$dir/assets/MiroFish_logo_left-Bf5baAoU.jpeg"
}

# --- Fake gcloud: models a versioned GCS bucket on local disk --------------
# Layout under $FAKE_GCS_ROOT/$BUCKET/_objects/$OBJECT_PATH/:
#   counter            last-used generation number (monotonic per object)
#   live               current live generation number, or empty/absent if
#                       the object does not exist (deleted or never created)
#   generations/$N.content / $N.meta (content_type\ncache_control)
MOCK_BIN="$WORKDIR/bin"
mkdir -p "$MOCK_BIN"
FAKE_GCS_ROOT="$WORKDIR/fake-gcs"
mkdir -p "$FAKE_GCS_ROOT"
CALL_LOG="$WORKDIR/gcloud-calls.log"
: >"$CALL_LOG"

cat >"$MOCK_BIN/gcloud" <<'MOCK_EOF'
#!/usr/bin/env bash
# Fake `gcloud storage` covering exactly the subcommands
# upload-mirofish-static.sh issues. Never touches the network.
set -Eeuo pipefail
printf '%s\n' "$*" >>"$CALL_LOG"

obj_dir() { # BUCKET OBJECT
  echo "$FAKE_GCS_ROOT/$1/_objects/$2"
}

parse_gs() { # gs://bucket/object[#gen] -> prints "bucket\tobject\tgen(or empty)"
  local url="${1#gs://}" bucket obj gen=""
  bucket="${url%%/*}"
  obj="${url#*/}"
  if [[ "$obj" == *"#"* ]]; then
    gen="${obj##*#}"
    obj="${obj%#*}"
  fi
  printf '%s\t%s\t%s\n' "$bucket" "$obj" "$gen"
}

[[ "$1" == "storage" ]] || { echo "fake gcloud: unsupported command $*" >&2; exit 2; }
shift

case "$1" in
  cp)
    shift
    content_type="" cache_control="" quiet=0
    args=()
    while (($#)); do
      case "$1" in
        --content-type=*) content_type="${1#*=}" ;;
        --cache-control=*) cache_control="${1#*=}" ;;
        --quiet) quiet=1 ;;
        *) args+=("$1") ;;
      esac
      shift
    done
    src="${args[0]}" dst="${args[1]}"

    if [[ "$src" != gs://* && "$dst" == gs://* ]]; then
      # Upload: local file -> new live generation.
      IFS=$'\t' read -r bucket obj _ <<<"$(parse_gs "$dst")"
      [[ "$obj" != "${FAIL_UPLOAD_OBJECT:-}" ]] || { echo "fake gcloud: simulated upload failure for $obj" >&2; exit 1; }
      dir="$(obj_dir "$bucket" "$obj")"
      mkdir -p "$dir/generations"
      prev=0; [[ -f "$dir/counter" ]] && prev="$(<"$dir/counter")"
      next=$((prev + 1))
      if [[ "$obj" == "${CORRUPT_OBJECT:-}" ]]; then
        cp "$src" "$dir/generations/$next.content"
        printf 'CORRUPTED' >>"$dir/generations/$next.content"
      else
        cp "$src" "$dir/generations/$next.content"
      fi
      printf '%s\n%s\n' "$content_type" "$cache_control" >"$dir/generations/$next.meta"
      echo "$next" >"$dir/counter"
      echo "$next" >"$dir/live"
    elif [[ "$src" == gs://* && "$dst" != gs://* ]]; then
      # Download: live content -> local file.
      IFS=$'\t' read -r bucket obj _ <<<"$(parse_gs "$src")"
      dir="$(obj_dir "$bucket" "$obj")"
      live=""; [[ -s "$dir/live" ]] && live="$(<"$dir/live")"
      [[ -n "$live" ]] || { echo "fake gcloud: no such object $src" >&2; exit 1; }
      cp "$dir/generations/$live.content" "$dst"
    elif [[ "$src" == gs://* && "$dst" == gs://* ]]; then
      # Restore-from-generation: gs://b/o#GEN -> gs://b/o (new live generation
      # carrying that old generation's content and metadata).
      IFS=$'\t' read -r sbucket sobj sgen <<<"$(parse_gs "$src")"
      IFS=$'\t' read -r dbucket dobj _ <<<"$(parse_gs "$dst")"
      [[ "$dobj" != "${FORCE_ROLLBACK_FAIL_OBJECT:-}" ]] ||
        { echo "fake gcloud: simulated rollback-restore failure for $dobj" >&2; exit 1; }
      sdir="$(obj_dir "$sbucket" "$sobj")"
      ddir="$(obj_dir "$dbucket" "$dobj")"
      [[ -n "$sgen" && -f "$sdir/generations/$sgen.content" ]] || { echo "fake gcloud: no such generation $src" >&2; exit 1; }
      mkdir -p "$ddir/generations"
      prev=0; [[ -f "$ddir/counter" ]] && prev="$(<"$ddir/counter")"
      next=$((prev + 1))
      cp "$sdir/generations/$sgen.content" "$ddir/generations/$next.content"
      cp "$sdir/generations/$sgen.meta" "$ddir/generations/$next.meta"
      echo "$next" >"$ddir/counter"
      echo "$next" >"$ddir/live"
    else
      echo "fake gcloud: unsupported cp form: $src -> $dst" >&2
      exit 2
    fi
    ;;
  rm)
    shift
    url=""
    for a in "$@"; do [[ "$a" == gs://* ]] && url="$a"; done
    IFS=$'\t' read -r bucket obj _ <<<"$(parse_gs "$url")"
    [[ "$obj" != "${FORCE_ROLLBACK_FAIL_OBJECT:-}" ]] ||
      { echo "fake gcloud: simulated rollback-delete failure for $obj" >&2; exit 1; }
    dir="$(obj_dir "$bucket" "$obj")"
    # Soft delete semantics on a versioned bucket: clear the live pointer
    # only. Generation history is never removed.
    : >"$dir/live"
    ;;
  objects)
    shift
    [[ "$1" == "describe" ]] || { echo "fake gcloud: unsupported objects subcommand $*" >&2; exit 2; }
    shift
    url="$1"; shift
    format=""
    for a in "$@"; do
      [[ "$a" == --format=* ]] && format="${a#--format=}"
    done
    IFS=$'\t' read -r bucket obj _ <<<"$(parse_gs "$url")"
    # Simulates a 403/permission or network failure -- deliberately NOT the
    # same error shape as genuine absence below -- so the real script's
    # classifier must be exercised on a non-404 failure, not just assumed.
    # Scoped to ONLY the pre-upload prior-generation check (value(generation)):
    # that is the specific describe call this mechanism tests the
    # classifier against. A genuinely new object's POST-upload metadata
    # describe calls (content_type/cache_control) must still succeed
    # normally once it is actually live -- forcing those too would make
    # every "treat this as a genuine 404" test fail for an unrelated reason
    # downstream. FORCE_METADATA_DESCRIBE_FAIL_OBJECT below is the
    # dedicated mechanism for failing THOSE calls instead.
    if [[ "$obj" == "${FORCE_DESCRIBE_ERROR_OBJECT:-}" && "$format" == "value(generation)" ]]; then
      echo "${FORCE_DESCRIBE_ERROR_TEXT:-ERROR: (gcloud.storage.objects.describe) HTTPError 403: Forbidden}" >&2
      exit 1
    fi
    # Fix round 3: precise, call-COUNT-based targeting (not object-name
    # based) across every `objects describe ... value(generation)` call in
    # this one script invocation -- pre-upload prior-generation checks AND
    # rollback's own current-generation checks both use this exact format,
    # so this is how a test pins down the Nth one specifically (e.g. the
    # rollback-time check for a particular object, not its earlier
    # pre-upload check).
    if [[ -n "${DESCRIBE_GEN_COUNTER_FILE:-}" && "$format" == "value(generation)" ]]; then
      n=0
      [[ -f "$DESCRIBE_GEN_COUNTER_FILE" ]] && n="$(<"$DESCRIBE_GEN_COUNTER_FILE")"
      n=$((n + 1))
      echo "$n" >"$DESCRIBE_GEN_COUNTER_FILE"
      if [[ -n "${FAIL_DESCRIBE_GEN_AT_CALL:-}" && "$n" == "${FAIL_DESCRIBE_GEN_AT_CALL}" ]]; then
        echo "${FAIL_DESCRIBE_GEN_TEXT:-ERROR: (gcloud.storage.objects.describe) HTTPError 403: Forbidden (call $n)}" >&2
        exit 1
      fi
    fi
    # Isolates testing the POST-upload metadata-verification describe calls
    # (content_type/cache_control) from the PRE-upload prior-generation
    # describe for the same object: only the named --format fails.
    if [[ "$obj" == "${FORCE_METADATA_DESCRIBE_FAIL_OBJECT:-}" && "$format" == "value(${FORCE_METADATA_DESCRIBE_FAIL_FIELD:-content_type})" ]]; then
      echo "fake gcloud: simulated metadata describe failure for $obj ($format)" >&2
      exit 1
    fi
    dir="$(obj_dir "$bucket" "$obj")"
    live=""; [[ -f "$dir/live" && -s "$dir/live" ]] && live="$(<"$dir/live")"
    if [[ -z "$live" ]]; then
      # Real `gcloud storage` 404 shape for a describe on a path with zero
      # matches -- the exact phrase the script's classifier looks for.
      echo "ERROR: (gcloud.storage.objects.describe) The following URLs matched no objects or files: $url" >&2
      exit 1
    fi
    case "$format" in
      "value(generation)") echo "$live" ;;
      "value(content_type)") sed -n '1p' "$dir/generations/$live.meta" ;;
      "value(cache_control)") sed -n '2p' "$dir/generations/$live.meta" ;;
      *) echo "fake gcloud: unsupported format $format" >&2; exit 2 ;;
    esac
    ;;
  *)
    echo "fake gcloud: unsupported storage subcommand $*" >&2
    exit 2
    ;;
esac
MOCK_EOF
chmod +x "$MOCK_BIN/gcloud"

# --- Fake mktemp / sha256sum: transparent passthroughs to the REAL binaries
# unless a specific invocation COUNT is targeted. These resolve the real
# binaries' paths NOW, before PATH is overridden below, and exec straight
# through to them for every call except the one being deliberately failed --
# so every other test in this file (which never sets the *_COUNTER_FILE/
# FAIL_*_AT_CALL env vars) behaves identically to using the system mktemp/
# sha256sum directly. This is how fix round 2's "injected post-upload
# mktemp/hash failure" tests simulate a real command actually failing
# (distinct from gcloud failing), without faking gcloud itself.
REAL_MKTEMP="$(command -v mktemp)"
REAL_SHA256SUM="$(command -v sha256sum || true)"
REAL_CAT="$(command -v cat)"
REAL_RM="$(command -v rm)"
export REAL_MKTEMP REAL_SHA256SUM REAL_CAT REAL_RM

cat >"$MOCK_BIN/mktemp" <<'MOCK_MKTEMP_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${MKTEMP_COUNTER_FILE:-}" ]]; then
  n=0
  [[ -f "$MKTEMP_COUNTER_FILE" ]] && n="$(<"$MKTEMP_COUNTER_FILE")"
  n=$((n + 1))
  echo "$n" >"$MKTEMP_COUNTER_FILE"
  if [[ -n "${FAIL_MKTEMP_AT_CALL:-}" && "$n" == "${FAIL_MKTEMP_AT_CALL}" ]]; then
    echo "fake mktemp: simulated failure at call $n" >&2
    exit 1
  fi
fi
exec "$REAL_MKTEMP" "$@"
MOCK_MKTEMP_EOF
chmod +x "$MOCK_BIN/mktemp"

cat >"$MOCK_BIN/sha256sum" <<'MOCK_SHA256_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${SHA256_COUNTER_FILE:-}" ]]; then
  n=0
  [[ -f "$SHA256_COUNTER_FILE" ]] && n="$(<"$SHA256_COUNTER_FILE")"
  n=$((n + 1))
  echo "$n" >"$SHA256_COUNTER_FILE"
  if [[ -n "${FAIL_SHA256_AT_CALL:-}" && "$n" == "${FAIL_SHA256_AT_CALL}" ]]; then
    echo "fake sha256sum: simulated failure at call $n" >&2
    exit 1
  fi
fi
if [[ -n "${REAL_SHA256SUM:-}" ]]; then
  exec "$REAL_SHA256SUM" "$@"
fi
exec shasum -a 256 "$@"
MOCK_SHA256_EOF
chmod +x "$MOCK_BIN/sha256sum"

# Fake cat/rm (fix round 4): same transparent-passthrough-unless-targeted
# design as mktemp/sha256sum above. These exist to reproduce fix round 4's
# finding -- rollback_current_generation()'s own bare `cat`/`rm` on a
# scratch err_file -- without touching gcloud itself. Counting is scoped
# PURELY to the real script under test: every internal `cat`/`rm` use
# inside this test file's own mock machinery was converted to bash's `cat`
# -free builtin file read (`$(<file)`) or an explicit "$REAL_CAT" call, so
# none of that counts here and a *_AT_CALL value always targets the real
# script's own invocation, not an accidental one from this harness.
cat >"$MOCK_BIN/cat" <<'MOCK_CAT_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${CAT_COUNTER_FILE:-}" ]]; then
  n=0
  [[ -f "$CAT_COUNTER_FILE" ]] && n="$(<"$CAT_COUNTER_FILE")"
  n=$((n + 1))
  echo "$n" >"$CAT_COUNTER_FILE"
  if [[ -n "${FAIL_CAT_AT_CALL:-}" && "$n" == "${FAIL_CAT_AT_CALL}" ]]; then
    echo "fake cat: simulated failure at call $n" >&2
    exit 1
  fi
fi
exec "$REAL_CAT" "$@"
MOCK_CAT_EOF
chmod +x "$MOCK_BIN/cat"

cat >"$MOCK_BIN/rm" <<'MOCK_RM_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -n "${RM_COUNTER_FILE:-}" ]]; then
  n=0
  [[ -f "$RM_COUNTER_FILE" ]] && n="$(<"$RM_COUNTER_FILE")"
  n=$((n + 1))
  echo "$n" >"$RM_COUNTER_FILE"
  if [[ -n "${FAIL_RM_AT_CALL:-}" && "$n" == "${FAIL_RM_AT_CALL}" ]]; then
    echo "fake rm: simulated failure at call $n" >&2
    exit 1
  fi
fi
exec "$REAL_RM" "$@"
MOCK_RM_EOF
chmod +x "$MOCK_BIN/rm"

export FAKE_GCS_ROOT CALL_LOG
# PATH override: the mocks are first, so the real gcloud/gsutil on this
# machine is never resolved for the `gcloud` command name. No real
# credential, project, or API endpoint is ever referenced below.
export PATH="$MOCK_BIN:$PATH"

live_gen() { # BUCKET OBJECT
  local dir="$FAKE_GCS_ROOT/$1/_objects/$2"
  # "$REAL_CAT" (not a bare `cat`): this helper must never be counted by,
  # or resolve to, the fake `cat` below -- it is test-harness plumbing, not
  # part of what a *_AT_CALL counter is meant to target.
  [[ -f "$dir/live" && -s "$dir/live" ]] && "$REAL_CAT" "$dir/live" || echo ""
}
live_content() { # BUCKET OBJECT
  local dir="$FAKE_GCS_ROOT/$1/_objects/$2" g
  g="$(live_gen "$1" "$2")"
  # "$REAL_CAT", not a bare `cat`: this streams possibly-binary object
  # content straight to stdout for `diff <(live_content ...) file` -- it
  # must never be intercepted (binary bytes through a fake cat would also
  # be unsafe to round-trip through a counting wrapper's own shell logic).
  [[ -n "$g" ]] && "$REAL_CAT" "$dir/generations/$g.content"
}

BUCKET="test-mirofish-bucket-fake"

# =========================================================================
# RED: preflight failures, each BEFORE any gcloud call
# =========================================================================
: >"$CALL_LOG"
D="$WORKDIR/red-missing-index"; mkdir -p "$D/assets"
echo x >"$D/assets/index-ABCDEF123.js"
out="$("$TARGET" "$D" "$BUCKET" 2>&1)" && fail "expected failure: missing index.html"
grep -q "missing index.html" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite missing index.html"
pass "missing index.html fails closed, zero gcloud calls"

: >"$CALL_LOG"
D="$WORKDIR/red-missing-assets"; mkdir -p "$D"
echo "<html></html>" >"$D/index.html"
out="$("$TARGET" "$D" "$BUCKET" 2>&1)" && fail "expected failure: missing assets/"
grep -q "missing assets/ directory" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite missing assets/"
pass "missing assets/ directory fails closed"

: >"$CALL_LOG"
D="$WORKDIR/red-no-hashed"; mkdir -p "$D/assets"
echo "<html></html>" >"$D/index.html"
echo "body{}" >"$D/assets/style.css"
out="$("$TARGET" "$D" "$BUCKET" 2>&1)" && fail "expected failure: no hash-named asset"
grep -q "no hash-named asset found" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite no hashed asset"
pass "missing hash-named asset under assets/ fails closed"

: >"$CALL_LOG"
D="$WORKDIR/red-symlink"; build_valid_fixture "$D"
ln -s "$D/index.html" "$D/assets/sneaky-ABCDEF12.js"
out="$("$TARGET" "$D" "$BUCKET" 2>&1)" && fail "expected failure: symlink present"
grep -q "symlink" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite a symlink"
pass "symlink in build output fails closed"

: >"$CALL_LOG"
D="$WORKDIR/red-bad-ext"; build_valid_fixture "$D"
echo "#!/bin/sh" >"$D/assets/leftover-ABCDEF12.sh"
out="$("$TARGET" "$D" "$BUCKET" 2>&1)" && fail "expected failure: unexpected extension"
grep -q "unexpected" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite an unexpected extension"
pass "unexpected extension fails closed"

: >"$CALL_LOG"
D="$WORKDIR/red-localhost"; build_valid_fixture "$D"
echo 'fetch("http://localhost:5001/api")' >>"$D/assets/index-DVY-GYHM.js"
out="$("$TARGET" "$D" "$BUCKET" 2>&1)" && fail "expected failure: localhost:5001 reference"
grep -q "localhost:5001" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite a localhost:5001 reference"
pass "localhost:5001 reference fails closed"

: >"$CALL_LOG"
D="$WORKDIR/red-secret"; build_valid_fixture "$D"
echo 'const LEAK="sk-THISISAFAKETAINTEDTOKEN1234567890";' >>"$D/assets/index-DVY-GYHM.js"
out="$("$TARGET" "$D" "$BUCKET" 2>&1)" && fail "expected failure: real secret-shaped string"
grep -q "secret-shaped string" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite a leaked secret-shaped string"
pass "real secret-shaped string fails closed"

# =========================================================================
# GREEN: benign i18n literal never trips the secret scan; full happy path
# =========================================================================
: >"$CALL_LOG"
D="$WORKDIR/green-first-deploy"; build_valid_fixture "$D"
out="$("$TARGET" "$D" "$BUCKET" 2>&1)" || fail "script exited non-zero on a valid build: $out"
grep -q "ZEP_API_KEY not configured" "$D/assets/index-DVY-GYHM.js" ||
  fail "test fixture lost the benign i18n literal it is supposed to carry"
grep -q "uploaded 5 object(s)" <<<"$out" || fail "missing success summary: $out"
pass "benign 'ZEP_API_KEY not configured' i18n literal does not trip the secret scan"

for obj in index.html icon.png assets/index-DVY-GYHM.js assets/index-7vLnMbyK.css assets/MiroFish_logo_left-Bf5baAoU.jpeg; do
  gen="$(live_gen "$BUCKET" "$obj")"
  [[ -n "$gen" ]] || fail "object $obj was not uploaded"
  [[ "$gen" == "1" ]] || fail "expected first-deploy generation 1 for $obj, got $gen"
  diff <(live_content "$BUCKET" "$obj") "$D/$obj" >/dev/null || fail "uploaded content for $obj does not match source"
done
pass "first deploy: every object live at generation 1 with byte-identical content"

html_ct="$(sed -n '1p' "$FAKE_GCS_ROOT/$BUCKET/_objects/index.html/generations/1.meta")"
html_cc="$(sed -n '2p' "$FAKE_GCS_ROOT/$BUCKET/_objects/index.html/generations/1.meta")"
[[ "$html_ct" == "text/html; charset=utf-8" ]] || fail "wrong index.html content-type: $html_ct"
[[ "$html_cc" == "no-cache, max-age=0, must-revalidate" ]] || fail "wrong index.html cache-control: $html_cc"

js_cc="$(sed -n '2p' "$FAKE_GCS_ROOT/$BUCKET/_objects/assets/index-DVY-GYHM.js/generations/1.meta")"
[[ "$js_cc" == "public, max-age=31536000, immutable" ]] || fail "wrong hashed-asset cache-control: $js_cc"
js_ct="$(sed -n '1p' "$FAKE_GCS_ROOT/$BUCKET/_objects/assets/index-DVY-GYHM.js/generations/1.meta")"
[[ "$js_ct" == "application/javascript" ]] || fail "wrong hashed-asset content-type: $js_ct"

icon_cc="$(sed -n '2p' "$FAKE_GCS_ROOT/$BUCKET/_objects/icon.png/generations/1.meta")"
[[ "$icon_cc" == "public, max-age=3600" ]] || fail "wrong non-hashed root asset cache-control: $icon_cc"
pass "per-object Content-Type and Cache-Control set correctly by extension"

# =========================================================================
# GREEN: before/after generation tracking on a re-deploy
# =========================================================================
: >"$CALL_LOG"
D2="$WORKDIR/green-second-deploy"; build_valid_fixture "$D2"
echo 'console.log("v2");' >>"$D2/assets/index-DVY-GYHM.js"
"$TARGET" "$D2" "$BUCKET" >/dev/null || fail "second deploy failed"
gen2="$(live_gen "$BUCKET" "assets/index-DVY-GYHM.js")"
[[ "$gen2" == "2" ]] || fail "expected generation 2 after re-deploy, got $gen2"
diff <(live_content "$BUCKET" "assets/index-DVY-GYHM.js") "$D2/assets/index-DVY-GYHM.js" >/dev/null ||
  fail "re-deployed content does not match the new source"
# Generation 1's content is retained untouched (never deleted).
[[ -f "$FAKE_GCS_ROOT/$BUCKET/_objects/assets/index-DVY-GYHM.js/generations/1.content" ]] ||
  fail "prior generation 1 content was deleted on a clean re-deploy"
pass "re-deploy: prior generation recorded, new generation live, old generation retained"

# =========================================================================
# RED + rollback: forced hard upload-command failure partway through
# =========================================================================
# upload-mirofish-static.sh processes files in `find | sort` order, which
# for this fixture is (byte sort, confirmed against the real
# implementation): assets/MiroFish_logo_left-*.jpeg, assets/index-*.css,
# assets/index-*.js, icon.png, index.html -- i.e. index.html is uploaded
# LAST. Failing on index.html therefore means every other object has
# ALREADY been re-uploaded (and verified) this attempt before the failure,
# which is the strongest rollback test: all five are journaled (fix round
# 2), but only the four genuinely mutated ones are actually restored --
# index.html itself (fix round 3: rollback now describes its ACTUAL
# current generation before acting) is left untouched, since its own
# upload command never ran/mutated anything: no restore-copy call, no new
# (wasted) generation.
: >"$CALL_LOG"
D3="$WORKDIR/fail-hard"; build_valid_fixture "$D3" # baseline JS (no "v2"): differs from the current live (D2) JS content
pre_html_gen="$(live_gen "$BUCKET" "index.html")"
out="$(FAIL_UPLOAD_OBJECT="index.html" "$TARGET" "$D3" "$BUCKET" 2>&1)" &&
  fail "expected non-zero exit on forced upload failure"
grep -q "upload failed for index.html" <<<"$out" || fail "missing failure message: $out"
grep -q "rolling back 5 object" <<<"$out" ||
  fail "expected exactly 5 journaled objects (incl. index.html itself, journaled pre-upload): $out"

# index.html's own upload command failed outright (nothing was ever
# written): its generation must be UNCHANGED (fix round 3 -- no wasted
# restore-from-itself generation bump), its content untouched, and NO
# restore-copy call issued for it at all.
post_html_gen="$(live_gen "$BUCKET" "index.html")"
[[ "$post_html_gen" == "$pre_html_gen" ]] ||
  fail "index.html's generation changed even though its own upload never mutated it: $pre_html_gen -> $post_html_gen"
diff <(live_content "$BUCKET" "index.html") "$D2/index.html" >/dev/null ||
  fail "index.html content changed even though its own upload failed"
grep -qF "index.html#$pre_html_gen" "$CALL_LOG" &&
  fail "a restore-copy call was issued for index.html even though it was never mutated: $(<"$CALL_LOG")"
grep -q "index.html is still at its prior generation ($pre_html_gen) -- its own upload never actually mutated it, nothing to restore" <<<"$out" ||
  fail "missing the 'nothing to restore' message for the unmutated index.html: $out"

# The JS object WAS re-uploaded with D3's different (no "v2") content before
# the later index.html failure -- rollback must restore it to the
# pre-attempt (D2, "+v2") release content, not leave D3's content live.
diff <(live_content "$BUCKET" "assets/index-DVY-GYHM.js") "$D2/assets/index-DVY-GYHM.js" >/dev/null ||
  fail "JS object was not restored to the pre-attempt (D2) release content"
! diff <(live_content "$BUCKET" "assets/index-DVY-GYHM.js") "$D3/assets/index-DVY-GYHM.js" >/dev/null 2>&1 ||
  fail "JS object was left on the failed attempt's content instead of being rolled back"
pass "forced hard upload failure: full rollback restores the pre-attempt release"

# =========================================================================
# RED + rollback: forced silent corruption, caught only by SHA-256 verify
# =========================================================================
# Corrupt the JS object (3rd in processing order): the jpeg and CSS objects
# ahead of it are already re-uploaded this attempt; icon.png and index.html
# after it are never reached. Verifies a real `gcloud storage cp` exit 0
# that silently returns wrong bytes is still caught -- by this script's own
# SHA-256 comparison, not by trusting the upload command's exit code.
: >"$CALL_LOG"
D4="$WORKDIR/fail-corrupt"; build_valid_fixture "$D4"
echo 'console.log("v4");' >>"$D4/assets/index-DVY-GYHM.js"
pre_css_gen="$(live_gen "$BUCKET" "assets/index-7vLnMbyK.css")"
pre_icon_gen="$(live_gen "$BUCKET" "icon.png")"
out="$(CORRUPT_OBJECT="assets/index-DVY-GYHM.js" "$TARGET" "$D4" "$BUCKET" 2>&1)" &&
  fail "expected non-zero exit on forced content corruption"
grep -q "SHA-256 mismatch for assets/index-DVY-GYHM.js" <<<"$out" || fail "missing SHA-256 mismatch message: $out"
grep -q "rolling back 3 object" <<<"$out" || fail "expected exactly 3 objects rolled back (jpeg, css, js): $out"

# icon.png and index.html sort AFTER the corrupted JS object: never reached
# this attempt, so untouched (still the pre-attempt D3-rollback release).
[[ "$(live_gen "$BUCKET" "icon.png")" == "$pre_icon_gen" ]] ||
  fail "icon.png was touched even though it was never reached this attempt"

# CSS was already re-uploaded this attempt before the later JS corruption
# was detected -- it must be restored to the pre-attempt release content.
# (The hard-upload-failure test above fully rolled D3 back, so the true
# persisted pre-attempt-4 content for every object is still D2's.)
css_gen_after="$(live_gen "$BUCKET" "assets/index-7vLnMbyK.css")"
((css_gen_after > pre_css_gen)) || fail "expected a restoring generation bump for the CSS object"
diff <(live_content "$BUCKET" "assets/index-7vLnMbyK.css") "$D2/assets/index-7vLnMbyK.css" >/dev/null ||
  fail "CSS object was not restored to its pre-attempt (D2) release content"

# The corrupted JS object itself must end up back on its pre-attempt (D2,
# "+v2") content, not left on the corrupted bytes or D4's own ("+v4") bytes.
diff <(live_content "$BUCKET" "assets/index-DVY-GYHM.js") "$D2/assets/index-DVY-GYHM.js" >/dev/null ||
  fail "corrupted JS object was not restored to its pre-attempt (D2) release content"
pass "forced silent corruption: SHA-256 verification catches it and triggers full rollback"

# =========================================================================
# Fix round 1 -- High: path allowlist (extension alone previously let any
# nested path through; only index.html, assets/<hash-named>, and an
# approved root icon are a public MiroFish UI asset).
# =========================================================================
BUCKET2="test-mirofish-bucket-fix1"

: >"$CALL_LOG"
D="$WORKDIR/red-nested-html"; build_valid_fixture "$D"
mkdir -p "$D/reports"
echo "<html>leak</html>" >"$D/reports/data.html"
out="$("$TARGET" "$D" "$BUCKET2" 2>&1)" && fail "expected failure: nested reports/data.html"
grep -q "unexpected path outside assets/" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite a disallowed nested HTML file"
pass "nested reports/data.html outside assets/ fails closed"

: >"$CALL_LOG"
D="$WORKDIR/red-nested-js"; build_valid_fixture "$D"
mkdir -p "$D/project"
echo "console.log('leak')" >"$D/project/code.js"
out="$("$TARGET" "$D" "$BUCKET2" 2>&1)" && fail "expected failure: nested project/code.js"
grep -q "unexpected path outside assets/" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite a disallowed nested JS file"
pass "nested project/code.js outside assets/ fails closed"

: >"$CALL_LOG"
D="$WORKDIR/red-unapproved-root"; build_valid_fixture "$D"
echo "<html>extra</html>" >"$D/extra.html"
out="$("$TARGET" "$D" "$BUCKET2" 2>&1)" && fail "expected failure: second root HTML file"
grep -q "unexpected root file" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite an extra, unapproved root file"
pass "a second root-level HTML file (only index.html is allowed outside assets/) fails closed"

: >"$CALL_LOG"
D="$WORKDIR/green-approved-icon"; build_valid_fixture "$D"
printf '\x00\x00\x01\x00-fake-ico-bytes-' >"$D/favicon.ico"
out="$(FAIL_UPLOAD_OBJECT="__never_matches_anything__" "$TARGET" "$D" "$BUCKET2" 2>&1)" ||
  fail "an approved root icon (favicon.ico) alongside index.html should not fail preflight: $out"
grep -q "build validated" <<<"$out" || fail "missing build-validated line: $out"
pass "an approved root icon (favicon.ico) passes preflight alongside index.html"

# =========================================================================
# Fix round 1 -- Medium: binary-safe secret scan. `grep -I` (the original
# flag) SKIPS any file it heuristically detects as binary -- every image
# asset in this build. A secret-shaped string smuggled into one must still
# be caught; `-a` (binary-files=text) scans it instead of skipping it.
# =========================================================================
: >"$CALL_LOG"
D="$WORKDIR/red-binary-secret"; build_valid_fixture "$D"
printf '\x89PNG\r\n\x1a\n\x00\x01\x02sk-REALLYLOOKSLIKEASECRETTOKEN0000\x03\x04\xff\xfe' >"$D/icon.png"
out="$("$TARGET" "$D" "$BUCKET2" 2>&1)" && fail "expected failure: secret-shaped string inside a binary asset"
grep -q "secret-shaped string" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite a secret-shaped string hidden in a binary file"
pass "binary-safe secret scan catches a secret-shaped string inside a binary (icon.png) asset"

# =========================================================================
# Fix round 2 -- Medium: the localhost:5001 scan still used `-I` (same bug
# class as the secret scan above): it SKIPS any file grep heuristically
# classifies as binary, so a dev-only backend URL hidden in an image never
# got caught. `-a` fixes it the same way.
# =========================================================================
: >"$CALL_LOG"
D="$WORKDIR/red-binary-localhost"; build_valid_fixture "$D"
printf '\x89PNG\r\n\x1a\n\x00\x01\x02http://localhost:5001/api\x03\x04\xff\xfe' >"$D/icon.png"
out="$("$TARGET" "$D" "$BUCKET2" 2>&1)" && fail "expected failure: localhost:5001 reference inside a binary asset"
grep -q "localhost:5001" <<<"$out" || fail "wrong message: $out"
[[ ! -s "$CALL_LOG" ]] || fail "gcloud was called despite a localhost:5001 reference hidden in binary bytes"
pass "binary-safe localhost:5001 scan catches the reference inside a binary (icon.png) asset"

# =========================================================================
# Fix round 1 -- High: a non-404 describe failure (403/network) BEFORE any
# mutation must abort and roll back whatever was already touched, never
# silently treat the object as brand-new (the old `|| true` bug: doing so
# would make a later rollback DELETE a real existing object instead of
# restoring it).
# =========================================================================
: >"$CALL_LOG"
BUCKET_403="test-mirofish-bucket-403" # pristine bucket: must never have gotten anything live
D="$WORKDIR/red-403"; build_valid_fixture "$D"
out="$(FORCE_DESCRIBE_ERROR_OBJECT="assets/MiroFish_logo_left-Bf5baAoU.jpeg" "$TARGET" "$D" "$BUCKET_403" 2>&1)" &&
  fail "expected non-zero exit on a non-404 describe failure"
grep -q "not with a confirmed 404 -- refusing to assume it is a new object" <<<"$out" ||
  fail "missing 403-vs-404 classification message: $out"
grep -q "rolling back 0 object" <<<"$out" ||
  fail "expected zero objects touched: this is the FIRST object processed, so nothing was mutated yet: $out"
[[ -z "$(live_gen "$BUCKET_403" "assets/MiroFish_logo_left-Bf5baAoU.jpeg")" ]] ||
  fail "object must not have been uploaded after its own prior-state check failed with a non-404 error"
pass "a non-404 describe failure (403/network) aborts and rolls back instead of assuming the object is new"

# =========================================================================
# Fix round 2 -- High: the round 1 classifier accepted ANY message
# containing the bare substring "not found" -- including an AMBIGUOUS one
# that also carries a 403/Forbidden signal. That must now be REJECTED
# (treated as a genuine error, not absence). A truly unambiguous 404
# variant -- NOT the mock's own default zero-match wording -- must still
# be ACCEPTED as absence. Both are tested below.
# =========================================================================
: >"$CALL_LOG"
BUCKET8="test-mirofish-bucket-403-ambiguous"
D="$WORKDIR/red-403-ambiguous"; build_valid_fixture "$D"
out="$(FORCE_DESCRIBE_ERROR_OBJECT="assets/MiroFish_logo_left-Bf5baAoU.jpeg" \
  FORCE_DESCRIBE_ERROR_TEXT="ERROR: (gcloud.storage.objects.describe) HTTPError 403: Forbidden (object not found for this service account)" \
  "$TARGET" "$D" "$BUCKET8" 2>&1)" &&
  fail "expected non-zero exit: a 403 message that ALSO contains 'not found' must not be accepted as a genuine 404"
grep -q "not with a confirmed 404 -- refusing to assume it is a new object" <<<"$out" ||
  fail "missing 403-vs-404 classification message: $out"
[[ -z "$(live_gen "$BUCKET8" "assets/MiroFish_logo_left-Bf5baAoU.jpeg")" ]] ||
  fail "object must not have been uploaded after an ambiguous (403 + 'not found' text) describe failure"
pass "an ambiguous '403 ... not found' message is rejected -- never accepted as a genuine 404"

: >"$CALL_LOG"
BUCKET9="test-mirofish-bucket-404-variant"
D="$WORKDIR/green-404-variant"; build_valid_fixture "$D"
out="$(FORCE_DESCRIBE_ERROR_OBJECT="assets/MiroFish_logo_left-Bf5baAoU.jpeg" \
  FORCE_DESCRIBE_ERROR_TEXT="ERROR: (gcloud.storage.objects.describe) NotFoundException: 404 no such object" \
  "$TARGET" "$D" "$BUCKET9" 2>&1)" ||
  fail "a genuine NotFoundException/404 message must still be accepted as absence: $out"
grep -q "uploaded 5 object(s)" <<<"$out" ||
  fail "deploy should have succeeded, treating the object as new: $out"
pass "a genuine 404/NotFoundException message (distinct from the mock's own default wording) is still accepted as absence"

# =========================================================================
# Fix round 1 -- Medium: forced failure after a NEW hashed asset AND an
# overwritten index.html: the brand-new asset must end up with NO live
# generation (fully undone), and index.html -- genuinely live-mutated this
# attempt before its own corruption was caught -- must be restored to the
# prior release, not left on the failed attempt's content.
# =========================================================================
: >"$CALL_LOG"
BUCKET3="test-mirofish-bucket-new-asset"
Dn1="$WORKDIR/new-asset-deploy1"; build_valid_fixture "$Dn1"
"$TARGET" "$Dn1" "$BUCKET3" >/dev/null || fail "initial deploy for the new-asset test failed"

Dn2="$WORKDIR/new-asset-deploy2"; build_valid_fixture "$Dn2"
echo '<!-- v2: references a new chunk --><div>new</div>' >>"$Dn2/index.html"
echo 'body{color:red}' >"$Dn2/assets/vendor-ZZ999999.css" # brand-new hashed asset, never seen before

out="$(CORRUPT_OBJECT="index.html" "$TARGET" "$Dn2" "$BUCKET3" 2>&1)" &&
  fail "expected non-zero exit on forced index.html corruption"
grep -q "SHA-256 mismatch for index.html" <<<"$out" || fail "missing SHA-256 mismatch message: $out"

[[ -z "$(live_gen "$BUCKET3" "assets/vendor-ZZ999999.css")" ]] ||
  fail "the brand-new hashed asset must have NO live generation after rollback"

post_index_gen="$(live_gen "$BUCKET3" "index.html")"
((post_index_gen > 1)) ||
  fail "expected a restoring generation bump for index.html (it was live-mutated this attempt before being caught)"
diff <(live_content "$BUCKET3" "index.html") "$Dn1/index.html" >/dev/null ||
  fail "index.html was not restored to the prior release content"
pass "forced failure after a new hashed asset + overwritten index.html: new object has no live generation, prior index restored"

# =========================================================================
# Fix round 1 -- Critical: the post-upload metadata-describe calls
# (content_type/cache_control) were previously UNGUARDED -- a bare
# assignment with no `if`/`||` around it. A failure there used to exit via
# plain `set -e` WITHOUT ever calling rollback. This is that exact
# reproduction, now expected to roll back like every other failure.
# =========================================================================
: >"$CALL_LOG"
BUCKET4="test-mirofish-bucket-metadata-fail"
Dm1="$WORKDIR/metadata-deploy1"; build_valid_fixture "$Dm1"
"$TARGET" "$Dm1" "$BUCKET4" >/dev/null || fail "initial deploy for the metadata-fail test failed"

Dm2="$WORKDIR/metadata-deploy2"; build_valid_fixture "$Dm2"
out="$(FORCE_METADATA_DESCRIBE_FAIL_OBJECT="assets/index-7vLnMbyK.css" FORCE_METADATA_DESCRIBE_FAIL_FIELD="content_type" \
  "$TARGET" "$Dm2" "$BUCKET4" 2>&1)" &&
  fail "expected non-zero exit when the post-upload metadata-describe call itself fails"
grep -q "metadata verification failed for assets/index-7vLnMbyK.css (content-type describe)" <<<"$out" ||
  fail "missing metadata-describe failure message: $out"
grep -q "rolling back" <<<"$out" ||
  fail "metadata-describe failure did not trigger rollback -- this was the unguarded-set-e-exit bug: $out"
diff <(live_content "$BUCKET4" "assets/index-7vLnMbyK.css") "$Dm1/assets/index-7vLnMbyK.css" >/dev/null ||
  fail "CSS object was not restored after its own metadata-describe call failed"
pass "a post-upload metadata-describe failure (previously unguarded) now triggers rollback instead of a bare set -e exit"

# =========================================================================
# Fix round 1 -- Critical: if rollback ITSELF fails partway through, the
# script must report that plus the original error, continue restoring the
# other objects anyway, and NEVER report success.
# =========================================================================
: >"$CALL_LOG"
BUCKET5="test-mirofish-bucket-rollback-fail"
Dr1="$WORKDIR/rollback-fail-deploy1"; build_valid_fixture "$Dr1"
"$TARGET" "$Dr1" "$BUCKET5" >/dev/null || fail "initial deploy for the rollback-fail test failed"

Dr2="$WORKDIR/rollback-fail-deploy2"; build_valid_fixture "$Dr2"
echo 'console.log("v2")' >>"$Dr2/assets/index-DVY-GYHM.js"
out="$(FAIL_UPLOAD_OBJECT="index.html" FORCE_ROLLBACK_FAIL_OBJECT="assets/MiroFish_logo_left-Bf5baAoU.jpeg" \
  "$TARGET" "$Dr2" "$BUCKET5" 2>&1)" &&
  fail "expected non-zero exit when rollback itself fails"
grep -q "upload failed for index.html" <<<"$out" || fail "original error missing from output: $out"
grep -q "ROLLBACK STEP FAILED: could not restore assets/MiroFish_logo_left-Bf5baAoU.jpeg" <<<"$out" ||
  fail "missing per-step rollback failure message: $out"
grep -q "ROLLBACK FAILED -- release may be in a mixed state" <<<"$out" ||
  fail "missing overall rollback-failed warning: $out"
! grep -q "uploaded 5 object(s)" <<<"$out" || fail "must never print the success summary when rollback failed"
# One failing restore must not abandon the rest of the rollback: the CSS
# object (a different object, restored in the same rollback pass) must
# still have been restored despite the jpeg's restore failing.
diff <(live_content "$BUCKET5" "assets/index-7vLnMbyK.css") "$Dr1/assets/index-7vLnMbyK.css" >/dev/null ||
  fail "CSS object should still have been restored despite the jpeg's rollback failure"
pass "when rollback itself fails: reports it plus the original error, keeps restoring other objects, never claims success"

# =========================================================================
# Fix round 2 -- Critical: a REAL command (mktemp, sha256sum) failing AFTER
# a successful upload, for the CURRENT object, must still roll that exact
# object back -- not just every OTHER object already in the journal. Round
# 1's own tests only forced gcloud itself to fail/corrupt; these force the
# actual local commands between the upload and its own verification to
# fail, which is the literal gap fix round 2 found: the object was only
# journaled AFTER those commands succeeded, so when one of them failed
# first, the object currently being processed was silently never rolled
# back even though its upload had already mutated the live bucket.
#
# Both scenarios use the SAME fixture shape: an initial successful deploy,
# then a second deploy that both (a) adds a brand-new hashed asset and (b)
# overwrites index.html -- so a single forced failure on index.html's own
# post-upload step must prove BOTH halves at once: the brand-new asset ends
# up with NO live generation (deleted), and index.html is restored to the
# first deploy's content (not left on the second deploy's new bytes, and
# not left mutated-but-unverified).
#
# Call counting: sha256_of/mktemp are each invoked exactly twice per
# object (once before the upload, once after) in this fixture's 6-object
# sort order (jpeg, css, js, the new asset, icon.png, index.html last) --
# so index.html's own POST-upload call is always the 12th invocation
# overall. These counts are asserted directly below, so a future code
# change that shifts them fails the test instead of silently targeting the
# wrong object.
# =========================================================================

# --- mktemp failure (post-upload tmp_download) -----------------------------
BUCKET6="test-mirofish-bucket-mktemp-fail"
Dt1="$WORKDIR/mktemp-fail-deploy1"; build_valid_fixture "$Dt1"
"$TARGET" "$Dt1" "$BUCKET6" >/dev/null || fail "initial deploy for the mktemp-fail test failed"

Dt2="$WORKDIR/mktemp-fail-deploy2"; build_valid_fixture "$Dt2"
echo '<!-- v2: references a new chunk --><div>new</div>' >>"$Dt2/index.html"
echo 'body{color:blue}' >"$Dt2/assets/vendor-ZZ999999.css" # brand-new hashed asset

MKTEMP_COUNTER_FILE="$WORKDIR/mktemp-counter-t"; : >"$MKTEMP_COUNTER_FILE"
out="$(MKTEMP_COUNTER_FILE="$MKTEMP_COUNTER_FILE" FAIL_MKTEMP_AT_CALL=12 \
  "$TARGET" "$Dt2" "$BUCKET6" 2>&1)" &&
  fail "expected non-zero exit when the post-upload mktemp call itself fails"
grep -q "fake mktemp: simulated failure at call 12" <<<"$out" ||
  fail "mktemp did not fail at the expected (12th, index.html's own post-upload) call: $out"
grep -q "mktemp failed while preparing to verify index.html" <<<"$out" ||
  fail "missing explicit mktemp-guard failure message: $out"
grep -q "rolling back" <<<"$out" ||
  fail "a post-upload mktemp failure for the CURRENT object did not trigger rollback: $out"
! grep -q "uploaded 6 object(s)" <<<"$out" || fail "must never print the success summary"
# Guarding this explicitly (not the ambient ERR trap) also fixed a found-
# along-the-way bug: a bare `var="$(mktemp)"` double-fired the trap (once
# inside the command-substitution subshell `-E` keeps alive, once again in
# the parent) -- exactly ONE "rolling back" line, not two, proves it.
[[ "$(grep -c "rolling back" <<<"$out")" == "1" ]] ||
  fail "rollback ran more than once for a single mktemp failure (the subshell/ERR-trap double-fire bug): $out"

[[ -z "$(live_gen "$BUCKET6" "assets/vendor-ZZ999999.css")" ]] ||
  fail "the brand-new hashed asset must have NO live generation after rollback"
diff <(live_content "$BUCKET6" "index.html") "$Dt1/index.html" >/dev/null ||
  fail "index.html (the object whose OWN post-upload mktemp call failed) was not restored to the prior release"
pass "injected post-upload mktemp failure for the CURRENT object (overwritten index + a new asset): new object removed, old index restored, no success claimed"

# --- sha256sum (hash) failure (post-download remote_sha) -------------------
BUCKET7="test-mirofish-bucket-hash-fail"
Dh1="$WORKDIR/hash-fail-deploy1"; build_valid_fixture "$Dh1"
"$TARGET" "$Dh1" "$BUCKET7" >/dev/null || fail "initial deploy for the hash-fail test failed"

Dh2="$WORKDIR/hash-fail-deploy2"; build_valid_fixture "$Dh2"
echo '<!-- v2: references a new chunk --><div>new</div>' >>"$Dh2/index.html"
echo 'body{color:green}' >"$Dh2/assets/vendor-ZZ999999.css"

SHA256_COUNTER_FILE="$WORKDIR/sha256-counter-h"; : >"$SHA256_COUNTER_FILE"
out="$(SHA256_COUNTER_FILE="$SHA256_COUNTER_FILE" FAIL_SHA256_AT_CALL=12 \
  "$TARGET" "$Dh2" "$BUCKET7" 2>&1)" &&
  fail "expected non-zero exit when the post-download hash call itself fails"
grep -q "fake sha256sum: simulated failure at call 12" <<<"$out" ||
  fail "sha256sum did not fail at the expected (12th, index.html's own post-upload remote hash) call: $out"
grep -q "could not hash downloaded content for index.html" <<<"$out" ||
  fail "missing explicit hash-guard failure message: $out"
grep -q "rolling back" <<<"$out" ||
  fail "a post-upload hash failure for the CURRENT object did not trigger rollback: $out"
! grep -q "uploaded 6 object(s)" <<<"$out" || fail "must never print the success summary"
[[ "$(grep -c "rolling back" <<<"$out")" == "1" ]] ||
  fail "rollback ran more than once for a single hash failure (the subshell/ERR-trap double-fire bug): $out"

[[ -z "$(live_gen "$BUCKET7" "assets/vendor-ZZ999999.css")" ]] ||
  fail "the brand-new hashed asset must have NO live generation after rollback"
diff <(live_content "$BUCKET7" "index.html") "$Dh1/index.html" >/dev/null ||
  fail "index.html (the object whose OWN post-upload hash call failed) was not restored to the prior release"
pass "injected post-upload hash (sha256sum) failure for the CURRENT object (overwritten index + a new asset): new object removed, old index restored, no success claimed"

# =========================================================================
# Fix round 3 -- High: rollback journals the current object before upload
# (round 2, kept), but previously acted on the journal UNCONDITIONALLY --
# an existing object whose own upload command failed outright (nothing
# mutated) still got a real restore-copy call, creating a pointless new
# generation. Rollback must now compare the object's ACTUAL current live
# generation to what was journaled BEFORE deciding to act, in one combined
# scenario that also re-proves rounds 1/2 behavior is preserved: a
# genuinely mutated existing object is still restored, and a genuinely
# created new object is still deleted.
# =========================================================================
BUCKET10="test-mirofish-bucket-noop-restore"
Dn1="$WORKDIR/noop-restore-deploy1"; build_valid_fixture "$Dn1"
"$TARGET" "$Dn1" "$BUCKET10" >/dev/null || fail "initial deploy for the noop-restore test failed"

Dn2="$WORKDIR/noop-restore-deploy2"; build_valid_fixture "$Dn2"
echo 'console.log("v2")' >>"$Dn2/assets/index-DVY-GYHM.js"       # genuinely mutated this attempt
echo 'body{color:purple}' >"$Dn2/assets/vendor-ZZ999999.css"     # brand-new asset, genuinely created

: >"$CALL_LOG"
pre_index_gen="$(live_gen "$BUCKET10" "index.html")"
out="$(FAIL_UPLOAD_OBJECT="index.html" "$TARGET" "$Dn2" "$BUCKET10" 2>&1)" &&
  fail "expected non-zero exit when index.html's own upload command fails"
grep -q "upload failed for index.html" <<<"$out" || fail "missing failure message: $out"
grep -q "rolling back 6 object" <<<"$out" || fail "expected 6 journaled objects (5 + 1 new): $out"

# index.html's own upload never ran -- its live generation never changed,
# so rollback must SKIP restoring it: no gcloud restore-copy call, no
# wasted new generation.
post_index_gen="$(live_gen "$BUCKET10" "index.html")"
[[ "$post_index_gen" == "$pre_index_gen" ]] ||
  fail "index.html's generation changed even though it was never actually mutated: $pre_index_gen -> $post_index_gen"
grep -qF "index.html#$pre_index_gen" "$CALL_LOG" &&
  fail "a restore-copy call was issued for index.html even though it was never mutated: $(<"$CALL_LOG")"
grep -q "index.html is still at its prior generation ($pre_index_gen)" <<<"$out" ||
  fail "missing the 'nothing to restore' message for the unmutated object: $out"

# The brand-new asset genuinely WAS created this attempt (rounds 1/2
# behavior preserved) -- it must still be deleted.
[[ -z "$(live_gen "$BUCKET10" "assets/vendor-ZZ999999.css")" ]] ||
  fail "the brand-new hashed asset must still be deleted after rollback"

# The JS object genuinely WAS mutated this attempt with different content
# (rounds 1/2 behavior preserved) -- it must still be restored.
diff <(live_content "$BUCKET10" "assets/index-DVY-GYHM.js") "$Dn1/assets/index-DVY-GYHM.js" >/dev/null ||
  fail "the genuinely mutated JS object was not restored to the pre-attempt release"
pass "fix round 3: an unmutated object (own upload failed) is skipped -- no restore-copy call, generation unchanged -- while genuinely mutated objects (incl. a new asset) are still rolled back"

# =========================================================================
# Fix round 3 -- High: if rollback's OWN current-generation check fails
# AMBIGUOUSLY (not a confirmed 404), it must never guess "absent" -- it
# must report that object's rollback step as failed (rollback incomplete,
# non-zero exit) and take NO action on it. Tested for both shapes: an
# EXISTING object (would otherwise be restored) and a BRAND-NEW object
# (would otherwise be deleted) -- the dangerous direction, since
# misclassifying "ambiguous" as "absent" there would silently skip
# deleting a real leftover object while reporting nothing wrong.
# =========================================================================

# --- existing object: ambiguous rollback-time describe ----------------------
BUCKET11="test-mirofish-bucket-rollback-ambiguous"
Da1="$WORKDIR/rollback-ambiguous-deploy1"; build_valid_fixture "$Da1"
"$TARGET" "$Da1" "$BUCKET11" >/dev/null || fail "initial deploy for the rollback-ambiguous test failed"

Da2="$WORKDIR/rollback-ambiguous-deploy2"; build_valid_fixture "$Da2"
echo 'console.log("v2")' >>"$Da2/assets/index-DVY-GYHM.js" # genuinely mutated

# Call order for this 5-object fixture: 5 pre-upload describes (calls
# 1-5, one per object, jpeg/css/js/icon/index.html), then index.html's own
# upload fails (FAIL_UPLOAD_OBJECT), triggering rollback in REVERSE order:
# index.html(6), icon(7), js(8), css(9), jpeg(10). Targeting call 10 hits
# jpeg's OWN rollback-time check -- it WAS genuinely re-uploaded this
# attempt (journaled with a real prior generation) and would otherwise be
# correctly restored.
: >"$CALL_LOG"
DESCRIBE_GEN_COUNTER_FILE="$WORKDIR/describe-gen-counter-a"; : >"$DESCRIBE_GEN_COUNTER_FILE"
pre_jpeg_gen="$(live_gen "$BUCKET11" "assets/MiroFish_logo_left-Bf5baAoU.jpeg")"
out="$(DESCRIBE_GEN_COUNTER_FILE="$DESCRIBE_GEN_COUNTER_FILE" FAIL_DESCRIBE_GEN_AT_CALL=10 \
  FAIL_DESCRIBE_GEN_TEXT="ERROR: (gcloud.storage.objects.describe) HTTPError 403: Forbidden" \
  FAIL_UPLOAD_OBJECT="index.html" "$TARGET" "$Da2" "$BUCKET11" 2>&1)" &&
  fail "expected non-zero exit (rollback itself must report incomplete)"
grep -q "ROLLBACK STEP FAILED: could not determine assets/MiroFish_logo_left-Bf5baAoU.jpeg's current state" <<<"$out" ||
  fail "missing the ambiguous-rollback-describe failure message: $out"
grep -q "ROLLBACK FAILED -- release may be in a mixed state" <<<"$out" ||
  fail "missing the overall rollback-failed warning: $out"
! grep -q "uploaded 5 object(s)" <<<"$out" || fail "must never print the success summary"
# Never guessed "absent": no restore call was attempted (can't risk
# guessing right either way), and the object was left exactly as this
# failed attempt's own upload left it -- NOT silently reported as fine.
grep -qE "assets/MiroFish_logo_left-Bf5baAoU\.jpeg#[0-9]+ gs://" "$CALL_LOG" &&
  fail "a restore-copy call must not be attempted when the rollback-time check itself is ambiguous: $(<"$CALL_LOG")"
# jpeg's generation should be exactly one higher than before this attempt
# (its own successful upload) and no more -- a second bump would mean a
# restore-copy silently happened despite the ambiguous check.
post_jpeg_gen="$(live_gen "$BUCKET11" "assets/MiroFish_logo_left-Bf5baAoU.jpeg")"
[[ "$post_jpeg_gen" == "$((pre_jpeg_gen + 1))" ]] ||
  fail "expected jpeg's generation to advance by exactly 1 (its own upload only, no restore): $pre_jpeg_gen -> $post_jpeg_gen"
# Other objects (css, js, icon) whose OWN rollback-time checks succeeded
# normally are still correctly restored despite jpeg's step failing.
diff <(live_content "$BUCKET11" "assets/index-7vLnMbyK.css") "$Da1/assets/index-7vLnMbyK.css" >/dev/null ||
  fail "CSS object should still have been restored despite jpeg's ambiguous rollback failure"
pass "ambiguous rollback-time describe for an EXISTING object: reported as rollback-incomplete, never guessed, other objects still restored"

# --- brand-new object: ambiguous rollback-time describe ---------------------
BUCKET12="test-mirofish-bucket-rollback-ambiguous-new"
Db1="$WORKDIR/rollback-ambiguous-new-deploy1"; build_valid_fixture "$Db1"
"$TARGET" "$Db1" "$BUCKET12" >/dev/null || fail "initial deploy for the rollback-ambiguous-new test failed"

Db2="$WORKDIR/rollback-ambiguous-new-deploy2"; build_valid_fixture "$Db2"
echo 'body{color:orange}' >"$Db2/assets/vendor-ZZ999999.css" # brand-new asset

# Same 6-object order as the noop-restore test above (jpeg, css, js,
# vendor-new, icon, index.html); pre-upload describes are calls 1-6,
# rollback (reverse order) is index.html(7), icon(8), vendor-new(9),
# js(10), css(11), jpeg(12). Targeting call 9 hits the brand-new asset's
# OWN rollback-time check -- the dangerous direction: misclassifying
# "ambiguous" as "absent" here would silently skip deleting a real
# leftover object while reporting nothing wrong.
: >"$CALL_LOG"
DESCRIBE_GEN_COUNTER_FILE="$WORKDIR/describe-gen-counter-b"; : >"$DESCRIBE_GEN_COUNTER_FILE"
out="$(DESCRIBE_GEN_COUNTER_FILE="$DESCRIBE_GEN_COUNTER_FILE" FAIL_DESCRIBE_GEN_AT_CALL=9 \
  FAIL_DESCRIBE_GEN_TEXT="ERROR: (gcloud.storage.objects.describe) HTTPError 403: Forbidden" \
  FAIL_UPLOAD_OBJECT="index.html" "$TARGET" "$Db2" "$BUCKET12" 2>&1)" &&
  fail "expected non-zero exit (rollback itself must report incomplete)"
grep -q "ROLLBACK STEP FAILED: could not determine assets/vendor-ZZ999999.css's current state" <<<"$out" ||
  fail "missing the ambiguous-rollback-describe failure message for the new object: $out"
grep -q "ROLLBACK FAILED -- release may be in a mixed state" <<<"$out" ||
  fail "missing the overall rollback-failed warning: $out"
# Never silently treated as "absent, nothing to delete": no such message,
# and no delete call was attempted either (refusing to guess either way).
! grep -q "assets/vendor-ZZ999999.css was never actually created" <<<"$out" ||
  fail "an ambiguous describe failure must never be silently treated as absent: $out"
grep -qE "storage rm .*vendor-ZZ999999\.css" "$CALL_LOG" &&
  fail "a delete call must not be attempted when the rollback-time check itself is ambiguous: $(<"$CALL_LOG")"
pass "ambiguous rollback-time describe for a BRAND-NEW object: reported as rollback-incomplete, never silently treated as already absent"

# =========================================================================
# Fix round 4 -- Medium: rollback_current_generation()'s own `cat`/`rm` on
# a scratch err_file were bare, unguarded commands -- reachable FROM INSIDE
# rollback() itself. A failure there would let the still-armed ERR trap
# fire a SECOND, re-entrant rollback() pass mid-way through the first one's
# for-loop. Both are now explicitly guarded; both scenarios below assert
# exactly ONE "rolling back" line (no re-entrant second pass) and no extra
# gcloud mutation for the affected object.
# =========================================================================

# --- failed READ (cat): must mark that object's rollback step ambiguous,
# never re-enter rollback, never claim success -----------------------------
BUCKET13="test-mirofish-bucket-cat-fail"
Dc1="$WORKDIR/cat-fail-deploy1"; build_valid_fixture "$Dc1"
"$TARGET" "$Dc1" "$BUCKET13" >/dev/null || fail "initial deploy for the cat-fail test failed"

Dc2="$WORKDIR/cat-fail-deploy2"; build_valid_fixture "$Dc2"
echo 'console.log("v2")' >>"$Dc2/assets/index-DVY-GYHM.js" # genuinely mutated

# Same call-order reasoning as the round-3 ambiguous-describe tests: 5
# pre-upload describes (1-5), then index.html's own upload fails, then
# rollback in reverse order -- index.html(6), icon(7), js(8), css(9),
# jpeg(10). Call 10 (jpeg's OWN rollback-time describe) is forced to fail;
# `cat` is used NOWHERE ELSE in this whole redeploy-over-an-existing-release
# scenario (describe_prior_generation's own cat branch is only reached for
# a genuinely new, not-yet-existing object), so it is called exactly once
# -- call 1 is unambiguously that one read.
: >"$CALL_LOG"
DESCRIBE_GEN_COUNTER_FILE="$WORKDIR/describe-gen-counter-c"; : >"$DESCRIBE_GEN_COUNTER_FILE"
CAT_COUNTER_FILE="$WORKDIR/cat-counter-c"; : >"$CAT_COUNTER_FILE"
out="$(DESCRIBE_GEN_COUNTER_FILE="$DESCRIBE_GEN_COUNTER_FILE" FAIL_DESCRIBE_GEN_AT_CALL=10 \
  FAIL_DESCRIBE_GEN_TEXT="ERROR: (gcloud.storage.objects.describe) HTTPError 403: Forbidden" \
  CAT_COUNTER_FILE="$CAT_COUNTER_FILE" FAIL_CAT_AT_CALL=1 \
  FAIL_UPLOAD_OBJECT="index.html" "$TARGET" "$Dc2" "$BUCKET13" 2>&1)" &&
  fail "expected non-zero exit (rollback itself must report incomplete)"
# (the fake cat's own diagnostic is captured via the script's own `2>&1` on
# that call -- by design, so no error detail is silently dropped -- and
# ends up folded into err_text, not printed to the terminal directly; the
# warning message below is the externally observable proof it fired.)
grep -q "(warning: could not read describe error output for assets/MiroFish_logo_left-Bf5baAoU.jpeg -- treating its current state as ambiguous, not absent)" <<<"$out" ||
  fail "missing the explicit cat-guard warning message: $out"
grep -q "ROLLBACK STEP FAILED: could not determine assets/MiroFish_logo_left-Bf5baAoU.jpeg's current state" <<<"$out" ||
  fail "a failed read must mark that object's rollback step incomplete: $out"
grep -q "ROLLBACK FAILED -- release may be in a mixed state" <<<"$out" ||
  fail "missing the overall rollback-failed warning: $out"
! grep -q "uploaded 5 object(s)" <<<"$out" || fail "must never print the success summary"
# Exactly ONE rollback pass: a failing bare `cat` under the still-armed ERR
# trap would otherwise let it fire a SECOND, re-entrant rollback().
[[ "$(grep -c "rolling back" <<<"$out")" == "1" ]] ||
  fail "rollback ran more than once after the cat failure (ERR-trap re-entry bug): $out"
# No restore/delete call attempted for jpeg -- a failed read must never
# silently guess either direction.
grep -qE "assets/MiroFish_logo_left-Bf5baAoU\.jpeg#[0-9]+ gs://" "$CALL_LOG" &&
  fail "a restore-copy call must not be attempted when the error text could not even be read: $(<"$CALL_LOG")"
# Other objects whose own rollback-time checks succeeded normally are
# still correctly restored despite jpeg's step failing.
diff <(live_content "$BUCKET13" "assets/index-7vLnMbyK.css") "$Dc1/assets/index-7vLnMbyK.css" >/dev/null ||
  fail "CSS object should still have been restored despite jpeg's cat-read failure"
pass "a failed read (cat) inside rollback's own current-generation check: marked ambiguous, exactly one rollback pass, no guessed mutation, other objects still restored"

# --- failed cleanup (rm): must report safely, keep the already-correct
# decision, never re-enter rollback, never silently succeed ----------------
BUCKET14="test-mirofish-bucket-rm-fail"
Dr3="$WORKDIR/rm-fail-deploy1"; build_valid_fixture "$Dr3"
"$TARGET" "$Dr3" "$BUCKET14" >/dev/null || fail "initial deploy for the rm-fail test failed"

Dr4="$WORKDIR/rm-fail-deploy2"; build_valid_fixture "$Dr4"
echo 'console.log("v2")' >>"$Dr4/assets/index-DVY-GYHM.js" # genuinely mutated

# No forced describe failure here -- every object's rollback-time describe
# succeeds normally (the SUCCESS branch), each followed by one cleanup
# `rm -f "$err_file"`. Call order, confirmed empirically (not just by hand
# count) against this exact fixture/scenario: per object in the main loop,
# one `rm` for describe_prior_generation's own success-path cleanup + one
# `rm` for the post-download tmp_download cleanup = 2 per object for
# jpeg/css/js/icon (8 total); index.html's own upload then fails before
# its tmp_download is ever reached, so it contributes only 1 -- 9 total
# through the main loop. Rollback (reverse order) adds one more `rm` per
# object's own current-generation check: index.html(10), icon(11),
# js(12), css(13), jpeg(14). Call 14 (jpeg's OWN rollback-time cleanup,
# the LAST object processed in reverse order) is targeted.
: >"$CALL_LOG"
RM_COUNTER_FILE="$WORKDIR/rm-counter-d"; : >"$RM_COUNTER_FILE"
out="$(RM_COUNTER_FILE="$RM_COUNTER_FILE" FAIL_RM_AT_CALL=14 \
  FAIL_UPLOAD_OBJECT="index.html" "$TARGET" "$Dr4" "$BUCKET14" 2>&1)" &&
  fail "expected non-zero exit (the ORIGINAL index.html upload failure, not the rm glitch)"
grep -q "fake rm: simulated failure at call 14" <<<"$out" ||
  fail "rm did not fail at the expected (14th, jpeg's rollback-time cleanup) call: $out"
grep -qE "\(warning: could not remove temporary file .* while checking assets/MiroFish_logo_left-Bf5baAoU\.jpeg -- continuing\)" <<<"$out" ||
  fail "missing the explicit rm-cleanup-guard warning message: $out"
! grep -q "uploaded 5 object(s)" <<<"$out" || fail "must never print the success summary"
# Exactly ONE rollback pass: a failing bare `rm` under the still-armed ERR
# trap would otherwise let it fire a SECOND, re-entrant rollback().
[[ "$(grep -c "rolling back" <<<"$out")" == "1" ]] ||
  fail "rollback ran more than once after the rm failure (ERR-trap re-entry bug): $out"
# jpeg's describe itself succeeded (only its cleanup failed) -- its
# genuinely-changed content must STILL be restored; the cleanup glitch
# must not block or corrupt the already-correct decision.
diff <(live_content "$BUCKET14" "assets/MiroFish_logo_left-Bf5baAoU.jpeg") "$Dr3/assets/MiroFish_logo_left-Bf5baAoU.jpeg" >/dev/null ||
  fail "jpeg was not restored despite only its temp-file cleanup (not its classification) failing"
pass "a failed cleanup (rm) inside rollback's own current-generation check: reported safely, exactly one rollback pass, the already-correct restore still happens, original failure status preserved"

# =========================================================================
# No real provider key material anywhere in this test or its mock
# =========================================================================
! grep -RIlE 'sk_(live|test)_|sk-[A-Za-z0-9]{20,}AQ|AIza[0-9A-Za-z_-]{30}' "$SCRIPT_DIR" >/dev/null 2>&1 ||
  fail "a real-shaped provider key pattern was found near these scripts"
command -v gcloud | grep -qF "$MOCK_BIN" || fail "the fake gcloud was not the one actually invoked"
pass "no real provider key material; only the fake gcloud on PATH was invoked"

echo "upload-mirofish-static.test: ok ($PASS_COUNT/$PASS_COUNT)"
