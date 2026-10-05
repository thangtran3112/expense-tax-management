# Expense Tax Management - Master Plan

> **Status:** Production foundation complete. Runtime TypeScript Temporal migration Tasks 1-6 and Task 7 Stage A merged, Task 7 Stage B source merged (TypeScript worker idle in production Compose); operator cutover (shared Temporal activation, release, advance, drain) and Stage C Python removal remain. Phase 3C implemented on `dev`, not deployed. Phase 3D-A, 3D-B, and 3D-C merged; none deployed, operator activation pending. VPS backup/restore tooling merged, operator activation pending. Env and secrets for all family-app apps live in Firestore `family-config` (`common/config/family_config.py`); the production deploy path that reads it ships with the next release.
> **Last updated:** 2026-10-04
> **Source of truth:** This file tracks phase state. Completed implementation details were removed after verification and remain available in git history.

## Handoff

- Runtime migration Tasks 1-6 and Task 7 Stage A merged (through PR #12); Task 7 Stage B source merged (#14) -- `workflow-worker` now ships idle in production Compose alongside `ai-worker`, routed by the data-driven dispatch-routing fence (generation 1 = Python, until an operator runs `advance`). Remaining: the Stage B operator cutover sequence (shared Temporal activation, non-production smoke, `advance`, drain, schedule migration), then Stage C Python removal.
- Phase 3D-A merged (#15), Phase 3D-B merged (#16), Phase 3D-C merged (#17). All three remain undeployed and inert in production (`MAILBOX_FEATURE_ENABLED` unset); 3D-B/3D-C production activation additionally requires the runtime migration Task 7 operator cutover above.
- VPS encrypted backup/restore tooling merged (#13); production activation (bucket/IAM provisioning, first real backup, operator restore rehearsal) is operator-only and pending.
- Execute Phase 3D-A, Phase 3D-B, then Phase 3D-C only after Phase 3C completes.
- Work on `feature/toby` from current `origin/dev`; create a separate worktree only when explicitly requested.
- Merge only through a pull request to protected `dev`; required quality CI must pass. Integration CI is advisory and must be reported when red.
- `main` remains production-only. Merges to `dev` never deploy production.
- Read `expense-tax-management/AGENTS.md` before implementation.
- Ordered owner runbook for activating everything below in production: [production-activation-runbook.md](production-activation-runbook.md).

## Product Goal

Self-hosted expense management for households, freelancers, and small businesses:

- Phone/tablet receipt capture and forwarded or connected-mailbox intake.
- Explicit Personal or Business expense scope with membership authorization.
- Project cost analysis without treating projects as tax entities.
- US federal tax preparation and deterministic exports; no direct filing.
- Office review for expenses, duplicates, tags, tax categories, and mailbox candidates.
- Foundry-owned AI routing and quotas, with no user-managed provider keys.

## Current Architecture

```text
Capture Web -----\
                  +--> App API (Fastify/Zod/Kysely) --> app PostgreSQL
Office Web ------/                |
                                  +--> Temporal TypeScript client
                                             |
                                             v
                                  Python Temporal worker --> signed storage adapter
                                                              (local now; GCS pending)
                                             |
                                             +--> App API callbacks
                                             +--> Foundry internal API

Foundry Web ----------> Foundry Service (Fastify/Zod/Kysely)
                                  |
                                  +--> foundry PostgreSQL
                                  +--> Secret Manager
```

- App API owns all customer-domain persistence.
- Foundry owns provider catalog, routing, quotas, reservations, and telemetry.
- Python owns durable workflows and data processing, never App or Foundry database writes.
- Zod contracts are canonical; generated TypeScript/Python artifacts are read-only.
- `expense-service/` and `frontend/web/` are transitional legacy surfaces and remain untouched.

## Completed Phases

- **Phase 0 - Core baseline:** TypeScript service rebaseline, Personal/Business/tax domain, plans and entitlements, Foundry catalog and quotas, Temporal worker, OCR, uploads, reports/exports, forwarded intake, Capture/Office/Foundry frontends, and UI gates complete.
- **Phase 1A - Polyglot CI:** Contracts, services, workers, and frontends run in GitHub Actions; integration coverage remains visible as a separate job.
- **Phase 1B - Private production auth/deployment:** Six immutable images deploy to VPS through GitHub OIDC/WIF and one Secret Manager bundle. Clerk identities, PostgreSQL mappings, signed webhook, and authenticated smoke verification complete.
- **Phase 1C - Gateway hardening:** Cloudflare free-tier Tunnel/DNS, explicit host/path ingress, loopback-only origins, bounded application rate limits/body limits, security headers, and fail-closed route checks complete.
- **Phase 1D - Protected development:** `dev` is default and protected; `feature/* -> dev` PRs require `Contracts, services, workers, frontends`; integration is advisory; production deployment remains `main`-only.
- **Phase 3B - Deduplication:** Scoped provenance, deterministic duplicate evidence, pending-review matches, transactional resolution, Office review, and production deployment complete.

## Remaining Work

| Order | Phase | Status | Canonical documents |
|---|---|---|---|
| Parallel | **TypeScript Temporal worker migration** | Tasks 1-6 and Task 7 Stage A merged (#12); Task 7 Stage B source merged (#14, `workflow-worker` idle in production Compose); remaining: operator cutover (shared Temporal activation, release, advance, drain) then Stage C Python removal | [migration plan](sub-plans/runtime-typescript-temporal-migration.md) / [historical handoff](HANDOFF.md) |
| Parallel | **Local Clerk development bootstrap** | Development credentials, M2M checks, local Compose stack (PostgreSQL/Temporal/both workers), and a reproducible dual-generation worker smoke complete; local frontend sign-in and local Clerk webhook remain owner-action-required | [sub-plan](sub-plans/local-clerk-development-bootstrap.md) |
| Parallel | **VPS encrypted backup and restore tooling** | Merged (#13); production activation (bucket/IAM provisioning, first backup, operator restore rehearsal) pending | [plan](sub-plans/vps-backup-and-restore.md) |
| 1 | **3C - Auto-tagging and categorization** | Implemented on `dev` (commits `a4ae60b`..`14bd9df`; PostgreSQL evidence 2026-09-19); not deployed | [spec](../../docs/superpowers/specs/2026-09-12-phase-3c-auto-tagging-design.md) / [implementation plan](../../docs/superpowers/plans/2026-09-12-phase-3c-auto-tagging.md) |
| 2 | **3D-A - Mailbox broker and connection lifecycle** | Merged (#15); not deployed; operator activation pending | [shared spec](../../docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md) / [plan](../../docs/superpowers/plans/2026-09-12-phase-3d-a-mailbox-broker.md) |
| 3 | **3D-B - Mailbox discovery and review** | Merged (#16); not deployed; production use additionally requires the runtime migration Task 7 operator cutover since 3D workflows run only on the TypeScript worker | [plan](../../docs/superpowers/plans/2026-09-12-phase-3d-b-mailbox-discovery.md) |
| 4 | **3D-C - Mailbox ingestion and provenance** | Merged (#17); not deployed; production use additionally requires runtime migration Task 7 cutover and 3D-A activation | [plan](../../docs/superpowers/plans/2026-09-12-phase-3d-c-mailbox-ingestion.md) |
| Later | **6A/6B/6C - SQL, semantic, and AI search** | Deferred; replan before execution | `plans/sub-plans/phase-6*.md` |
| Later | **9A/9B/9C - Graph foundation, ingestion, and search** | Deferred; replan before execution | `plans/sub-plans/phase-9*.md` |
| Later | **12A/12B/12C - Mobile application** | Deferred; framework decision pending | `plans/sub-plans/phase-12*.md` |

## Required Sequence

1. Phase 3C creates App migration `016` and `ExpenseEnrichmentWorkflow`.
2. Runtime migration Task 7 Stage A takes App migration `017`.
3. Phase 3D-A creates mailbox migration `018` and a VPS-container mailbox broker in the Expense production Compose, with a dedicated PostgreSQL token-vault database/roles.
4. Phase 3D-B creates discovery migration `019` and opaque Temporal discovery orchestration on the TypeScript workflow worker.
5. Phase 3D-C creates ingestion migration `020` and direct broker-to-App materialization.
6. 3D-A source may merge to `dev` once Phase 3C is in; production activation of 3D-B/C requires runtime migration Task 7 cutover (`sub-plans/runtime-typescript-temporal-migration.md`), since 3D workflows run only on the TypeScript worker.
7. Production rollout for Phase 3C/3D requires separate release planning and explicit deployment approval.

### 3D-A Operator Activation (post-merge, pre-production)

3D-A source is feature-complete and phase-verified on `dev` (pending merge) but the mailbox feature stays fully inert in production (`MAILBOX_FEATURE_ENABLED` unset/false) until an operator explicitly completes every item below, in order:

1. **Vault bootstrap** — run `deploy/production/bootstrap-mailbox-vault-db.sh` against the production Postgres cluster to create the token-vault database and its separate runtime (DML-only) / migration (DDL-only) roles. Operator-only; never run by normal deploy.
2. **Clerk mailbox identities** — provision the three real machine identities (`app-api-mailbox`, `workflow-worker-mailbox`, `mailbox-broker-app`) in production Clerk, then store their audience, subjects, and machine secret keys in the Firestore production profile (`common/config/family_config.py set expense-tax-management/production <NAME>`).
3. **Google OAuth client** — create the production Google OAuth 2.0 client (Gmail readonly scope only) and store `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_REDIRECT_URI` in the same profile.
4. **Production profile with `MAILBOX_FEATURE_ENABLED=true`** — set every remaining mailbox key in `expense-tax-management/production` (vault keys, broker URLs, vault database URLs, and `MAILBOX_SERVICE_TOKEN_*`/`MAILBOX_SERVICE_JWKS_URL` equal to the Clerk values), then set `MAILBOX_FEATURE_ENABLED` to `true` last. `deploy.sh` (`validate_required_values`) refuses an enabled profile with missing or mismatched values.
5. **Cloudflare Terraform apply** — run `terraform plan`/`apply` in `infrastructure/cloudflare/expense-tax/` (via `.github/workflows/expense-tax-cloudflare.yml`'s production-environment, manually-dispatched job) to create the `expense-mailbox.tobytran.dev` DNS record and Tunnel ingress rule for `/oauth/google/callback`.

3D-B/3D-C source may also merge to `dev` once implemented, but their workflows' production activation additionally depends on runtime migration Task 7 cutover (3D workflows run only on the TypeScript worker) — independent of, and in addition to, the 3D-A list above.

### 3D-B Operator Activation (additional, after the 3D-A list above)

3D-B's scheduled scans do not start themselves: nothing calls `ensureMailboxSchedule` automatically (by design — reconciliation over import-time creation). After `MAILBOX_FEATURE_ENABLED` is turned on and runtime migration Task 7 cutover has happened, an operator must run `node dist/temporal/mailbox-schedule-reconcile.js reconcile` (`services/app-api/src/temporal/mailbox-schedule-reconcile.ts`) once to create the daily `02:00` Temporal Schedule for every existing active/scan-enabled connection; re-running it later is safe (idempotent) and is how a newly-connected mailbox's schedule gets created going forward until a startup hook replaces this manual step.

### 3D-C Operator Activation (additional, after the 3D-A/3D-B lists above)

3D-C source is feature-complete and phase-verified against real PostgreSQL (`test/integration/app-domain-3d-c-mailbox.test.ts`, gated `PHASE_3D_C_T7_INTEGRATION=1`, wired into the zero-skip CI chain), but production ingestion stays inert until, in addition to the 3D-A/3D-B activation steps above:

1. **Runtime migration Task 7 cutover** has happened — `MailboxMaterializeWorkflow`/`MailboxOcrReceiptWorkflow` run only on the TypeScript `services/workflow-worker`, never the legacy Python worker.
2. **3D-A activation is complete** (real Clerk mailbox identities, token-vault bootstrap, Google OAuth client, `MAILBOX_FEATURE_ENABLED=true` secret bundle) and **3D-B's schedule reconcile** has run — 3D-C's `ingest` approval is the consumer of a `queued` candidate that only an active, scheduled scan ever produces.
3. **Real Gmail test-account verification** (plan Task 7 Step 6, `test/e2e/connected-mailbox.e2e.test.ts`) — operator-gated, run against a provisioned test Google account and the production-shaped VPS Compose stack before enabling the feature for real tenants; never run in CI.

## Remaining-Phase Constraints

- Phase 3C uses deterministic rules and tenant history only. No live LLM, embeddings, paid provider, or automatic spending/tax-category acceptance.
- Rule tags may auto-apply; historical tags and spending/tax-category suggestions require review.
- Tax automation suggests category only, never deductible percentage, filing treatment, or reviewed status.
- Phase 3D supports Gmail first through a provider adapter; Outlook remains unsupported until separately implemented.
- Gmail scope is exactly `https://www.googleapis.com/auth/gmail.readonly`.
- OAuth refresh tokens are stored as AES-256-GCM ciphertext in a dedicated PostgreSQL token-vault database. Plaintext tokens never enter Temporal history, browsers, logs, or VPS files, and exist only in broker memory.
- Mailbox attachment bytes and provider metadata bypass Temporal; workflows carry opaque IDs and counts only.
- Phase 3B duplicate candidates remain pending review and never auto-merge.
- Mailbox broker runs as a VPS container in the Expense production Compose; no new GCP compute, no static GCP key.

## Production Snapshot

- Public edge: Cloudflare free-tier Tunnel and DNS.
- Origins: VPS application ports bound to loopback only.
- Services: App API, Foundry Service, AI worker, Temporal, Capture Web, Office Web, and Foundry Web deployed through `.github/workflows/expense-tax-deploy.yml`.
- Authentication: Clerk user, organization, platform, and M2M boundaries verified; production smoke passed 13/13.
- Webhook: exact supported Clerk events active; signed delivery and replay verified.
- Secret handling: one non-destroyed production Secret Manager bundle version; no repository secrets.
- Infrastructure status and deferred operations: [ROADMAP.md](ROADMAP.md).

## Durable Boundaries

- Every customer resource carries explicit Personal or Business scope; tenant administration alone grants no expense access.
- Foundry rejects tenant tokens; platform authorization remains PostgreSQL-owned.
- Manual user decisions outrank accepted historical decisions, which outrank deterministic automation.
- Every remote write or production mutation requires explicit execution-time confirmation.
- Cloudflare paid WAF/rate limiting/Workers/Access and always-on GCP compute require separate cost approval.
