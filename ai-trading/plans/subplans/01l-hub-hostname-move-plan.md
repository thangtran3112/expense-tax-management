# Hub Hostname Move and Terminal Hostnames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Trading Hub on `trading-hub.tobytran.dev` (Worker + GCS) and the two terminals on `tradingagents.tobytran.dev` and `ai-hedge-fund.tobytran.dev`, leaving `trading.tobytran.dev` untouched for Desk Phase 4.

**Architecture:** Rename the existing staging Worker hostname `trading-static` to `trading-hub` in Terraform. Add two tunnel hostnames that reach new Caddy host blocks, which run the existing Clerk-cookie gate, rewrite `/` onto ttyd's `--base-path`, and redirect signed-out navigations to the hub login. The hub links to the new hostnames and allows them as `returnTo` targets.

**Tech Stack:** Caddy 2, Cloudflare Terraform provider v5, Cloudflare Workers (JS modules), Next.js static export (TypeScript, `node --test`), Bash smoke tests with Docker.

**Spec:** `ai-trading/plans/subplans/01l-hub-hostname-move.md`

## Global Constraints

- Never edit `ai-trading/packages/*`. Never print secrets. Public repo: no emails, account numbers, or VPS addresses.
- `trading.tobytran.dev` keeps its current tunnel routes (`web:3000` plus `/u/*` and `/__auth/*` to Caddy) until Desk Phase 4. Nothing new links to it as the hub.
- `CLERK_AUDIENCE` stays `https://trading.tobytran.dev`; only its comment changes.
- `ALLOWED_ORIGINS` final value: `https://trading.tobytran.dev,https://trading-hub.tobytran.dev`. Terminal hostnames are not added.
- Signed-out redirect target is the fixed literal `https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2F<host>%2F`.
- Infrastructure only through Terraform under `infrastructure/`. Deploys keep MiroFish (`MIROFISH_ACTIVATE=keep`).
- One PR to `dev` for the whole change (root `AGENTS.md`, "Conserve GitHub Actions minutes"). Work on `feature/toby` in the main checkout.

## Review Focus

- A request for `/u/tradingagents/` on a terminal hostname must not bypass the gate: it gets 401 signed out (smoke test in Task 1).
- A WebSocket upgrade from a signed-out browser on a terminal hostname gets 401, not a 302 (smoke test in Task 1).
- The `127.0.0.1`/`trading-origin` path (no matching host block) keeps its `/u/*` gate: existing 401 and forged-header checks still pass (Task 1 reruns them).
- Look-alike `returnTo` hosts (`tradingagents.tobytran.dev.evil.com`, `http://`, explicit ports, userinfo) fall back to `/` (unit tests in Task 2).
- `terraform plan` must show no change to the four `trading.tobytran.dev` ingress entries or its DNS record (checked in Task 4 and at rollout).

---

### Task 1: Terminal host blocks in Caddy, with real-Caddy smoke checks

**Files:**
- Modify: `ai-trading/deploy/production/Caddyfile` (insert after the Vibe-Trading block, before `:8080 {`)
- Modify: `ai-trading/deploy/ci/smoke-test.sh` (`smoke_gateway`)

**Interfaces:**
- Produces: hostnames `tradingagents.tobytran.dev` → `ta-terminal:7681`, `ai-hedge-fund.tobytran.dev` → `ahf-terminal:7681`, used by Task 4's tunnel ingress.

- [ ] **Step 1: Write the failing smoke checks.** In `smoke_gateway`, right after the line `echo "ok   Caddy replaced a spoofed Cf-Access-Authenticated-User-Email header with the verified one"`, add:

```bash
  # Terminal hostnames (01l): same gate, `/` rewritten onto ttyd's base path,
  # signed-out navigations sent to the hub login, everything else 401.
  local ta_host=(-H 'Host: tradingagents.tobytran.dev')
  local nav
  nav="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "${ta_host[@]}" -H 'Sec-Fetch-Mode: navigate' http://127.0.0.1:18080/)"
  [[ "$nav" == "302 https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Ftradingagents.tobytran.dev%2F" ]] \
    || fail "signed-out navigation on the terminal hostname should redirect to the hub login, got: $nav"
  echo "ok   signed-out navigation on a terminal hostname redirects to the hub login"
  expect_status 401 http://127.0.0.1:18080/token "${ta_host[@]}"
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/ "${ta_host[@]}"
  expect_status 401 http://127.0.0.1:18080/ "${ta_host[@]}" --cookie "$expired_cookie" -H 'Sec-Fetch-Mode: websocket'
  body="$(curl -s --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' "${ta_host[@]}" http://127.0.0.1:18080/)"
  [[ "$body" == "smoke@example.test" ]] || fail "terminal hostname: expected the verified email upstream, got: $body"
  echo "ok   terminal hostname replaces a spoofed identity header with the verified one"
  expect_status 401 http://127.0.0.1:18080/token -H 'Host: ai-hedge-fund.tobytran.dev'
```

