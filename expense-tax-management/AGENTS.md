# Expense Tax Management Agent Rules

## Architecture

- App API + Foundry: Fastify/Zod/Kysely; separate PostgreSQL ownership.
- Temporal workers: TypeScript only (`services/workflow-worker`); no direct App/Foundry DB access.
- Zod contracts canonical; generated files read-only.
- Customer resources require explicit Personal/business scope authorization; tenant role alone never grants profile access.
- Foundry rejects tenant tokens; platform authorization remains PostgreSQL-owned.
- `expense-service` and `frontend/web` transitional; leave untouched.
- Frontend mockup gates remain app-specific.

## Completed Baseline

Phase 0 baseline, Phase 1A CI, Phase 1B private production deployment/auth, Phase 1C gateway hardening, Phase 1D protected development, and Phase 3B deduplication are complete. Canonical status: `plans/PLAN.md`. Completed implementation detail remains in git history, not live planning files.

## Current Production

- Clerk production + private Cloudflare Tunnel deployed.
- Hosts: `expense.tobytran.dev`, `expense-api.tobytran.dev`, `expense-capture.tobytran.dev`, `expense-office.tobytran.dev`, `expense-foundry.tobytran.dev`.
- Clerk Frontend API: `https://clerk.tobytran.dev`.
- VPS app ports loopback-only; Tunnel connector healthy.
- Production Clerk invitations redirect to `/accept-invitation`; ticket binds signup to invited email.
- Password policy: minimum 8 characters; compromised-password rejection on; complexity rules off.
- Clerk SPF/DKIM CNAMEs verified. DMARC: `_dmarc.tobytran.dev` = `v=DMARC1; p=none; adkim=s; aspf=s`.
- Clerk user/org mappings and Foundry operator roles provisioned; signed webhook delivery/replay verified.
- Authenticated production smoke passed 13/13.
- Release 2026-10-05 (`main` `d7426e5`, expense only; ai-trading stays on `dev`) is deployed: Phases 3B, 3C, 3D-A/B/C (3D inert: `MAILBOX_FEATURE_ENABLED=false`), runtime migration Task 7 Stage A/B, and family-config runtime env (the VPS loads the production profile from Firestore at deploy time).
- Releases 2026-10-06 (#31) and 2026-10-07 (#33, `main` `0a8831b`) are deployed:
  - web session wiring: Capture/Office sessions, scopes endpoint, CORS, auto-upload, public `/privacy`;
  - first-upload fixes: App API 2s job-dispatch loop, Capture duplicate-upload guard, OCR bytes kept out of Temporal history, app-owned storage volumes.
- Expense-only releases now cherry-pick the `dev` squash commits onto `main`, because `dev` carries ai-trading changes in shared paths.
- Shared Temporal `family-temporal` is active (`/opt/family-app/temporal`); legacy Expense Temporal is stopped (`restart=no`).
- Dispatch routing advanced to generation 2 on 2026-10-06. New jobs run on the TypeScript `workflow-worker` (namespace `expense-tax`, queue `expense-tax-processing`); the Python `ai-worker` is idle.
- Real Capture OCR jobs completed on the TypeScript worker on 2026-10-07. Remaining: Stage C Python removal (runbook Phase 3).
- Clerk production Google sign-in uses a custom OAuth client in GCP project `expense-tax-tobytran-2026` (Google Auth Platform app `Family Expense Tax`, published "In production"). Its ID/secret live in Firestore `expense-tax-management/ops` (`CLERK_GOOGLE_OAUTH_CLIENT_*`).

## Boundaries

- Preserve unrelated worktree changes, especially `plans/mockups/**`; stage exact paths only.
- Never inspect, print, commit, or expose secrets.
- Keep runtime and migration DB credentials separate.
- Do not edit generated contracts/clients directly.
- Use tests first for behavior changes; config-only changes need direct verification.
- Smallest correct diff.
- Production is the only environment until commercialization (no dev or staging); local runs and the VPS are both production, except that local frontends keep Clerk development keys because Clerk rejects production keys on `localhost`.

## Env and Secrets

- Single source for all family-app env and secrets: Firestore `family-config` (`tobytran-portfolio`): `shared/*` reused values, `apps/<app>/profiles/<profile>` app env; access only via `common/config/family_config.py`.
- Laptop and VPS mirror: both load env at runtime through that CLI; no env/key files in the repo; GitHub keeps CI copies only, refreshed from Firestore.

## Authorization

- Explicit Personal/business scope on every customer resource.
- Reject Foundry tenant tokens in every auth path.
- Treat graph output as navigation evidence, never authorization proof.

## Git Safety

- Default working branch is `feature/toby`; work directly on it permanently, across sessions.
- Use a separate git worktree with its own throwaway `feature/*` branch only when a worktree is explicitly requested for that session.
- Before starting new work on `feature/toby`: `git fetch origin`, then fast-forward `feature/toby` onto `origin/dev` (it carries no unmerged unique history once its prior PR is merged).
- Never commit directly on `dev` or `main`.
- Push `feature/toby` (or the explicitly requested worktree's branch), then open a pull request to `dev`.
- Unit/quality check must succeed before merge.
- Integration result is advisory and must be reported when red.
- GitHub CLI merge is authorized after the required check is green and the PR is mergeable, squash merge is enabled, and the branch includes current `origin/dev`; use squash merge.
- After a squash merge, `feature/toby` diverges from its now-merged commits; fast-forward it onto the new `origin/dev` tip (or reset+force-push `feature/toby` specifically if fast-forward is not possible) before the next round of work. Never force-push `dev` or `main`.
- Never bypass branch protection.
- `main` remains outside the development flow until a later release phase.
- Personal repository standing approval: agents may push `feature/*` branches, open pull requests to `dev`, and squash-merge them into `origin/dev` without execution-time confirmation once the merge conditions above hold.
- Conserve GitHub Actions minutes: stack commits locally, push only after local verification, and open exactly one pull request per phase; avoid extra pushes to an open pull request unless CI fails.
- Every other remote write still needs explicit execution-time confirmation immediately before the command: anything targeting `main`, workflow dispatch, ruleset or default-branch changes, and force-pushes other than `feature/toby` resets.
- Preserve unrelated worktree changes, especially `plans/mockups/**`; stage exact paths only.
- Never inspect, print, commit, or expose secrets.
- Inspect status and diff before editing; never revert unrelated changes.

## Verification

- Report commands and exact outcomes.
- Do not run `opencode debug config`; resolved output may expose provider secrets.
- Restart opencode after project config/agent/rule changes.

## Infrastructure Policy

- Production mutation requires explicit deployment approval.
- VPS hosts APIs, Temporal, workers, and stateful orchestration; no always-on GCP compute.
- Production GCP owns the Cloudflare Terraform WIF and state; family config lives in Firestore `family-config` (`tobytran-portfolio`); Phase 3D mailbox broker runs as a VPS container; no new GCP compute.
- Temporal database bootstrap remains an explicit operator-only Task 8; normal deploy never runs `bootstrap-temporal-db.sh`.
- Current infrastructure sources: `infrastructure/vps/`, `infrastructure/cloudflare/expense-tax/`, `.github/workflows/expense-tax-deploy.yml`.
