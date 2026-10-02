# Expense Tax Management - Master Plan

> **Status:** Production foundation complete. Runtime TypeScript Temporal migration Tasks 1-5 merged; Task 6 shared Temporal source in PR review. Phase 3C implemented on `dev`; Phase 3D remains on the product roadmap.
> **Last updated:** 2026-09-24
> **Source of truth:** This file tracks phase state. Completed implementation details were removed after verification and remain available in git history.

## Handoff

- Runtime migration Task 5 merged through PR #11; Task 6 shared Temporal source is in PR review. Production activation remains operator-only. Phase 3C status reconciled against merged code; 3D plans must be revised to match `ARCHITECTURE.md` before implementation.
- Execute Phase 3D-A, Phase 3D-B, then Phase 3D-C only after Phase 3C completes.
- Work on `feature/toby` from current `origin/dev`; create a separate worktree only when explicitly requested.
- Merge only through a pull request to protected `dev`; required quality CI must pass. Integration CI is advisory and must be reported when red.
- `main` remains production-only. Merges to `dev` never deploy production.
- Read `expense-tax-management/AGENTS.md` before implementation.

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
| Parallel | **TypeScript Temporal worker migration** | Tasks 1-5 merged; Task 6 shared Temporal source locally verified, awaiting PR; no production cutover | [migration plan](sub-plans/runtime-typescript-temporal-migration.md) / [historical handoff](HANDOFF.md) |
| Parallel | **Local Clerk development bootstrap** | Development credentials and M2M checks complete; local sign-in, webhook, and scoped data flow pending | [sub-plan](sub-plans/local-clerk-development-bootstrap.md) |
| 1 | **3C - Auto-tagging and categorization** | Implemented on `dev` (commits `a4ae60b`..`14bd9df`; PostgreSQL evidence 2026-09-19); not deployed | [spec](../../docs/superpowers/specs/2026-09-12-phase-3c-auto-tagging-design.md) / [implementation plan](../../docs/superpowers/plans/2026-09-12-phase-3c-auto-tagging.md) |
| 2 | **3D-A - Mailbox broker and connection lifecycle** | Blocked by 3C | [shared spec](../../docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md) / [plan](../../docs/superpowers/plans/2026-09-12-phase-3d-a-mailbox-broker.md) |
| 3 | **3D-B - Mailbox discovery and review** | Blocked by 3D-A | [plan](../../docs/superpowers/plans/2026-09-12-phase-3d-b-mailbox-discovery.md) |
| 4 | **3D-C - Mailbox ingestion and provenance** | Blocked by 3D-B | [plan](../../docs/superpowers/plans/2026-09-12-phase-3d-c-mailbox-ingestion.md) |
| Later | **6A/6B/6C - SQL, semantic, and AI search** | Deferred; replan before execution | `plans/sub-plans/phase-6*.md` |
| Later | **9A/9B/9C - Graph foundation, ingestion, and search** | Deferred; replan before execution | `plans/sub-plans/phase-9*.md` |
| Later | **12A/12B/12C - Mobile application** | Deferred; framework decision pending | `plans/sub-plans/phase-12*.md` |

## Required Sequence

1. Phase 3C creates App migration `016` and `ExpenseEnrichmentWorkflow`.
2. Phase 3D-A creates mailbox migration `017` and dedicated scale-to-zero Cloud Run broker.
3. Phase 3D-B creates discovery migration `018` and opaque Temporal discovery orchestration.
4. Phase 3D-C creates ingestion migration `019` and direct broker-to-App materialization.
5. Production rollout for Phase 3C/3D requires separate release planning and explicit deployment approval.

## Remaining-Phase Constraints

- Phase 3C uses deterministic rules and tenant history only. No live LLM, embeddings, paid provider, or automatic spending/tax-category acceptance.
- Rule tags may auto-apply; historical tags and spending/tax-category suggestions require review.
- Tax automation suggests category only, never deductible percentage, filing treatment, or reviewed status.
- Phase 3D supports Gmail first through a provider adapter; Outlook remains unsupported until separately implemented.
- Gmail scope is exactly `https://www.googleapis.com/auth/gmail.readonly`.
- OAuth tokens live only in broker-managed Secret Manager versions. They never enter PostgreSQL, Temporal history, browsers, logs, or VPS files.
- Mailbox attachment bytes and provider metadata bypass Temporal; workflows carry opaque IDs and counts only.
- Phase 3B duplicate candidates remain pending review and never auto-merge.
- Cloud Run broker uses managed identity and `min-instances=0`; no static GCP key.

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
