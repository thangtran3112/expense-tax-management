# Local Clerk Development Bootstrap

## Goal

Run local Expense Tax authentication against the existing Clerk Development
instance, isolated from production users, machines, and credentials. This is a
local verification task, not a production deployment or a new Clerk application.

## Current State

- [x] Clerk CLI authenticated and Expense Tax project linked to its existing Development instance.
- [x] Official Clerk MCP reachable from OpenCode and Claude Code.
- [x] Development publishable and secret keys pulled into ignored local environment files for the package root and Capture, Office, and Foundry frontends; permissions set to `0600`.
- [x] Local Compose settings use Development issuer, JWKS, and separate App and Foundry machine credentials; both service JWT verifiers accept live Development tokens.
- [x] Python and TypeScript token clients issue and validate live Development M2M tokens. Frontend builds and Compose configuration validation pass.

## Remaining Local Verification

- [x] Start disposable local PostgreSQL and Temporal services with separate runtime and migration database credentials. The TypeScript worker's workflow port is complete (runtime-typescript-temporal-migration Task 7 Stage B source); `workflow-worker` is now a local Compose service, gated behind the `workflow-worker` Compose profile (ruling: mirrors the existing `phase-0i-migrations` one-shot-service convention) so it is not started by `up -d` by default.
- [ ] Configure a Development-only signed Clerk webhook path to the local App API. Verify user, organization, and membership events, including replay, without connecting a production webhook. **Owner action required** (no agent-automatable path: requires a human-operated Clerk Dashboard webhook endpoint pointed at a reachable local/tunneled URL). Exact steps:
  1. In the Clerk Dashboard, open the Expense Tax project's **Development** instance → Webhooks.
  2. Add an endpoint URL reachable from Clerk (e.g. a `cloudflared tunnel` or `ngrok` pointed at local App API's webhook route), subscribed to `user.*`, `organization.*`, and `organizationMembership.*` events.
  3. Copy the endpoint's signing secret into the local `.env`'s `CLERK_WEBHOOK_SIGNING_SECRET` (never commit it).
  4. Trigger one event per subscribed type from the Dashboard (or via a real sign-up/org action in the Development instance) and confirm App API accepts and applies it.
  5. Resend the same event from the Dashboard's webhook log and confirm App API's replay handling returns its replay-marker response without re-applying the event.
- [ ] Sign in through local Capture, Office, and Foundry frontends using Development identities. Verify App and Foundry authorization against local PostgreSQL mappings and explicit Personal/business scope. **Owner action required** (no agent-automatable path: requires an interactive human browser sign-in against the live Clerk Development hosted UI). Exact steps:
  1. `./scripts/compose.sh up -d --wait` the full local stack (or `pnpm --filter capture-web/office-web/foundry-web dev` locally) with the ignored local `.env`/`.env.local` Development keys already in place.
  2. Open each of Capture (`:7301/capture`), Office (`:7302/dashboard`), and Foundry (`:7303/providers`) in a browser and sign in with a real Development-instance identity.
  3. Confirm each frontend reaches its authenticated view (not redirected to sign-in) and that App/Foundry's authorization checks resolve the expected Personal/business scope from local PostgreSQL (no cross-tenant/cross-scope access).
- [x] Exercise one App API to Python worker to App API callback through the local queue. After the TypeScript worker cutover tasks, repeat the flow on its separate queue and namespace. Verified by `scripts/local-worker-smoke.mjs` (`pnpm smoke:local-worker`): a disposable foundation-echo job completes on generation 1 (namespace `default` / queue `expense-tax-ai-worker`, the real `ai-worker` container), then after an operator-style `dispatch-routing.js advance --from-generation 1` against the local database, a second job completes on namespace `expense-tax` / queue `expense-tax-processing` (the real `workflow-worker` container) -- both workers call back into App API with real Development Clerk M2M credentials loaded only through Compose/env.
- [x] Record reproducible local setup and smoke outcomes; keep every credential out of tracked files, logs, and test artifacts. See "Reproducible Local Setup and Smoke Outcome" below.

## Reproducible Local Setup and Smoke Outcome

Commands (run from `expense-tax-management/`, local `.env` with real Development Clerk M2M credentials already in place):

```bash
pnpm install --frozen-lockfile
LOCAL_WORKER_SMOKE_CONFIRM=I-understand-local-worker-smoke pnpm smoke:local-worker -- --execute
```

The script refuses to run without both the `--execute` flag and the matching
`LOCAL_WORKER_SMOKE_CONFIRM` value, refuses unless the resolved database host
is the local Compose `postgres` service, and refuses with the exact missing
variable names (never values) if Development Clerk M2M credentials are not
loaded. It starts only the services it needs, runs App API migrations,
bootstraps the `expense-tax` Temporal namespace, drives both dispatch
generations described above, and stops/removes only the Compose services it
started.

Outcome of the last real run on this machine: **PASS** -- generation 1 job
reached `SUCCEEDED` via the real `ai-worker` container's callback;
`dispatch-routing.js status`/`advance --from-generation 1` ran against the
local database; generation 2 job reached `SUCCEEDED` on namespace
`expense-tax` / queue `expense-tax-processing` via the real `workflow-worker`
container's callback; teardown left no stray containers (verified against
`local-llm-observability-postgres-1`, `geo-types-pg`, `geo-orch-pg`, which were
never touched). The script's safety guards and plan/ordering logic are also
covered by `scripts/local-worker-smoke.test.mjs`, run without Docker.

## Boundaries

- `pk_test_` and `sk_test_` belong to Development; production keys never enter local frontend builds.
- Clerk MCP supplies SDK guidance; CLI and service clients perform authenticated instance operations.
- Production deployment, production identities, and production webhook settings remain outside this task.
