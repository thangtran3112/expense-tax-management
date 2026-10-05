# Family App Monorepo

Shared infrastructure and family applications deployed to one VPS with selected GCP services.

## Layout

```text
family-app/
|-- infrastructure/                       # Local shared stack, VPS bootstrap, Cloudflare Terraform
`-- expense-tax-management/
    |-- packages/contracts/                # Canonical Zod contracts and generated artifacts
    |-- services/app-api/                  # Fastify/Kysely customer API
    |-- services/foundry-service/          # Fastify/Kysely AI control plane
    |-- services/ai-worker/                # Python Temporal worker
    |-- frontend/capture-web/              # Next.js capture application
    |-- frontend/office-web/               # Next.js review/reporting application
    |-- frontend/foundry-web/              # Next.js operator application
    |-- deploy/production/                 # Production Compose and deployment scripts
    |-- expense-service/                   # Transitional legacy FastAPI; do not extend
    |-- frontend/web/                      # Transitional legacy frontend; do not extend
    `-- plans/PLAN.md                       # Canonical phase tracker and handoff
```

## Development

```bash
cd expense-tax-management
pnpm install --frozen-lockfile
uv --directory common/python/expense-contracts sync --frozen
uv --directory services/ai-worker sync --frozen
pnpm compose:up
```

Core verification:

```bash
pnpm ci:lint
pnpm ci:typecheck
pnpm ci:test
pnpm ci:python:lint
pnpm ci:python:test
pnpm ci:build
pnpm contracts:check
```

## Branch Flow

- `dev` is default and protected.
- Start coding work from current `origin/dev` in a `feature/*` worktree.
- Merge through a pull request to `dev`; required quality CI must pass.
- `main` is production-only and deploys through `.github/workflows/expense-tax-deploy.yml`.

Read `expense-tax-management/AGENTS.md` and `expense-tax-management/plans/PLAN.md` before implementation.
