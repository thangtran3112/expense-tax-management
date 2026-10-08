# MiroFish Upstream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MiroFish as the Trading Hub's fourth unmodified upstream app: a pinned git submodule, a backend-only VPS image, a statically built original Vue UI for a dedicated GCS bucket, a hub registry card with honest pre-activation copy, and the narrow, explicit interface points this work shares with the parallel static-hub/GCS/Worker/Clerk-gateway implementation ("Plan A", implementing [01e](01e-static-hub-gcs-design.md)).

**Architecture:** Submodule `packages/mirofish` stays byte-for-byte upstream. An external Dockerfile builds `backend/` alone with `uv` into a single-Flask-process VPS image; a second external Dockerfile builds the unmodified `frontend/` with `npm ci && npm run build` and exports static files via a Bake local-output target, for upload to a dedicated `mirofish.tobytran.dev` GCS bucket. A dedicated Cloudflare Worker route and DNS records serve that bucket and forward `/api/*` to the VPS over an unrouted `mirofish-origin.tobytran.dev` hostname on the existing ai-trading tunnel, through Plan A's authenticated `gateway:8080` service. On the VPS, `family_config.py render ai-trading/mirofish --out-dir <root-only runtime directory>` creates the ephemeral `mirofish.env` that Compose reads. No environment file lives in this repository, no Secret Manager bundle is used, and the disabled Compose profile leaves MiroFish stopped until its Firestore profile exists. The hub registry gains a "Simulation lab" category and a pre-activation MiroFish card with no launch link until a separate, later activation review passes.

**Tech Stack:** Docker Buildx Bake, `uv` 0.9.26, Python 3.11 (slim-trixie, pinned digest already used by `ai-hedge-fund`), Node 24, Vite/Vue (unmodified upstream build), Terraform (`hashicorp/google` and `cloudflare/cloudflare` 5.26.0), Next.js 16.3.8 static registry (`frontend/lib/apps.ts`), bash (Bake/CI/smoke scripts).

**Spec:** [01d-mirofish-hub-design.md](01d-mirofish-hub-design.md) (primary) and [01e-static-hub-gcs-design.md](01e-static-hub-gcs-design.md) (routing/auth it depends on). Executors read both specs plus [AGENTS.md](../../AGENTS.md) and [01f-upstream-sync-skills-design.md](01f-upstream-sync-skills-design.md) (divergence policy for the submodule this plan adds).

**Firestore naming:** `ai-trading/mirofish` is the `family_config.py` CLI target for Firestore document `apps/ai-trading/profiles/mirofish`. Use the short CLI target in every command. The literal Firestore document path is explanatory only, never a CLI argument.

## Global Constraints

