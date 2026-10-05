# Local Stack

Runs the release 1 stack on a laptop, with Caddy standing in for the Cloudflare Tunnel. Run every command from the repository root.

1. Create local secrets (gitignored):

   ```bash
   mkdir -p ai-trading/deploy/local/secrets
   for f in ai-trading/deploy/production/env/*.env.example; do
     cp "$f" "ai-trading/deploy/local/secrets/$(basename "$f" .example)"
   done
   ```

   In the copies, delete every line whose value is `replace-me`. Then set `API_AUTH_KEY=local-dev-key` in `vibe-trading.env` and `TUNNEL_TOKEN=unused-locally` in `cloudflared.env`. Add provider keys only if you want real LLM runs.

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

4. Open http://localhost:8080 for the hub. Vibe-Trading is at http://localhost:8899; paste `local-dev-key` when it asks.

5. Stop the stack: run the same compose command with `down` instead of `up -d --wait`.
