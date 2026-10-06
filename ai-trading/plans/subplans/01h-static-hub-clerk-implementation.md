# Static Hub, GCS, Cloudflare Worker, Clerk + Caddy Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Commit policy override for this plan:** the developer has explicitly forbidden automatic `git add`/`git commit`/`git push` for this work. Every task below ends with a "Report completion (no git operations)" step instead of the writing-plans skill's default "Commit" step — it names the files the task touched and that its tests pass, nothing more. This also keeps parallel subagents safe: several tasks' files can be edited concurrently without two subagents racing to stage the same index. The controlling session decides if and when to run `git add`/`git commit`, only if the user explicitly asks.

**Goal:** Build the Trading Hub's first production deployment as a static export served from a public-read GCS bucket behind a Cloudflare Worker, add client-side Clerk (Google) login, and add a Caddy-based gateway that enforces Clerk-verified sessions — declaratively, via Caddy's `forward_auth` and `reverse_proxy`, not a hand-written Node proxy — as the sole enforcement point for the browser terminals' Cloudflare-Access-style identity header, proven end to end on a staging hostname before `trading.tobytran.dev` is ever exposed publicly.

**Architecture:** `ai-trading/frontend` flips `next.config.ts` to `output: "export"`; its build output (`out/`) is uploaded to a new public-read GCS bucket. A new Cloudflare Worker (`infrastructure/cloudflare/ai-trading/worker/hub-router.js`) serves static GET/HEAD paths from that bucket (falling back to `404.html`), and forwards `/u/*`, `/__auth/*`, `/__control/*` to a new unrouted tunnel-origin hostname (`trading-origin.tobytran.dev`). Two new services sit behind that origin hostname: **`gateway`** (stock `caddy:2-alpine`, port `8080` — the thing the tunnel actually points at) and **`auth`** (a tiny Node service, port `8181`, internal-only). `auth` exposes exactly two routes: `POST /__auth/session` (verify a Clerk session token against the family allowlist and the request's `Origin`, then issue a signed `Secure; HttpOnly; SameSite=Lax; Domain=tobytran.dev` cookie) and `GET /__auth/check` (verify that cookie, returning `204` with an `X-Verified-Email` response header, or `401`). `gateway`'s Caddyfile does the actual enforcement: for `/u/tradingagents*` and `/u/ai-hedge-fund*` it strips any client-supplied `Cf-Access-Authenticated-User-Email` header, runs `forward_auth auth:8181` against `/__auth/check`, copies the verified `X-Verified-Email` response header onto the request as `Cf-Access-Authenticated-User-Email`, and only then `reverse_proxy`s to `ta-terminal`/`ahf-terminal` — Caddy's `reverse_proxy` handles the WebSocket upgrade automatically, with no special-cased code. This moves ttyd's existing `--auth-header` trust boundary onto Caddy+`auth` from the hub's very first deployment, without any change to the upstream terminal images and without a single line of hand-written HTTP-proxy or WebSocket code anywhere in this plan. `ai-trading/frontend/Dockerfile` is rewritten to serve the same static `out/` directory with a small Node static-file server instead of `next start`; deployed as the `web` compose service, it is this plan's simplest, lowest-risk way to put the hub in front of the family at all (no Worker/GCS dependency), and 01e's own documented fallback if the Worker path does not pan out. Everything new is built and proven on a staging hostname (`trading-static.tobytran.dev`) first; only the final, explicitly operator-gated task points `trading.tobytran.dev` itself at the Worker.

**Tech Stack:** Next.js 16 App Router static export, stock `caddy:2-alpine` (Caddyfile only, no Caddy plugin, no custom build) for the gateway, plain Node (`node:http`, no `node:net`, no hand-rolled proxy) for the `auth` service, `@clerk/backend` for server-side Clerk token verification, `@clerk/clerk-react` for the client-side SDK, plain ES module JavaScript (no bundler) for the Cloudflare Worker, Terraform (`hashicorp/google` and `cloudflare/cloudflare` `>= 5.8.2, < 6.0.0`), `common/config/family_config.py` (Firestore `family-config`) for every new secret/config value, Node's built-in `node:test` runner for pure-logic unit tests plus real `docker run`-based integration tests (real Caddy, real `auth` image, a real `ta-terminal`/ttyd image for the WebSocket check) for everything Caddy itself enforces.

**Spec:** [01e-static-hub-gcs-design.md](01e-static-hub-gcs-design.md) (primary — now explicitly requires Caddy `forward_auth`/`reverse_proxy` instead of a custom Node proxy, per owner approval) and [01d-mirofish-hub-design.md](01d-mirofish-hub-design.md) (interfaces only — MiroFish itself is out of scope here). Executors also read [AGENTS.md](../../AGENTS.md), [01-release-1-hub-design.md](01-release-1-hub-design.md) (the code this plan changes — not yet deployed to production; see "Current production state" below), the two sibling implementation plans referenced in "Coordination with sibling plans" below, and the Firestore `family-config` handoff referenced in "Dependency" below.

## Current production state (read this before assuming anything is already live)

- **No ai-trading hub production deployment exists.** PR #21 merged the original three-upstream hub to `dev` only (2026-10-05); nothing under `ai-trading/` has been deployed to the VPS or to `main`. There is no running `web` container and no live Cloudflare Tunnel route serving `trading.tobytran.dev` — "no public backend if gate absent" therefore means this plan must not expose anything publicly before Clerk + the gateway are in place and proven, not that it must preserve some already-running system.
- **Cloudflare Access did not enable successfully.** `infrastructure/cloudflare/ai-trading/main.tf` (merged to `dev`) defines `cloudflare_zero_trust_access_application.ai_trading`/`cloudflare_zero_trust_access_policy.family` in code, but enabling it failed; there is no live Access gate protecting any ai-trading hostname today. Nothing in this plan relies on Access being active, and nothing in this plan claims to be "removing" a live Access gate — Task 11 only ensures the Terraform code stops naming `hub_hostname` as an Access destination, which is correct cleanup regardless of Access's own enablement state. The staging-hostname-first discipline below (Task 10 before Task 11) is not protecting an already-running system — it is 01e's own prescribed build order for a brand-new deployment, and the only thing standing between "no public backend" and a public, unauthenticated one, so it still runs in full.
- Consequently: wherever this plan used to say "the existing (unchanged) Next server," "the currently deployed Next server," or implied a currently live Cloudflare Access + Tunnel route, read it as "this plan's own first deployment of the hub" — there is no prior live Next web process and no prior live Access gate to be unchanged from.

## Dependency: Firestore `family-config` (must land on `dev` before this plan's Tasks 9-11 run)

This plan's new secrets (`CLERK_SECRET_KEY`, `SESSION_SIGNING_KEY`, `ALLOWED_EMAILS`, `ALLOWED_ORIGINS`, `PUBLISHABLE_KEY`) are read from Firestore database `family-config` (project `tobytran-portfolio`) through `common/config/family_config.py`, per the approved design (`docs/superpowers/specs/2026-10-05-family-config-firestore-design.md`) and the ai-trading handoff (`ai-trading/plans/handoffs/2026-10-05-family-config.md`). **Neither exists on this plan's branch yet** — `common/config/` currently lives only on `feature/toby` (commit `c70a67e`), not on `dev`, and is not an ancestor of this worktree's branch. Tasks 1-8 (frontend, Worker, auth service, Caddy gateway, and their tests) do not depend on this CLI at all and can be implemented and tested in isolation. Tasks 9, 10, and 11 do depend on it — Task 9 explicitly checks for its presence before writing any deploy-time wiring against it, and if it is absent, stops and names this exact dependency rather than guessing at an interface that might not match what actually lands.

**This plan never adds to, reads at runtime from, or deletes the old Secret Manager bundle.** The handoff's text claims the `ai-trading-env-bundle` secret "was never created," but this session independently confirmed via GCP metadata that it **does exist** in project `tobytran-portfolio`, with one enabled version (version 1) — the handoff's own claim is stale. This plan does not correct or act on that discrepancy: it does not read `ai-trading-env-bundle` at runtime, does not write to it, and above all **never destroys or deletes it or any of its versions** — any migration of its contents or cleanup of the secret itself is a separate, explicitly operator-approved task, not something this plan performs or depends on. The handoff's own item 2 (removing `infrastructure/gcp/ai-trading/main.tf`'s `google_secret_manager_secret.env_bundle` resource and its accessor bindings, including the one on `expense-tax-env-files`) stays **out of this plan's scope** regardless of whether the secret itself turns out to be populated or empty — that removal belongs to whoever executes the full handoff, with its own explicit confirmation gate. This plan's own new Terraform (`hub-bucket.tf`, `hub-static.tf`) never references `env_bundle` in any form.

## Coordination with sibling plans

Two other fully written implementation plans share this directory and some of this plan's files:

- **[01i-mirofish-upstream-implementation.md](01i-mirofish-upstream-implementation.md)** ("Plan B") adds MiroFish as a fourth upstream app, with its **own** GCS bucket, **own** Cloudflare Worker (`ai-trading-mirofish-static`), and **own** compose sibling file. It explicitly treats this plan's files as "Plan A's" and avoids editing them except at two named coordination points. This plan mirrors that same discipline for MiroFish's files: nothing in this plan edits `packages/mirofish`, `docker-compose.mirofish.yml`, `mirofish-bucket.tf`, or `mirofish*.tf`.
- **[01j-upstream-sync-skills-implementation.md](01j-upstream-sync-skills-implementation.md)** ("Plan C") adds `.opencode/skills/sync-*` divergence-check skills. No file overlap with this plan.

**The interface 01i's Task 7 Step 5 is waiting on, updated for Caddy:** the public entry point this plan builds is named `gateway` in `ai-trading/deploy/production/docker-compose.yml` — stock `caddy:2-alpine`, listening on container port `8080`, reachable inside the Compose network as `gateway:8080` (this exact name/port is unchanged from this plan's pre-Caddy draft, so 01i's own Terraform ingress-line reference to it does not need to change). What changes for 01i is *how* it integrates: MiroFish's `/api/*` route is **not** added to any Node router — it is added as a new `handle /api/* { ... }` block in `ai-trading/deploy/production/Caddyfile`, mirroring the `/u/tradingagents*` block exactly (strip the identity header it cares about, if any; `forward_auth auth:8181` with the same `uri /__auth/check` and `copy_headers`; `reverse_proxy mirofish:5001`). Task 7's Caddyfile marks the exact insertion point with a comment, immediately before the catch-all `handle { respond 404 }`. 01i's own compose sibling file must also add the `gateway` (Caddy) container to its `mirofish` network so that hostname resolves, mirroring how `gateway` already joins `ta`/`ahf` for the existing terminals.