- Submodule URL `https://github.com/666ghj/MiroFish`, pinned to `7657031ac01184afe2cb220f5ee3545573b5e843` (verified against the untracked reference clone's `git rev-parse HEAD`; this exact SHA is what every task below cites).
- No MiroFish Vue or Flask source file is edited or vendored. Every build step copies the unmodified submodule tree as a named Bake build context; no `patch`, no `sed`, no committed diff inside `packages/mirofish`.
- `VITE_API_BASE_URL=https://mirofish.tobytran.dev` is a build-time argument only; the build must fail loudly if it is empty or if `localhost:5001` survives into the built assets (Review Focus #2).
- One Flask process only (upstream task polling uses in-memory state); no multi-worker/gunicorn wrapping.
- No Node/Vite/npm in the VPS backend image; the backend-only Dockerfile context is `packages/mirofish/backend` alone.
- `backend/uploads/` (Flask's `Config.UPLOAD_FOLDER`, resolved to `/app/uploads` in the built image) is a dedicated named volume, never baked into the image, never shared with another app's volume.
- AGPL-3.0: the hub card links the exact pinned source revision (`.../tree/7657031ac01184afe2cb220f5ee3545573b5e843`) and its `LICENSE` file at that same revision, not a branch or "latest" link.
- Zep Cloud free tier only (10,000 credits/month, no rollover); no auto-top-up; no paid Flex plan; the user's existing OpenAI key is the `LLM_API_KEY` (no Anthropic gateway is introduced).
- Credentials (`ZEP_API_KEY`, `LLM_API_KEY`, optionally `LLM_BASE_URL`/`LLM_MODEL_NAME`) live only in Firestore runtime profile `ai-trading/mirofish`. The VPS reader key renders that profile with `common/config/family_config.py`; this plan never reads, adds to, or deletes a Secret Manager bundle, and never creates a real `.env` file inside the repository.
- The Firestore handoff must merge before any live MiroFish activation. Until then, CI uses dummy keys only and the MiroFish Compose profile stays disabled; no task writes a Firestore profile automatically.
- CI may build images and probe `/health` with dummy, non-secret key strings. CI never calls Zep or an LLM provider, never runs a paid or real simulation.
- No GCP compute for the app itself (GCS + Cloudflare only); no new Secret Manager bundle; no change to `infrastructure/cloudflare/zero-trust/`.
- `family-app` is public: no real hostnames beyond the already-public `tobytran.dev` subdomains named in the approved specs, no account identifiers, no secret values, anywhere in committed files.
- **Plan A boundary:** `infrastructure/cloudflare/ai-trading/main.tf`, `infrastructure/gcp/ai-trading/main.tf`'s existing resources, the hub's `frontend/next.config.ts` static-export change, and the Clerk-gateway service itself belong to Plan A's in-flight 01e implementation. This plan creates sibling files for everything MiroFish-specific (own Terraform files, own compose file, own Dockerfiles) and touches a shared file only at the single-line, explicitly flagged points in Tasks 5 and 7 — never a structural rewrite of a file Plan A owns.

## Review Focus

- **Startup key validation vs. a real health pass:** MiroFish's `Config.validate()` exits the process non-zero before Flask ever binds a port if `LLM_API_KEY` or `ZEP_API_KEY` is empty. A CI probe that passes only because the container never started would silently stop catching real regressions. Task 2's smoke step asserts the container is both running and health-checked, with dummy non-empty keys, not just "exit code 0 somewhere."
- **Build-time `VITE_API_BASE_URL` falsy fallback:** the upstream client does `import.meta.env.VITE_API_BASE_URL || 'http://localhost:5001'`. An empty-string build arg is falsy in JavaScript, so a silently-empty CI variable would still bake in `localhost:5001` and no build error would otherwise surface it. Task 3 fails the build if the arg is empty or if `localhost:5001` appears anywhere in `dist/`.
- **Direct origin hostname must not bypass the gateway:** `mirofish-origin.tobytran.dev` is reachable over the same tunnel as the public hostname; per 01e it must hit Caddy `gateway:8080`, which uses `forward_auth` to `auth:8181`, never Flask directly. Task 8's pre-apply and staged checks assert this.
- **AGPL link pinned to the deployed commit, not a moving branch:** the hub card's source/license links must name `7657031ac01184afe2cb220f5ee3545573b5e843` literally; a future Dependabot submodule bump must not silently leave the displayed link pointing at a commit the running image no longer matches. Task 4's check asserts the link strings contain the exact pinned SHA used in Task 1 and Task 2/3's build.
- **Zep/LLM credential absence must disable, not crash, the other three apps:** since `mirofish.env` does not exist until the Firestore profile is ready, the production compose file and `deploy.sh` must tolerate it being absent without failing the deploy of TradingAgents, ai-hedge-fund, or Vibe-Trading. Tasks 5 and 9 test this explicitly (Compose config validation with the file missing; VPS-side render only during activation).

---

## File Structure

New files this plan owns outright (no collision with Plan A):

| File | Responsibility |
|---|---|
| `ai-trading/deploy/upstream/mirofish/Dockerfile` | External, backend-only image build (uv, Python, single Flask process) |
| `ai-trading/deploy/upstream/mirofish-frontend/Dockerfile` | External, Node-only static build + scratch export of the unmodified Vue app |
| `ai-trading/deploy/production/docker-compose.mirofish.yml` | MiroFish's compose service, network, and volume (loaded as a sibling `-f` file) |
| `ai-trading/deploy/ci/mirofish-health-check.sh` | Small helper the smoke test and CI job both call to probe `/health` with dummy keys |
| `infrastructure/gcp/ai-trading/mirofish-bucket.tf` | Dedicated static bucket + CI upload identity for the MiroFish Vue build |
| `infrastructure/cloudflare/ai-trading/mirofish.tf` | Dedicated Worker script/route and DNS records for `mirofish.tobytran.dev` / `mirofish-origin.tobytran.dev` |
| `infrastructure/cloudflare/ai-trading/mirofish-variables.tf` | Variables scoped to the file above (keeps `variables.tf` itself, which Plan A also extends, untouched) |
| `infrastructure/cloudflare/ai-trading/workers/mirofish-static.js` | Worker source: Clerk-gated custom-host HTML, GCS static fetches, and `/api/*` origin forwarding |
| `ai-trading/deploy/ci/upload-mirofish-static.sh` | CI-only authenticated GCS upload, object metadata, verification, and generation rollback |

Existing files this plan edits, and exactly how narrowly:

| File | Edit | Owner conflict risk |
|---|---|---|
| `.gitmodules` | Append one `[submodule "ai-trading/packages/mirofish"]` block | None (pure addition) |
| `ai-trading/AGENTS.md` | Task 1 only changes the protected-upstream list from three paths to four. Plan A updates Secrets and Cloudflare token rules after the handoff merges. | Coordinated — separate sections, no duplicate edit |
| `ai-trading/plans/STATUS.md` | Flip the MiroFish Upstream Pins row from "proposed submodule" wording to deployed; no other row touched | None |
| `ai-trading/frontend/lib/apps.ts` | Add `AppIconKey` member, `hubCategories` entry, `UpstreamSetupApp` type, and one `hubApps` entry | None (Plan A's static-export work does not touch this registry file) |
| `ai-trading/frontend/components/app-card.tsx` | Add one `app.kind === "upstream-setup"` branch to the footer hint | None |
| `ai-trading/frontend/components/status-badge.tsx` | Add one `app.status === "setup-required"` branch | None |
| `ai-trading/frontend/app/apps/[slug]/page.tsx` | Add one `app.kind === "upstream-setup"` render branch before the generic external/terminal branches | None |
| `ai-trading/deploy/docker-bake.hcl` | Append `mirofish-backend` and `mirofish-frontend` targets and add them to `group "default"` | Low — additive to a list Plan A may also append to; last-to-land rebases trivially |
| `ai-trading/deploy/docker-bake.ci.hcl` | Append matching GHA cache blocks for the two new targets | Low, same reasoning |
| `ai-trading/deploy/production/deploy.sh` | Add the sibling Compose file; Task 9 adds explicit VPS-side Firestore rendering only for MiroFish activation | Low — narrow, flagged lines (Tasks 5 and 9) |
| `ai-trading/deploy/production/health-check.sh` | Append `mirofish` to `SERVICES` and the same `-f` flag | Low — two narrow, flagged lines (Task 5) |
| `ai-trading/deploy/production/docker-compose.yml` | After Plan A, add `mirofish` to Caddy gateway networks only | Shared Plan A file — one additive network entry |
| `ai-trading/deploy/production/Caddyfile` | After Plan A, add MiroFish's Caddy `forward_auth auth:8181` and `reverse_proxy mirofish:5001` stanza | Shared Plan A file — one additive hostname stanza |
| `ai-trading/deploy/ci/smoke-test.sh` | Append a `smoke_mirofish` function and its dispatch case | None (purely additive function + case arm) |
| `ai-trading/deploy/local/docker-compose.override.yml` | Add MiroFish to the local `router`'s `depends_on` and a route in the Caddyfile | None |
| `ai-trading/deploy/local/Caddyfile` | Add one `handle /api*` block pointing at the local mirofish container | None |
| `.github/workflows/ai-trading-ci.yml` | Add one new, independent `mirofish` job | None (new job, no edits to existing jobs) |
| `.github/workflows/ai-trading-deploy.yml` | Add reviewed MiroFish static-upload staging/activation job using Workload Identity | Shared deploy workflow — additive gated job |
| `infrastructure/cloudflare/ai-trading/main.tf` | **Coordination point (Task 8, Step 6):** append exactly one `mirofish-origin` ingress before the catch-all | **Shared resource** — see Task 8's Caddy-gated coordination note |

---

### Task 0: Confirm handoff and Plan A ownership before live work

**Files:** none in this plan.

**Dependencies:** The family-config handoff must merge before live activation. Plan A owns the `ai-trading/AGENTS.md` **Secrets and Environment Values** and **Cloudflare API Token** sections, including replacement of old Secret Manager guidance with `common/config/family_config.py` and `shared/cloudflare` values. This plan owns only Task 1's protected-upstream-list addition in that file.

- [ ] **Step 1: Verify the handoff landed without reading values**

Run: `common/config/family_config.py ls` and `common/config/family_config.py keys ai-trading/deploy`.

Expected: CLI is present and names-only reads succeed. Do not create `ai-trading/mirofish`, print values, or activate MiroFish before the owner provisions that profile.

- [ ] **Step 2: Verify Plan A's Caddy gateway contract**

Confirm Plan A has deployed Caddy at `gateway:8080`, using `forward_auth` to `auth:8181`, and has updated the two AGENTS.md sections above. Caddy, not a Node proxy, must authenticate every direct-origin request before this plan applies MiroFish DNS or Worker resources.

- [ ] **Step 3: Verify and report**

Report handoff and Plan A dependency state by names and revisions only. Do not stage, commit, push, write Firestore, or apply infrastructure.

---

### Task 1: Pin the MiroFish submodule as the fourth protected upstream

**Files:**
- Modify: `.gitmodules`
- Modify: `ai-trading/AGENTS.md:42` (the "Never edit ... submodules" line and its upstream list)
- Modify: `ai-trading/plans/STATUS.md` (Upstream Pins table, MiroFish row only)
- Create: nothing (the submodule itself is added by `git submodule add`, not hand-written)

**Interfaces:**
- Produces: `ai-trading/packages/mirofish/{backend,frontend}` as a clean submodule checkout at `7657031ac01184afe2cb220f5ee3545573b5e843`, consumed by Tasks 2 and 3's Bake contexts.

- [ ] **Step 1: Add the submodule pinned to the verified commit**

`git submodule add` updates the index. Run it only during a user-directed integration operation; no parallel task stages this gitlink.

```bash
git submodule add https://github.com/666ghj/MiroFish.git ai-trading/packages/mirofish
git -C ai-trading/packages/mirofish checkout 7657031ac01184afe2cb220f5ee3545573b5e843
```

- [ ] **Step 2: Verify the pinned commit matches the reference clone exactly**

Run: `git -C ai-trading/packages/mirofish rev-parse HEAD`
Expected: `7657031ac01184afe2cb220f5ee3545573b5e843` (must match `ai-trading/temp/mirofish-reference`'s `HEAD` byte for byte; the reference clone is gitignored scratch and is never itself committed or referenced from compose/Bake).

- [ ] **Step 3: Update `.gitmodules`**

```ini
[submodule "ai-trading/packages/mirofish"]
	path = ai-trading/packages/mirofish
	url = https://github.com/666ghj/MiroFish.git
```

(Appended after the existing `vibe-trading` block; `git submodule add` in Step 1 writes this automatically — this step is the diff review, not a hand-edit.)

- [ ] **Step 4: Update `AGENTS.md`'s upstream list**

Change:

```markdown
- Never edit `packages/trading-agents`, `packages/ai-hedge-fund`, or `packages/vibe-trading` (git submodules). Wrapper Dockerfiles live in `deploy/upstream/`.
```

to:

```markdown
- Never edit `packages/trading-agents`, `packages/ai-hedge-fund`, `packages/vibe-trading`, or `packages/mirofish` (git submodules). Wrapper Dockerfiles live in `deploy/upstream/`.
```

- [ ] **Step 5: Update `STATUS.md`'s Upstream Pins row**

Change the MiroFish row from:

```markdown
| MiroFish | `packages/mirofish` (proposed submodule) | `7657031ac011` | AGPL-3.0 | Unmodified Vue client built into GCS, unmodified Flask engine on VPS; financial prediction is not shipped and activation needs Zep Cloud + OpenAI-compatible LLM key |
```

to:

```markdown
| MiroFish | `packages/mirofish` | `7657031ac01184afe2cb220f5ee3545573b5e843` | AGPL-3.0 | Unmodified Vue client built into GCS, unmodified Flask engine on VPS; financial prediction is not shipped and activation needs Zep Cloud + OpenAI-compatible LLM key |
```

- [ ] **Step 6: Verify the submodule is clean and the diff is additive-only**

Run: `git status --porcelain ai-trading/packages/mirofish && git diff --stat -- .gitmodules ai-trading/AGENTS.md ai-trading/plans/STATUS.md`
Expected: the submodule reports clean (no output from the first command); the diff stat shows only the three files above, each with small `+`/`-` counts, no other path touched.

- [ ] **Step 7: Verify and report**

Report the pinned SHA, changed paths, and `git status --short`. Do not stage, commit, or push; the user decides if and when to do so.

---

### Task 2: Backend-only VPS image (external Dockerfile, uv, single Flask process)

**Files:**
- Create: `ai-trading/deploy/upstream/mirofish/Dockerfile`
- Modify: `ai-trading/deploy/docker-bake.hcl` (append `mirofish-backend` target, add to `group "default"`)
- Modify: `ai-trading/deploy/docker-bake.ci.hcl` (append matching cache block)
- Modify: `ai-trading/deploy/ci/smoke-test.sh` (append `smoke_mirofish_backend` — folded into Task 10's combined `smoke_mirofish`, written here first as the backend half)

**Interfaces:**
- Consumes: `ai-trading/packages/mirofish/backend` (Task 1's pinned submodule subtree) as the named Bake context `upstream`.
- Produces: image tag `${REGISTRY}/ai-trading-mirofish-backend:${TAG}`, exposing port `5001`, with `/health` unauthenticated, `/app/uploads` as the mount point for the named volume Task 5 defines, and `FLASK_HOST`/`FLASK_PORT` as its only baked-in environment (every credential comes from the service's `env_file` at deploy time).

- [ ] **Step 1: Write the external Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1.7
# MiroFish backend-only image. "upstream" is the unmodified package source
# (ai-trading/packages/mirofish/backend), copied in as-is and built with uv
# from its pinned lock. No Node/Vite/npm: the Vue frontend ships separately
# as static assets for the dedicated GCS bucket (see mirofish-frontend).
ARG PYTHON_IMAGE=python:3.11-slim-trixie@sha256:6f31d6e9ba2b0a787a3f81c37b004155b87b9efa1b771182bd550c1615745be5

FROM ${PYTHON_IMAGE} AS build
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /src
# Installs exactly what the upstream lock pins; a stale lock fails the build loudly.
COPY --from=upstream pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY --from=upstream . .
RUN uv sync --frozen --no-dev

FROM ${PYTHON_IMAGE}
COPY --from=build /src /app
RUN useradd --create-home --shell /usr/sbin/nologin mirofish \
 && mkdir -p /app/uploads/simulations \
 && chown -R mirofish:mirofish /app/uploads
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    FLASK_HOST=0.0.0.0 \
    FLASK_PORT=5001
USER mirofish
WORKDIR /app
EXPOSE 5001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/health', timeout=4)"
ENTRYPOINT ["python", "run.py"]
```

- [ ] **Step 2: Add the Bake target**

Append to `ai-trading/deploy/docker-bake.hcl`, inside `group "default" { targets = [...] }` add `"mirofish-backend"`, and after the `vibe-trading` target add:

```hcl
target "mirofish-backend" {
  context = "ai-trading/deploy/upstream/mirofish"
  contexts = {
    upstream = "ai-trading/packages/mirofish/backend"
  }
  tags = ["${REGISTRY}/ai-trading-mirofish-backend:${TAG}"]
}
```

- [ ] **Step 3: Add the matching CI cache block**

Append to `ai-trading/deploy/docker-bake.ci.hcl`:

```hcl
target "mirofish-backend" {
  cache-from = ["type=gha,scope=ai-trading-mirofish-backend"]
  cache-to   = ["type=gha,scope=ai-trading-mirofish-backend,mode=max"]
}
```

- [ ] **Step 4: Build it**

Run (from the repository root): `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load mirofish-backend`
Expected: image `ghcr.io/thangtran3112/family-app/ai-trading-mirofish-backend:local` builds with no edits inside `/src` reported by `uv sync` (lock is respected, not regenerated).

- [ ] **Step 5: Probe `/health` with dummy, non-secret keys (no real Zep/LLM call)**

```bash
docker run -d --name smoke-mirofish-backend -p 127.0.0.1:15001:5001 \
  -e LLM_API_KEY=sk-smoke-dummy -e ZEP_API_KEY=z_smoke-dummy \
  ghcr.io/thangtran3112/family-app/ai-trading-mirofish-backend:local
sleep 3
curl -fsS http://127.0.0.1:15001/health
docker rm -f smoke-mirofish-backend
```

Expected: the container's state is `running` (not `exited`) and `curl` returns `{"status": "ok", "service": "MiroFish Backend"}`. If the container exited immediately, `Config.validate()` rejected one of the dummy keys as empty — re-check the `-e` flags, not the Dockerfile; this never signals "the simulation engine works" (Review Focus #1).

- [ ] **Step 6: Verify and report**

Report the image build and dummy-key health result with changed paths. Do not stage, commit, or push.

---

### Task 3: Static Vue build for the dedicated GCS bucket

**Files:**
- Create: `ai-trading/deploy/upstream/mirofish-frontend/Dockerfile`
- Modify: `ai-trading/deploy/docker-bake.hcl` (append `mirofish-frontend` target)
- Modify: `ai-trading/deploy/docker-bake.ci.hcl` (append matching cache block)
- Modify: `ai-trading/.gitignore` (ignore the local Bake output directory)

**Interfaces:**
- Consumes: `ai-trading/packages/mirofish/frontend` (Task 1's pinned submodule subtree) as the named Bake context `upstream`.
- Produces: `ai-trading/frontend-artifacts/mirofish/` on the local filesystem (an `index.html` plus hashed assets), the exact directory Task 6's CI upload step reads from. No image tag is pushed for this target; it only emits files via `output = ["type=local,...]`.

- [ ] **Step 1: Write the external Dockerfile**

```dockerfile
# syntax=docker/dockerfile:1.7
# MiroFish's unmodified Vue frontend, built into static assets for the
# dedicated mirofish GCS bucket. "upstream" is the unmodified package source
# (ai-trading/packages/mirofish/frontend). No source or Vite config is
# edited; VITE_API_BASE_URL is Vite's own build-time env mechanism.
FROM node:24-slim AS build
ARG VITE_API_BASE_URL
WORKDIR /src
COPY --from=upstream package.json package-lock.json ./
RUN npm ci
COPY --from=upstream . .
RUN set -eu; \
    if [ -z "$VITE_API_BASE_URL" ]; then \
      echo "VITE_API_BASE_URL must be set and non-empty" >&2; exit 1; \
    fi; \
    VITE_API_BASE_URL="$VITE_API_BASE_URL" npm run build; \
    if grep -rqF "localhost:5001" dist; then \
      echo "built assets still reference localhost:5001; VITE_API_BASE_URL did not take effect" >&2; \
      exit 1; \
    fi

FROM scratch AS export
COPY --from=build /src/dist /
```

- [ ] **Step 2: Add the Bake target**

Append to `ai-trading/deploy/docker-bake.hcl` (not added to `group "default"` — it emits files, not an image, so CI invokes it by name, not via the default group):

```hcl
variable "MIROFISH_API_BASE_URL" {
  default = "https://mirofish.tobytran.dev"
}

target "mirofish-frontend" {
  context = "ai-trading/deploy/upstream/mirofish-frontend"
  contexts = {
    upstream = "ai-trading/packages/mirofish/frontend"
  }
  args = {
    VITE_API_BASE_URL = MIROFISH_API_BASE_URL
  }
  target = "export"
  output = ["type=local,dest=ai-trading/frontend-artifacts/mirofish"]
}
```

- [ ] **Step 3: Add the matching CI cache block**

Append to `ai-trading/deploy/docker-bake.ci.hcl`:

```hcl
target "mirofish-frontend" {
  cache-from = ["type=gha,scope=ai-trading-mirofish-frontend"]
  cache-to   = ["type=gha,scope=ai-trading-mirofish-frontend,mode=max"]
}
```

- [ ] **Step 4: Ignore the local output directory**

Append to `ai-trading/.gitignore`:

```
frontend-artifacts/
```

- [ ] **Step 5: Confirm the builder supports local output, then build**

Run: `docker buildx inspect --bootstrap | grep -i driver`
Expected: `docker-container` (or any driver other than plain `docker`, which cannot emit `type=local`). If it prints `docker`, run `docker buildx create --name ai-trading --driver docker-container --use` once before continuing.

Run (from the repository root): `docker buildx bake -f ai-trading/deploy/docker-bake.hcl mirofish-frontend`
Expected: `ai-trading/frontend-artifacts/mirofish/index.html` and an `assets/` directory exist; the build fails loudly (not silently) if `VITE_API_BASE_URL` was empty or `localhost:5001` leaked through (Review Focus #2).

- [ ] **Step 6: Verify no localhost reference and no secrets in the built assets**

```bash
grep -rl "localhost:5001" ai-trading/frontend-artifacts/mirofish && echo FAIL || echo ok
grep -rliE "sk-|zep_|api[_-]?key" ai-trading/frontend-artifacts/mirofish && echo FAIL || echo ok
```

Expected: both print `ok` (no match). A static Vue build has no business containing a key string; if the second check matches, stop and inspect the build before any upload step ever runs.

- [ ] **Step 7: Verify and report**

Report static-build checks and changed paths. Do not stage, commit, or push.

---

### Task 4: Hub registry card — "Simulation lab", pre-activation copy

**Files:**
- Modify: `ai-trading/frontend/lib/apps.ts`
- Modify: `ai-trading/frontend/components/app-card.tsx`
- Modify: `ai-trading/frontend/components/status-badge.tsx`
- Modify: `ai-trading/frontend/app/apps/[slug]/page.tsx`

**Interfaces:**
- Produces: `HubApp` union gains a fourth member `UpstreamSetupApp` (`kind: "upstream-setup"`, `status: "setup-required"`), consumed by the three component files in this same task. No other task reads these types.

- [ ] **Step 1: Extend `lib/apps.ts`'s types and registry**

```ts
// hubCategories: add after "funds"
{ id: "simulation", label: "Simulation lab" },

// AppIconKey: add "mirofish"
export type AppIconKey = "tradingAgents" | "hedgeFund" | "vibeTrading" | "familyDesk" | "mirofish";

// appIcons: add
import { Fish } from "lucide-react"; // alongside the existing Bot, LineChart, MessagesSquare, Rocket import
// ...
mirofish: Fish,

// New app kind, alongside PlannedApp/TerminalApp/ExternalApp
export type UpstreamSetupApp = BaseApp & {
  kind: "upstream-setup";
  status: "setup-required";
  sourceUrl: string;
  licenseUrl: string;
  pinnedCommit: string;
  requiredKeys: readonly string[];
};
export type HubApp = PlannedApp | TerminalApp | ExternalApp | UpstreamSetupApp;
```

Append to `hubApps` (after `vibe-trading`, before `desk`):

```ts
{
  slug: "mirofish",
  kind: "upstream-setup",
  status: "setup-required",
  name: "MiroFish",
  category: "simulation",
  tags: ["Multi-agent simulation", "Upload to report", "Experimental"],
  icon: "mirofish",
  device: "touch",
  summary:
    "Experimental simulation lab: upload source material and watch thousands of AI agents with independent memory interact in a digital sandbox, then read a report. Financial prediction is not shipped upstream yet.",
  goodFor: "Trying the original MiroFish simulator — not stock, futures, or broker analysis.",
  costNote: "Needs a Zep Cloud free-tier key and an OpenAI-compatible LLM key, both kept server-side.",
  sourceUrl: "https://github.com/666ghj/MiroFish/tree/7657031ac01184afe2cb220f5ee3545573b5e843",
  licenseUrl: "https://github.com/666ghj/MiroFish/blob/7657031ac01184afe2cb220f5ee3545573b5e843/LICENSE",
  pinnedCommit: "7657031ac01184afe2cb220f5ee3545573b5e843",
  requiredKeys: ["ZEP_API_KEY", "LLM_API_KEY"],
},
```

- [ ] **Step 2: Add the status badge branch**

In `status-badge.tsx`, before the final `return` (the "Live" fallback), insert:

```tsx
if (app.status === "setup-required") {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      Experimental · Setup required
    </span>
  );
}
```

- [ ] **Step 3: Add the card footer branch**

In `app-card.tsx`'s `CardBody`, after the `app.kind === "external"` block, add:

```tsx
{app.kind === "upstream-setup" && (
  <span className="inline-flex items-center gap-1">Setup required before launch</span>
)}
```

- [ ] **Step 4: Add the detail-page branch**

In `page.tsx`, before the `const Icon = appIcons[app.icon];` generic branch, insert a dedicated early return for the new kind (so it never falls into the `app.url`/`app.firstVisitNote` branch those other kinds own):

```tsx
if (app.kind === "upstream-setup") {
  const Icon = appIcons[app.icon];
  return (
    <PageShell breadcrumb={app.name}>
      <div className="mx-auto w-full max-w-[720px] px-4 py-12 md:px-6">
        <div className="rounded-xl border border-border bg-card p-6 text-center sm:p-8">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-muted">
            <Icon aria-hidden size={20} />
          </div>
          <h1 className="mt-4 text-2xl font-semibold text-foreground">{app.name}</h1>
          <div className="mt-2 flex justify-center">
            <StatusBadge app={app} />
          </div>
          <p className="mt-4 text-muted-foreground">{app.summary}</p>
          <dl className="mt-4 space-y-1 text-left text-sm text-muted-foreground">
            <div>
              <dt className="inline font-medium text-foreground">Good for: </dt>
              <dd className="inline">{app.goodFor}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-foreground">Cost: </dt>
              <dd className="inline">{app.costNote}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-foreground">Needs: </dt>
              <dd className="inline">{app.requiredKeys.join(", ")}</dd>
            </div>
          </dl>
          <p className="mt-6 text-left text-sm text-muted-foreground">
            Both of us share this experimental instance&apos;s projects. Activation (auth, keys, and a verified
            end-to-end run) is a separate, reviewed change — this page has no launch link yet.
          </p>
          <div className="mt-6 flex justify-center gap-4 text-sm">
            <a href={app.sourceUrl} target="_blank" rel="noopener" className="underline underline-offset-2">
              Pinned source
            </a>
            <a href={app.licenseUrl} target="_blank" rel="noopener" className="underline underline-offset-2">
              AGPL-3.0 license
            </a>
          </div>
        </div>
      </div>
    </PageShell>
  );
}
```

- [ ] **Step 5: Typecheck, lint, build**

Run (from `ai-trading/frontend`): `pnpm typecheck && pnpm lint && pnpm build`
Expected: all three pass. `pnpm typecheck` is the step that actually proves the new `UpstreamSetupApp` union member is handled everywhere `HubApp` is destructured — a missing branch in any of the three components fails here, not at runtime.

- [ ] **Step 6: Verify the pinned-commit link (Review Focus #4)**

Run: `grep -o '7657031ac01184afe2cb220f5ee3545573b5e843' ai-trading/frontend/lib/apps.ts | wc -l`
Expected: `3` (once in `sourceUrl`, once in `licenseUrl`, once in `pinnedCommit`) — all three must cite the exact SHA Task 1 pinned and Task 2/3 built from, not a shorter prefix or a branch name.

- [ ] **Step 7: Verify and report**

Report typecheck, lint, build, and pinned-link results with changed paths. Do not stage, commit, or push.

---

### Task 5: Production compose file (parallel-safe sibling) and local dev route

**Files:**
- Create: `ai-trading/deploy/production/docker-compose.mirofish.yml`
- Modify: `ai-trading/deploy/production/deploy.sh` (two narrow lines — coordination-flagged)
- Modify: `ai-trading/deploy/production/health-check.sh` (two narrow lines — coordination-flagged)
- Modify: `ai-trading/deploy/production/docker-compose.yml` (Plan A gateway network entry only, after Plan A lands)
- Modify: `ai-trading/deploy/production/Caddyfile` (Plan A Caddy stanza only, after Plan A lands)
- Modify: `ai-trading/deploy/local/docker-compose.override.yml`
- Modify: `ai-trading/deploy/local/Caddyfile`

**Interfaces:**
- Consumes: image `${AI_TRADING_REGISTRY}/ai-trading-mirofish-backend:${AI_TRADING_IMAGE_TAG}` (Task 2); ephemeral runtime file `${AI_TRADING_RUNTIME_ENV_DIR:-/run/family-app/ai-trading}/mirofish.env`, rendered only on the VPS by Task 9.
- Produces: Docker network `mirofish` (internal, no host ports), named volume `mirofish-uploads`, service name `mirofish` — the exact identifiers Task 8's gateway routing and Task 10's CI job reference.
- **Coordination point:** Plan A's authenticated gateway is `gateway:8080`. It joins the `mirofish` network and proxies `/api/*` to `mirofish:5001`; no tunnel ingress or public hostname targets Flask directly.

- [ ] **Step 1: Write the sibling compose file**

```yaml
# ai-trading production stack: MiroFish (release 1, fourth upstream app).
# Loaded as a sibling file alongside docker-compose.yml:
#   docker compose -f docker-compose.yml -f docker-compose.mirofish.yml ...
# Never merged into docker-compose.yml directly -- see Task 5's File Structure
# note in plans/subplans/01i-mirofish-upstream-implementation.md.
name: ai-trading

services:
  mirofish:
    image: ${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}/ai-trading-mirofish-backend:${AI_TRADING_IMAGE_TAG:?AI_TRADING_IMAGE_TAG is required}
    restart: unless-stopped
    # MiroFish is disabled until Task 9 renders this file on the VPS. Compose
    # v2.24+ accepts the optional long syntax, so missing keys cannot break
    # `docker compose config` or unrelated services.
    profiles: ["mirofish"]
    env_file:
      - path: ${AI_TRADING_RUNTIME_ENV_DIR:-/run/family-app/ai-trading}/mirofish.env
        required: false
    volumes:
      - mirofish-uploads:/app/uploads
    networks: [mirofish]
    mem_limit: 4g
    cpus: 2
    pids_limit: 512
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/health', timeout=4)"]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3

networks:
  # Joined only by Plan A's authenticated `gateway:8080` service. No host
  # port is published; gateway reaches this service as `mirofish:5001`.
  mirofish: {}

volumes:
  mirofish-uploads: {}
```

- [ ] **Step 2: Confirm Compose optional `env_file` support, then validate merged config**

Run: `docker compose version --short`.

Expected: Compose v2.24.0 or newer. This minimum is required for `env_file.path` with `required: false`; stop and report a lower version instead of claiming missing files are tolerated.

Run: `docker compose -f ai-trading/deploy/production/docker-compose.yml -f ai-trading/deploy/production/docker-compose.mirofish.yml config --quiet`

Expected: exits `0` with no output while `mirofish.env` is absent. This proves optional-file handling plus service/network/volume merge. It does not start the disabled `mirofish` profile.

- [ ] **Step 3: Append the two coordination-flagged lines to `deploy.sh`**

Change:

```bash
compose() {
  docker compose --project-name ai-trading --env-file "$IMAGES_ENV" -f "$APP_DIR/docker-compose.yml" "$@"
}
```

to:

```bash
compose() {
  local mirofish_compose=()
  [[ -f "$APP_DIR/docker-compose.mirofish.yml" ]] && mirofish_compose=(-f "$APP_DIR/docker-compose.mirofish.yml")
  docker compose --project-name ai-trading --env-file "$IMAGES_ENV" -f "$APP_DIR/docker-compose.yml" "${mirofish_compose[@]}" "$@"
}
```

- [ ] **Step 4: Append the matching lines to `health-check.sh`**

Change:

```bash
SERVICES=(web ta-terminal ahf-terminal vibe-trading cloudflared)
```

to:

```bash
SERVICES=(web ta-terminal ahf-terminal vibe-trading cloudflared)
[[ -f "${AI_TRADING_RUNTIME_ENV_DIR:-/run/family-app/ai-trading}/mirofish.env" ]] && SERVICES+=(mirofish)
```

Change:

```bash
compose() {
  docker compose --project-name ai-trading --env-file "$APP_DIR/images.env" -f "$APP_DIR/docker-compose.yml" "$@"
}
```

to:

```bash
compose() {
  local mirofish_compose=()
  [[ -f "$APP_DIR/docker-compose.mirofish.yml" ]] && mirofish_compose=(-f "$APP_DIR/docker-compose.mirofish.yml")
  docker compose --project-name ai-trading --env-file "$APP_DIR/images.env" -f "$APP_DIR/docker-compose.yml" "${mirofish_compose[@]}" "$@"
}
```

- [ ] **Step 5: Shellcheck both scripts**

Run: `shellcheck ai-trading/deploy/production/deploy.sh ai-trading/deploy/production/health-check.sh`
Expected: no new warnings versus the pre-edit baseline (array-append and conditional-flag patterns are shellcheck-clean idioms already used elsewhere in these scripts).

- [ ] **Step 6: Add MiroFish to Plan A's Caddy gateway after Plan A lands**

Add `mirofish` to the `gateway` service's network list in `ai-trading/deploy/production/docker-compose.yml`. Add this Caddy hostname stanza to the Plan A Caddyfile, preserving its existing global handlers:

```caddyfile
mirofish-origin.tobytran.dev {
  forward_auth auth:8181 {
    uri /__auth/check
  }
  reverse_proxy mirofish:5001
}
```

`gateway:8080` is Caddy. `auth:8181` verifies Clerk-derived gateway sessions; Caddy forwards only authenticated requests to Flask. Do not add an unauthenticated Flask route, edit MiroFish source, or replace Caddy with Node.

- [ ] **Step 7: Verify Task 5's review-focus case: missing MiroFish keys do not block other services**

With no `mirofish.env` in the runtime directory, run the Step 2 `docker compose ... config --quiet` command and existing non-MiroFish smoke checks. Expected: configuration and existing checks pass, while `docker compose config --profiles` lists `mirofish` as disabled. Do not create a repository env file or persistent transitional file to make this pass.

- [ ] **Step 8: Add the local dev route**

Append to `ai-trading/deploy/local/docker-compose.override.yml`'s `router.depends_on`: add `mirofish`. Append to `ai-trading/deploy/local/Caddyfile`'s `:8080` block, before the generic `handle { reverse_proxy web:3000 }`:

```
handle /api* {
	reverse_proxy mirofish:5001
}
```

- [ ] **Step 9: Verify and report**

Report Compose version, merged-config result, shellcheck result, and changed paths. Do not stage, commit, or push.

---

### Task 6: Dedicated GCS static bucket and CI upload identity

**Files:**
- Create: `infrastructure/gcp/ai-trading/mirofish-bucket.tf`

**Interfaces:**
- Produces: output `mirofish_bucket_name`, consumed by a future CI upload step (owned by whichever plan wires the actual `gsutil`/`gcloud storage` upload — Plan A's existing hub-upload pipeline is the natural place to add one more `rsync` line once this bucket exists; this task only provisions the bucket and the identity, it does not add that upload step, since the hub's own upload script is Plan A's file).

- [ ] **Step 1: Write the bucket and CI identity**

```hcl
# Dedicated static bucket for MiroFish's unmodified Vue build (Task 3's
# output). Public-read-only by design (01e): it holds only built HTML/CSS/JS,
# never secrets, accounts, uploads, or portfolio data. Separate from the
# hub's own bucket (Plan A's infrastructure/gcp/ai-trading/main.tf) so a
# mistake in one upload pipeline cannot touch the other bucket's objects.

variable "mirofish_static_bucket_name" {
  type        = string
  description = "Globally unique GCS bucket name for MiroFish's static Vue build. No default -- same reasoning as the backup bucket's name variable."
}

resource "google_storage_bucket" "mirofish_static" {
  project                     = var.project_id
  name                        = var.mirofish_static_bucket_name
  location                    = "US"
  uniform_bucket_level_access = true
  force_destroy               = false

  versioning {
    enabled = true # CI restores prior object generations if post-upload verification fails.
  }

  website {
    main_page_suffix = "index.html"
    not_found_page   = "index.html" # Vue history-mode deep links (01e section 2, point 2)
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "mirofish_static_public_read" {
  bucket = google_storage_bucket.mirofish_static.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# Upload-only identity for this bucket alone -- narrower than the deploy
# service account's broad access, so a compromised upload step cannot read
# Secret Manager or write to any other bucket.
resource "google_service_account" "mirofish_static_uploader" {
  project      = var.project_id
  account_id   = "ai-trading-mirofish-upload"
  display_name = "ai-trading mirofish static upload (GitHub OIDC)"
}

resource "google_service_account_iam_member" "mirofish_static_uploader_wif_binding" {
  service_account_id = google_service_account.mirofish_static_uploader.name
  role                = "roles/iam.workloadIdentityUser"
  member              = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.deploy.name}/attribute.repository/${var.github_repository}"
}

resource "google_storage_bucket_iam_member" "mirofish_static_uploader_write" {
  bucket = google_storage_bucket.mirofish_static.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.mirofish_static_uploader.email}"
}

output "mirofish_bucket_name" {
  value       = google_storage_bucket.mirofish_static.name
  description = "MiroFish static bucket name. The Cloudflare Worker (infrastructure/cloudflare/ai-trading/mirofish.tf) binds its GCS backend to this value."
}
```

- [ ] **Step 2: `fmt` and `validate` (no apply — operator-applied per AGENTS.md)**

Run: `terraform -chdir=infrastructure/gcp/ai-trading fmt -check mirofish-bucket.tf`
Expected: no diff printed.

Run: `docker run --rm -v "$PWD":/w -w /w/infrastructure/gcp/ai-trading hashicorp/terraform:latest init -backend=false && docker run --rm -v "$PWD":/w -w /w/infrastructure/gcp/ai-trading hashicorp/terraform:latest validate`
Expected: `Success! The configuration is valid.` — this validates the new file against the existing `main.tf`'s `google_iam_workload_identity_pool.deploy` and `google_project_service.apis` references (both already exist there), proving the cross-file reference resolves without needing to touch `main.tf` itself.

- [ ] **Step 3: Verify and report**

Report Terraform `fmt` and `validate` results with changed paths. Do not stage, commit, or push.

---

### Task 7: CI authenticated MiroFish static upload and rollback

**Files:**
- Create: `ai-trading/deploy/ci/upload-mirofish-static.sh`
- Modify: `.github/workflows/ai-trading-deploy.yml` (reviewed staging/activation job only)

**Interfaces:**
- Consumes: Task 3's `ai-trading/frontend-artifacts/mirofish/`, Task 6's `mirofish_bucket_name`, and the Terraform-created `ai-trading-mirofish-upload` Workload Identity identity.
- Produces: only public HTML/CSS/JS/font/image objects in the MiroFish bucket. It never uploads keys, reports, project files, or backend uploads. Its successful artifact is what the staging Worker and later public route serve.

- [ ] **Step 1: Write the CI upload script**

`upload-mirofish-static.sh` accepts the artifact directory and bucket name. It must fail before uploading unless `index.html` and at least one hashed file under `assets/` exist, and it must rerun Task 3's localhost and secret-pattern checks. It records each destination object's current GCS generation before replacement, then uploads with the Terraform-provisioned Workload Identity identity only; no console upload or local credentials are part of deployment.

Set metadata explicitly by extension: HTML as `text/html; charset=utf-8` with `Cache-Control: no-cache, max-age=0, must-revalidate`; hashed `.js`, `.css`, fonts, and images with their correct MIME type and `Cache-Control: public, max-age=31536000, immutable`. Verify uploaded `index.html`, each hashed asset listed by the build manifest, content type, cache policy, and SHA-256 against the artifact. The bucket's Task 6 object versioning is required for rollback.

- [ ] **Step 2: Implement automatic failed-upload rollback**

If upload or verification fails, restore each replaced object from its recorded prior generation and delete only newly created objects from this attempt. The script then exits non-zero. Do not delete noncurrent generations or a prior release. Report the failed revision and restored generation numbers without values or credentials.

- [ ] **Step 3: Add deployment-CI authentication and upload order**

In a reviewed staging/activation job in `ai-trading-deploy.yml`, retain checkout with recursive submodules, build `mirofish-frontend`, then authenticate through the Terraform-created Workload Identity provider as `ai-trading-mirofish-upload`. Invoke `upload-mirofish-static.sh` with `ai-trading/frontend-artifacts/mirofish/` and the Terraform output bucket name. PR CI builds and tests only; it never uploads. Deployment CI must upload before the staging Worker route is tested and before public activation; no manual Cloud Console upload is allowed.

- [ ] **Step 4: Verify staging artifact and rollback path**

After upload, fetch staging-host `index.html` and a manifest-listed hashed asset. Assert expected content type, cache policy, and matching body hashes. Run the script once against a deliberately invalid artifact in an isolated test bucket or mocked `gcloud storage` harness; assert non-zero exit and restoration of the prior generation. Never test rollback against the production bucket.

- [ ] **Step 5: Verify and report**

Report artifact revision, object names, metadata checks, and rollback-test result. Do not stage, commit, push, manually upload, or apply infrastructure.

---

### Task 8: Dedicated Cloudflare routing for `mirofish.tobytran.dev`

**Files:**
- Create: `infrastructure/cloudflare/ai-trading/mirofish-variables.tf`
- Create: `infrastructure/cloudflare/ai-trading/mirofish.tf`
- Create: `infrastructure/cloudflare/ai-trading/workers/mirofish-static.js`
- Modify (coordination point, Step 5 only): `infrastructure/cloudflare/ai-trading/main.tf`

**Interfaces:**
- Consumes: `data.cloudflare_zone.main`, `var.cloudflare_account_id`, `cloudflare_zero_trust_tunnel_cloudflared.ai_trading` — all already defined in Plan A's `main.tf`; this file only reads them, never redefines them.
- Produces: `mirofish.tobytran.dev` (public, Worker-routed to the GCS bucket) and `mirofish-origin.tobytran.dev` (unrouted tunnel-origin hostname, gateway-protected) — the two hostnames Task 5's compose network and the activation checklist (Task 10) both name.
- Produces: `mirofish-static.tobytran.dev` as the staging Worker route. Task 7 uploads the pinned static artifact before this route is tested; public activation comes only after the Caddy direct-origin gate passes.

- [ ] **Step 1: Verify the installed Cloudflare provider schema before writing Worker Terraform**

Run after `terraform -chdir=infrastructure/cloudflare/ai-trading init -backend=false`:

```bash
terraform -chdir=infrastructure/cloudflare/ai-trading providers schema -json |
  jq '.provider_schemas."registry.terraform.io/cloudflare/cloudflare".resource_schemas
    | {workers_script: .cloudflare_workers_script, workers_route: .cloudflare_workers_route}'
```

Expected: inspect the returned schema and record the exact script-name attribute and route script-reference attribute for installed `cloudflare/cloudflare` 5.26.0. Only then write Steps 2-3. If plural Workers resources or these attributes differ, stop and revise those blocks from the schema output; do not add a speculative resource or binding.

- [ ] **Step 2: Write the file-scoped variables**

```hcl
# Variables used only by mirofish.tf, kept out of the shared variables.tf
# Plan A also extends, so both files can grow independently.

variable "mirofish_hostname" {
  type        = string
  description = "MiroFish's public hostname (static Vue UI)."
  default     = "mirofish.tobytran.dev"
}

variable "mirofish_origin_hostname" {
  type        = string
  description = "MiroFish's unrouted tunnel-origin hostname (no Worker route; reached only via the tunnel, behind the gateway)."
  default     = "mirofish-origin.tobytran.dev"
}

variable "mirofish_staging_hostname" {
  type        = string
  description = "Staging hostname for the Worker-served MiroFish static UI."
  default     = "mirofish-static.tobytran.dev"
}

variable "mirofish_bucket_name" {
  type        = string
  description = "GCS bucket name from infrastructure/gcp/ai-trading's mirofish_bucket_name output. Passed explicitly rather than read via terraform_remote_state, to keep this file's blast radius independent of the GCP state's shape."
}
```

- [ ] **Step 3: Write valid GCS-fetch Worker Terraform and source**

```hcl
# Dedicated Worker + DNS for mirofish.tobytran.dev, independent of the hub's
# own Worker (Plan A's main.tf). Serves static GET/HEAD paths from the
# dedicated mirofish bucket (infrastructure/gcp/ai-trading/mirofish-bucket.tf)
# and falls back to index.html for Vue history-mode deep links (01e section
# 2, point 2). No business logic, LLM calls, or persistent state here.

resource "cloudflare_dns_record" "mirofish_public" {
  zone_id = data.cloudflare_zone.main.id
  name    = var.mirofish_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.ai_trading.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true
  comment = "ai-trading mirofish (public, Worker-routed)"
}

resource "cloudflare_dns_record" "mirofish_staging" {
  zone_id = data.cloudflare_zone.main.id
  name    = var.mirofish_staging_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.ai_trading.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true
  comment = "ai-trading mirofish static staging (Worker-routed)"
}

resource "cloudflare_dns_record" "mirofish_origin" {
  zone_id = data.cloudflare_zone.main.id
  name    = var.mirofish_origin_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.ai_trading.id}.cfargotunnel.com"
  ttl     = 1
  proxied = true
  comment = "ai-trading mirofish (unrouted tunnel origin; no Worker route)"
}

resource "cloudflare_workers_script" "mirofish_static" {
  account_id = var.cloudflare_account_id
  name       = "ai-trading-mirofish-static"
  content = templatefile("${path.module}/workers/mirofish-static.js", {
    bucket = var.mirofish_bucket_name
  })
}

resource "cloudflare_workers_route" "mirofish_static" {
  zone_id = data.cloudflare_zone.main.id
  pattern = "${var.mirofish_hostname}/*"
  script  = cloudflare_workers_script.mirofish_static.id
}

resource "cloudflare_workers_route" "mirofish_static_staging" {
  zone_id = data.cloudflare_zone.main.id
  pattern = "${var.mirofish_staging_hostname}/*"
  script  = cloudflare_workers_script.mirofish_static.id
}
```

Use the Step 1 schema output if `name` or `script` differ. GCS uses HTTPS fetches, not an R2 or Workers binding. Write `infrastructure/cloudflare/ai-trading/workers/mirofish-static.js`:

```js
const BUCKET = "${bucket}";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const origin = new URL(request.url);
      origin.hostname = "mirofish-origin.tobytran.dev";
      return fetch(new Request(origin, request));
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const gate = await fetch(new Request("https://mirofish-origin.tobytran.dev/__auth/check", {
      headers: { cookie: request.headers.get("cookie") || "" },
      redirect: "manual",
    }));
    if (gate.status !== 204) return gate;
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const assetUrl = "https://storage.googleapis.com/" + BUCKET + path;
    let res = await fetch(assetUrl, { cf: { cacheTtl: path === "/index.html" ? 0 : 31536000 } });
    if (res.status === 404) {
      // Vue history-mode deep link fallback.
      res = await fetch("https://storage.googleapis.com/" + BUCKET + "/index.html", { cf: { cacheTtl: 0 } });
    }
    return res;
  },
};
```

- [ ] **Step 5: Prove Plan A Caddy authentication before public Worker or DNS apply**

Plan A must be deployed first: `gateway:8080` is Caddy, Caddy's `forward_auth` targets `auth:8181`, and Task 5's additive `mirofish-origin.tobytran.dev` stanza and `mirofish` gateway network entry must be live. Only then apply the origin DNS/tunnel ingress through IaC and run:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://mirofish-origin.tobytran.dev/api/graph
curl --cookie "__ai_trading_session=<valid-session-cookie>" -s -o /dev/null -w '%{http_code}\n' https://mirofish-origin.tobytran.dev/api/graph
```

Expected: the unauthenticated request is a login redirect, 401, or 403; it is never a Flask response. The valid-session request reaches the authenticated Caddy proxy and returns MiroFish's proxied endpoint status. Record only status codes. If either result differs, stop: do not apply a Worker route, staging DNS, or public DNS.

- [ ] **Step 6: Coordination point — append the one shared ingress line**

Before this step, confirm with Plan A's current state of `infrastructure/cloudflare/ai-trading/main.tf`'s `cloudflare_zero_trust_tunnel_cloudflared_config.ai_trading` resource (its `ingress` list shape may have changed from the version read while writing this plan). Append one entry immediately before the existing `{ service = "http_status:404" }` catch-all (which must stay last):

```hcl
      {
        hostname = var.mirofish_origin_hostname
        service  = "http://gateway:8080"
      },
```

`gateway:8080` is Plan A's published Caddy interface. It uses `forward_auth` to `auth:8181`; Caddy alone reaches `mirofish:5001`. Never add an ingress targeting Flask or an unauthenticated origin.

- [ ] **Step 7: `fmt` and `validate`**

Run: `terraform -chdir=infrastructure/cloudflare/ai-trading fmt -check mirofish-variables.tf mirofish.tf`
Expected: no diff.

Run: `docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest init -backend=false && docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest validate`
Expected: `Success! The configuration is valid.`

- [ ] **Step 8: Deploy staging Worker only after Steps 5-7 pass**

Apply the Worker script, staging DNS/route, and uploaded artifact through IaC/CI only after the direct-origin checks pass. Exercise staging HTML, a hashed asset, a Vue deep link, multipart `/api/*` upload forwarding, and the `__auth/check` redirect before any public MiroFish hostname is routed. For the multipart check, use [01h Task 10 Step 4](01h-static-hub-clerk-implementation.md): its unsupported 5 MB `.bin` reaches the real Flask parser without invoking an LLM. Do not treat client-side `%{size_upload}` alone as proof of backend receipt. Do not apply `mirofish.tobytran.dev` until staging passes.

- [ ] **Step 9: Direct-origin bypass check (Review Focus #3), once staged**

This check runs after staging is deployed; repeat it before public activation:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://mirofish-origin.tobytran.dev/api/graph
curl -s -o /dev/null -w '%{http_code}\n' https://mirofish.tobytran.dev/api/graph
```

Expected: neither returns a 2xx without a valid Clerk gateway session cookie attached; both return the gateway's redirect-to-login or 401/403, never a Flask response.

- [ ] **Step 10: Verify and report**

Report provider-schema findings, Terraform `fmt`/`validate`, and origin-gate check results with changed paths. Do not stage, commit, or push.

---

### Task 9: Firestore runtime profile on the VPS

**Files:**
- Modify: `ai-trading/deploy/production/deploy.sh` (one explicit MiroFish activation path after Plan A installs `family_config.py` beside deploy files)

**Interfaces:**
- Consumes: Firestore runtime profile `ai-trading/mirofish`, available only through `common/config/family_config.py` on the VPS with `FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json`.
- Produces: `${AI_TRADING_RUNTIME_ENV_DIR:-/run/family-app/ai-trading}/mirofish.env` at mode `0600`; it is an ephemeral runtime file outside this repository. Required profile names are `ZEP_API_KEY` and `LLM_API_KEY`; optional names are `LLM_BASE_URL` and `LLM_MODEL_NAME`.
- Does not use, add to, migrate from, or delete a Secret Manager env bundle. Do not modify `render-env.sh`; it is obsolete for this service and transitional-bundle cleanup belongs to the separate family-config handoff.

- [ ] **Step 1: Provision the Firestore profile before enabling MiroFish**

The owner writes the values to `ai-trading/mirofish` through `common/config/family_config.py`; no value is placed in a repository file. On the operator machine, names-only verification is:

```bash
common/config/family_config.py keys ai-trading/mirofish
```

Expected: required names are present. Do not print values.

- [ ] **Step 2: Render only on the VPS when enabling the Compose profile**

Plan A must first copy `common/config/family_config.py` to `$APP_DIR/family_config.py` with the deploy files. The activation command is:

```bash
sudo install -d -m 0700 /run/family-app/ai-trading
sudo env FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json \
  "$APP_DIR/family_config.py" render ai-trading/mirofish \
  --out-dir /run/family-app/ai-trading
sudo test -f /run/family-app/ai-trading/mirofish.env
sudo test "$(stat -c '%a' /run/family-app/ai-trading/mirofish.env)" = 600
```

Only after this succeeds, set `COMPOSE_PROFILES=mirofish` for the deployment that starts the service. Missing profile, missing reader key, or render failure is an activation blocker; leave MiroFish disabled and report it. Do not make unrelated services depend on this render.

- [ ] **Step 3: Verify the disabled and enabled paths**

Without the runtime file and without `COMPOSE_PROFILES=mirofish`, run Task 5 Step 2's merged Compose config and existing non-MiroFish checks. With the profile rendered, run:

```bash
COMPOSE_PROFILES=mirofish docker compose \
  -f ai-trading/deploy/production/docker-compose.yml \
  -f ai-trading/deploy/production/docker-compose.mirofish.yml config --quiet
```

Expected: both configuration paths are valid. The enabled path only validates configuration here; the separate activation review performs the authenticated end-to-end run.

- [ ] **Step 4: Verify and report**

Report only profile key names, render success/failure, file mode, and changed paths. Do not stage, commit, push, or delete any transitional bundle.

---

### Task 10: CI wiring, activation checklist, non-goals

**Files:**
- Modify: `ai-trading/deploy/ci/smoke-test.sh` (append `smoke_mirofish` + dispatch case)
- Modify: `.github/workflows/ai-trading-ci.yml` (append one new job)
- Modify: `ai-trading/plans/STATUS.md` (Open Questions: record that static upload/staging, Task 8's Caddy-authenticated route, and the Firestore handoff gate public activation)

**Interfaces:**
- Consumes: `mirofish-health-check.sh` is folded directly into `smoke-test.sh` rather than kept separate (right-sizing per the writing-plans skill — a five-line helper does not earn its own file once it has exactly one caller).
- Produces: a green `mirofish` CI job on every PR touching `ai-trading/**`, matching the existing per-app job pattern (`hub`, `scripts`, and one job per upstream app — confirm the exact existing job list in `ai-trading-ci.yml` before naming this job, so it sits alongside its siblings rather than duplicating one).

- [ ] **Step 1: Add the smoke-test function**

Append to `ai-trading/deploy/ci/smoke-test.sh`, after the existing `smoke_vibe` function:

```bash
smoke_mirofish_backend() {
  start smoke-mirofish "$(image mirofish-backend)" 15001 5001 \
    -e LLM_API_KEY=sk-smoke-dummy -e ZEP_API_KEY=z_smoke-dummy
  expect_status 200 http://127.0.0.1:15001/health
  expect_body '"status": "ok"' http://127.0.0.1:15001/health
}

smoke_mirofish_frontend() {
  local dir="ai-trading/frontend-artifacts/mirofish"
  [[ -f "$dir/index.html" ]] || fail "$dir/index.html missing -- run docker buildx bake mirofish-frontend first"
  grep -qF "localhost:5001" -r "$dir" && fail "mirofish static build still references localhost:5001"
  echo "ok   mirofish static build has no localhost:5001 reference"
}
```

- [ ] **Step 2: Add the dispatch case**

In `smoke-test.sh`'s argument-handling tail (the `case "$1" in ... esac` or equivalent dispatch that already calls `smoke_web`/`smoke_terminal`/`smoke_vibe` for `all`), add:

```bash
mirofish) smoke_mirofish_backend; smoke_mirofish_frontend ;;
```

and inside the `all)` arm, add calls to both new functions alongside the existing ones.

- [ ] **Step 3: Add the CI job**

Append to `.github/workflows/ai-trading-ci.yml` (mirroring the existing per-app job's checkout/buildx/bake/smoke-test shape — read the existing `vibe-trading` or `ahf-terminal` job immediately above this insertion point for the exact `uses:`/cache steps, then reproduce that shape for these two new targets):

```yaml
  mirofish:
    name: MiroFish (backend image + static build)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
          submodules: recursive
      - uses: docker/setup-buildx-action@v3
      - run: docker buildx bake -f ai-trading/deploy/docker-bake.hcl -f ai-trading/deploy/docker-bake.ci.hcl --load mirofish-backend
      - run: docker buildx bake -f ai-trading/deploy/docker-bake.hcl -f ai-trading/deploy/docker-bake.ci.hcl mirofish-frontend
      - run: ai-trading/deploy/ci/smoke-test.sh mirofish
```

- [ ] **Step 4: Run the full local smoke suite once Tasks 2–3 have built images**

Run: `ai-trading/deploy/ci/smoke-test.sh all`
Expected: every existing app's checks still pass (unchanged), plus the two new `smoke_mirofish_*` checks pass.

- [ ] **Step 5: Shellcheck and workflow lint**

Run: `shellcheck ai-trading/deploy/ci/smoke-test.sh`
Run: `actionlint .github/workflows/ai-trading-ci.yml`
Expected: both clean.

- [ ] **Step 6: Update `STATUS.md`'s MiroFish Open Question**

Change the bullet's final sentence from "Activation needs the Zep key and an authenticated VPS gateway." to: "The submodule, backend image, and static build are implemented (see [subplans/01i-mirofish-upstream-implementation.md](subplans/01i-mirofish-upstream-implementation.md)); activation still needs the Zep/LLM keys from the Firestore handoff and Plan A's authenticated VPS gateway."

- [ ] **Step 7: Final scope check**

Confirm none of this plan's tasks: ship financial prediction copy, add a launch link before activation, create a second Secret Manager bundle, run a real Zep/LLM call in CI, implement Phase 1B's start/stop control (01g), or rewrite a Plan A file beyond Task 5's one gateway network entry and one Caddy stanza plus Task 8's one tunnel ingress. Grep for accidental scope creep:

```bash
git diff --stat ai-trading plans infrastructure .github 2>/dev/null
```

Expected: every listed file matches this plan's File Structure table; nothing under `infrastructure/cloudflare/zero-trust/`, no production Compose edit beyond Task 5's gateway network entry, no `/settings` route, and no `__control` path.

- [ ] **Step 8: Verify and report**

Report smoke, lint, and scope results with changed paths. Do not stage, commit, or push.

---

## Coverage Check

**Spec coverage:** submodule pin (Task 1) · backend-only external Dockerfile, uv, single Flask process, dedicated upload volume (Task 2) · unmodified `npm ci && npm run build`, build-time `VITE_API_BASE_URL`, no-localhost guard (Task 3) · hub card, category, pre-activation copy, AGPL source/license links pinned to commit (Task 4) · Caddy `forward_auth` gateway boundary, no host port on Flask, dedicated Compose network (Task 5) · dedicated public-read-only GCS bucket (Task 6) · authenticated CI upload, staging verification, and object-generation rollback (Task 7) · Caddy-gated Worker/DNS routing, staged before public activation (Task 8) · Firestore-handoff runtime profile interface, no new Secret Manager bundle (Task 9) · CI build/smoke coverage and activation-status bookkeeping (Task 10). Live activation requires the handoff, Caddy gate, Zep/OpenAI keys, and one real end-to-end run; no task claims them complete.

**Worker check:** Task 8 contains only GCS HTTPS fetch code and schema-gated Terraform. It contains no Cloudflare storage binding or interim replacement step.

**Review corrections:** Task 7 now makes the bucket a deployable static release with metadata checks and generation rollback. Task 8 now blocks Worker/public DNS on Caddy `forward_auth` proof, and Task 0/9 make the Firestore handoff and correct CLI target explicit. File ownership now includes the Worker source and Caddy/gateway coordination.

**Type consistency:** `HubApp`'s new member is `UpstreamSetupApp` everywhere (Task 4); the compose service/network/volume names (`mirofish`, `mirofish-uploads`) match across Tasks 5, 7, and 9; the image tag `ai-trading-mirofish-backend` and Bake target name `mirofish-backend` match across Tasks 2 and 9; the pinned SHA `7657031ac01184afe2cb220f5ee3545573b5e843` is identical in Tasks 1, 2 (base image comment lineage), 4 (three link fields), and STATUS.md.

**Review Focus:** all five items (startup-key false-positive, falsy-fallback build-arg, direct-origin bypass, pinned-commit drift, missing-credential tolerance) each have an owning task and an explicit check step, listed above.
