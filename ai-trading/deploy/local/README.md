# Local Stack

Runs the release 1 stack on a laptop, with Caddy standing in for the Cloudflare Tunnel. Run every command from the repository root.

1. Render env files from the Secret Manager bundle into a directory outside the repository (never commit or gitignore a secret file inside `ai-trading/`):

   ```bash
   export AI_TRADING_SECRETS_DIR="${TMPDIR:-/tmp}/ai-trading-local-env"
   CLOUDSDK_ACTIVE_CONFIG_NAME=personal python3 infrastructure/secrets/env-bundle.py render ai-trading \
     --out-dir "$AI_TRADING_SECRETS_DIR" tradingagents ai-hedge-fund vibe-trading
   printf 'TUNNEL_TOKEN=unused-locally\n' >"$AI_TRADING_SECRETS_DIR/cloudflared.env"
   chmod 0600 "$AI_TRADING_SECRETS_DIR/cloudflared.env"
   ```

   `vibe-trading.env` renders with the real shared `API_AUTH_KEY` from the bundle; overwrite it with the fixed local-dev key so it matches the value pasted in step 4 (never display or reuse the production key locally):

   ```bash
   sed -i.bak 's/^API_AUTH_KEY=.*/API_AUTH_KEY=local-dev-key/' "$AI_TRADING_SECRETS_DIR/vibe-trading.env" && rm -f "$AI_TRADING_SECRETS_DIR/vibe-trading.env.bak"
   ```

2. Build the images:

   ```bash
   TAG=local VIBE_TRADING_URL=http://localhost:8899 docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load
   ```

3. Start the stack:

   ```bash
   docker compose -p ai-trading-local --env-file ai-trading/deploy/local/local.env \
     -f ai-trading/deploy/production/docker-compose.yml \
     -f ai-trading/deploy/local/docker-compose.override.yml up -d --wait
   ```

4. Open http://localhost:8080 for the hub. Vibe-Trading is at http://localhost:8899; on first visit open Settings > Local API access, paste `local-dev-key` into Server API key, and save.

5. Stop the stack: run the same compose command with `down` instead of `up -d --wait`.