**Shared files, both plans touch (independently, additively):**
- `infrastructure/cloudflare/ai-trading/main.tf`'s single `cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading` resource has one ordered `ingress` list. Both plans insert their own hostname-scoped entry immediately before the trailing `{ service = "http_status:404" }` catch-all, which must stay last. Either plan may land first; the other's insertion is independent and non-conflicting.
- `infrastructure/gcp/ai-trading/`: 01i adds `mirofish-bucket.tf` as a sibling file reusing `google_project_service.apis` and `google_service_account.deploy` from `main.tf`. This plan does the same with `hub-bucket.tf`. Neither touches `main.tf` itself.
- `ai-trading/deploy/ci/smoke-test.sh` and `.github/workflows/ai-trading-ci.yml`: both plans append independent functions/jobs (`smoke_mirofish_*`/`mirofish` job vs. this plan's `smoke_gateway` function and `scripts`/`images` job additions).
- `ai-trading/plans/STATUS.md`: both plans update separate bullets (01i's MiroFish Open Question; this plan's "awaiting an end-to-end routing/auth spike" bullet, Task 10).

**Terraform Workers resource names are genuinely uncertain across both plans.** 01i's own Task 7 Step 1 flags this and tells its executor to confirm via `terraform providers schema -json` before finalizing; this plan's Task 3 does the same, independently, because the provider's exact attribute names (`cloudflare_workers_script`'s `name` vs. `script_name`; `cloudflare_workers_route`'s `script` referencing `.id` vs. `.script_name`) are not fully settled between the two plans' authors and must be confirmed empirically against the pinned `>= 5.8.2, < 6.0.0` provider at execution time, not assumed from either plan's prose.

## Global Constraints

- `next.config.ts`: `output: "export"`. No middleware, server-side Clerk helpers, runtime `cookies()`/`headers()`, API routes, rewrites, redirects, Server Actions, or ISR anywhere in `ai-trading/frontend`.
- The Clerk publishable key may be embedded in the static bundle. The Clerk secret key, any Clerk JWT/session-signing material, and every other provider key (`OPENAI_API_KEY`, `ZEP_API_KEY`, etc.) must never appear in `ai-trading/frontend/out/` or any file committed to the repository.
- Single production Clerk instance, zone `tobytran.dev`, Frontend API `clerk.tobytran.dev`, no satellite-domain configuration (`isSatellite` is never set) — `trading.tobytran.dev` and `trading-static.tobytran.dev` are plain subdomains of the same zone the Clerk instance already serves for `expense.tobytran.dev`, so the default client SDK session-sharing behavior applies without extra configuration. Reuse the existing Google OAuth provider already configured on that instance; do not add a new one.
- The gateway session cookie is `Secure; HttpOnly; SameSite=Lax; Domain=tobytran.dev`, named `__ai_trading_session`, capped at 3600 seconds and re-issued by the client periodically (Task 7). Because the Worker makes the split-origin backend invisible to the browser (the page's own `fetch`/WebSocket calls always target `trading*.tobytran.dev`, never `trading-origin.tobytran.dev` directly), every request to `/__auth/*` and `/u/*` is same-origin from the browser's perspective — no CORS headers are needed anywhere in `auth` or the Caddyfile.
- **No hand-written HTTP reverse-proxy or WebSocket-proxy code anywhere in this plan.** `gateway` (Caddy) owns all reverse-proxying and WebSocket upgrades declaratively, via its Caddyfile's `forward_auth`/`reverse_proxy` directives. `auth` (Node) owns only the two `/__auth/*` routes and never imports `node:net` or proxies a request anywhere.
- Every new secret/config value this plan introduces lives in Firestore `family-config` (project `tobytran-portfolio`), read only through `common/config/family_config.py` — never a new Secret Manager bundle, never a `.env`/key file committed inside `ai-trading/`. New Firestore profile: `ai-trading/gateway` (values `CLERK_SECRET_KEY`, `SESSION_SIGNING_KEY`, `ALLOWED_EMAILS`, `ALLOWED_ORIGINS`) — the profile ID stays `gateway` for Firestore/interface continuity, but the rendered file is renamed to `auth.env` and consumed by the `auth` compose service, since `gateway` itself (Caddy) needs no secrets at all, only its Caddyfile. New profile `ai-trading/clerk` (value `PUBLISHABLE_KEY`, not secret but still centrally managed). See "Dependency: Firestore `family-config`" above.
- Cloudflare: reuse the single shared `CLOUDFLARE_AGENT_API_TOKEN`; never create a new or narrower token.
- Terraform: this plan's own tasks run `fmt -check` and `validate` only. `terraform apply`/`plan` against production Cloudflare resources runs through the existing `ai-trading-infra.yml` automation (`workflow_dispatch` with `apply: true`) exactly as today; the GCP bucket root (`infrastructure/gcp/ai-trading/`) remains operator-applied per its existing header comment — this plan does not change that.
- Upstream packages (`packages/trading-agents`, `packages/ai-hedge-fund`, `packages/vibe-trading`) are never edited. The ttyd auth-header contract (`TTYD_AUTH_HEADER=Cf-Access-Authenticated-User-Email`, already baked into `deploy/upstream/trading-agents/Dockerfile` and `deploy/upstream/ai-hedge-fund/Dockerfile`) is reused unchanged — Caddy's `copy_headers` produces the same header name, just from a different, newer source of trust.
- `family-app` is a public repository: no secrets, email addresses, account numbers, or VPS addresses in any committed file, including Terraform defaults, test fixtures, and comments.
- Local development (`ai-trading/deploy/local/`) is unchanged by this plan: its own Caddy instance keeps injecting a fixed `Cf-Access-Authenticated-User-Email` header straight to `ta-terminal`/`ahf-terminal`, mirroring what a verified session (or a separately enabled Cloudflare Access policy) would set, without exercising either the production Caddyfile or `auth`. The production gateway stack is exercised by its own tests (Tasks 4-7), not by the local dev harness.
- No GCP application compute, no Cloud Functions, no Cloud Run, no paid GCS load balancer.

## Review Focus

1. **A client forges the `Cf-Access-Authenticated-User-Email` header directly against `trading-origin.tobytran.dev`** to impersonate a ttyd user, since that hostname never carries any Cloudflare Access policy (unrouted tunnel-origin hostnames are not Access destinations in this plan's Terraform, regardless of whether Access is separately enabled elsewhere). Task 7's real-Caddy integration test proves the Caddyfile's `request_header -Cf-Access-Authenticated-User-Email` strip plus `copy_headers` always replaces an inbound forged value with the verified one, by asserting what a real upstream actually received.
2. **A POST to `/__auth/session` from a non-allowed `Origin`** (CSRF against `auth`, since the endpoint is unauthenticated by definition at the moment it runs). Task 6's unit test asserts a cross-origin POST is rejected with 403 before the body is even parsed; Task 7's integration test re-proves it through the real Caddyfile.
3. **An expired or revoked session still proxies a long-lived WebSocket**, because Caddy's `forward_auth` on the WS-upgrade request is the *only* check for that connection (once the tunnel is established, Caddy does not re-check mid-stream — an inherent limit of any reverse-proxy session model, not unique to this design). Task 6's unit test proves `/__auth/check` itself rejects an expired cookie; Task 7's integration test proves the same cookie is rejected on the actual `/u/tradingagents*` path through Caddy, before any bytes reach ttyd.
4. **The Worker silently serves `index.html` (200) for a deleted or renamed app route** instead of `404.html` with a 404 status, which would make a removed app look "live" with stale content. Task 3's unit test asserts the 404 fallback for both a never-existed path and (implicitly, via the resolver's pure logic) any path without a matching object.
5. **Safari's Intelligent Tracking Prevention silently breaks the Clerk sign-in flow** across `clerk.tobytran.dev` and `trading-static.tobytran.dev`/`trading.tobytran.dev`, with no error surfaced to the user beyond "sign-in doesn't work on my iPad." Task 10 is a dedicated, gated spike for exactly this, run before `trading.tobytran.dev` is ever exposed publicly.

---

## File Structure

| File | Responsibility |
|---|---|
| `ai-trading/frontend/next.config.ts` | Static export config (Task 1) |
| `ai-trading/frontend/static-server.mjs` | Tiny Node static file server for the `web` image, same route-resolution rules as the Worker (Task 1) |
| `ai-trading/frontend/Dockerfile` | Rewritten to build `out/` and run `static-server.mjs` (Task 1) |
| `ai-trading/deploy/ci/check-static-export.sh` | CI gate: required files present, no secret-shaped strings anywhere in `out/` (Task 1) |
| `infrastructure/gcp/ai-trading/hub-bucket.tf` | Public-read GCS bucket + upload IAM for the hub's static build (Task 2) |
| `infrastructure/cloudflare/ai-trading/hub-static-variables.tf`, `hub-static.tf` | Worker script, Worker route, staging/origin DNS records (Task 3) |
| `infrastructure/cloudflare/ai-trading/worker/hub-router.js`, `hub-router.test.js`, `package.json` | The Worker itself: pure routing-decision functions (tested) plus the `fetch` handler (Task 3) |
| `ai-trading/auth/package.json`, `src/session.js`, `session.test.js` | Signed-cookie issue/verify (Task 4) |
| `ai-trading/auth/src/allowlist.js`, `origin.js`, `*.test.js` | Family-email and Origin allowlist checks (Task 4) |
| `ai-trading/auth/src/clerk.js`, `clerk.test.js` | Clerk token verification wrapper, dependency-injected for tests (Task 5) |
| `ai-trading/auth/src/server.js`, `server.test.js`, `Dockerfile` | The entire `auth` service: two routes, no proxy code (Task 6) |
| `ai-trading/deploy/production/Caddyfile` | The entire `gateway` service's config: header strip, `forward_auth`, `reverse_proxy` (Task 7) |
| `ai-trading/deploy/production/docker-compose.yml` | New `gateway` (Caddy) + `auth` (Node) services and networks (Task 7, additive) |
| `ai-trading/deploy/docker-bake.hcl`, `docker-bake.ci.hcl` | New `auth` build target (Task 7; `gateway` needs no build, stock image) |
| `ai-trading/deploy/ci/smoke-test.sh`, `ai-trading/deploy/production/health-check.sh` | Real-Caddy integration test; `gateway`/`auth` added to the health-checked service list (Task 7) |
| `.github/workflows/ai-trading-ci.yml` | `auth` added to the existing scaffold loop; no new job needed (Task 7) |
| `ai-trading/frontend/components/auth-provider.tsx`, `auth-gate.tsx` | Clerk provider + sign-in gate (Task 8) |
| `ai-trading/frontend/lib/auth.ts`, `auth.test.ts` | Pure gate-state and cookie-refresh-interval helpers (Task 8) |
| `ai-trading/frontend/app/layout.tsx` | Wires the provider/gate around `{children}` (Task 8) |
| `ai-trading/deploy/production/deploy.sh`, `.github/workflows/ai-trading-deploy.yml`, `ai-trading/deploy/docker-bake.hcl` | `ai-trading/gateway`/`ai-trading/clerk` Firestore profiles wired into VPS-side render (writing `auth.env`) and the build (Task 9) |
| `ai-trading/deploy/ci/upload-hub-static.sh` | GCS upload with per-path Cache-Control (Task 9) |
| `ai-trading/plans/STATUS.md` | Spike result recorded (Task 10) |
| `infrastructure/cloudflare/ai-trading/main.tf` | First public exposure: `hub_hostname` Worker route; `hub_hostname` stops being named as an Access destination (Task 11, operator-gated) |

---

### Task 1: Static export + VPS static-serving image (the hub's simplest, first serving path)

**Files:**
- Modify: `ai-trading/frontend/next.config.ts`
- Create: `ai-trading/frontend/static-server.mjs`
- Modify: `ai-trading/frontend/Dockerfile`
- Create: `ai-trading/deploy/ci/check-static-export.sh`
- Modify: `ai-trading/deploy/ci/smoke-test.sh` (`smoke_web`, additive assertions only)

**Interfaces:**
- Consumes: `hubApps`/`findApp` from `ai-trading/frontend/lib/apps.ts` (unchanged).
- Produces: `ai-trading/frontend/out/` build artifact with this exact shape (verified by `check-static-export.sh`, consumed by Task 2's upload and Task 3's Worker): `index.html`, `apps/tradingagents.html`, `apps/ai-hedge-fund.html`, `apps/vibe-trading.html`, `404.html`, `_next/static/**`. The route-resolution rule (`"/"` → `index.html`; a path with a file extension → served as-is; anything else → `<path>.html`, falling back to `404.html` on a miss) is the exact rule Task 3's Worker also implements — written once here as the authoritative statement, reused in prose (not in code — different runtimes) by Task 3.

- [ ] **Step 1: Flip the Next config to a static export**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  poweredByHeader: false,
};

export default nextConfig;
```

- [ ] **Step 2: Write the static file server used by the `web` image**

```js
// ai-trading/frontend/static-server.mjs
// Serves the pre-built `out/` directory with the same route-resolution rule
// the Cloudflare Worker (infrastructure/cloudflare/ai-trading/worker/hub-router.js)
// implements for the GCS-backed path: this is the hub's first production
// serving path (no deployment of any kind exists yet) and 01e's documented
// fallback if the Worker/GCS path does not pass Task 9's spike. Task 10
// repoints trading.tobytran.dev's tunnel ingress from this container to the
// Worker once that spike passes. No framework, stdlib only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const ROOT = new URL("./out/", import.meta.url).pathname;
const PORT = Number(process.env.PORT || 3000);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function resolveObjectPath(pathname) {
  if (pathname === "/") return "index.html";
  const clean = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (/\.[A-Za-z0-9]+$/.test(clean)) return clean;
  return `${clean}.html`;
}

function cacheControlFor(objectPath) {
  if (objectPath.startsWith("_next/static/")) return "public, max-age=31536000, immutable";
  return "no-store";
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

async function readUnderRoot(objectPath) {
  const full = normalize(join(ROOT, objectPath));
  if (!full.startsWith(normalize(ROOT))) throw new Error("path escapes root");
  return readFile(full);
}

export function createStaticServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://static-server");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const objectPath = resolveObjectPath(url.pathname);
    let body;
    let status = 200;
    try {
      body = await readUnderRoot(objectPath);
    } catch {
      try {
        body = await readUnderRoot("404.html");
        status = 404;
      } catch {
        res.writeHead(404).end();
        return;
      }
    }
    const headers = {
      ...SECURITY_HEADERS,
      "content-type": CONTENT_TYPES[extname(objectPath)] || "application/octet-stream",
      "cache-control": cacheControlFor(objectPath),
    };
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createStaticServer().listen(PORT, () => {
    console.log(`static-server listening on ${PORT}`);
  });
}
```

- [ ] **Step 3: Write the test for the resolver**

```js
// ai-trading/frontend/static-server.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveObjectPath } from "./static-server.mjs";

test("root maps to index.html", () => {
  assert.equal(resolveObjectPath("/"), "index.html");
});
test("an app route maps to <slug>.html", () => {
  assert.equal(resolveObjectPath("/apps/tradingagents"), "apps/tradingagents.html");
});
test("a trailing slash is stripped before adding .html", () => {
  assert.equal(resolveObjectPath("/apps/tradingagents/"), "apps/tradingagents.html");
});
test("a path with a file extension is served as-is", () => {
  assert.equal(resolveObjectPath("/favicon.ico"), "favicon.ico");
  assert.equal(resolveObjectPath("/_next/static/chunks/app.abc123.js"), "_next/static/chunks/app.abc123.js");
});
```

Run: `node --experimental-strip-types --test ai-trading/frontend/static-server.test.mjs` (the file is plain `.mjs`, so the flag is a no-op safety net; included for consistency with Task 8's `.ts` test command).
Expected: 4 passing tests.

- [ ] **Step 4: Rewrite the Dockerfile**

```dockerfile
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG NEXT_PUBLIC_VIBE_TRADING_URL=https://vibe-trading.tobytran.dev
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_VIBE_TRADING_URL=$NEXT_PUBLIC_VIBE_TRADING_URL \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/out ./out
COPY --from=build --chown=app:app /app/static-server.mjs ./static-server.mjs
USER app
EXPOSE 3000
CMD ["node", "static-server.mjs"]
```

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is unset in Task 1 (Clerk doesn't exist yet in the hub until Task 8) — the build must still succeed with it empty, since `next build` with `output: "export"` does not fail on an unset `NEXT_PUBLIC_*` value, it only ships `undefined` into the client bundle, which Task 8's code handles explicitly.

- [ ] **Step 5: Build locally and verify the artifact shape**

Run (from `ai-trading/frontend`): `pnpm install --frozen-lockfile && pnpm build`
Expected: `out/index.html`, `out/apps/tradingagents.html`, `out/apps/ai-hedge-fund.html`, `out/apps/vibe-trading.html`, `out/404.html`, `out/_next/static/` all exist; `out/apps/desk.html` does **not** exist (the planned app has no static page — `dynamicParams = false` in `app/apps/[slug]/page.tsx` already enforces this, unchanged).

- [ ] **Step 6: Write the CI export-contents and non-exposure check**

```bash
#!/usr/bin/env bash
# Verifies a freshly built ai-trading/frontend/out/ directory: the required
# routes exist, and no secret-shaped string made it into the static bundle.
# Usage: ai-trading/deploy/ci/check-static-export.sh OUT_DIR
set -Eeuo pipefail

OUT_DIR="${1:?usage: check-static-export.sh OUT_DIR}"

fail() {
  echo "check-static-export: $*" >&2
  exit 1
}

for required in index.html apps/tradingagents.html apps/ai-hedge-fund.html apps/vibe-trading.html 404.html; do
  [[ -f "$OUT_DIR/$required" ]] || fail "missing $required"
done
[[ -d "$OUT_DIR/_next/static" ]] || fail "missing _next/static"
[[ -f "$OUT_DIR/apps/desk.html" ]] && fail "apps/desk.html exists but Family Desk is not live yet"

# Forbidden patterns: Clerk/OpenAI/Zep secret key prefixes and literal
# secret-section key names. Clerk PUBLISHABLE keys (pk_live_/pk_test_) are
# expected and excluded.
if grep -RIlE 'sk_(live|test)_|sk-[A-Za-z0-9]{20,}|CLERK_SECRET_KEY=|ZEP_API_KEY=|SESSION_SIGNING_KEY=' "$OUT_DIR"; then
  fail "a secret-shaped string was found in the static export"
fi

echo "check-static-export: ok ($OUT_DIR)"
```

- [ ] **Step 7: Run it against the real build**

Run: `ai-trading/deploy/ci/check-static-export.sh ai-trading/frontend/out`
Expected: `check-static-export: ok (...)`.

- [ ] **Step 8: Run it against a complete, otherwise-valid build with one secret sentinel injected**

This fixture must be a byte-for-byte copy of the real, already-passing `out/` directory — not a minimal hand-built reconstruction — so the only thing that can make `check-static-export.sh` fail is the secret-scan itself, never a missing-file check firing first for the wrong reason:

```bash
rm -rf /tmp/tainted-out
cp -r ai-trading/frontend/out /tmp/tainted-out
echo 'CLERK_SECRET_KEY=sk_live_fake' >> /tmp/tainted-out/index.html
output="$(ai-trading/deploy/ci/check-static-export.sh /tmp/tainted-out 2>&1)"; status=$?
rm -rf /tmp/tainted-out
echo "$output"
echo "exit=$status"
```

Expected: `exit=1`, and `$output` contains the literal line `check-static-export: a secret-shaped string was found in the static export` — specifically that message, not a `missing ...` message, which would mean the fixture was incomplete and the test never actually exercised the secret-scan logic.

- [ ] **Step 9: Add the matching `smoke_web` assertions**

In `ai-trading/deploy/ci/smoke-test.sh`'s `smoke_web()`, after the existing `expect_body` lines, append:

```bash
  local headers
  headers="$(curl -fsSI http://127.0.0.1:13000/)"
  grep -qi '^cache-control: no-store' <<<"$headers" || fail "expected no-store Cache-Control on /"
  grep -qi '^x-frame-options: DENY' <<<"$headers" || fail "expected X-Frame-Options on /"
```

- [ ] **Step 10: Shellcheck**

Run: `shellcheck ai-trading/deploy/ci/check-static-export.sh ai-trading/deploy/ci/smoke-test.sh`
Expected: clean.

- [ ] **Step 11: Report completion (no git operations)**

This task is done once every "Expected" check above has passed. Do not run `git add`, `git commit`, or `git push` here — a parallel subagent working on a different task may be touching the index at the same time, and staging is the controlling session's call, done only if it explicitly asks. Report which files this task created or modified, and that its tests pass:
  - `ai-trading/frontend/next.config.ts`
  - `ai-trading/frontend/static-server.mjs`
  - `ai-trading/frontend/static-server.test.mjs`
  - `ai-trading/frontend/Dockerfile`
  - `ai-trading/deploy/ci/check-static-export.sh`
  - `ai-trading/deploy/ci/smoke-test.sh`

---

### Task 2: Dedicated GCS static bucket for the hub (sibling file, operator-applied)

**Files:**
- Create: `infrastructure/gcp/ai-trading/hub-bucket.tf`

**Interfaces:**
- Consumes: `google_project_service.apis`, `google_service_account.deploy` (both already defined in `infrastructure/gcp/ai-trading/main.tf`; this file only reads them).
- Produces: output `hub_bucket_name`, consumed by Task 3's Worker binding and Task 9's upload script.

- [ ] **Step 1: Write the bucket and reuse the existing deploy service account**

```hcl
# Dedicated static bucket for the Trading Hub's static export (Task 1's
# `out/` directory). Public-read-only by design (01e): it holds only built
# HTML/CSS/JS, never secrets, accounts, uploads, or portfolio data. Separate
# from MiroFish's own bucket (infrastructure/gcp/ai-trading/mirofish-bucket.tf,
# owned by the sibling 01i plan) so a mistake in one upload pipeline cannot
# touch the other bucket's objects.

resource "google_storage_bucket" "hub_static" {
  project                     = var.project_id
  name                        = "tobytran-ai-trading-hub"
  location                    = "US"
  uniform_bucket_level_access = true
  force_destroy               = true # rebuilt on every deploy; no data worth retaining

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "hub_static_public_read" {
  bucket = google_storage_bucket.hub_static.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# Reuses the existing deploy service account (main.tf) rather than minting a
# new identity: this plan's upload step runs from the same GitHub Actions
# deploy job that already authenticates as this service account.
resource "google_storage_bucket_iam_member" "hub_static_deploy_writer" {
  bucket = google_storage_bucket.hub_static.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.deploy.email}"
}

output "hub_bucket_name" {
  value       = google_storage_bucket.hub_static.name
  description = "Hub static bucket name. The Cloudflare Worker (infrastructure/cloudflare/ai-trading/hub-static.tf) binds its GCS backend to this value."
}
```

`tobytran-ai-trading-hub` must be globally unique across all of GCS. If `terraform apply` reports it is taken, pick a different concrete name (e.g. append a short random suffix) and update Task 3's `hub_static_bucket_name` default to match — do not leave the bucket name as a variable with no default, since Task 9's upload script needs one concrete value to target.

- [ ] **Step 2: `fmt` and `validate` only (no apply — operator-applied per `AGENTS.md`)**

Run: `docker run --rm -v "$PWD":/w -w /w/infrastructure/gcp/ai-trading hashicorp/terraform:latest fmt -check hub-bucket.tf`
Expected: no diff printed.

Run:
```bash
docker run --rm -v "$PWD":/w -w /w/infrastructure/gcp/ai-trading hashicorp/terraform:latest init -backend=false
docker run --rm -v "$PWD":/w -w /w/infrastructure/gcp/ai-trading hashicorp/terraform:latest validate
```
Expected: `Success! The configuration is valid.` — this proves the cross-file reference to `main.tf`'s existing `google_service_account.deploy` and `google_project_service.apis` resolves without editing `main.tf`.

- [ ] **Step 3: Report completion (no git operations)**

This task is done once every "Expected" check above has passed. Do not run `git add`, `git commit`, or `git push` here — a parallel subagent working on a different task may be touching the index at the same time, and staging is the controlling session's call, done only if it explicitly asks. Report which files this task created or modified, and that its tests pass:
  - `infrastructure/gcp/ai-trading/hub-bucket.tf`

---

### Task 3: Cloudflare Worker, staging route, and unrouted gateway-origin hostname

**Files:**
- Create: `infrastructure/cloudflare/ai-trading/worker/package.json`
- Create: `infrastructure/cloudflare/ai-trading/worker/hub-router.js`
- Create: `infrastructure/cloudflare/ai-trading/worker/hub-router.test.js`
- Create: `infrastructure/cloudflare/ai-trading/hub-static-variables.tf`
- Create: `infrastructure/cloudflare/ai-trading/hub-static.tf`
- Modify (coordination point, Step 6 only): `infrastructure/cloudflare/ai-trading/main.tf`

**Interfaces:**
- Consumes: `data.cloudflare_zone.main`, `var.cloudflare_account_id`, `cloudflare_zero_trust_tunnel_cloudflared.ai_trading` (all already defined in `main.tf`; this file only reads them). Task 2's `hub_bucket_name` output, passed explicitly as a variable default rather than read via `terraform_remote_state`, to keep this file's blast radius independent of the GCP state's shape (same reasoning 01i's Task 7 uses for its own bucket-name variable).
- Produces: `trading-static.tobytran.dev` (staging, Worker-routed) and `trading-origin.tobytran.dev` (unrouted tunnel-origin hostname, pointed at `gateway:8080` — Task 7's Caddy service) — the two hostnames Task 9's spike exercises. `isDynamicPath`/`resolveStaticObjectKey`, exported from `hub-router.js`, are the pure functions Task 9's spike also exercises manually against a deployed Worker.

- [ ] **Step 1: Confirm the exact Workers resource names for the pinned provider**

Run (after `terraform -chdir=infrastructure/cloudflare/ai-trading init -backend=false`):
```bash
terraform -chdir=infrastructure/cloudflare/ai-trading providers schema -json \
  | jq '.provider_schemas."registry.terraform.io/cloudflare/cloudflare".resource_schemas | keys[] | select(test("workers"))'
```
Expected: `cloudflare_workers_script` and `cloudflare_workers_route` both exist. If this run's pinned provider version differs from what Step 3 below assumes (resource attribute `name` on the script, `script` referencing `.id` on the route — per the official provider docs' v5 migration guide), adjust Step 3's HCL to match this command's actual output before proceeding; do not guess.

- [ ] **Step 2: Write the pure routing-decision module and its test**

```js
// infrastructure/cloudflare/ai-trading/worker/hub-router.js
// Route-resolution rule matches ai-trading/frontend/static-server.mjs's
// resolveObjectPath exactly (same build output, two different runtimes —
// kept as two files on purpose, see Task 1's Interfaces note).

export function resolveStaticObjectKey(pathname) {
  if (pathname === "/") return "index.html";
  const clean = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (/\.[A-Za-z0-9]+$/.test(clean)) return clean;
  return `${clean}.html`;
}

export function isDynamicPath(pathname) {
  return (
    pathname === "/u" || pathname.startsWith("/u/") ||
    pathname === "/__auth" || pathname.startsWith("/__auth/") ||
    pathname === "/__control" || pathname.startsWith("/__control/")
  );
}

const STATIC_HOST = "storage.googleapis.com";
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};
const STRIPPED_RESPONSE_HEADERS = [
  "x-goog-hash",
  "x-goog-stored-content-length",
  "x-goog-storage-class",
  "x-guploader-uploadid",
];

function withHeaders(response, status) {
  const headers = new Headers(response.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: status ?? response.status, headers });
}

