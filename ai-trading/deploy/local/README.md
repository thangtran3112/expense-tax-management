# Local Stack

Runs the release 1 stack on a laptop, with Caddy standing in for the Cloudflare Tunnel. Run every command from the repository root. Every value comes from Firestore `family-config` through `common/config/family_config.py` (`common/config/README.md`); never an old Secret Manager bundle, never a `.env` file inside `ai-trading/`.

This stack's own `deploy/local/Caddyfile` (loaded by the `router` service in step 3's override) injects a **mock** identity header (`Cf-Access-Authenticated-User-Email: local-dev@example.test`) straight onto the terminal routes — it never calls the real `auth`/`gateway` services and never exercises Clerk. It is a UI smoke stack, not an auth test. The real production gate (Caddy `forward_auth` → `auth:8181` → Clerk token verification, `deploy/production/Caddyfile`) is tested separately, against a real Caddy container, by `ai-trading/deploy/ci/smoke-test.sh all` (see `ai-trading/AGENTS.md`'s Verification section).

1. Render the four Firestore profiles into a directory outside the repository (never commit or gitignore a secret file inside `ai-trading/`). `render` writes one file per profile named after the profile; `ai-trading/gateway` is renamed `auth.env` to match the compose service that reads it, the same rename `deploy.sh` does in production:

   ```bash
   export AI_TRADING_SECRETS_DIR="${TMPDIR:-/tmp}/ai-trading-local-env"
   common/config/family_config.py render \
     ai-trading/tradingagents ai-trading/ai-hedge-fund ai-trading/vibe-trading ai-trading/gateway \
     --out-dir "$AI_TRADING_SECRETS_DIR"
   mv "$AI_TRADING_SECRETS_DIR/gateway.env" "$AI_TRADING_SECRETS_DIR/auth.env"
   printf 'TUNNEL_TOKEN=unused-locally\n' >"$AI_TRADING_SECRETS_DIR/cloudflared.env"
   chmod 0600 "$AI_TRADING_SECRETS_DIR/cloudflared.env"
   ```

   `vibe-trading.env` renders with the real shared `API_AUTH_KEY`; overwrite it with the fixed local-dev key so it matches the value pasted in step 4 (never display or reuse the production key locally):

   ```bash
   sed -i.bak 's/^API_AUTH_KEY=.*/API_AUTH_KEY=local-dev-key/' "$AI_TRADING_SECRETS_DIR/vibe-trading.env" && rm -f "$AI_TRADING_SECRETS_DIR/vibe-trading.env.bak"
   printf 'VIBE_API_AUTH_KEY=local-dev-key\n' >"$AI_TRADING_SECRETS_DIR/vibe-gateway.env"
   chmod 0600 "$AI_TRADING_SECRETS_DIR/vibe-gateway.env"
   ```

   `vibe-gateway.env` is what production's `deploy.sh` derives for the Caddy gateway, which supplies Vibe's key after the Clerk check. The local `router` does not use it, so step 4's pasted key still applies locally.

2. Build the images. The frontend build needs the public Clerk key as a build arg (`CLERK_PUBLISHABLE_KEY`, baked in as `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`); an empty value fails the build on purpose:

   ```bash
   export CLERK_PUBLISHABLE_KEY="$(common/config/family_config.py get ai-trading/clerk PUBLISHABLE_KEY)"
   TAG=local VIBE_TRADING_URL=http://localhost:8899 docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load
   ```

3. Start the stack:

   ```bash
   docker compose -p ai-trading-local --env-file ai-trading/deploy/local/local.env \
     -f ai-trading/deploy/production/docker-compose.yml \
     -f ai-trading/deploy/production/docker-compose.mirofish.yml \
     -f ai-trading/deploy/local/docker-compose.override.yml up -d --wait
   ```

4. Open http://localhost:8080 for the hub. Vibe-Trading is at http://localhost:8899; on first visit open Settings > Local API access, paste `local-dev-key` into Server API key, and save.

5. Stop the stack: run the same compose command with `down` instead of `up -d --wait`.
