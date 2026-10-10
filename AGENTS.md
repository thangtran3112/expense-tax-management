# family-app Agent Rules

Each package's rules live in its own `AGENTS.md` (see "Package rules"). This file covers the git checkout that all sessions share and the rules that apply everywhere.

## Shared Git Checkout

- Several coding sessions work in this repository at the same time.
- **Main sessions work in the main checkout (`/Users/tobytran/personal/family-app`) on the local branch `feature/toby`.** Never switch it to another branch or leave it detached.
- **Worktrees for a main session are opt-in** (owner rule, 2026-10-10). By default a main session works in the main checkout and never opens a worktree on its own judgment. It uses one only with the owner's explicit instruction or approval, for example when the owner wants more parallelism.
- Subagents work in worktrees, under `.worktrees/`, each on its own `feature/*` branch. The main session merges the subagent's branch into `feature/toby`, then removes the worktree and deletes the branch.
- Before you commit, merge, stash, or reset in the main checkout, run `git status --short --branch`. Stage exact paths only; never stage, stash, or discard changes you did not make. If another session's changes are in the way, stop and tell the owner.
- A reset of `feature/toby` discards every session's commits that are not on `dev` yet. Before any reset, check `git log origin/dev..feature/toby` for other sessions' commits; if there are any, ask the owner.

## Package rules

Start a session inside the package you are changing. Each package's `AGENTS.md` governs that package only; where rules conflict, the package being edited wins. Never apply one app's branch, release, or deploy policy to another.

| Path | What | Rules |
|---|---|---|
| `ai-trading/` | Trading Hub (open-source apps) and the Family Desk | `ai-trading/AGENTS.md` |
| `expense-tax-management/` | Expense and tax apps | `expense-tax-management/AGENTS.md` |
| `infrastructure/` | Terraform, VPS bootstrap, shared compose, backups | `infrastructure/README.md` |
| `common/config/` | Firestore `family-config` CLI | `common/config/README.md` |
| `docs/superpowers/` | Cross-app specs and plans | n/a |

## Everywhere

- Public repo: never commit or print secrets, email addresses, account numbers, or VPS addresses.
- All secrets and env values live in Firestore `family-config`, read and written only through `common/config/family_config.py`. No `.env` or key files in the repo.
- Infrastructure is code under `infrastructure/`; no console edits. GCP commands use `CLOUDSDK_ACTIVE_CONFIG_NAME=personal`. One shared Cloudflare token (`shared/cloudflare`): never create another.
- One shared VPS: touch only your own app's containers, images, and volumes; never run a global `docker system prune`.
- Never commit to or force-push `dev` or `main`; work reaches `dev` by pull request; `main` releases carry only the owning package's paths. Delivery authorization is per package.

## Parallel sessions

Stay inside your area, follow any plan another session has published in the repo, keep edits to shared files (such as `ai-trading/plans/STATUS.md`) small and additive, merge `origin/dev` before you push, and never stage or revert another session's changes.
