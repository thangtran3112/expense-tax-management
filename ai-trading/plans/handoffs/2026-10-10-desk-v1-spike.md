# Handoff: Family Desk v1, Phase 0 Spike and Phase 1 Planning

**Date:** 2026-10-10
**From:** the ai-trading main session that designed Desk v1 and started the spike (session root was the repository root)
**For:** the next ai-trading main session, started with the working directory `ai-trading/`
**Read first:**
- `../AGENTS.md` (shared checkout)
- `AGENTS.md`
- `plans/subplans/02a-desk-v1-strategies-design.md`
- `plans/subplans/02c-desk-v1-implementation-plan.md`
- `plans/subplans/02c-desk-v1-tasks/phase-0-spike.md`
- `plans/subplans/02d-desk-spike-results.md`

Paths below are relative to `ai-trading/` unless they start with `../`.

## Where Things Stand

| Item | State |
|---|---|
| Design | Approved section by section in conversation, then merged to `dev`. Specs: `02a` (Desk v1), `02b` (market data), and a pointer in `02`; decisions are in `STATUS.md` (2026-10-10 rows). |
| Mockups | Paper file "TobyTest" (https://app.paper.design/file/01M4K3AXAKQC8Z6JTW03YR5HEG), page "Family Desk · R2 mockups". Six artboards: D1 Today, D2 Strategies, D3 Paper (desktop); M3 Today, M2 ES chart, M5 Watchlist (mobile). |
| Plan | `02c` master plan with phases 0–7, Global Constraints, Review Focus, Shared Interfaces, and phase outlines. Only Phase 0 has a detailed task file. Each later phase gets its own task file, written with the writing-plans skill and reviewed by the owner before it starts. |
| Phase 0 spike | Tasks 0.1–0.3 are done: desk-side checks, docs research, and the probe tools in `tools/ibkr-probe/` (9 tests, ruff clean). Task 0.4 (owner IBKR setup) is open, and Tasks 0.5–0.6 wait on it. |
| Research notes | Local and gitignored, under `temp/research/`: vendors, brokers, IBKR docs, upstream tools, upstream strategy models |
| Git | Everything this session produced is merged to `dev` (PR #74). No branch, worktree, or uncommitted work is handed over; this file and the merged files are the whole handoff. The main checkout belongs to the ai-trading main session (owner direction, 2026-10-10). |

## Next Steps, in Order

0. **Start a fresh branch from `dev`.**
   - Run `git -C .. status --short --branch`. If the main checkout has changes you did not make, stop and tell the owner (root `../AGENTS.md`).
   - Run `git -C .. fetch origin && git -C .. switch -c feature/ai-trading-desk-p0 origin/dev`. Pick any `feature/ai-trading-*` name.
1. **Ask the owner for Task 0.4** (`phase-0-spike.md`):
   - create the data username and its subscriptions (about $16 per month: $10 + $4.50 + $1.50);
   - check whether that username has its own paper account, and switch on data sharing;
   - create the Flex query and token per IBKR account, and store them in `ai-trading/desk` with `family_config.py set` (the README shows a no-echo way);
   - install IB Gateway on the Mac.
2. **Run Task 0.5** on a weekday in US regular hours, with the owner logged into IB Gateway: the probe commands are in `phase-0-spike.md` and `tools/ibkr-probe/README.md`. Record only masked or aggregate values in `02d`.
3. **Run Task 0.6:**
   - choose one gateway or two (02d check 1);
   - correct 02b's cost line after the first bill;
   - mark Phase 0 done in `02c` and `STATUS.md`;
   - ship it as a pull request to `dev`.
4. **Write `plans/subplans/02c-desk-v1-tasks/phase-1-strategy-core.md`** with the writing-plans skill, from the Phase 1 outline in `02c`.
   - It needs no IBKR access, so write it while Task 0.4 is pending.
   - Get owner review, then execute it with a subagent in a `.worktrees/` worktree (subagent-driven development).
   - Merge the subagent's branch into the main checkout's branch, then remove the worktree.

## Decisions Already Made (do not reopen without the owner)

- **Strategy-first:** every alert and paper order comes from a user-owned, versioned strategy. There are no manual price alerts.
- **Strategy specs:** JSON, with Zod v4 in `ai-trading/contracts` as the source of truth, generating JSON Schema and then Pydantic. YAML was rejected (YAML 1.1 reads `15:55` as a number). The API re-validates every save.
- **Live data:** one IBKR data username, shared by both users across all ai-trading apps. The owner accepted the per-person licensing gray area.
- **History:** free sources (Alpaca historical bars since 2016, Stooq, SEC EDGAR, FRED, Finnhub).
- **Data budget:** at most $30 per month.
- **Paper trading:** IBKR paper, behind the paper guard (`DU` account prefix, the paper port, and a `paper` config).
- **Hostnames and layout:**
  - `trading.tobytran.dev` is the Desk; the hub moves to `trading-hub.tobytran.dev`, replacing `trading-static`.
  - Paper is a tab in the Desk under the same Clerk login.
- **Parked:** Desk v2 (automated live long-term trading) and Desk v3 (automated day trading, 1–10 trades a day). v1 must not block them (02a §15).

## Things the Next Session Should Know

- **Two lanes** (`AGENTS.md` Scope, from PR #77):
  - This is the Family Desk lane: `plans/subplans/02*.md`, the Paper mockups, and the Desk's own directories.
  - The open-source lane owns the hub, the upstream apps, and the hub's move to `trading-hub`. Phase 4 waits for that move; it does not redo it.
  - Do not edit the other lane's files. Keep edits to `plans/STATUS.md` and `AGENTS.md` small and additive.
  - The open-source lane's newest handoff is `plans/handoffs/*trading-hub*`.
- **Shared checkout.** Expense sessions' own `AGENTS.md` says they work on `feature/toby` in the main checkout, but the owner gave the main checkout to the ai-trading main session.
  - The root `../AGENTS.md` now tells every session to check `git status --short --branch` before switching or committing there.
  - Watch for commits on our branch that are not ours, and tell the owner.
  - Push often.
- **Delivery.**
  - Pull requests to `dev` must pass the required "Contracts, services, workers, frontends" check, and auto-merge is disabled. Use `gh pr checks <n> --watch`, then `gh pr merge <n> --squash`. Never pass `--delete-branch`, `--admin`, or force pushes.
  - The ruleset also requires the branch to be up to date with `dev`, and the expense CI takes about 15 minutes, so `dev` often moves during a run. When the merge says "not up to date", run `gh pr update-branch <n>`, wait for the checks again, then merge.
  - Bundle a phase's commits into one pull request to save CI cycles.
  - Commit messages are a single line with no trailer.
  - AGENTS.md's standing delivery authorization covers routine commits, pull requests, merges, scoped `main` releases, and deploys of a requested phase.
- **IBKR facts from the docs** (see 02d):
  - Two-factor login likely applies to paper logins too, so plan for a weekly Monday phone approval.
  - Streaming US stocks over the API needs the $4.50 add-on.
  - IBKR updates arrive every 250 ms (100 ms for options), not every tick.
  - Up to 32 API clients can connect to one gateway.
  - Pacing is 60 historical requests per 10 minutes.
- **VPS headroom** (read-only check): 6 vCPU, 11.4 GiB RAM with 9.4 GiB available, no swap, 35 GB of disk free. Phase 3 memory limits are in 02d check 6.
- **Paper MCP quirks** (for mockup edits):
  - Text nodes do not inherit font or color, so set `font-family: Inter` and a color on every text element.
  - `get_screenshot` often lags one write; take it twice.
  - Use `find_nodes` with `textValue` to locate text.
  - Call `finish_working_on_nodes` when done.
  - Mobbin search does not index Apple's Stocks app by name; Stake's screens are indexed.
- **Secrets.** Read and write only through `../common/config/family_config.py`. Never print values, and never keep `.env` files inside `ai-trading/`. For VPS access, follow `../infrastructure/gcp/family-config/install-reader-key.sh` (`with-file shared/vps VPS_OPERATOR_SSH_PRIVATE_KEY`) and keep commands read-only unless a phase deploys.
- **Upstream submodules** (`packages/*`): never edit them. The four upstream checkouts with full source live in `../.worktrees/ai-trading-hub/ai-trading/packages/`, a parallel session's worktree; read only. The main checkout's submodules are not initialized.
