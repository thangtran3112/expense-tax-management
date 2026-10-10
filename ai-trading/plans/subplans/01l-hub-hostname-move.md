# Hub Hostname Move to `trading-hub` and Terminal Hostnames: Design

**Date:** 2026-10-10 · **Lane:** open-source (Trading Hub) · **Status:** draft for owner review

Related: [02a §8](02a-desk-v1-strategies-design.md) (hostnames), [01e](01e-static-hub-gcs-design.md) and [01h](01h-static-hub-clerk-implementation.md) (static hub, Worker, Clerk gate, Task 10 staging checks), [STATUS.md](../STATUS.md).

## 1. Goal

- The Trading Hub's public address becomes `https://trading-hub.tobytran.dev`, so the Family Desk can take `trading.tobytran.dev` (Desk Phase 4).
- TradingAgents and ai-hedge-fund also get their own hostnames: `tradingagents.tobytran.dev` and `ai-hedge-fund.tobytran.dev`.
- Success: everything the hub does today works on `trading-hub`, both terminal hostnames open a full-screen terminal after sign-in, and `trading.tobytran.dev` can be handed to the Desk without touching hub code again.

## 2. Owner Decisions (2026-10-10)

| Question | Decision |
|---|---|
| How `trading-hub` serves the hub | Worker + GCS: `trading-static` is renamed `trading-hub`. This approves the 01h Task 11 public Worker cutover for the hub's new hostname. The auth limits (copied cookie valid up to one hour, cross-tab refresh, open streams not closed) are unchanged and already live on `trading.tobytran.dev`. |
| Vibe-Trading and MiroFish | Keep their own hostnames. No upstream patches. |
| TradingAgents and ai-hedge-fund | Add dedicated hostnames. They stay reachable as `/u/*` routes on the hub too. |

## 3. Design

### 3.1 Hostnames after this change

| Host | Served by | Notes |
|---|---|---|
| `trading-hub.tobytran.dev` | `ai-trading-hub-router` Worker: static export from GCS; `/u/*` and `/__auth/*` proxied to `trading-origin` → tunnel → Caddy | Replaces `trading-static` (its DNS record and Worker route are renamed, so `trading-static` stops resolving) |
| `trading-origin.tobytran.dev` | Tunnel → Caddy | Unchanged |
| `tradingagents.tobytran.dev` | Tunnel → Caddy → `ta-terminal` | New |
| `ai-hedge-fund.tobytran.dev` | Tunnel → Caddy → `ahf-terminal` | New |
| `trading.tobytran.dev` | Tunnel → `web:3000` and Caddy, as today | Keeps serving the hub until Desk Phase 4 takes it. Nothing new may link to it as the hub. |
| `vibe-trading.`, `mirofish-static.` | Unchanged | MiroFish's login redirect now points at `trading-hub` |

### 3.2 Terminal hostnames (Caddy)