async function fetchStatic(bucket, pathname) {
  const key = resolveStaticObjectKey(pathname);
  const res = await fetch(`https://${STATIC_HOST}/${bucket}/${key}`);
  if (res.status === 404 && key !== "404.html") {
    const notFound = await fetch(`https://${STATIC_HOST}/${bucket}/404.html`);
    return withHeaders(notFound, 404);
  }
  return withHeaders(res);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isDynamicPath(url.pathname)) {
      const originUrl = `https://${env.ORIGIN_HOSTNAME}${url.pathname}${url.search}`;
      return fetch(originUrl, request);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    return fetchStatic(env.STATIC_BUCKET, url.pathname);
  },
};
```

```json
{
  "private": true,
  "type": "module"
}
```

```js
// infrastructure/cloudflare/ai-trading/worker/hub-router.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStaticObjectKey, isDynamicPath } from "./hub-router.js";

test("root maps to index.html", () => {
  assert.equal(resolveStaticObjectKey("/"), "index.html");
});
test("an app route maps to <slug>.html", () => {
  assert.equal(resolveStaticObjectKey("/apps/tradingagents"), "apps/tradingagents.html");
});
test("trailing slash is stripped before adding .html", () => {
  assert.equal(resolveStaticObjectKey("/apps/tradingagents/"), "apps/tradingagents.html");
});
test("a path with a file extension is served as-is", () => {
  assert.equal(resolveStaticObjectKey("/_next/static/chunks/app.a1b2c3.js"), "_next/static/chunks/app.a1b2c3.js");
  assert.equal(resolveStaticObjectKey("/favicon.ico"), "favicon.ico");
});
test("dynamic prefixes are recognized and everything else is not", () => {
  assert.equal(isDynamicPath("/u/tradingagents/"), true);
  assert.equal(isDynamicPath("/__auth/session"), true);
  assert.equal(isDynamicPath("/__control/apps"), true);
  assert.equal(isDynamicPath("/apps/tradingagents"), false);
  assert.equal(isDynamicPath("/"), false);
});
```

Run: `node --test infrastructure/cloudflare/ai-trading/worker/hub-router.test.js`
Expected: 5 passing tests.

- [ ] **Step 3: Write the Terraform variables and resources**

```hcl
# infrastructure/cloudflare/ai-trading/hub-static-variables.tf
# Variables used only by hub-static.tf, kept out of the shared variables.tf
# so both files can grow independently of each other and of the sibling
# mirofish-variables.tf (01i).

variable "hub_static_hostname" {
  type        = string
  description = "Staging hostname for the Worker-served static hub, proven before trading.tobytran.dev is cut over (Task 10)."
  default     = "trading-static.tobytran.dev"
}

variable "hub_origin_hostname" {
  type        = string
  description = "Unrouted tunnel-origin hostname for the hub's dynamic paths (/u/*, /__auth/*, /__control/*). No Worker route; reached only via the tunnel, by the Caddy gateway."
  default     = "trading-origin.tobytran.dev"
}

variable "hub_static_bucket_name" {
  type        = string
  description = "GCS bucket name from infrastructure/gcp/ai-trading's hub_bucket_name output."
  default     = "tobytran-ai-trading-hub"
}
```

```hcl
# infrastructure/cloudflare/ai-trading/hub-static.tf
# Worker + DNS for the hub's static export, independent of MiroFish's own
# Worker (01i's mirofish.tf). No business logic, LLM calls, or persistent
# state here — see Review Focus #4 and the Worker's own unit tests.

