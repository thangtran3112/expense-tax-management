#!/usr/bin/env bash
# Renders the four ai-trading production env files into OUT_DIR from the
# Secret Manager bundle: tradingagents.env, ai-hedge-fund.env, vibe-trading.env
# (via infrastructure/secrets/env-bundle.py render) and cloudflared.env (the
# live Cloudflare Tunnel token, fetched through the Cloudflare API).
# Usage: ai-trading/deploy/ci/render-env.sh OUT_DIR
set -Eeuo pipefail
umask 077

OUT_DIR="${1:?usage: render-env.sh OUT_DIR}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
BUNDLE_TOOL="$REPO_ROOT/infrastructure/secrets/env-bundle.py"

python3 "$BUNDLE_TOOL" render ai-trading --out-dir "$OUT_DIR" tradingagents ai-hedge-fund vibe-trading

FETCH_SCRIPT="$(mktemp)"
cleanup() { rm -f "$FETCH_SCRIPT"; }
trap cleanup EXIT

cat >"$FETCH_SCRIPT" <<'SCRIPT_EOF'
set -Eeuo pipefail
tunnel_id="$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$TF_VAR_cloudflare_account_id/cfd_tunnel?name=ai-trading&is_deleted=false" \
  | jq -r '.result[0].id')"
if [[ -z "$tunnel_id" || "$tunnel_id" == "null" ]]; then
  echo "render-env: ai-trading tunnel not found" >&2
  exit 1
fi
token="$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$TF_VAR_cloudflare_account_id/cfd_tunnel/$tunnel_id/token" \
  | jq -r '.result')"
if [[ -z "$token" || "$token" == "null" ]]; then
  echo "render-env: empty tunnel token" >&2
  exit 1
fi
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  echo "::add-mask::$token"
fi
umask 077
printf 'TUNNEL_TOKEN=%s\n' "$token" >"$OUT_DIR/cloudflared.env"
chmod 0600 "$OUT_DIR/cloudflared.env"
SCRIPT_EOF
chmod 0700 "$FETCH_SCRIPT"

export OUT_DIR
python3 "$BUNDLE_TOOL" exec ai-trading cloudflare -- bash "$FETCH_SCRIPT"