- One host block per terminal in `deploy/production/Caddyfile`, placed before the catch-all `:8080` block (the same pattern as Vibe-Trading's block).
- Each block runs the existing gate unchanged: strip `Cf-Access-Authenticated-User-Email`, `forward_auth auth:8181` with `uri /__auth/check`, copy the verified email into that header.
- `rewrite * /u/<app>{uri}`, then `reverse_proxy <app>-terminal:7681`. ttyd 1.7.7 builds its `token` and `ws` URLs from `location.pathname`, so at `/` it asks for `/token` and `/ws`. The rewrite maps them onto its `--base-path`, so the URL stays clean and the container is unchanged.
- ttyd `--check-origin` compares `Origin` with `Host`. Both are the terminal hostname on this path, so it passes without the Worker's origin rewrite.
- Signed out: a top-level navigation (`Sec-Fetch-Mode: navigate`) gets a 302 to `https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2F<host>%2F`, a fixed literal per host (Caddy has no URL-encoding placeholder, and the terminal only has one page). Every other unauthenticated request (`/token`, `/ws`) gets the 401 it gets today.
- The hub's `safeReturnTo` allowlist adds the two exact hostnames.

### 3.3 Hub frontend

- `lib/apps.ts`: each terminal app gets a `hostUrl` (`https://tradingagents.tobytran.dev/`, `https://ai-hedge-fund.tobytran.dev/`). The terminal page's "Open in new tab" link uses it. The embedded iframe keeps the same-origin `/u/<app>/` path, so it needs no cross-site cookie or framing change.
- `lib/auth.ts`: add the two hostnames to `ALLOWED_RETURN_TO_HOSTS`.
- No hard-coded hub hostname is added. The Desk card has no link today and gets none here.

### 3.4 Auth service and Clerk

- `ALLOWED_ORIGINS` (Firestore `ai-trading/gateway`) becomes `https://trading.tobytran.dev,https://trading-hub.tobytran.dev`. `trading-static` is removed after the rename. The terminal hostnames are not added: they never call `/__auth/session` or `/__auth/logout`, they only send the `Domain=tobytran.dev` cookie to `/__auth/check`.
- `CLERK_AUDIENCE` stays `https://trading.tobytran.dev`. It is a fixed custom claim in the one Clerk instance's session token template, which `expense` shares (`clerk.tobytran.dev`), so it cannot differ per host. It is an opaque instance-wide marker. The per-host check is `azp` against `ALLOWED_ORIGINS`. Only the comment in `auth/src/clerk.js` changes, to say this.
- Clerk instance: read its `allowed_origins` setting. If the list is non-empty, add `https://trading-hub.tobytran.dev` through the Clerk API (`clerk-cli` skill). If it is empty, nothing changes; `trading-static` already worked that way.
- The session cookie already uses `Domain=tobytran.dev`, so one sign-in covers the hub, both terminal hostnames, Vibe-Trading, and MiroFish.

### 3.5 Cloudflare Terraform (`infrastructure/cloudflare/ai-trading/`)

- `hub-static-variables.tf`: `hub_static_hostname` default becomes `trading-hub.tobytran.dev`. The DNS record and Worker route update in place; the resource addresses stay.
- `variables.tf`: new `terminal_hostnames` map (`tradingagents`, `ai_hedge_fund`). `hub_hostname` keeps `trading.tobytran.dev`; its description says it is the interim hub host until Desk Phase 4.
- `main.tf`: one tunnel ingress entry per terminal hostname to `http://gateway:8080`, and the same hostnames merged into `local.tunnel_hostnames` for their proxied CNAME records.
- `workers/mirofish-static.js`: `HUB_LOGIN_URL` becomes `https://trading-hub.tobytran.dev/login`, with its tests.
- The README hostname table is updated.

### 3.6 What this does not change

- Vibe-Trading, MiroFish's own hostnames, the upstream apps, the `web` container, and `trading.tobytran.dev`'s routes.
- After Desk Phase 4 takes `trading.tobytran.dev`, this lane removes the now-unused `web` service and the `hub_hostname` tunnel entries in a small follow-up, unless Phase 4 already did.

## 4. Rollout Order

1. One PR to `dev` with the code, Terraform, and docs above. Release the `ai-trading/` and `infrastructure/cloudflare/ai-trading/` paths to `main` with `[skip ci]`.
2. Add `https://trading-hub.tobytran.dev` to Firestore `ALLOWED_ORIGINS`, keeping the other two, and check Clerk `allowed_origins` (§3.4).
3. Deploy dispatch with `deploy_app=true` and `upload_hub_static=true`. MiroFish stays on through `keep`. `deploy.sh` renders the new `ALLOWED_ORIGINS`, and Caddy gets the terminal host blocks.
4. Apply `cloudflare/ai-trading` (DNS, Worker route rename, tunnel ingress, MiroFish Worker update).
5. Verify (§5), then remove `trading-static` from `ALLOWED_ORIGINS` and redeploy.
6. Tell the Desk lane that the move is done (STATUS row and the next handoff). Phase 4 then points `trading.tobytran.dev` at the Desk.

Rollback: revert the Terraform defaults and apply. That brings `trading-static` back and removes the terminal hostnames. `trading.tobytran.dev` serves the hub throughout.

## 5. Verification

Offline, before merge:
- `node --test` in `ai-trading/auth`, `pnpm test` in `ai-trading/frontend` (return-to allowlist and `hostUrl`), the Worker tests in `infrastructure/cloudflare/ai-trading/worker` and `workers`.
- `deploy/ci/smoke-test.sh all` against the real Caddy, extended with: on a terminal hostname, no cookie → `/` navigation 302 to the hub login and `/ws` 401; a forged identity header is stripped; a verified cookie reaches ttyd at `/` and `/ws`. An unknown `Host` still hits the catch-all.
- `terraform validate` for the root.

Live, after rollout (the 01h Task 10 checks repeated on `trading-hub`):
- `trading-hub` `/` and `/apps/tradingagents` return 200 from the Worker; `/u/*` returns 401 without a session, including with a forged identity header.
- Signed in (Chromium on the agent profile; the owner repeats the Safari check): hub sign-in, reload, and both embedded terminals get WebSocket 101 through Worker → `trading-origin` → Caddy → ttyd.
- `tradingagents.` and `ai-hedge-fund.tobytran.dev`: a signed-out navigation redirects to the hub login and returns to the terminal after sign-in; signed in, the terminal opens full-screen with WebSocket 101.
- The `mirofish-static` login redirect goes to `trading-hub`; `trading.tobytran.dev` still serves the hub; `trading-static` no longer resolves.
- Production containers stay healthy, MiroFish stays on, and the expense stack is untouched.
