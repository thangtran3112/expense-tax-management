# Expense Tax Management

Self-hosted expense management for households, freelancers, and small businesses.

## Architecture

- `packages/contracts`: canonical Zod contracts, OpenAPI/JSON Schema, generated clients, and generated Python DTOs.
- `services/app-api`: Fastify/Kysely customer API and sole customer-domain database owner.
- `services/foundry-service`: Fastify/Kysely provider catalog, routing, quota, reservation, and telemetry owner.
- `services/ai-worker`: Python Temporal workflows and data processing; no direct App/Foundry database access.
- `frontend/capture-web`: receipt capture and invitation flow.
- `frontend/office-web`: expense, duplicate, tax, tagging, and mailbox review.
- `frontend/foundry-web`: platform operations.
- `expense-service` and `frontend/web`: transitional legacy surfaces; leave untouched.

## Status

- Core Phase 0 baseline complete.
- Private Clerk production deployment, gateway hardening, protected `dev`, and Phase 3B deduplication complete.
- Next: Phase 3C deterministic auto-tagging, then Phase 3D-A/B/C connected mailbox.
- Canonical status and links: [`plans/PLAN.md`](plans/PLAN.md).

## Prerequisites

- Node.js 22 or newer
- pnpm 11.9
- Python 3.13 or newer
- uv
- Docker with Compose

## Setup

```bash
pnpm install --frozen-lockfile
uv --directory common/python/expense-contracts sync --frozen
uv --directory services/ai-worker sync --frozen
pnpm compose:up
```

Local values belong in `.env`; `.env.example` documents required keys.

## Verification

```bash
pnpm ci:lint
pnpm ci:typecheck
pnpm ci:test
pnpm ci:python:lint
pnpm ci:python:test
pnpm ci:build
pnpm contracts:check
```

Database/integration suites use their explicit environment gates and disposable PostgreSQL instances. See package scripts and active phase plans for exact commands.

## Workflow

- Read `AGENTS.md` before coding.
- Create a fresh worktree from `origin/dev` on `feature/*`.
- Use test-first changes and smallest correct diffs.
- Push only after immediate confirmation; merge by PR to protected `dev`.
- Production deployment requires separate release planning and approval.