And after the existing `echo "ok   WebSocket handshake reaches a real ttyd through Caddy with a valid cookie"`, add:

```bash
  ws_status="$(curl -s -o /dev/null -w '%{http_code}' --cookie "$cookie" -H 'Host: tradingagents.tobytran.dev' \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H 'Origin: http://tradingagents.tobytran.dev' \
    http://127.0.0.1:18080/ws)"
  [[ "$ws_status" == "101" ]] || fail "expected 101 from a real ttyd at /ws on the terminal hostname, got $ws_status"
  echo "ok   WebSocket handshake reaches a real ttyd at /ws on the terminal hostname"
```

(ttyd's `--check-origin` compares the `Origin` host with `Host`; both are `tradingagents.tobytran.dev` here.)

- [ ] **Step 2: Run to verify it fails.** From the repo root, after `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load auth ta-terminal vibe-trading`:

Run: `ai-trading/deploy/ci/smoke-test.sh gateway`
Expected: FAIL at "signed-out navigation on the terminal hostname should redirect" (the catch-all answers 401 with no redirect).

- [ ] **Step 3: Add the host blocks.** Insert into `Caddyfile` before `:8080 {`:

```caddy
# Terminal hostnames (01l). Same gate as the /u/* routes below; `/` is
# rewritten onto ttyd's --base-path (ttyd builds its token and ws URLs from
# location.pathname), so the terminal opens at the hostname root. A signed-out
# top-level navigation is sent to the hub login with a fixed returnTo; every
# other unauthenticated request (token, ws) keeps the plain 401.
http://tradingagents.tobytran.dev:8080 {
	route {
		request_header -Cf-Access-Authenticated-User-Email
		forward_auth auth:8181 {
			uri /__auth/check
			copy_headers X-Verified-Email>Cf-Access-Authenticated-User-Email
			@denied status 401
			handle_response @denied {
				@navigate header Sec-Fetch-Mode navigate
				redir @navigate https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Ftradingagents.tobytran.dev%2F 302
				respond 401
			}
		}
		rewrite * /u/tradingagents{uri}
		reverse_proxy ta-terminal:7681
	}
}

http://ai-hedge-fund.tobytran.dev:8080 {
	route {
		request_header -Cf-Access-Authenticated-User-Email
		forward_auth auth:8181 {
			uri /__auth/check
			copy_headers X-Verified-Email>Cf-Access-Authenticated-User-Email
			@denied status 401
			handle_response @denied {
				@navigate header Sec-Fetch-Mode navigate
				redir @navigate https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Fai-hedge-fund.tobytran.dev%2F 302
				respond 401
			}
		}
		rewrite * /u/ai-hedge-fund{uri}
		reverse_proxy ahf-terminal:7681
	}
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `ai-trading/deploy/ci/smoke-test.sh gateway`
Expected: all `ok` lines, ending `smoke tests passed: gateway`. The pre-existing checks (bare `/u/tradingagents/` 401, forged header, Vibe host) still pass.

- [ ] **Step 5: Commit.**

```bash
git add ai-trading/deploy/production/Caddyfile ai-trading/deploy/ci/smoke-test.sh
git commit -m "feat(ai-trading): tradingagents and ai-hedge-fund hostnames behind the Caddy gate"
```

### Task 2: Hub links and returnTo allowlist

**Files:**
- Modify: `ai-trading/frontend/lib/apps.ts` (`TerminalApp` type, the two terminal entries)
- Modify: `ai-trading/frontend/components/terminal-frame.tsx:29` ("Open in new tab" `href`)
- Modify: `ai-trading/frontend/lib/auth.ts:220-231` (`ALLOWED_RETURN_TO_HOSTS` and its comment)
- Test: `ai-trading/frontend/lib/auth.test.ts`

**Interfaces:**
- Consumes: Task 1's hostnames.
- Produces: `TerminalApp.hostUrl: \`https://${string}/\``.

- [ ] **Step 1: Write the failing tests.** Append to `lib/auth.test.ts`:

```ts
test("safeReturnTo allows the terminal hostnames' root over https (01l)", () => {
  assert.equal(safeReturnTo("https://tradingagents.tobytran.dev/"), "https://tradingagents.tobytran.dev/");
  assert.equal(safeReturnTo("https://ai-hedge-fund.tobytran.dev/"), "https://ai-hedge-fund.tobytran.dev/");
});

test("safeReturnTo rejects look-alike terminal hostnames (01l)", () => {
  assert.equal(safeReturnTo("http://tradingagents.tobytran.dev/"), "/");
  assert.equal(safeReturnTo("https://tradingagents.tobytran.dev.evil.com/"), "/");
  assert.equal(safeReturnTo("https://tradingagents.tobytran.dev:443/"), "/");
  assert.equal(safeReturnTo("https://user:pass@ai-hedge-fund.tobytran.dev/"), "/");
  assert.equal(safeReturnTo("https://evil-ai-hedge-fund.tobytran.dev/"), "/");
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd ai-trading/frontend && pnpm test`
Expected: FAIL in "allows the terminal hostnames' root" (returns `/`).

- [ ] **Step 3: Implement.** In `lib/auth.ts`, extend the set and its comment:

```ts
// ...and the two terminal hostnames (01l): their Caddy gate sends a
// signed-out navigation to /login with returnTo set to the terminal root.
const ALLOWED_RETURN_TO_HOSTS: ReadonlySet<string> = new Set([
  "mirofish.tobytran.dev",
  "mirofish-static.tobytran.dev",
  "tradingagents.tobytran.dev",
  "ai-hedge-fund.tobytran.dev",
]);
```

In `lib/apps.ts`:

```ts
export type TerminalApp = BaseApp & {
  kind: "terminal";
  status: "live";
  terminalPath: `/u/${string}/`;
  hostUrl: `https://${string}/`;
};
```

and add `hostUrl: "https://tradingagents.tobytran.dev/",` after `terminalPath: "/u/tradingagents/",`, and `hostUrl: "https://ai-hedge-fund.tobytran.dev/",` after `terminalPath: "/u/ai-hedge-fund/",`.

In `components/terminal-frame.tsx`, change the "Open in new tab" anchor's `href={app.terminalPath}` to `href={app.hostUrl}` (the iframe keeps `src={app.terminalPath}`).

- [ ] **Step 4: Run to verify it passes.**

Run: `cd ai-trading/frontend && pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all pass; `out/` builds.