resource "cloudflare_dns_record" "hub_static_staging" {
  zone_id = data.cloudflare_zone.main.id
  name    = var.hub_static_hostname
  type    = "A"
  content = "192.0.2.1" # TEST-NET-1 (RFC 5737): never dialed, the Worker route below intercepts every request first
  ttl     = 1
  proxied = true
  comment = "ai-trading hub static staging (Worker-routed)"
}

resource "cloudflare_dns_record" "hub_origin" {
  zone_id = data.cloudflare_zone.main.id
  name    = var.hub_origin_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.ai_trading.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true
  comment = "ai-trading hub (unrouted tunnel origin; no Worker route; reached only by the Caddy gateway)"
}

resource "cloudflare_workers_script" "hub_router" {
  account_id = var.cloudflare_account_id
  name       = "ai-trading-hub-router"
  content    = file("${path.module}/worker/hub-router.js")

  bindings = [
    { type = "plain_text", name = "STATIC_BUCKET", text = var.hub_static_bucket_name },
    { type = "plain_text", name = "ORIGIN_HOSTNAME", text = var.hub_origin_hostname },
  ]
}

resource "cloudflare_workers_route" "hub_static" {
  zone_id = data.cloudflare_zone.main.id
  pattern = "${var.hub_static_hostname}/*"
  script  = cloudflare_workers_script.hub_router.id
}
```

If Step 1's schema check showed different attribute names than used above (`name`/`.id`), adjust both resources to match before Step 4.

- [ ] **Step 4: `fmt` and `validate`**

Run: `docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest fmt -check hub-static-variables.tf hub-static.tf`
Expected: no diff.

Run:
```bash
docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest init -backend=false
docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest validate
```
Expected: `Success! The configuration is valid.`

- [ ] **Step 5: `fmt` the worker directory (JS, not Terraform) and re-run its test**

Run: `node --test infrastructure/cloudflare/ai-trading/worker/hub-router.test.js`
Expected: still 5 passing tests (Step 4 only touched `.tf` files).

- [ ] **Step 6: Coordination point — append the one shared ingress line**

Before this step, confirm `infrastructure/cloudflare/ai-trading/main.tf`'s `cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading` resource's current `ingress` list shape (it may already carry 01i's own `mirofish_origin_hostname` entry — either order is fine). Append one entry immediately before the existing `{ service = "http_status:404" }` catch-all, which must stay last:

```hcl
      {
        hostname = var.hub_origin_hostname
        service  = "http://gateway:8080"
      },
```

`gateway:8080` is the Caddy service Task 7 builds — the Compose service name and port are unchanged by the move from a custom Node gateway to Caddy, so this exact line does not change if this plan's earlier, non-Caddy draft has already been read by another agent.

- [ ] **Step 7: Re-validate after the shared-file edit**

Run: `docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest validate`
Expected: `Success! The configuration is valid.` — `gateway:8080` does not need to exist yet for `validate` to pass (it is just a string in the ingress JSON); Task 9's spike is where this is actually exercised end-to-end.

- [ ] **Step 8: Report completion (no git operations)**

This task is done once every "Expected" check above has passed. Do not run `git add`, `git commit`, or `git push` here — a parallel subagent working on a different task may be touching the index at the same time, and staging is the controlling session's call, done only if it explicitly asks. Report which files this task created or modified, and that its tests pass:
  - `infrastructure/cloudflare/ai-trading/worker/package.json`
  - `infrastructure/cloudflare/ai-trading/worker/hub-router.js`
  - `infrastructure/cloudflare/ai-trading/worker/hub-router.test.js`
  - `infrastructure/cloudflare/ai-trading/hub-static-variables.tf`
  - `infrastructure/cloudflare/ai-trading/hub-static.tf`
  - `infrastructure/cloudflare/ai-trading/main.tf`

---

### Task 4: Auth service — signed session cookie, email allowlist, Origin allowlist

**Files:**
- Create: `ai-trading/auth/package.json`
- Create: `ai-trading/auth/src/session.js`
- Create: `ai-trading/auth/src/session.test.js`
- Create: `ai-trading/auth/src/allowlist.js`
- Create: `ai-trading/auth/src/allowlist.test.js`
- Create: `ai-trading/auth/src/origin.js`
- Create: `ai-trading/auth/src/origin.test.js`

**Interfaces:**
- Produces: `sign(payload, secretHex)` / `verify(token, secretHex)` (HMAC-SHA256, base64url, fail-closed on tamper or expiry) — consumed by Task 6's `server.js`. `isAllowedEmail(email, csv)` / `isAllowedOrigin(originHeader, csv)` — consumed by Task 5 and Task 6.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "@ai-trading/auth",
  "private": true,
  "version": "0.1.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "node --test src/**/*.test.js"
  },
  "dependencies": {
    "@clerk/backend": "^1.21.0"
  }
}
```

- [ ] **Step 2: Write the failing tests for `session.js`**

```js
// ai-trading/auth/src/session.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, verify } from "./session.js";

const KEY = "a".repeat(64); // 32 bytes hex, same shape as a real SESSION_SIGNING_KEY

test("a freshly signed token verifies and returns its payload", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = sign({ email: "family@tobytran.dev", exp }, KEY);
  const payload = verify(token, KEY);
  assert.equal(payload.email, "family@tobytran.dev");
  assert.equal(payload.exp, exp);
});

test("a tampered payload fails verification", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = sign({ email: "family@tobytran.dev", exp }, KEY);
  const [body, mac] = token.split(".");
  const tampered = `${Buffer.from('{"email":"attacker@evil.com","exp":9999999999}').toString("base64url")}.${mac}`;
  assert.equal(verify(tampered, KEY), null);
  assert.equal(verify(`${body}.wrongmac`, KEY), null);
});

test("an expired token fails verification even with a correct signature", () => {
  const exp = Math.floor(Date.now() / 1000) - 10;
  const token = sign({ email: "family@tobytran.dev", exp }, KEY);
  assert.equal(verify(token, KEY), null);
});

test("a token signed with a different key fails verification", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = sign({ email: "family@tobytran.dev", exp }, KEY);
  assert.equal(verify(token, "b".repeat(64)), null);
});

test("malformed tokens fail closed, not throw", () => {
  assert.equal(verify("", KEY), null);
  assert.equal(verify("not-a-token", KEY), null);
  assert.equal(verify(null, KEY), null);
});
```

Run: `node --test ai-trading/auth/src/session.test.js`
Expected: FAIL — `session.js` does not exist yet.

- [ ] **Step 3: Implement `session.js`**

```js
// ai-trading/auth/src/session.js
import { createHmac, timingSafeEqual } from "node:crypto";

export function sign(payload, secretHex) {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", Buffer.from(secretHex, "hex")).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify(token, secretHex) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expectedMac = createHmac("sha256", Buffer.from(secretHex, "hex")).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (typeof payload.email !== "string" || !payload.email) return null;
  return payload;
}
```

- [ ] **Step 4: Run the session tests**

Run: `node --test ai-trading/auth/src/session.test.js`
Expected: 5 passing tests.

- [ ] **Step 5: Allowlist and Origin checks, test-first**

```js
// ai-trading/auth/src/allowlist.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedEmail } from "./allowlist.js";

test("an exact, case-insensitive match is allowed", () => {
  assert.equal(isAllowedEmail("Family@Tobytran.dev", "family@tobytran.dev,spouse@tobytran.dev"), true);
});
test("an email not on the list is rejected", () => {
  assert.equal(isAllowedEmail("stranger@example.com", "family@tobytran.dev,spouse@tobytran.dev"), false);
});
test("an empty or missing list rejects everything", () => {
  assert.equal(isAllowedEmail("family@tobytran.dev", ""), false);
  assert.equal(isAllowedEmail("family@tobytran.dev", undefined), false);
});
```

```js
// ai-trading/auth/src/allowlist.js
export function isAllowedEmail(email, allowedEmailsCsv) {
  const allowed = new Set(
    (allowedEmailsCsv || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
  return allowed.has((email || "").toLowerCase());
}
```

```js
// ai-trading/auth/src/origin.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin } from "./origin.js";

const ALLOWED = "https://trading.tobytran.dev,https://trading-static.tobytran.dev";

test("an exact allowed Origin passes", () => {
  assert.equal(isAllowedOrigin("https://trading.tobytran.dev", ALLOWED), true);
});
test("a missing Origin header is rejected", () => {
  assert.equal(isAllowedOrigin(undefined, ALLOWED), false);
  assert.equal(isAllowedOrigin(null, ALLOWED), false);
});
test("a cross-site Origin is rejected even when it looks similar", () => {
  assert.equal(isAllowedOrigin("https://trading.tobytran.dev.evil.com", ALLOWED), false);
  assert.equal(isAllowedOrigin("http://trading.tobytran.dev", ALLOWED), false); // scheme must match too
});
```

```js
// ai-trading/auth/src/origin.js
export function isAllowedOrigin(originHeader, allowedOriginsCsv) {
  if (!originHeader) return false;
  const allowed = new Set((allowedOriginsCsv || "").split(",").map((o) => o.trim()).filter(Boolean));
  return allowed.has(originHeader);
}
```

- [ ] **Step 6: Run all four test files**

Run: `node --test ai-trading/auth/src/session.test.js ai-trading/auth/src/allowlist.test.js ai-trading/auth/src/origin.test.js`
Expected: 11 passing tests total.

- [ ] **Step 7: Report completion (no git operations)**

This task is done once every "Expected" check above has passed. Do not run `git add`, `git commit`, or `git push` here — a parallel subagent working on a different task may be touching the index at the same time, and staging is the controlling session's call, done only if it explicitly asks. Report which files this task created or modified, and that its tests pass:
  - `ai-trading/auth/package.json`
  - `ai-trading/auth/src/session.js`
  - `ai-trading/auth/src/session.test.js`
  - `ai-trading/auth/src/allowlist.js`
  - `ai-trading/auth/src/allowlist.test.js`
  - `ai-trading/auth/src/origin.js`
  - `ai-trading/auth/src/origin.test.js`

---

### Task 5: Auth service — Clerk token verification

**Files:**
- Create: `ai-trading/auth/src/clerk.js`
- Create: `ai-trading/auth/src/clerk.test.js`

**Interfaces:**
- Consumes: `@clerk/backend`'s `verifyToken` (default; dependency-injectable for tests, per its `verify` parameter).
- Produces: `verifyClerkToken(token, { secretKey, authorizedParties, verify? })` → `{ sub, email } | null`, consumed by Task 6's `/__auth/session` handler.
- **Operator precondition this code depends on, not something code can enforce:** the Clerk Dashboard's default session token (Sessions → Customize session token) must include a custom `email` claim, e.g. `{"email": "{{user.primary_email_address}}"}`. The default Clerk session token does not carry email by default. Without this claim, every verification fails closed (Step 4 below proves this exact failure mode).

- [ ] **Step 1: Write the failing tests, using a fake `verify` function (no live Clerk call)**

```js
// ai-trading/auth/src/clerk.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyClerkToken } from "./clerk.js";

const OK_PAYLOAD = { data: { sub: "user_123", email: "Family@Tobytran.dev" } };

test("a valid token with an email claim returns a normalized identity", async () => {
  const result = await verifyClerkToken("tok", { verify: async () => OK_PAYLOAD });
  assert.deepEqual(result, { sub: "user_123", email: "family@tobytran.dev" });
});

test("a result shaped as { errors } is rejected", async () => {
  const result = await verifyClerkToken("tok", { verify: async () => ({ errors: [{ message: "bad" }] }) });
  assert.equal(result, null);
});

test("a verify() that throws is rejected, not propagated", async () => {
  const result = await verifyClerkToken("tok", {
    verify: async () => {
      throw new Error("network down");
    },
  });
  assert.equal(result, null);
});

test("a payload missing the custom email claim is rejected (Clerk Dashboard precondition unmet)", async () => {
  const result = await verifyClerkToken("tok", { verify: async () => ({ data: { sub: "user_123" } }) });
  assert.equal(result, null);
});

test("an empty token short-circuits without calling verify", async () => {
  let called = false;
  const result = await verifyClerkToken("", {
    verify: async () => {
      called = true;
      return OK_PAYLOAD;
    },
  });
  assert.equal(result, null);
  assert.equal(called, false);
});
```

Run: `node --test ai-trading/auth/src/clerk.test.js`
Expected: FAIL — `clerk.js` does not exist yet.

- [ ] **Step 2: Implement `clerk.js`**

```js
// ai-trading/auth/src/clerk.js
import { verifyToken } from "@clerk/backend";

export async function verifyClerkToken(token, { secretKey, authorizedParties, verify = verifyToken } = {}) {
  if (!token) return null;
  let result;
  try {
    result = await verify(token, { secretKey, authorizedParties });
  } catch {
    return null;
  }
  if (!result || result.errors) return null;
  const payload = result.data ?? result;
  if (!payload || typeof payload.sub !== "string") return null;
  if (typeof payload.email !== "string" || !payload.email) return null;
  return { sub: payload.sub, email: payload.email.toLowerCase() };
}
```

- [ ] **Step 3: Run the tests**

Run: `node --test ai-trading/auth/src/clerk.test.js`
Expected: 5 passing tests.

- [ ] **Step 4: Report completion (no git operations)**

This task is done once every "Expected" check above has passed. Do not run `git add`, `git commit`, or `git push` here — a parallel subagent working on a different task may be touching the index at the same time, and staging is the controlling session's call, done only if it explicitly asks. Report which files this task created or modified, and that its tests pass:
  - `ai-trading/auth/src/clerk.js`
  - `ai-trading/auth/src/clerk.test.js`

---

### Task 6: Auth service entrypoint (two routes, no proxy code)

**Files:**
- Create: `ai-trading/auth/src/server.js`
- Create: `ai-trading/auth/src/server.test.js`
- Create: `ai-trading/auth/Dockerfile`

