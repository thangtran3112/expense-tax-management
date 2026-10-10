# family-app Agent Rules

Project rules live in `ai-trading/AGENTS.md` and `expense-tax-management/AGENTS.md`. This file only covers the git checkout that all sessions share.

## Shared Git Checkout

- Several coding sessions work in this repository at the same time.
- The main checkout (`/Users/tobytran/personal/family-app`) always stays on `feature/toby`. Never switch it to another branch or leave it detached.
- The owner assigns the main checkout to one main session, which works directly on `feature/toby` there.
- Other sessions and all subagents use worktrees under `.worktrees/`, each on its own `feature/*` branch. A worktree never checks out `feature/toby`.
- Before you reset, stash, merge, or commit in the main checkout, run `git status --short --branch`. If it shows changes you did not make:
  - do not touch them;
  - use your own worktree;
  - tell the owner.
- Remove your own worktree after its branch is merged.