- [ ] **Step 5: Commit.**

```bash
git add ai-trading/frontend/lib/apps.ts ai-trading/frontend/lib/auth.ts ai-trading/frontend/lib/auth.test.ts ai-trading/frontend/components/terminal-frame.tsx
git commit -m "feat(ai-trading): hub links to the terminal hostnames and accepts them as returnTo"
```

### Task 3: MiroFish login redirect and the audience comment

**Files:**
- Modify: `infrastructure/cloudflare/ai-trading/workers/mirofish-static.js:59`
- Test: `infrastructure/cloudflare/ai-trading/workers/mirofish-static.test.js` (lines 200, 209, 236, 257, 288, 295, 354)
- Modify: `ai-trading/auth/src/clerk.js:16-20` (comment only)

- [ ] **Step 1: Update the tests first.** Replace every `https://trading.tobytran.dev/login` with `https://trading-hub.tobytran.dev/login`, and the hostname assertion `"trading.tobytran.dev"` (line 288) with `"trading-hub.tobytran.dev"`:

```bash
sed -i '' -e 's|https://trading\.tobytran\.dev/login|https://trading-hub.tobytran.dev/login|g' \
  -e 's|parsed.hostname, "trading\.tobytran\.dev"|parsed.hostname, "trading-hub.tobytran.dev"|' \
  infrastructure/cloudflare/ai-trading/workers/mirofish-static.test.js
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node --test infrastructure/cloudflare/ai-trading/workers/*.test.js`
Expected: FAIL (the Worker still redirects to `trading.tobytran.dev`).

- [ ] **Step 3: Implement.** In `mirofish-static.js`: `const HUB_LOGIN_URL = "https://trading-hub.tobytran.dev/login";`. In `clerk.js`, replace the comment above `CLERK_ISSUER` with:

```js
// Fixed per 01e's binding ruling. CLERK_AUDIENCE is the custom `aud` claim of
// the single Clerk instance's session-token template, which expense shares,
// so it cannot differ per hub host (01l §3.4): treat it as an opaque marker.
// The per-host check is `azp` against ALLOWED_ORIGINS. Not caller-configurable.
```

- [ ] **Step 4: Run to verify it passes.**

