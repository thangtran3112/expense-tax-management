# Upstream Sync Skills and Divergence Policy

Status: Approved by owner on 2026-10-05. Applies to the four upstream git submodules in [the Trading Hub design](01-release-1-hub-design.md). Family Desk code lives outside all submodules.

## Goal

Keep TradingAgents, ai-hedge-fund, Vibe-Trading, and MiroFish as close to each author's upstream release as possible. Give the coding agent one discoverable, project-local sync skill per upstream. Updating one upstream must not accidentally rewrite or commit inside another. Each update is a reviewed change to its gitlink and any **external** deployment adapter that upstream changes require.

## Skill placement and triggers

Create exactly four opencode project skills under the **family-app repository root** (`family-app/.opencode/skills/`, not `ai-trading/.opencode/skills/`):

| Skill | Triggers | Submodule path | Source |
|---|---|---|---|
| `.opencode/skills/sync-tradingagents/SKILL.md` | update/sync TradingAgents | `ai-trading/packages/trading-agents` | `TauricResearch/TradingAgents` |
| `.opencode/skills/sync-ai-hedge-fund/SKILL.md` | update/sync ai-hedge-fund | `ai-trading/packages/ai-hedge-fund` | `virattt/ai-hedge-fund` |
| `.opencode/skills/sync-vibe-trading/SKILL.md` | update/sync Vibe-Trading | `ai-trading/packages/vibe-trading` | `HKUDS/Vibe-Trading` |
| `.opencode/skills/sync-mirofish/SKILL.md` | update/sync MiroFish | `ai-trading/packages/mirofish` | `666ghj/MiroFish` |

The MiroFish skill becomes usable **after** the MiroFish submodule is added; before then it reports that dependency rather than inventing a local checkout. The same commit that adds that submodule updates `ai-trading/AGENTS.md` from three to four protected upstream paths. Each skill has valid YAML frontmatter (`name`, `description`) and a short README-style body. The description triggers only for its own upstream; an unrelated task must not activate it. No global opencode config change is needed for project-local `.opencode/skills/`. Restart opencode after the skills land so the running session discovers them.

## Shared workflow every skill teaches

1. Identify the monorepo/worktree and its branch. Read `ai-trading/AGENTS.md`, `.gitmodules`, `plans/STATUS.md`, and this skill's tracked pin. Refuse to alter a dirty superproject or dirty target submodule; never stash, reset, discard, or force-push user changes.
2. Fetch the correct upstream remote. Compare old pin with candidate revision (commit log and diffs of Dockerfile, lockfiles, configuration defaults, API routes, migration files, license/notice, and relevant workflows). Report breaking changes and new required keys before moving the gitlink. Do not adopt an upstream `latest` image unrelated to the pin.
3. For an unmodified upstream, move only that submodule to the selected remote commit; keep the original URL and remote. Do not edit its source or commit inside it. If tests/build or external adapters break, restore the original pin only when the submodule remains otherwise clean, and report the failure.
4. Run focused verification using the repo's existing Bake/CI smoke scripts with fake provider keys; no paid simulations/trades or live broker access. Include a package-specific check:
   - TradingAgents: CLI import/help and browser terminal 407/200/302 checks.
   - ai-hedge-fund: CLI help, Textual browser terminal and lockfile compatibility.
   - Vibe-Trading: `/live`, Bearer auth, same-site/hostile-origin checks, static UI build.
   - MiroFish: original Vue static build, single-process Flask `/health` with dummy keys, unchanged API routes, and upload-volume assumptions. Do not call Zep or the LLM in CI. Keep AGPL-3.0 source/license links pinned to the deployed revision.
5. Summarize old/new SHA, upstream changes, adapter changes, exact check results, and any activation gate. Do not commit, push, open a PR, merge, publish, or deploy unless the user's request or repo policy explicitly authorizes that action. Never touch another app's pin.

## Divergence protocol

Upstream pin bumps need no divergence file. Deployment wrappers, Terraform, the Family Desk backend, and local docs **outside** the submodules are not upstream forks. If an upstream-source edit becomes unavoidable:

1. Explain why a wrapper/config change will not work and get the owner's decision to fork.
2. Fork that specific upstream repository, point its submodule URL to the fork and put `DIVERGENCE.md` **inside that fork** in the same commit as its first source change. A local commit inside an original upstream submodule cannot be fetched by CI or other family members and is not acceptable.
3. `DIVERGENCE.md` records the upstream URL and base commit, each modified path and rationale, how to reapply/drop the change on a future sync, tests run, and the new upstream base after reconciliation. It includes the exact command `git remote add upstream <original-url>` for a fresh clone and instructs the sync skill to re-add/verify that remote idempotently. The fork's local remotes are not stored in `.gitmodules`. MiroFish modifications additionally require an AGPL-3.0 source-availability review. No divergence file is added to an untouched upstream repo.
4. Update `.gitmodules`, test the fork, and record the decision in `plans/STATUS.md`. Sync against the original upstream remote; never force-push an upstream branch.

## Verification of the four skills

Use the skill-creator and writing-skills workflows on **each** skill: a disposable baseline scenario before drafting, a skill-guided scenario after drafting, and a focused correction if an agent would advance a dirty submodule, lose a fork patch, skip a required source/license notice, or push without authorization. Test the four skills independently, in parallel in separate fixture worktrees under `ai-trading/temp/`; remove only those disposable worktrees after collecting the results. Check frontmatter, names and OpenCode discovery; no real upstream pin moves or network writes are needed to test them.

## Later Family Desk

Release 2 introduces a separate backend that selectively combines the first three repositories' useful patterns and modules with attribution. It does not replace their untouched upstream deployments or feed MiroFish into trading logic. Reuse via direct upstream dependencies where feasible, or small adapted modules with license notices; a change to the Family Desk is **not** a divergence of an upstream submodule.