**Interfaces:**
- Consumes: `sign`/`verify` (Task 4), `isAllowedEmail`/`isAllowedOrigin` (Task 4), `verifyClerkToken` (Task 5).
- Produces: `createAuthServer(env)` — a plain `node:http` server with exactly two routes, consumed directly by Task 7's Caddyfile (`forward_auth auth:8181` / `reverse_proxy auth:8181`). `GET /__auth/check` → `204` with response header `X-Verified-Email: <email>` for a valid session cookie, `401` otherwise. `POST /__auth/session` → `204` + `Set-Cookie` on a verified, allowed Clerk user; `400` on a malformed body; `401` on an unverified or disallowed user; `403` on a disallowed `Origin`. This file never imports `node:net`, never calls `http.request` against another service, and never touches a WebSocket — all reverse-proxying is Task 7's Caddyfile's job.

- [ ] **Step 1: Write the failing tests**

```js
// ai-trading/auth/src/server.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthServer } from "./server.js";
import { sign } from "./session.js";

const SECRET = "a".repeat(64);
const ENV = {
  SESSION_SIGNING_KEY: SECRET,
  ALLOWED_EMAILS: "family@tobytran.dev",
  ALLOWED_ORIGINS: "https://trading.tobytran.dev",
};

function validCookie(email = "family@tobytran.dev", expOffsetSeconds = 3600) {
  return `__ai_trading_session=${sign({ email, exp: Math.floor(Date.now() / 1000) + expOffsetSeconds }, SECRET)}`;
}

async function withAuthServer(env, run) {
  const server = createAuthServer(env);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await run(port);
  } finally {
    server.close();
  }
}

test("GET /__auth/check is 401 with no cookie", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`);
    assert.equal(res.status, 401);
  });
});

test("GET /__auth/check is 204 with X-Verified-Email for a valid cookie", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, { headers: { cookie: validCookie() } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("x-verified-email"), "family@tobytran.dev");
  });
});

test("GET /__auth/check is 401 for an expired cookie", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/check`, {
      headers: { cookie: validCookie("family@tobytran.dev", -10) },
    });
    assert.equal(res.status, 401);
  });
});

test("POST /__auth/session rejects a cross-origin request before touching the body", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: "https://evil.example.test", "content-type": "application/json" },
      body: JSON.stringify({ token: "whatever" }),
    });
    assert.equal(res.status, 403);
  });
});

test("POST /__auth/session issues a cookie for a verified, allowed Clerk user", async () => {
  const env = { ...ENV, verifyToken: async () => ({ data: { sub: "user_1", email: "family@tobytran.dev" } }) };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: "https://trading.tobytran.dev", "content-type": "application/json" },
      body: JSON.stringify({ token: "real-looking-clerk-token" }),
    });
    assert.equal(res.status, 204);
    const setCookie = res.headers.get("set-cookie");
    assert.match(setCookie, /^__ai_trading_session=/);
    assert.match(setCookie, /Domain=tobytran\.dev/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
  });
});

test("POST /__auth/session rejects a verified user who is not on the allowlist", async () => {
  const env = { ...ENV, verifyToken: async () => ({ data: { sub: "user_2", email: "stranger@example.com" } }) };
  await withAuthServer(env, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: "https://trading.tobytran.dev", "content-type": "application/json" },
      body: JSON.stringify({ token: "real-looking-clerk-token" }),
    });
    assert.equal(res.status, 401);
  });
});

test("POST /__auth/session returns 400 for a malformed body", async () => {
  await withAuthServer(ENV, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/__auth/session`, {
      method: "POST",
      headers: { origin: "https://trading.tobytran.dev", "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(res.status, 400);
  });
});
```

Run: `node --test ai-trading/auth/src/server.test.js`
Expected: FAIL — `server.js` does not exist yet.

- [ ] **Step 2: Implement `server.js`**

```js
// ai-trading/auth/src/server.js
// Two routes only. Caddy (ai-trading/deploy/production/Caddyfile, the
// "gateway" service) owns every reverse-proxy and WebSocket concern
// declaratively; this file never does either.
import { createServer } from "node:http";
import { sign, verify } from "./session.js";
import { verifyClerkToken } from "./clerk.js";
import { isAllowedEmail } from "./allowlist.js";
import { isAllowedOrigin } from "./origin.js";

