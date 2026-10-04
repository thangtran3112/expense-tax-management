# Expense Tax Management Agent Rules

## Architecture

- App API + Foundry: Fastify/Zod/Kysely; separate PostgreSQL ownership.
- Python: Temporal worker only; no direct App/Foundry DB access.
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
- Phase 3B deduplication is deployed. Phase 3C is implemented on `dev` but not deployed. Phase 3D-A, 3D-B, and 3D-C are implemented on `dev` but not deployed. All of 3D stays inert in production (`MAILBOX_FEATURE_ENABLED` unset) pending operator activation; 3D-B/3D-C production use additionally requires the runtime migration Task 7 operator cutover below.
- Temporal dispatch routing is data-driven (Task 7 Stage A, `app.temporal_dispatch_routing`): generation 1 = legacy Python routing (namespace `default`, queue `expense-tax-ai-worker`) until an operator runs `advance` (Stage B). `dev` no longer hardcodes `expense-tax-processing` for new jobs, so the prior release hazard is resolved. Task 7 Stage B source is merged: `workflow-worker` ships idle in production Compose alongside `ai-worker`; the remaining operator cutover sequence (shared Temporal activation, non-production smoke, `advance`, drain) and Stage C Python removal are not yet executed.

## Boundaries

- Preserve unrelated worktree changes, especially `plans/mockups/**`; stage exact paths only.
- Never inspect, print, commit, or expose secrets.
- Keep runtime and migration DB credentials separate.
- Do not edit generated contracts/clients directly.
- Use tests first for behavior changes; config-only changes need direct verification.
- Smallest correct diff.

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
- Current production GCP owns Secret Manager/IAM/GitHub OIDC/WIF; Phase 3D mailbox broker runs as a VPS container; no new GCP compute.
- Secret Manager production bundle retains exactly one non-destroyed version.
- Temporal database bootstrap remains an explicit operator-only Task 8; normal deploy never runs `bootstrap-temporal-db.sh`.
- Current infrastructure sources: `infrastructure/vps/`, `infrastructure/cloudflare/expense-tax/`, `.github/workflows/expense-tax-deploy.yml`.
