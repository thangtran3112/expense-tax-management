#!/usr/bin/env bash
# Publishes a verified hub export as a versioned GCS transaction.
set -uo pipefail

OUT_DIR="${1:?usage: upload-hub-static.sh OUT_DIR BUCKET}"
BUCKET="${2:?usage: upload-hub-static.sh OUT_DIR BUCKET}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "upload-hub-static: $*" >&2; exit 1; }
[[ -d "$OUT_DIR" ]] || fail "missing $OUT_DIR"

is_404() {
  local text="$1"
  ! grep -qiE '\b(403|forbidden|permissiondenied|accessdenied)\b' <<<"$text" &&
    grep -qE 'matched no objects or files|NotFoundException|No such object or bucket|(^|[^0-9])404([^0-9]|$)' <<<"$text"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

mime_for() {
  case "${1##*.}" in
    html) echo 'text/html; charset=utf-8' ;; txt) echo 'text/x-component' ;; css) echo 'text/css; charset=utf-8' ;;
    js|mjs) echo 'application/javascript' ;; ico) echo 'image/x-icon' ;;
    png) echo 'image/png' ;; jpg|jpeg) echo 'image/jpeg' ;; gif) echo 'image/gif' ;;
    svg) echo 'image/svg+xml' ;; webp) echo 'image/webp' ;;
    woff) echo 'font/woff' ;; woff2) echo 'font/woff2' ;; ttf) echo 'font/ttf' ;; otf) echo 'font/otf' ;;
    *) return 1 ;;
  esac
}