const COOKIE_NAME = "__ai_trading_session";
const COOKIE_MAX_AGE_SECONDS = 3600;

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function readJsonBody(req, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createAuthServer(env) {
  const { SESSION_SIGNING_KEY, ALLOWED_EMAILS, ALLOWED_ORIGINS, clerkSecretKey, verifyToken } = env;

  async function handleSession(req, res) {
    if (req.method !== "POST") return res.writeHead(405).end();
    if (!isAllowedOrigin(req.headers.origin, ALLOWED_ORIGINS)) return res.writeHead(403).end();
    let body;
    try {
      body = await readJsonBody(req, 8192);
    } catch {
      return res.writeHead(400).end();
    }
    const claims = await verifyClerkToken(body.token, {
      secretKey: clerkSecretKey,
      authorizedParties: (ALLOWED_ORIGINS || "").split(",").filter(Boolean),
      verify: verifyToken,
    });
    if (!claims || !isAllowedEmail(claims.email, ALLOWED_EMAILS)) return res.writeHead(401).end();
    const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_SECONDS;
    const token = sign({ email: claims.email, exp }, SESSION_SIGNING_KEY);
    res.writeHead(204, {
      "set-cookie": `${COOKIE_NAME}=${token}; Domain=tobytran.dev; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    });
    res.end();
  }

  function handleCheck(req, res) {
    const token = readCookie(req, COOKIE_NAME);
    const session = token ? verify(token, SESSION_SIGNING_KEY) : null;
    if (!session) return res.writeHead(401).end();
    res.writeHead(204, { "x-verified-email": session.email });
    res.end();
  }

  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://auth");
    if (pathname === "/__auth/session") return handleSession(req, res);
    if (pathname === "/__auth/check") return handleCheck(req, res);
    res.writeHead(404).end();
  });
}

/* c8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createAuthServer({
    SESSION_SIGNING_KEY: process.env.SESSION_SIGNING_KEY,
    ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    clerkSecretKey: process.env.CLERK_SECRET_KEY,
  });
  const port = Number(process.env.PORT || 8181);
  server.listen(port, () => console.log(`auth listening on ${port}`));
}
/* c8 ignore stop */
```

- [ ] **Step 3: Run the tests**

Run: `node --test ai-trading/auth/src/server.test.js`
Expected: 7 passing tests.

- [ ] **Step 4: Write the Dockerfile**

```dockerfile
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app package.json ./package.json
COPY --chown=app:app src ./src
USER app
EXPOSE 8181
CMD ["node", "src/server.js"]
```

- [ ] **Step 5: Report completion (no git operations)**

This task is done once every "Expected" check above has passed. Do not run `git add`, `git commit`, or `git push` here — a parallel subagent working on a different task may be touching the index at the same time, and staging is the controlling session's call, done only if it explicitly asks. Report which files this task created or modified, and that its tests pass:
  - `ai-trading/auth/src/server.js`
  - `ai-trading/auth/src/server.test.js`
  - `ai-trading/auth/Dockerfile`

---

### Task 7: Caddy gateway, compose wiring, and a real-Caddy integration test

**Files:**
- Create: `ai-trading/deploy/production/Caddyfile`
- Modify: `ai-trading/deploy/production/docker-compose.yml`
- Modify: `ai-trading/deploy/docker-bake.hcl`
- Modify: `ai-trading/deploy/docker-bake.ci.hcl`
- Modify: `ai-trading/deploy/ci/smoke-test.sh`
- Modify: `ai-trading/deploy/production/health-check.sh`
- Modify: `.github/workflows/ai-trading-ci.yml` (one line in the existing `scripts` job's scaffold loop; no new job)

**Interfaces:**
- Consumes: Task 6's `auth` image, port `8181`, routes `/__auth/session` and `/__auth/check`. The existing `ta-terminal`/`ahf-terminal` images, port `7681` each.
- Produces: the `gateway` Compose service (stock `caddy:2-alpine`, container port `8080`) — the exact name/port 01i's Task 7 Step 5 and this plan's own Task 3 both already reference. `gateway:8080`'s behavior: strip any client `Cf-Access-Authenticated-User-Email`, `forward_auth auth:8181` against `/__auth/check`, `copy_headers` the verified identity back onto the request, `reverse_proxy` to the matching terminal with automatic WebSocket upgrade. A marked insertion point in the Caddyfile for 01i's MiroFish `/api/*` route.

- [ ] **Step 1: Write the Caddyfile**

```caddyfile
# ai-trading/deploy/production/Caddyfile
# The "gateway" service. Every reverse-proxy and WebSocket-upgrade concern
# lives here, declaratively -- there is no hand-written Node proxy anywhere
# in this plan (see Global Constraints). "auth" (ai-trading/auth) is the only
# upstream this file ever calls for a verification decision.
{
	admin off
	auto_https off
}

:8080 {
	handle /__auth/* {
		reverse_proxy auth:8181
	}

	handle /u/tradingagents* {
		request_header -Cf-Access-Authenticated-User-Email
		forward_auth auth:8181 {
			uri /__auth/check
			copy_headers X-Verified-Email>Cf-Access-Authenticated-User-Email
		}
		reverse_proxy ta-terminal:7681
	}

	handle /u/ai-hedge-fund* {
		request_header -Cf-Access-Authenticated-User-Email
		forward_auth auth:8181 {
			uri /__auth/check
			copy_headers X-Verified-Email>Cf-Access-Authenticated-User-Email
		}
		reverse_proxy ahf-terminal:7681
	}

	handle /__healthz {
		respond 200
	}

	# --- Plan B (01i) inserts MiroFish's /api/* route here, immediately
	# before the catch-all below. Mirror the /u/* blocks above exactly:
	#   handle /api/* {
	#       forward_auth auth:8181 {
	#           uri /__auth/check
	#           copy_headers X-Verified-Email>Cf-Access-Authenticated-User-Email
	#       }
	#       reverse_proxy mirofish:5001
	#   }
	# Join this Caddy ("gateway") container to the "mirofish" compose
	# network in that plan's own sibling compose file so the hostname
	# resolves. /__control/* (01g, not yet reviewed) is reserved the same
	# way: no block here, so it falls through to the 404 below until that
	# plan adds one. ---

	handle {
		respond 404
	}
}
```

`request_header -Cf-Access-Authenticated-User-Email` and the subsequent `copy_headers` both mutate the same original request object in sequence (Caddy's documented behavior for `forward_auth`/`copy_headers`: on a 2xx response from the auth upstream, the listed fields are set on the original request, which then continues to the next directive in this block — the `reverse_proxy` to the terminal). Stripping first is defense-in-depth even though `copy_headers`'s underlying `request_header` set already overwrites rather than appends; both together make Review Focus #1 true independent of exactly which Caddy version's internals you're relying on.

- [ ] **Step 2: Validate the Caddyfile with the real `caddy` binary**

Run:
```bash
docker run --rm -v "$PWD/ai-trading/deploy/production/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```
Expected: exits `0` and prints a line confirming the configuration is valid (exact wording varies by Caddy point release; a nonzero exit or a parse-error message is the failure signal to act on).

- [ ] **Step 3: Add `gateway` and `auth` to production compose**

```yaml
  gateway:
    # Not digest-pinned yet, unlike this file's other images: `caddy:2-alpine`
    # matches the tag already used unpinned in
    # ai-trading/deploy/local/docker-compose.override.yml. Pin it before the
    # real production deploy (Task 9) by running
    # `docker pull caddy:2-alpine && docker inspect --format '{{index .RepoDigests 0}}' caddy:2-alpine`
    # and using that exact value here.
    image: caddy:2-alpine
    restart: unless-stopped
    volumes:
      - ../production/Caddyfile:/etc/caddy/Caddyfile:ro
    networks: [gateway, ta, ahf]
    mem_limit: 64m
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1:8080/__healthz"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

  auth:
    image: ${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}/ai-trading-auth:${AI_TRADING_IMAGE_TAG:?AI_TRADING_IMAGE_TAG is required}
    restart: unless-stopped
    env_file:
      - ${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}/auth.env
    networks: [gateway]
    mem_limit: 128m
    pids_limit: 128
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8181/__auth/check').then((r) => process.exit(r.status === 401 ? 0 : 1), () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3
```

Add `gateway: {}` to the top-level `networks:` block. Add `gateway` to `cloudflared`'s `networks:` list (`[hub, ta, ahf, vibe, gateway]`) so the tunnel can reach Caddy.

- [ ] **Step 4: Add the `auth` Bake target (no target needed for `gateway` — stock image)**

In `ai-trading/deploy/docker-bake.hcl`, add `"auth"` to `group "default"`'s `targets` list, and add:

```hcl
target "auth" {
  context = "ai-trading/auth"
  tags    = ["${REGISTRY}/ai-trading-auth:${TAG}"]
}
```

In `ai-trading/deploy/docker-bake.ci.hcl`, add:

```hcl
target "auth" {
  cache-from = ["type=gha,scope=ai-trading-auth"]
  cache-to   = ["type=gha,scope=ai-trading-auth,mode=max"]
}
```

- [ ] **Step 5: Add a real-Caddy integration test to `smoke-test.sh`**

Append to the shared `cleanup()` function (it currently only removes `containers[]`) so a mid-test failure never leaks the Docker network this test creates:
```bash
  docker network rm smoke-gateway-net >/dev/null 2>&1 || true
```

Append the signing helper and the test function:

```bash
# sign_smoke_cookie KEY_HEX EMAIL EXP_OFFSET_SECONDS: signs a cookie value
# with the same HMAC scheme as ai-trading/auth/src/session.js, using only
# Node (already a dependency of this script's own checks elsewhere), so this
# test needs no extra tooling beyond Docker.
sign_smoke_cookie() {
  docker run --rm node:24-alpine node -e '
const { createHmac } = require("node:crypto");
const key = Buffer.from(process.argv[1], "hex");
const payload = JSON.stringify({ email: process.argv[2], exp: Math.floor(Date.now() / 1000) + Number(process.argv[3]) });
const body = Buffer.from(payload).toString("base64url");
const mac = createHmac("sha256", key).update(body).digest("base64url");
process.stdout.write(`__ai_trading_session=${body}.${mac}`);
' "$1" "$2" "$3"
}

smoke_gateway() {
  local net="smoke-gateway-net" key
  docker network rm "$net" >/dev/null 2>&1 || true
  docker network create "$net" >/dev/null
  key="$(printf 'a%.0s' {1..64})"

  docker run -d --name smoke-auth --network "$net" --network-alias auth \
    -e SESSION_SIGNING_KEY="$key" -e ALLOWED_EMAILS=smoke@example.test \
    -e ALLOWED_ORIGINS=https://trading.example.test \
    "$(image auth)" >/dev/null
  containers+=(smoke-auth)

  # Header-echo stand-in for ta-terminal: returns whatever it received as
  # Cf-Access-Authenticated-User-Email, so the test can prove Caddy replaced
  # a forged value before any upstream ever saw it. No WebSocket code here --
  # this container is swapped for a real ttyd image below for that check.
  docker run -d --name smoke-echo-upstream --network "$net" --network-alias ta-terminal \
    python:3.12-alpine python3 -c '
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = self.headers.get("Cf-Access-Authenticated-User-Email", "none").encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
http.server.HTTPServer(("0.0.0.0", 7681), H).serve_forever()
' >/dev/null
  containers+=(smoke-echo-upstream)

  docker run -d --name smoke-caddy --network "$net" -p 127.0.0.1:18080:8080 \
    -v "$PWD/ai-trading/deploy/production/Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2-alpine >/dev/null
  containers+=(smoke-caddy)

  local cookie expired_cookie body
  cookie="$(sign_smoke_cookie "$key" smoke@example.test 3600)"
  expired_cookie="$(sign_smoke_cookie "$key" smoke@example.test -10)"

  expect_status 401 http://127.0.0.1:18080/u/tradingagents/
  expect_status 403 http://127.0.0.1:18080/__auth/session \
    -X POST -H 'Origin: https://evil.example.test' -H 'Content-Type: application/json' -d '{}'
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/ --cookie "$expired_cookie"

  body="$(curl -s --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' \
    http://127.0.0.1:18080/u/tradingagents/)"
  [[ "$body" == "smoke@example.test" ]] || fail "expected the upstream to see the verified email, got: $body"
  echo "ok   Caddy replaced a spoofed Cf-Access-Authenticated-User-Email header with the verified one"

  # Swap the header-echo stand-in for a real ttyd to prove the WebSocket
  # handshake actually reaches a real upstream through forward_auth + reverse_proxy.
  docker rm -f smoke-echo-upstream >/dev/null
  docker run -d --name smoke-ta-terminal --network "$net" --network-alias ta-terminal "$(image ta-terminal)" >/dev/null
  containers+=(smoke-ta-terminal)
  docker restart smoke-caddy >/dev/null
  sleep 2

  local ws_status
  ws_status="$(curl -s -o /dev/null -w '%{http_code}' --cookie "$cookie" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    http://127.0.0.1:18080/u/tradingagents/)"
  [[ "$ws_status" == "101" ]] || fail "expected 101 Switching Protocols through Caddy to a real ttyd, got $ws_status"
  echo "ok   WebSocket handshake reaches a real ttyd through Caddy with a valid cookie"

  docker network rm "$net" >/dev/null 2>&1 || true
}
```

Add `gateway) smoke_gateway ;;` to the dispatch `case`, and `smoke_gateway` to the `all)` arm (after `smoke_terminal ta-terminal ...`, since this test reuses that image).

- [ ] **Step 6: Add `gateway` and `auth` to `health-check.sh`'s service list**

In `ai-trading/deploy/production/health-check.sh`, change:
```bash
SERVICES=(web ta-terminal ahf-terminal vibe-trading cloudflared)
```
to:
```bash
SERVICES=(web ta-terminal ahf-terminal vibe-trading cloudflared gateway auth)
```

If 01i's Task 5 has already landed its own guarded `SERVICES+=(mirofish)` line below this, this edit is an independent array entry and composes with it without conflict.

- [ ] **Step 7: Add `auth` to the CI `scripts` job's secret-file scaffold**

In `.github/workflows/ai-trading-ci.yml`'s `scripts` job, change:
```bash
for name in tradingagents ai-hedge-fund vibe-trading cloudflared; do : >"$secrets/$name.env"; done
```
to:
```bash
for name in tradingagents ai-hedge-fund vibe-trading cloudflared auth; do : >"$secrets/$name.env"; done
```

No new CI job is needed: the existing `images` job already builds the full default Bake group (now including `auth`) and runs `smoke-test.sh all`, which now also runs `smoke_gateway` and already has `ta-terminal` built in the same job.

- [ ] **Step 8: Run the auth unit tests and the new integration test locally**

Run: `node --test ai-trading/auth/src/*.test.js`
Expected: 18 passing tests (5 session + 3 allowlist + 3 origin + 5 clerk + 7 server, per Tasks 4-6 — if this count does not match, recount Tasks 4-6's own "Expected" lines before proceeding).

Run (after building the `auth` and `ta-terminal` images locally, e.g. via `docker buildx bake -f ai-trading/deploy/docker-bake.hcl -f ai-trading/deploy/docker-bake.ci.hcl --load auth ta-terminal ta-upstream terminal-tools`): `ai-trading/deploy/ci/smoke-test.sh gateway`
Expected: all `expect_status`/`ok` lines pass; the script exits `0`.

- [ ] **Step 9: Shellcheck and compose-config check**

Run: `shellcheck ai-trading/deploy/ci/smoke-test.sh ai-trading/deploy/production/health-check.sh`
Expected: clean.

Run: `docker compose -f ai-trading/deploy/production/docker-compose.yml config --quiet` with `AI_TRADING_SECRETS_DIR` pointed at a scratch directory containing empty `tradingagents.env`, `ai-hedge-fund.env`, `vibe-trading.env`, `cloudflared.env`, `auth.env` files, and `AI_TRADING_IMAGE_TAG` set to a 40-hex-char placeholder.
Expected: exits `0` — `gateway` needs no `env_file` entry at all, so it is not in this list.

- [ ] **Step 10: Report completion (no git operations)**

This task is done once every "Expected" check above has passed. Do not run `git add`, `git commit`, or `git push` here — a parallel subagent working on a different task may be touching the index at the same time, and staging is the controlling session's call, done only if it explicitly asks. Report which files this task created or modified, and that its tests pass:
  - `ai-trading/deploy/production/Caddyfile`
  - `ai-trading/deploy/production/docker-compose.yml`
  - `ai-trading/deploy/docker-bake.hcl`
  - `ai-trading/deploy/docker-bake.ci.hcl`
  - `ai-trading/deploy/ci/smoke-test.sh`
  - `ai-trading/deploy/production/health-check.sh`
  - `.github/workflows/ai-trading-ci.yml`

---

### Task 8: Frontend — client-side Clerk login and the private-hub gate

**Files:**
- Modify: `ai-trading/frontend/package.json` (add `@clerk/clerk-react`)
- Create: `ai-trading/frontend/lib/auth.ts`
- Create: `ai-trading/frontend/lib/auth.test.ts`
- Create: `ai-trading/frontend/components/auth-provider.tsx`
- Create: `ai-trading/frontend/components/auth-gate.tsx`
- Modify: `ai-trading/frontend/app/layout.tsx`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (Task 1's Dockerfile ARG; Task 9 wires its real value). `useAuth()`/`useUser()`/`SignIn` from `@clerk/clerk-react` (plain client SDK — not `@clerk/nextjs`, since this app has no server/middleware for `@clerk/nextjs`'s server helpers to attach to; see Global Constraints).
- Produces: `getGateState({ isLoaded, isSignedIn })` (pure, tested) and `SESSION_REFRESH_INTERVAL_MS` — consumed by `auth-gate.tsx`. `AuthProvider`/`AuthGate` wrap `{children}` in `layout.tsx`, gating every route in the hub, including the home page.

- [ ] **Step 1: Add the dependency**

```json
"@clerk/clerk-react": "^5.19.0"
```
into `ai-trading/frontend/package.json`'s `dependencies`. Run (from `ai-trading/frontend`): `pnpm install`.

- [ ] **Step 2: Write the failing test for the pure gate-state helper**

```ts
// ai-trading/frontend/lib/auth.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getGateState, SESSION_REFRESH_INTERVAL_MS } from "./auth";

test("not yet loaded is the loading state", () => {
  assert.equal(getGateState({ isLoaded: false, isSignedIn: undefined }), "loading");
});
test("loaded but not signed in is the signed-out state", () => {
  assert.equal(getGateState({ isLoaded: true, isSignedIn: false }), "signed-out");
});
test("loaded and signed in is ready", () => {
  assert.equal(getGateState({ isLoaded: true, isSignedIn: true }), "ready");
});
test("the refresh interval is well under the session cookie's one-hour cap", () => {
  assert.ok(SESSION_REFRESH_INTERVAL_MS < 3600_000);
  assert.ok(SESSION_REFRESH_INTERVAL_MS > 0);
});
```

Run: `node --experimental-strip-types --test ai-trading/frontend/lib/auth.test.ts`
Expected: FAIL — `auth.ts` does not exist yet.

- [ ] **Step 3: Implement `auth.ts`**

```ts
// ai-trading/frontend/lib/auth.ts
export type GateState = "loading" | "signed-out" | "ready";

export function getGateState(input: { isLoaded: boolean; isSignedIn: boolean | undefined }): GateState {
  if (!input.isLoaded) return "loading";
  if (!input.isSignedIn) return "signed-out";
  return "ready";
}

// The session cookie is capped at 3600s (ai-trading/auth/src/server.js);
// refresh well before that so a user never sees a mid-session 401.
export const SESSION_REFRESH_INTERVAL_MS = 20 * 60 * 1000;

export function requireClerkPublishableKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key) throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required");
  return key;
}
```

- [ ] **Step 4: Run the test**

Run: `node --experimental-strip-types --test ai-trading/frontend/lib/auth.test.ts`
Expected: 4 passing tests.

- [ ] **Step 5: Write the Clerk provider**

```tsx
// ai-trading/frontend/components/auth-provider.tsx
"use client";

import { ClerkProvider } from "@clerk/clerk-react";
import type { ReactNode } from "react";
import { requireClerkPublishableKey } from "@/lib/auth";

export function AuthProvider({ children }: { children: ReactNode }) {
  const publishableKey = requireClerkPublishableKey(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  return <ClerkProvider publishableKey={publishableKey}>{children}</ClerkProvider>;
}
```

- [ ] **Step 6: Write the sign-in gate, which also POSTs the Clerk token to `auth`**

```tsx
// ai-trading/frontend/components/auth-gate.tsx
"use client";

import { useEffect } from "react";
import { SignIn, useAuth } from "@clerk/clerk-react";
import type { ReactNode } from "react";
import { getGateState, SESSION_REFRESH_INTERVAL_MS } from "@/lib/auth";

async function postSessionToken(getToken: () => Promise<string | null>) {
  const token = await getToken();
  if (!token) return;
  await fetch("/__auth/session", {
    method: "POST",
    credentials: "include", // same-origin request (the Worker hides the split origin); sends the session cookie back on later requests
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const state = getGateState({ isLoaded, isSignedIn });

  useEffect(() => {
    if (state !== "ready") return;
    postSessionToken(getToken);
    const id = setInterval(() => postSessionToken(getToken), SESSION_REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state, getToken]);

  if (state === "loading") {
    return (
      <main className="flex h-dvh items-center justify-center">
        <p className="text-muted-foreground">Loading secure workspace...</p>
      </main>
    );
  }
  if (state === "signed-out") {
    return (
      <main className="flex h-dvh items-center justify-center">
        <SignIn routing="hash" />
      </main>
    );
  }
  return children;
}
```

- [ ] **Step 7: Wire both into `layout.tsx`**

```tsx
import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider } from "@/components/auth-provider";
import { AuthGate } from "@/components/auth-gate";

const inter = localFont({
  src: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Trading Hub",
  description: "Private family hub for AI trading apps.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="flex h-dvh flex-col bg-background text-foreground antialiased">
        <AuthProvider>
          <AuthGate>{children}</AuthGate>
        </AuthProvider>
      </body>
    </html>
  );
}
```

- [ ] **Step 8: Build and typecheck**

Run (from `ai-trading/frontend`): `pnpm typecheck && NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_fixture pnpm build`
Expected: both succeed; `out/index.html` contains the Clerk script tag (the provider renders even though sign-in itself cannot be exercised without a real Clerk instance — that happens in Task 9's spike).

- [ ] **Step 9: Re-run Task 1's static-export check against the new build**

Run: `ai-trading/deploy/ci/check-static-export.sh ai-trading/frontend/out`
Expected: `check-static-export: ok (...)` — confirms the fixture publishable key (`pk_test_fixture`, a `pk_` prefix, not `sk_`) does not trip the secret-scan, and no real secret leaked in from the environment.

- [ ] **Step 10: Report completion (no git operations)**

This task is done once every "Expected" check above has passed. Do not run `git add`, `git commit`, or `git push` here — a parallel subagent working on a different task may be touching the index at the same time, and staging is the controlling session's call, done only if it explicitly asks. Report which files this task created or modified, and that its tests pass:
  - `ai-trading/frontend/package.json`
  - `ai-trading/frontend/pnpm-lock.yaml`
  - `ai-trading/frontend/lib/auth.ts`
  - `ai-trading/frontend/lib/auth.test.ts`
  - `ai-trading/frontend/components/auth-provider.tsx`
  - `ai-trading/frontend/components/auth-gate.tsx`
  - `ai-trading/frontend/app/layout.tsx`

---

### Task 9: Family-config profiles, deploy/build wiring, and the GCS upload script

**Precondition — stop and check before Step 1:** this task depends on `common/config/family_config.py` and its handoff (see "Dependency: Firestore `family-config`" above) already being merged to `dev`. Run `test -x common/config/family_config.py` at the start of this task. If it fails, stop: do not re-implement the old `env-bundle.py` pattern as a substitute, and do not guess at `family_config.py`'s interface from this plan's description of it alone — wait for the dependency to land, then re-read `common/config/README.md` for the exact CLI surface before continuing, since this task's commands below were written against that file as it reads on `feature/toby` commit `c70a67e` and may have changed by the time this task actually runs.

**Files:**
- Modify: `ai-trading/deploy/production/deploy.sh`
- Modify: `.github/workflows/ai-trading-deploy.yml`
- Modify: `ai-trading/deploy/docker-bake.hcl`
- Create: `ai-trading/deploy/ci/upload-hub-static.sh`

**Interfaces:**
- Produces: Firestore profile `ai-trading/gateway` (`CLERK_SECRET_KEY`, `SESSION_SIGNING_KEY`, `ALLOWED_EMAILS`, `ALLOWED_ORIGINS`) rendered **on the VPS itself**, at deploy time, by `deploy.sh` calling `family_config.py render ai-trading/gateway --out-dir "$SECRETS_DIR"` — which writes `$SECRETS_DIR/gateway.env` (the file is always named after the profile; `family_config.py` has no option to rename it), immediately moved to `$SECRETS_DIR/auth.env` to match Task 7's `auth` compose service's `env_file` path. Read by the VPS from Firestore directly, per the handoff's "VPS reads Firestore itself" pattern, using the already-provisioned, database-wide `family-config-reader` key at `/etc/family-app/config-reader.json` — a completely different mechanism from the other, CI-staged `SECRET_FILES`. `ai-trading/clerk` profile (`PUBLISHABLE_KEY`) reaches the Docker build as `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, via a plain (non-secret) GitHub Actions **variable** refreshed from Firestore by hand — not a live CI-side Firestore call — mirroring how the design doc's own `CLERK_PUBLISHABLE_KEY`/`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` values are kept for `expense-tax-management`. `upload-hub-static.sh OUT_DIR BUCKET` — uploads with per-path `Cache-Control`; wiring it into an automated deploy step is Task 10's concern, once a real production target exists to run it against.

- [ ] **Step 1: Create the two new profiles and their values (operator; not executed by an agent)**

None of these values exist yet. The operator runs (values are illustrative shapes, not real secrets — never paste an actual key into this plan file or any commit):

```bash
openssl rand -hex 32 | common/config/family_config.py set ai-trading/gateway SESSION_SIGNING_KEY
printf '%s' "$CLERK_SECRET_KEY" | common/config/family_config.py set ai-trading/gateway CLERK_SECRET_KEY
printf '%s' "family1@tobytran.dev,family2@tobytran.dev" | common/config/family_config.py set ai-trading/gateway ALLOWED_EMAILS
printf '%s' "https://trading.tobytran.dev,https://trading-static.tobytran.dev" | common/config/family_config.py set ai-trading/gateway ALLOWED_ORIGINS
printf '%s' "$CLERK_PUBLISHABLE_KEY" | common/config/family_config.py set ai-trading/clerk PUBLISHABLE_KEY
common/config/family_config.py keys ai-trading/gateway
common/config/family_config.py keys ai-trading/clerk
```
Expected: the final two commands print exactly the four and one names above (never values).

- [ ] **Step 2: Wire `deploy.sh` to render `auth.env` from Firestore at deploy time**

In `ai-trading/deploy/production/deploy.sh`, add this function near `compose()`:
```bash
# render_auth_env: writes $SECRETS_DIR/auth.env fresh from Firestore
# family-config on every deploy (ai-trading/plans/handoffs/2026-10-05-family-config.md).
# The profile is named "gateway" in Firestore for interface continuity, but
# the file family_config.py writes (named after the profile) is renamed here
# to auth.env to match the actual compose service that reads it -- "gateway"
# itself is Caddy and needs no secrets at all. Unlike SECRET_FILES above
# (CI-staged via ENV_STAGING_DIR and scp'd), this profile is read by the VPS
# itself with the shared, database-wide reader key -- nothing renders or
# stages it from CI.
render_auth_env() {
  local family_config="$APP_DIR/family_config.py"
  [[ -x "$family_config" ]] || die "missing $family_config; copy it alongside deploy.sh first"
  FAMILY_CONFIG_CREDENTIALS="${FAMILY_CONFIG_CREDENTIALS:-/etc/family-app/config-reader.json}" \
    "$family_config" render ai-trading/gateway --out-dir "$SECRETS_DIR"
  mv -f "$SECRETS_DIR/gateway.env" "$SECRETS_DIR/auth.env"
}
```

Then, in the script's main flow, change:
```bash
install -d -m 0755 "$APP_DIR"
deploy_tag "$IMAGE_TAG"
```
to:
```bash
install -d -m 0755 "$APP_DIR"
render_auth_env
deploy_tag "$IMAGE_TAG"
```

- [ ] **Step 3: Copy `family_config.py` to the VPS alongside the other deploy files**

In `.github/workflows/ai-trading-deploy.yml`'s deploy job, change:
```bash
scp "${scp_opts[@]}" \
  ai-trading/deploy/production/docker-compose.yml \
  ai-trading/deploy/production/deploy.sh \
  ai-trading/deploy/production/health-check.sh \
  "$VPS_USER@$VPS_HOST:/tmp/ai-trading-deploy/"
```
to:
```bash
scp "${scp_opts[@]}" \
  ai-trading/deploy/production/docker-compose.yml \
  ai-trading/deploy/production/deploy.sh \
  ai-trading/deploy/production/health-check.sh \
  ai-trading/deploy/production/Caddyfile \
  common/config/family_config.py \
  "$VPS_USER@$VPS_HOST:/tmp/ai-trading-deploy/"
```

And, in the same job's remote install command, add two more `sudo install` lines alongside the existing three (`docker-compose.yml`, `deploy.sh`, `health-check.sh`):
```bash
sudo install -o root -g root -m 0644 /tmp/ai-trading-deploy/Caddyfile /opt/family-app/ai-trading/Caddyfile;
sudo install -o root -g root -m 0755 /tmp/ai-trading-deploy/family_config.py /opt/family-app/ai-trading/family_config.py;
```

`docker-compose.yml`'s `gateway` service (Task 7) mounts `../production/Caddyfile` relative to itself; confirm this install path matches that relative reference once both files are installed under `/opt/family-app/ai-trading/`.

- [ ] **Step 4: Refresh the build-time Clerk publishable key as a GitHub Actions variable**

Run once (operator), and again whenever the Clerk publishable key changes:
```bash
common/config/family_config.py get ai-trading/clerk PUBLISHABLE_KEY \
  | gh variable set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY --env ai-trading-production --repo thangtran3112/family-app
```

- [ ] **Step 5: Pass it into the build**

In `ai-trading/deploy/docker-bake.hcl`, add:
```hcl
variable "CLERK_PUBLISHABLE_KEY" {
  default = ""
}
```
and, in the `web` target's `args` block, add `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = CLERK_PUBLISHABLE_KEY` alongside the existing `NEXT_PUBLIC_VIBE_TRADING_URL = VIBE_TRADING_URL` line.

In `.github/workflows/ai-trading-deploy.yml`'s "Build and push immutable images" step, add `CLERK_PUBLISHABLE_KEY: ${{ vars.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}` to that step's existing `env:` block (alongside `TAG: ${{ github.sha }}`).

- [ ] **Step 6: Shellcheck and a Bake print check**

Run: `shellcheck ai-trading/deploy/production/deploy.sh`
Expected: clean.

Run (from the repository root): `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --print web`
Expected: the printed JSON's `web` target `args` include `"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": ""` when `CLERK_PUBLISHABLE_KEY` is unset in the environment — proving the default is empty (safe), not absent (which would be a silent typo in the variable name).

- [ ] **Step 7: Write the GCS upload script**

This script is written now so Task 9's own spike has something concrete to run against the staging bucket/hostname; wiring it into an automated deploy step is Task 10's concern, once a real production target exists to run it against.

```bash
#!/usr/bin/env bash
# Uploads a built ai-trading/frontend/out/ directory to the hub's GCS bucket
# with per-path Cache-Control, then deletes any remote object no longer
# present locally (an immutable, from-scratch deploy per push).
# Usage: upload-hub-static.sh OUT_DIR BUCKET
set -Eeuo pipefail

OUT_DIR="${1:?usage: upload-hub-static.sh OUT_DIR BUCKET}"
BUCKET="${2:?usage: upload-hub-static.sh OUT_DIR BUCKET}"

[[ -d "$OUT_DIR" ]] || { echo "upload-hub-static: missing $OUT_DIR" >&2; exit 1; }

# Hashed Next.js assets: long, immutable cache.
gsutil -m -h "Cache-Control:public, max-age=31536000, immutable" \
  rsync -r "$OUT_DIR/_next/static" "gs://$BUCKET/_next/static"

# Everything else (HTML, 404.html, favicon, etc.): no caching, so a deploy
# is visible immediately. -x excludes the directory already uploaded above
# with a different Cache-Control header, so rsync -d below does not delete it.
gsutil -m -h "Cache-Control:no-store" \
  rsync -r -d -x '^_next/static/.*$' "$OUT_DIR" "gs://$BUCKET"

echo "upload-hub-static: uploaded $OUT_DIR to gs://$BUCKET"
```

- [ ] **Step 8: Shellcheck**

Run: `shellcheck ai-trading/deploy/ci/upload-hub-static.sh`
Expected: clean.

- [ ] **Step 9: Report completion (no git operations)**

This task is done once every "Expected" check above has passed. Do not run `git add`, `git commit`, or `git push` here — a parallel subagent working on a different task may be touching the index at the same time, and staging is the controlling session's call, done only if it explicitly asks. Report which files this task created or modified, and that its tests pass:
  - `ai-trading/deploy/production/deploy.sh`
  - `.github/workflows/ai-trading-deploy.yml`
  - `ai-trading/deploy/docker-bake.hcl`
  - `ai-trading/deploy/ci/upload-hub-static.sh`

---

### Task 10: Preflight spike — Safari cross-subdomain Clerk, Worker WebSocket + multipart forward-compat (go/no-go gate)

**Files:**
- Modify: `ai-trading/plans/STATUS.md` (record the result; one bullet)

This task requires real, deployed infrastructure (Tasks 2, 3, 7, 9's outputs, actually applied — `terraform apply` on the GCP bucket root per its operator-applied process, `workflow_dispatch(apply=true)` on `ai-trading-infra.yml` for the Cloudflare root, and the **first-ever** production deploy of the `web`/`gateway`/`auth`/`ta-terminal`/`ahf-terminal`/`vibe-trading`/`cloudflared` images via `ai-trading-deploy.yml`). It cannot be executed from a write-only planning session; it is the first task in this plan an executor with real infrastructure access runs, and its own precondition is that the VPS reader key (`/etc/family-app/config-reader.json`, handoff's `install-reader-key.sh`) is already installed — if it is not, Task 9's `render_auth_env` step fails loudly before any container starts, which is the correct, documented failure mode, not a bug to work around here.

**Interfaces:**
- Consumes: `trading-static.tobytran.dev` (Task 3), `trading-origin.tobytran.dev` (Task 3), the `gateway`/`auth` services (Task 7), the hub static build (Tasks 1, 9).
- Produces: a recorded PASS/FAIL per check in `STATUS.md`, gating Task 11.

- [ ] **Step 1: Deploy the staging path (this is the hub's first production deployment of any kind)**

Apply `infrastructure/gcp/ai-trading` (operator, for the bucket), run `ai-trading-infra.yml` with `apply: true` (for the Worker/route/DNS/ingress line), run `ai-trading/deploy/ci/upload-hub-static.sh ai-trading/frontend/out <hub_bucket_name>`, and run the first `ai-trading-deploy.yml` deploy (all seven services — `web`, `gateway`, `auth`, `ta-terminal`, `ahf-terminal`, `vibe-trading`, `cloudflared` — Task 9's `render_auth_env` included) once Tasks 1-9 are merged to `main`.

- [ ] **Step 2: Safari cross-subdomain Clerk check**

On an actual iPad or Mac running Safari, with Intelligent Tracking Prevention at its default (not disabled) setting:
1. Open `https://trading-static.tobytran.dev/`.
2. Sign in with Google through Clerk's hosted `SignIn` component.
3. Confirm the hub renders past the sign-in gate (not stuck on "Loading secure workspace...").
4. Reload the page. Confirm it does **not** show the sign-in screen again (the Clerk client session persisted).
5. Close Safari entirely, reopen, revisit the URL. Confirm the session still persists (not just a single-tab in-memory state).

Record PASS/FAIL for each of the five checks in `STATUS.md`.

- [ ] **Step 3: Worker WebSocket forward-compat check**

```bash
curl -i -N \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  --cookie "__ai_trading_session=<a cookie obtained via Step 2's real sign-in>" \
  "https://trading-static.tobytran.dev/u/tradingagents/"
```
Expected: `HTTP/1.1 101 Switching Protocols`, not a plain 200/404 — proves the Worker's `fetch(originUrl, request)` pattern (Task 3) plus Caddy's `forward_auth`/`reverse_proxy` (Task 7, already proven locally against Docker containers in that task's own integration test) also work through the real tunnel, to a real ttyd, in production.

- [ ] **Step 4: Worker large-body/multipart forward-compat check (after 01i's staging setup)**

`/__auth/session` reads only the Bearer header and never consumes the request body. A `curl` `%{size_upload}` against that route proves only that the client sent bytes, not that the Worker and gateway delivered them. After Step 1 deploys the shared Caddy gateway, stage MiroFish's backend and `mirofish-static.tobytran.dev` Worker per [01i Task 8](01i-mirofish-upstream-implementation.md); its direct-origin auth checks must pass before staging the Worker. Do not route the public MiroFish hostname. This staging setup requires its own operator approval and optional Firestore profile. Until the real multipart consumer is ready, leave this step and Task 10's go/no-go decision pending.

The upstream Flask route `/api/graph/ontology/generate` parses the `files` multipart field before deciding whether to call an LLM. Send a disposable 5 MB `.bin` (an unsupported extension) with a nonempty requirement. Flask must report **no documents processed**, rather than **no file uploaded**; the former response is reached only after it parses the multipart file and rejects its extension. This path does not invoke Zep or an LLM:

```bash
(
  payload="$(mktemp /tmp/mirofish-spike.XXXXXX)"
  trap 'rm -f "$payload"' EXIT
  head -c 5000000 /dev/urandom > "$payload"
  curl -sS -w '\n%{http_code} %{size_upload}\n' \
    --cookie '__ai_trading_session=<a cookie obtained via Step 2>' \
    -H 'Accept-Language: en' \
    -F 'simulation_requirement=upload transport probe' \
    -F "files=@${payload};filename=probe.bin;type=application/octet-stream" \
    'https://mirofish-static.tobytran.dev/api/graph/ontology/generate'
)
```

Expected: Flask returns `400` with `No documents were processed successfully. Please check file formats.`; `%{size_upload}` exceeds `5000000` by multipart framing bytes. A `401`, a missing-file response, or a gateway/Worker error fails the check. Record the result in `STATUS.md` before Task 11. The hub's own dynamic routing remains covered by Step 3's real WebSocket check; this request tests the same POST-forwarding idiom through MiroFish's real body-consuming path.

- [ ] **Step 5: Direct-origin bypass check (mirrors 01i's own Task 7 Step 7 for MiroFish)**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://trading-origin.tobytran.dev/u/tradingagents/"
curl -s -o /dev/null -w '%{http_code}\n' "https://trading-static.tobytran.dev/u/tradingagents/"
```
Expected: both `401` without a cookie (neither hostname reaches `ta-terminal` without a valid, Caddy-verified session) — confirms Review Focus #1's fix holds against the real deployed path, not just Task 7's local Docker integration test.

- [ ] **Step 6: Record the go/no-go decision**

In `ai-trading/plans/STATUS.md`, change the bullet describing the Cloudflare Workers' offline checks and pending live staging spike:
```
...The Cloudflare Workers and Clerk-verified VPS gateway pass offline checks; live routing/auth and browser checks still require an operator-approved staging spike. See [subplans/01e-static-hub-gcs-design.md](subplans/01e-static-hub-gcs-design.md).
```
to one of:
- **PASS:** "...The Cloudflare Worker/GCS route and Clerk-verified Caddy gateway passed their end-to-end routing/auth spike (Steps 2-5 of [subplans/01h-static-hub-clerk-implementation.md](subplans/01h-static-hub-clerk-implementation.md) Task 10, <date>); Task 11's first public exposure of `trading.tobytran.dev` is cleared to proceed pending explicit owner approval."
- **FAIL (Safari):** "...The Clerk sign-in flow does not reliably persist across `clerk.tobytran.dev` and `trading*.tobytran.dev` in Safari (spike Task 10, Step 2, <date>). Per [subplans/01e-static-hub-gcs-design.md](subplans/01e-static-hub-gcs-design.md)'s fallback, the static export stays served directly from the VPS (`web`, Task 1's static-file server, already deployed by this task's own Step 1) indefinitely; Task 11 is not executed until this is resolved."
- **FAIL (Worker/Caddy):** same shape, naming Step 3, 4, or 5's specific failure.

If FAIL, stop here — do not proceed to Task 11. `web` (deployed by this task's own Step 1) keeps serving the hub correctly either way; nothing about the family's actual day-to-day use depends on Task 11 ever running.

- [ ] **Step 7: Report completion (no git operations)**

This task is done once every "Expected" check above has passed. Do not run `git add`, `git commit`, or `git push` here — a parallel subagent working on a different task may be touching the index at the same time, and staging is the controlling session's call, done only if it explicitly asks. Report which files this task created or modified, and that its tests pass:
  - `ai-trading/plans/STATUS.md`

---

### Task 11: First public exposure of `trading.tobytran.dev` via the Worker (operator-gated; only if Task 10 passed)

**Do not start this task without Task 10 recorded as PASS and the user's explicit go-ahead for this specific step**, in addition to the standing Terraform-apply approval rule in `AGENTS.md`. This task is written in full so it is ready the moment both conditions are met — it does not execute itself. There is no live system being "cut over" here: before this task runs, `trading.tobytran.dev` is already real traffic (Task 10 deployed it, directly to `web`), and this task's only change is to make the Worker/GCS/Caddy path — already proven on `trading-static.tobytran.dev` — serve that same real hostname instead.

**Files:**
- Modify: `infrastructure/cloudflare/ai-trading/main.tf`
- Modify: `infrastructure/cloudflare/ai-trading/hub-static-variables.tf` (default value only)
- Modify: `infrastructure/cloudflare/ai-trading/README.md`

**Interfaces:**
- Consumes: Task 10's PASS result.
- Produces: `trading.tobytran.dev` served by the Worker/GCS path instead of directly by `web`. `web` itself, `ai-trading/frontend/Dockerfile`, and `static-server.mjs` are left in place (not deleted by this task) — they remain the documented 01e fallback, and Step 5's rollback below depends on them still being reachable.

- [ ] **Step 1: Point the real hostname at the Worker**

In `hub-static-variables.tf`, change `hub_static_hostname`'s default from `"trading-static.tobytran.dev"` to `"trading.tobytran.dev"` (same variable Task 3 already defined; this single-line change moves the Worker route and the staging DNS record onto the production hostname — delete the now-unused `trading-static.tobytran.dev` DNS record in the same change by removing the separate `cloudflare_dns_record.hub_static_staging` resource's distinct name, or keep both hostnames live side-by-side if the operator prefers a longer soak; either is valid, record which was chosen in the commit/PR description).

- [ ] **Step 2: Stop routing `hub_hostname`'s dynamic paths straight to `web`/`ta-terminal`/`ahf-terminal`**

In `main.tf`'s `cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading` resource, remove the three `hub_hostname`-scoped ingress entries (the `/u/tradingagents` rule, the `/u/ai-hedge-fund` rule, and the catch-all `{ hostname = var.hub_hostname, service = "http://web:3000" }`) — the Worker now owns all of `hub_hostname`'s routing, forwarding dynamic paths to `trading-origin.tobytran.dev` (Task 3/6's rules, already in place and already proven against the staging hostname in Task 10).

In `cloudflare_zero_trust_access_application.ai_trading`'s `destinations`, remove the `{ type = "public", uri = var.hub_hostname }` entry, leaving only `vibe_trading_hostname` (unchanged, out of scope for this plan — Vibe-Trading keeps its own Cloudflare Access policy exactly as it is today). This edit is correct whether or not Access has ever been enabled for this account: it stops the code from naming `hub_hostname` as an Access destination either way, and has no live effect if Access was never turned on.

- [ ] **Step 3: `fmt`, `validate`, and a plan review before any apply**

Run `fmt -check` and `validate` as in every prior Terraform task. Then run `terraform plan` (not apply) and have the operator read the full plan output before approving `apply` — this removes production ingress rules that `trading.tobytran.dev` has been actually serving since Task 10, which is exactly the kind of change `AGENTS.md`'s "never run apply without separate, explicit approval" rule exists for.

- [ ] **Step 4: Update the README**

In `infrastructure/cloudflare/ai-trading/README.md`'s routing table, change:
```
| `trading.tobytran.dev` | `^/u/tradingagents(/.*)?$` to `ta-terminal:7681`; `^/u/ai-hedge-fund(/.*)?$` to `ahf-terminal:7681`; everything else to `web:3000` |
```
to:
```
| `trading.tobytran.dev` | Worker-served static GCS hub; `/u/*`, `/__auth/*`, `/__control/*` forwarded to `trading-origin.tobytran.dev` (Caddy gateway, `forward_auth`-protected) |
```

- [ ] **Step 5: Post-apply health and rollback check**

Per 01e's own deployment-order requirement: after `apply`, run Task 10's Steps 2-5 again against `trading.tobytran.dev` itself (not the staging hostname). If any check now fails against the real hostname where it passed on staging, revert this task's Terraform change immediately (`terraform apply` the prior state) — `web` was never stopped or undeployed by this task, so a reverted apply restores exactly the serving path that was already live and working since Task 10, with no backend state change either way.

- [ ] **Step 6: Report completion (no git operations)**

This task is done once every "Expected" check above has passed. Do not run `git add`, `git commit`, or `git push` here — a parallel subagent working on a different task may be touching the index at the same time, and staging is the controlling session's call, done only if it explicitly asks. Report which files this task created or modified, and that its tests pass:
  - `infrastructure/cloudflare/ai-trading/main.tf`
  - `infrastructure/cloudflare/ai-trading/hub-static-variables.tf`
  - `infrastructure/cloudflare/ai-trading/README.md`

---

## Self-Review

**Spec coverage:** static export, no middleware/API routes/ISR (Task 1) · public-read GCS bucket, reused deploy identity (Task 2) · Worker routing with the documented HTML-fallback rule and tested pure resolver, staging hostname, unrouted gateway-origin hostname (Task 3) · signed cookie, email/Origin allowlists (Task 4) · Clerk verification with the Dashboard custom-claim precondition stated explicitly (Task 5) · the `auth` service's two routes, zero proxy code (Task 6) · the Caddyfile doing every bit of reverse-proxying and header rewriting declaratively, a real-Caddy integration test exercising 401/403/expired-cookie/spoofed-header/WebSocket-handshake, compose/bake/smoke/health-check wiring, `gateway:8080` interface published for 01i (Task 7) · client-side Clerk login gating every route, periodic cookie refresh under the session cookie's 1-hour cap (Task 8) · Firestore `family-config` profiles, VPS-side rendering at deploy time (with the `gateway`-profile-to-`auth.env` rename made explicit), GitHub-variable-refreshed build key, upload script with per-path cache headers (Task 9) · Safari + WebSocket + multipart preflight spike with a recorded go/no-go, doubling as the hub's actual first production deployment (Task 10) · operator-gated first public exposure with a documented rollback (Task 11). The one 01e requirement explicitly **not** implemented here, per explicit instruction, is `/__control/*`'s actual handler (01g, a separate, not-yet-reviewed spec) — the Worker forwards that prefix generically (Task 3) and the Caddyfile's catch-all 404s it (Task 7) so it is reachable the moment 01g's own plan adds a Caddy block behind it, without this plan guessing at that design. Also explicitly out of scope: removing `infrastructure/gcp/ai-trading/main.tf`'s existing `google_secret_manager_secret.env_bundle` resource/bindings (the handoff's own item 2, not this plan's — and that secret is confirmed to actually exist, with one enabled version, so this plan is doubly careful never to touch it), and migrating the three pre-existing upstream apps' secrets off the old bundle tool (also the handoff's scope — this plan only adds the two new `ai-trading/gateway`/`ai-trading/clerk` profiles).

**Placeholder scan:** no "TBD"/"later"/"handle edge cases" strings, and no scaffolded or no-op test bodies, appear in any task — every test shown is valid and complete at the point it appears in its own task. The one genuinely open question (exact `cloudflare_workers_script`/`cloudflare_workers_route` attribute names) is not guessed past — both Task 3 and 01i's Task 7 independently instruct confirming it via `terraform providers schema -json` before finalizing, which is the correct way to handle a real, shared, provider-version-dependent uncertainty rather than asserting false confidence. Task 9's dependency on `common/config/family_config.py` (not yet on `dev`) is named explicitly rather than worked around by re-inventing the old bundle tool's interface. Task 1's secret-scan negative test uses a byte-for-byte copy of the real, already-passing build before injecting its sentinel — not a minimal hand-built fixture — specifically so it is the secret-scan message, not a missing-file message, that the test actually asserts.

**Type consistency:** the Caddy gateway service name (`gateway`) and port (`8080`) are identical across Tasks 3, 7, and the "Coordination with sibling plans" section 01i's own Task 7 Step 5 reads; the `auth` service name/port (`auth`, `8181`) are identical across Tasks 6, 7, and 9. The cookie name (`__ai_trading_session`), its `Domain=tobytran.dev`/`Secure`/`HttpOnly`/`SameSite=Lax`/3600s shape, and the identity header name (`Cf-Access-Authenticated-User-Email`, matching Caddy's own `request_header`/`copy_headers` casing conventions) are identical across Tasks 4, 6, 7, 8, and 10. The bucket name (`tobytran-ai-trading-hub`) is identical across Tasks 2, 3, and 9's upload script usage. The Firestore profile name `ai-trading/gateway` and its rendered-then-renamed file `auth.env` are stated identically in the Global Constraints, Task 9's Interfaces, and Task 9 Step 2's code.

**Review Focus:** each of the five items (header forgery, CSRF on `/__auth/session`, stale-session-on-a-WebSocket, Worker 404 fallback, Safari ITP) names the exact task and test that owns it — Task 7's real-Caddy integration test for #1 and #3, Task 6's unit test for #2 and #3, Task 3's unit test for #4, Task 10's spike for #5 — not merely listed and forgotten.

## Execution Handoff

Plan complete and saved to `ai-trading/plans/subplans/01h-static-hub-clerk-implementation.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — a fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — implement every task in this session, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

For this plan I recommend **subagent-driven**, because Task 7 (the Caddyfile's `forward_auth`/header-strip/`copy_headers` chain) is the single highest-consequence piece of this entire plan — since this is the hub's first production deployment, a mistake there ships an impersonation hole from day one, with no prior Cloudflare Access gate to fall back on — and it benefits from an independent reviewer's fresh eyes, and from the real-Caddy integration test in that same task actually passing against a reviewer-approved Caddyfile, more than the plan as a whole benefits from finishing fastest. Does the plan capture what you want, and which approach should we use?