Run: `node --test infrastructure/cloudflare/ai-trading/workers/*.test.js infrastructure/cloudflare/ai-trading/worker/*.test.js && (cd ai-trading/auth && node --test)`
Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add infrastructure/cloudflare/ai-trading/workers/mirofish-static.js infrastructure/cloudflare/ai-trading/workers/mirofish-static.test.js ai-trading/auth/src/clerk.js
git commit -m "feat(ai-trading): MiroFish login redirect goes to trading-hub"
```

### Task 4: Cloudflare Terraform

**Files:**
- Modify: `infrastructure/cloudflare/ai-trading/hub-static-variables.tf:6-10`
- Modify: `infrastructure/cloudflare/ai-trading/variables.tf`
- Modify: `infrastructure/cloudflare/ai-trading/main.tf` (ingress list, `locals.tunnel_hostnames`)
- Modify: `infrastructure/cloudflare/ai-trading/hub-static.tf:31` (comment string only)
- Modify: `infrastructure/cloudflare/ai-trading/README.md` (hostname table)

**Interfaces:**
- Consumes: Task 1's hostnames.

- [ ] **Step 1: Variables.** `hub-static-variables.tf`:

```hcl
variable "hub_static_hostname" {
  type        = string
  description = "Public Trading Hub hostname, served by the hub-router Worker from GCS (01l; formerly the trading-static staging hostname)."
  default     = "trading-hub.tobytran.dev"
}
```

`variables.tf`: change `hub_hostname`'s description to `"Interim hub hostname, tunneled to web:3000 and the Caddy gateway until Desk Phase 4 takes it (01l)."` and append:

```hcl
variable "terminal_hostnames" {
  type        = map(string)
  description = "Dedicated terminal hostnames, tunneled to the Caddy gateway (01l)."
  default = {
    tradingagents = "tradingagents.tobytran.dev"
    ai_hedge_fund = "ai-hedge-fund.tobytran.dev"
  }
}
```

- [ ] **Step 2: Ingress and DNS.** In `main.tf`, change the config to build the list with the terminal entries placed right after the Vibe-Trading entry (Cloudflare matches ingress rules in order; the catch-all must stay last):

```hcl
  config = {
    ingress = concat(
      [
        # ... the existing hub_hostname and vibe_trading_hostname entries, unchanged ...
      ],
      [for name, host in var.terminal_hostnames : {
        # 01l: whole hostname to the Caddy gateway, whose host block runs
        # the same Clerk-cookie gate as /u/* and rewrites / onto ttyd.
        hostname = host
        service  = "http://gateway:8080"
      }],
      [
        # ... the existing hub_origin_hostname, mirofish_origin_hostname, and http_status:404 entries, unchanged ...
      ],
    )
  }