validate_paths() {
  local file rel
  while IFS= read -r -d '' file; do
    rel="${file#"$OUT_DIR"/}"
    case "$rel" in
      index.html|404.html|_not-found.html|login.html|favicon.ico|index.txt|login.txt|_not-found.txt|__next._tree.txt|__next._full.txt|__next.__PAGE__.txt|_next/static/*) ;;
      apps/tradingagents.html|apps/ai-hedge-fund.html|apps/vibe-trading.html|apps/mirofish.html|apps/tradingagents.txt|apps/ai-hedge-fund.txt|apps/vibe-trading.txt|apps/mirofish.txt) ;;
      login/__next._tree.txt|login/__next._full.txt|login/__next.login.__PAGE__.txt) ;;
      _not-found/__next._tree.txt|_not-found/__next._full.txt|_not-found/__next._not-found.__PAGE__.txt) ;;
      apps/tradingagents/__next._tree.txt|apps/tradingagents/__next._full.txt|apps/tradingagents/__next.apps.\$d\$slug.__PAGE__.txt) ;;
      apps/ai-hedge-fund/__next._tree.txt|apps/ai-hedge-fund/__next._full.txt|apps/ai-hedge-fund/__next.apps.\$d\$slug.__PAGE__.txt) ;;
      apps/vibe-trading/__next._tree.txt|apps/vibe-trading/__next._full.txt|apps/vibe-trading/__next.apps.\$d\$slug.__PAGE__.txt) ;;
      apps/mirofish/__next._tree.txt|apps/mirofish/__next._full.txt|apps/mirofish/__next.apps.\$d\$slug.__PAGE__.txt) ;;
      *) fail "unexpected path in static export: $rel" ;;
    esac
    mime_for "$rel" >/dev/null || fail "unsupported public asset type: $rel"
  done < <(find "$OUT_DIR" -type f -print0)
  if grep -RalE 'sk_(live|test)_|sk-[A-Za-z0-9_-]{20,}|CLERK_SECRET_KEY=|ZEP_API_KEY=|SESSION_SIGNING_KEY=' "$OUT_DIR" >/dev/null 2>&1; then
    fail "a secret-shaped string was found in the static export"
  fi
}

if find "$OUT_DIR" -type l -print -quit | grep -q .; then
  fail "symlink found in static export"
fi
"$SCRIPT_DIR/check-static-export.sh" "$OUT_DIR" || exit $?
validate_paths

mapfile -d '' -t ALL_FILES < <(find "$OUT_DIR" -type f -print0 | sort -z)
HASHED=() OTHER=()
declare -A LOCAL PRIOR REMOTE
for file in "${ALL_FILES[@]}"; do
  rel="${file#"$OUT_DIR"/}"; LOCAL["$rel"]="$file"
  if [[ "$rel" == _next/static/* ]]; then HASHED+=("$rel"); else OTHER+=("$rel"); fi
done

# Listing and snapshots complete before first write. A 403/network error is
# never mistaken for an empty bucket or a new object.
if ! remote_listing="$(gcloud storage ls --recursive "gs://$BUCKET" 2>&1)"; then
  fail "could not list remote objects before upload: $remote_listing"
fi
while IFS= read -r url; do
  [[ -z "$url" ]] && continue
  prefix="gs://$BUCKET/"; [[ "$url" == "$prefix"* ]] || fail "unexpected object listing entry: $url"
  REMOTE["${url#"$prefix"}"]=1
done <<<"$remote_listing"

describe_prior() {
  local obj="$1" out err
  if ! err="$(mktemp)"; then fail "mktemp failed while checking $obj"; fi
  if out="$(gcloud storage objects describe "gs://$BUCKET/$obj" --format='value(generation)' 2>"$err")"; then
    rm -f "$err" || fail "could not clean temporary file while checking $obj"
    PRIOR["$obj"]="$out"; return
  fi
  if ! out="$(cat "$err" 2>&1)"; then rm -f "$err" || true; fail "could not read prior-state error for $obj"; fi
  rm -f "$err" || fail "could not clean temporary file while checking $obj"
  if is_404 "$out"; then PRIOR["$obj"]=""; return; fi
  fail "could not determine prior state of $obj (not a confirmed 404): $out"
}

for rel in "${!LOCAL[@]}"; do describe_prior "$rel"; done
STALE=()
for rel in "${!REMOTE[@]}"; do
  [[ "$rel" == _next/static/* || -n "${LOCAL[$rel]:-}" ]] && continue
  STALE+=("$rel"); describe_prior "$rel"
done

JOURNAL_OBJECTS=() JOURNAL_PRIOR=()
journal() { JOURNAL_OBJECTS+=("$1"); JOURNAL_PRIOR+=("${PRIOR[$1]}"); }

current_state() {
  local obj="$1" out err
  CURRENT_STATE=ambiguous CURRENT_GEN=""
  if ! err="$(mktemp)"; then return; fi
  if out="$(gcloud storage objects describe "gs://$BUCKET/$obj" --format='value(generation)' 2>"$err")"; then
    rm -f "$err" || true; CURRENT_STATE=present CURRENT_GEN="$out"; return
  fi
  if ! out="$(cat "$err" 2>&1)"; then rm -f "$err" || true; return; fi
  rm -f "$err" || true
  is_404 "$out" && { CURRENT_STATE=absent; return; }
}

rollback() {
  local i obj prior failed=0
  echo "upload-hub-static: rolling back ${#JOURNAL_OBJECTS[@]} object(s)" >&2
  for ((i=${#JOURNAL_OBJECTS[@]}-1; i>=0; i--)); do
    obj="${JOURNAL_OBJECTS[i]}"; prior="${JOURNAL_PRIOR[i]}"; current_state "$obj"
    if [[ "$CURRENT_STATE" == ambiguous ]]; then echo "  ROLLBACK STEP FAILED: cannot determine $obj current state" >&2; failed=1; continue; fi
    if [[ -n "$prior" ]]; then
      if [[ "$CURRENT_STATE" == present && "$CURRENT_GEN" == "$prior" ]]; then
        echo "  $obj unchanged; no restore" >&2
      elif ! gcloud storage cp --quiet "gs://$BUCKET/$obj#$prior" "gs://$BUCKET/$obj"; then
        echo "  ROLLBACK STEP FAILED: could not restore $obj" >&2; failed=1
      fi
    elif [[ "$CURRENT_STATE" == present ]]; then
      if ! gcloud storage rm --quiet "gs://$BUCKET/$obj"; then echo "  ROLLBACK STEP FAILED: could not delete new $obj" >&2; failed=1; fi
    fi
  done
  return "$failed"
}

abort_transaction() {
  local message="$1"
  echo "upload-hub-static: $message" >&2
  rollback || echo "upload-hub-static: ROLLBACK FAILED -- release may be mixed" >&2
  exit 1
}

upload_and_verify() {
  local rel="$1" file="${LOCAL[$1]}" type cache local_sha remote_sha tmp remote_type remote_cache
  type="$(mime_for "$rel")" || abort_transaction "no MIME type for $rel"
  [[ "$rel" == _next/static/* ]] && cache='public, max-age=31536000, immutable' || cache='no-store'
  local_sha="$(sha256 "$file")" || abort_transaction "could not hash $rel"
  journal "$rel"
  gcloud storage cp --quiet --content-type="$type" --cache-control="$cache" "$file" "gs://$BUCKET/$rel" || abort_transaction "upload failed for $rel"
  tmp="$(mktemp)" || abort_transaction "mktemp failed while verifying $rel"
  gcloud storage cp --quiet "gs://$BUCKET/$rel" "$tmp" || { rm -f "$tmp" || true; abort_transaction "download verification failed for $rel"; }
  remote_sha="$(sha256 "$tmp")" || { rm -f "$tmp" || true; abort_transaction "could not hash uploaded $rel"; }
  rm -f "$tmp" || abort_transaction "could not clean verification file for $rel"
  [[ "$local_sha" == "$remote_sha" ]] || abort_transaction "SHA-256 mismatch for $rel"
  remote_type="$(gcloud storage objects describe "gs://$BUCKET/$rel" --format='value(content_type)' 2>&1)" || abort_transaction "content-type verification failed for $rel: $remote_type"
  remote_cache="$(gcloud storage objects describe "gs://$BUCKET/$rel" --format='value(cache_control)' 2>&1)" || abort_transaction "cache-control verification failed for $rel: $remote_cache"
  [[ "$remote_type" == "$type" && "$remote_cache" == "$cache" ]] || abort_transaction "metadata mismatch for $rel"
}

for rel in "${HASHED[@]}"; do upload_and_verify "$rel"; done
for rel in "${OTHER[@]}"; do upload_and_verify "$rel"; done
for rel in "${STALE[@]}"; do journal "$rel"; gcloud storage rm --quiet "gs://$BUCKET/$rel" || abort_transaction "delete stale object failed for $rel"; done

echo "upload-hub-static: uploaded ${#ALL_FILES[@]} object(s) to gs://$BUCKET"
