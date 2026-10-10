# family-app Agent Rules

Project rules live in `ai-trading/AGENTS.md` and `expense-tax-management/AGENTS.md`. This file only covers the git checkout that all sessions share.

## Shared Git Checkout

- Several coding sessions work in this repository at the same time.
- The owner assigns the main checkout (`/Users/tobytran/personal/family-app`) to one main session. Other sessions and all subagents use worktrees under `.worktrees/`.
- Before you switch branches, reset, stash, or commit in the main checkout, run `git status --short --branch`.
- If the main checkout is on another session's branch or has changes you did not make:
  - do not switch, reset, stash, or commit there;
  - use your own worktree;
  - tell the owner.
- Remove your own worktree after its branch is merged.