```

Move the existing entries verbatim (comments included) into the first and third lists. Then:

```hcl
locals {
  tunnel_hostnames = merge(
    {
      hub          = var.hub_hostname
      vibe_trading = var.vibe_trading_hostname
    },
    var.terminal_hostnames,
  )
}
```

`hub-static.tf`: change the DNS comment to `"ai-trading hub (Worker-routed)"`. README table: add rows for `trading-hub.tobytran.dev` (Worker: static from GCS, `/u/*` and `/__auth/*` via `trading-origin`), `tradingagents.tobytran.dev` and `ai-hedge-fund.tobytran.dev` (Caddy gate → terminal), and mark `trading.tobytran.dev` as the interim hub host until Desk Phase 4.

- [ ] **Step 3: Validate.**

Run (repo root): `docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest init -backend=false && docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest fmt -check && docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest validate`
Expected: `Success! The configuration is valid.` Remove the `.terraform/` directory and lock file changes it creates if they are not already tracked.

- [ ] **Step 4: Plan against live state (read-only).** Follow the README's "Local apply" `init` and `plan` (no `apply`). Expected changes only: DNS record `hub_static_staging` name → `trading-hub`, Worker route `hub_static` pattern → `trading-hub.tobytran.dev/*`, two new DNS records, the tunnel config gaining two ingress entries. No change to `cloudflare_dns_record.tunnel["hub"]` and no change to the four `trading.tobytran.dev` ingress entries. Delete `tfplan`.

- [ ] **Step 5: Commit.**

```bash
git add infrastructure/cloudflare/ai-trading/
git commit -m "feat(ai-trading): trading-hub replaces trading-static; terminal hostnames in the tunnel"
```

### Task 5: Docs

**Files:**
- Modify: `ai-trading/deploy/production/README.md` (URL table lines 7-9; acceptance checklist)
- Modify: `ai-trading/AGENTS.md` ("Hostnames" bullets)
- Modify: `ai-trading/frontend/static-server.mjs:6` (comment), `ai-trading/deploy/local/Caddyfile:6` (comment)

- [ ] **Step 1: Runbook.** URL table: `web` → `https://trading-hub.tobytran.dev/` (Worker; `web` container serves the interim `trading.tobytran.dev`), `ta-terminal` → `https://tradingagents.tobytran.dev/` (also `/u/tradingagents/` on the hub), `ahf-terminal` → `https://ai-hedge-fund.tobytran.dev/` (also `/u/ai-hedge-fund/`). Acceptance checklist: add "terminal hostnames redirect a signed-out browser to the hub login and open full-screen after sign-in".

- [ ] **Step 2: AGENTS.md.** Replace the bullets that say TradingAgents and ai-hedge-fund have no hostnames and that the hub has not moved with:

```md
- `tradingagents.tobytran.dev` and `ai-hedge-fund.tobytran.dev`: the two terminals, full-screen, behind the same Caddy/Clerk gate (01l). They also stay `/u/*` routes on the hub.
- The hub moved to `trading-hub.tobytran.dev` (Worker + GCS, 01l). `trading.tobytran.dev` still serves the hub from `web:3000` only until Desk Phase 4 takes it; do not link to it as the hub.
```

- [ ] **Step 3: Comments.** `static-server.mjs` and `deploy/local/Caddyfile`: name `trading-hub.tobytran.dev` where they describe the public hub.

- [ ] **Step 4: Commit.**

```bash
git add ai-trading/deploy/production/README.md ai-trading/AGENTS.md ai-trading/frontend/static-server.mjs ai-trading/deploy/local/Caddyfile
git commit -m "docs(ai-trading): hub on trading-hub, terminal hostnames"
```

### Task 6: Ship and roll out

- [ ] **Step 1: Full local verification.** `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load` then `ai-trading/deploy/ci/smoke-test.sh all`; `pnpm test` in `ai-trading/frontend`; the Worker and auth tests from Task 3. Whole-branch review by a fresh reviewer.
- [ ] **Step 2: PR.** `git fetch origin && git merge origin/dev`, push `feature/toby`, open one PR to `dev`, wait for the required check, merge with `--match-head-commit`.
- [ ] **Step 3: Firestore before release.** Append the new origin without printing the profile:

```bash
cur="$(common/config/family_config.py get ai-trading/gateway ALLOWED_ORIGINS)"
printf '%s' "$cur,https://trading-hub.tobytran.dev" | common/config/family_config.py set ai-trading/gateway ALLOWED_ORIGINS
```

- [ ] **Step 4: Clerk.** Load the `clerk-cli` skill, read the production instance's `allowed_origins`. If non-empty, add `https://trading-hub.tobytran.dev`; if empty, change nothing.
- [ ] **Step 5: Release.** Scoped release to `main` of every path this PR changed (`build-release.sh`, from the handoff's Appendix B). Its push deploy rebuilds images and renders the new `ALLOWED_ORIGINS`; MiroFish stays on through `keep`. Wait for it to finish green.
- [ ] **Step 6: Static upload.** `gh workflow run ai-trading-deploy.yml --ref main -f upload_hub_static=true` (no `deploy_app`). Wait for green.
- [ ] **Step 7: Terraform apply.** `gh workflow run ai-trading-infra.yml --ref main -f apply=true`; read the plan in its log first (the same expectations as Task 4 Step 4). Wait for green.
- [ ] **Step 8: Live checks** (spec §5): `trading-hub` `/` and `/apps/tradingagents` 200; `/u/tradingagents/` 401 with and without a forged identity header; terminal hostnames 302 to the hub login for a navigation and 401 for `/token`; signed-in Chromium (agent profile) gets WebSocket 101 on both embedded terminals and on both terminal hostnames; `mirofish-static` redirects to the `trading-hub` login; `trading.tobytran.dev` still 200; `trading-static` no longer resolves; containers healthy with zero restarts, MiroFish running, expense containers unchanged. Ask the owner to repeat the Safari sign-in check on `trading-hub`.
- [ ] **Step 9: Drop `trading-static`.** Set `ALLOWED_ORIGINS` to exactly `https://trading.tobytran.dev,https://trading-hub.tobytran.dev`, then `gh workflow run ai-trading-deploy.yml --ref main -f deploy_app=true` and recheck that the hub sign-in still works.
- [ ] **Step 10: Record.** STATUS row (move done; Desk Phase 4 unblocked) and the next Trading Hub handoff, carried in the next PR.
