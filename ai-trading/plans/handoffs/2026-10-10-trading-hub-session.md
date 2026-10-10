# Handoff: Trading Hub lane (open-source apps)

**Date:** 2026-10-10
**From:** the Trading Hub session (worktree `.worktrees/ai-trading-hub`, removed after its last merge)
**For:** the next Trading Hub session, started in `ai-trading/` of its own worktree
**Read first:** `ai-trading/AGENTS.md` (rules, hostnames, lanes), `ai-trading/plans/STATUS.md` (tracker), `ai-trading/deploy/production/README.md` (runbook)

## 1. Start here

The main checkout (`/Users/tobytran/personal/family-app`) belongs to the Family Desk session (branch `feature/ai-trading-desk-v1` on 2026-10-10). Do not switch, reset, stash, or commit there. Start your own worktree and work in its `ai-trading/` folder:

```bash
cd /Users/tobytran/personal/family-app           # read-only use of the main checkout
git status --short --branch && git worktree list # whose branch is this? who else is running?
git fetch origin
git worktree add .worktrees/<task> -b feature/ai-trading-<task> origin/dev
cd .worktrees/<task>/ai-trading                  # open (or session_move) your session here
git submodule update --init --depth 1 ai-trading/packages/<app>   # only the upstream apps you need to read
```

Remove the worktree and its local branch as soon as its pull request merges (`git -C /Users/tobytran/personal/family-app worktree remove --force .worktrees/<task>`; `--force` is needed because submodules are checked out).

Rules that bite (all in `ai-trading/AGENTS.md`): never edit `packages/*`; never print secrets; Vibe-Trading is direct OpenAI only; the owner's standing delivery authorization covers PR to `dev`, scoped release to `main`, deploy, and live verification, not paid purchases or the gated items in section 4. `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` are sponsored: use them freely for tests and live checks.

## 2. State at the end of this session (verified live)

| Area | State |
|---|---|
| Production | Images `c9b7df5` (main at the disk-guard release): `ta-terminal`, `ahf-terminal`, `vibe-trading`, `auth`, `web`, `mirofish` healthy with zero restarts; `gateway` and `cloudflared` untouched; the expense stack is never touched by this lane (it was healthy; its own release deployed separately at 16:41-16:44 UTC). MiroFish is enabled (`deploy_app=true`, `activate_mirofish=true`). |
| Terminals | The launcher (`deploy/upstream/terminal/session.sh`) keeps output after a run ends, prompts "Press Enter to start another analysis", never reruns on reconnect, and exits on EOF. The real tmux lifecycle test (`deploy/upstream/terminal/test-session-lifecycle.py`) passes inside both production terminal containers. |
| Vibe-Trading | Direct OpenAI `gpt-5.5` (`shared/llm:OPENAI_API_KEY_1`), enforced by `deploy/upstream/vibe-trading/start-vibe.py`. Verified: adapter and `/settings/llm` agree, no OpenRouter value, key not copied to settings, one real completion. |
| Disk | The 96 GB VPS disk filled on the first deploy attempt (each release is about 17 GB; MiroFish's backend alone is 12.5 GB with no shared layers; old tags were never removed). Fixed by `deploy.sh` (PR #72): prunes old commit-tagged `ai-trading-*` images, keeps the release and `last-good-tag`, refuses to start below `AI_TRADING_MIN_FREE_GB` (default 30) free. Verified live after the `c9b7df5` deploy: it pruned `ee15c11` by itself (only `c9b7df5` and the rollback target `aab45c1` remain), the disk is 66% used with 34 GB free, the deployed `deploy.sh` equals `main`'s, and on the real host its guard refuses a 100000 GiB requirement and passes 1 GiB. The next deploy prunes `aab45c1` first, so it starts with about 50 GB free. |
| PRs this session | #69 terminal/Vibe fix, #70 release, #71 sponsored-key note, #72 disk guard, #76 its release, and the docs PR that carries this handoff (hostnames, lanes, status, the 01k proposal). |

## 3. Next work, in order

1. **Root `AGENTS.md`.** The Desk session's PR #74 (check whether it has merged) adds a root `AGENTS.md` with the "Shared Git Checkout" rules and rewrites the Git bullet of `ai-trading/AGENTS.md`. I did not add a competing root file, and my edits to `ai-trading/AGENTS.md` and `STATUS.md` avoid its lines (a dry-run merge of the two branches was clean; whichever lands second only needs `gh pr update-branch`). Once their root file is on `dev`, add the package map, "Everywhere" rules, and parallel-session etiquette from Appendix A as an additive PR.
2. **Decide how Vibe-Trading (and MiroFish) are reached** (section 4, question 1). Nothing to build until the owner answers.
3. **Hub hostname move to `trading-hub.tobytran.dev`** (the Desk takes `trading.tobytran.dev`; Desk plan `02a` §8). Design first, then the cutover order from the plan: bring up `trading-hub`, pass the staging checks on it, then free `trading.tobytran.dev`. Touchpoints found by grep on 2026-10-10:

   | Where | What changes |
   |---|---|
   | `ai-trading/auth/src/clerk.js` | `CLERK_AUDIENCE` is the constant `https://trading.tobytran.dev`; the hub and the Desk will be two hosts under one Clerk login, so decide per-host audiences (tests: `clerk.test.js`, `origin.test.js`, `server.test.js`) |
   | Clerk instance (API or dashboard) | allowed origins, session-token `aud` claim, cookie domain; the `clerk-cli` skill can do the API part |
   | Firestore `ai-trading/gateway` | `ALLOWED_ORIGINS` |
   | `infrastructure/cloudflare/ai-trading/` | `variables.tf` (hub hostname), `hub-static-variables.tf` (`trading-static`, `trading-origin`), `main.tf` (tunnel ingress), Worker routes, `README.md` |
   | `infrastructure/cloudflare/ai-trading/workers/mirofish-static.js` | `HUB_LOGIN_URL` redirect (and its tests) |
   | `ai-trading/frontend/` | `lib/apps.ts` (Desk card links to `trading.tobytran.dev`), `static-server.mjs` comment |
   | `ai-trading/deploy/production/` | `Caddyfile` host blocks, `README.md` URL table and acceptance checklist; ttyd origin checks |

   The public Worker cutover still needs the separate approval and auth-limit review recorded in `STATUS.md` (copied-cookie, cross-tab refresh, open-stream expiry limits). The Desk plan's fallback if the move fails: stay on `trading-static`.
4. **ai-hedge-fund without a Financial Datasets key:** `plans/subplans/01k-ai-hedge-fund-data-options.md` (proposal). Recommended: point `FDClient.BASE_URL` at the Desk's `/api/data` from the wrapper image; needs the Desk lane's data layer and an FD-shaped `/api/data` surface. Waits for the owner.
5. **Weekly Dependabot upstream bumps** (sync skills under `.opencode/skills/`), and the pending MiroFish public hostname/Worker cutover.

## 4. Open questions for the owner

1. **Why does Vibe-Trading have its own hostname; should every app be a route on `trading-hub`?** Answered in `STATUS.md` (Release 1 Build Notes). Short version: upstream Vibe calls its API through a hard-coded `BASE = ""` (everything root-relative: `/api`, `/auth/sse-ticket`, `/sessions`, `/swarm`, `/settings`, `/options`, ...), has no router `basename` and no backend prefix support, and sends `X-Frame-Options: DENY`. As a route it would collide with `/api/*` and cannot be embedded. Terminals are routes because ttyd has `--base-path`. Recommended: keep Vibe on its own hostname and link to it from the hub. Alternatives: patch at image-build time (breaks "unmodified upstream", re-verify every bump) or a rewriting proxy (brittle with SSE/WebSocket). MiroFish looks feasible as a route (build-time `VITE_API_BASE_URL`, no router base) after a spike.
2. `ai-hedge-fund.tobytran.dev` does not exist (no DNS). ai-hedge-fund and TradingAgents are terminal routes on the hub host. Does the owner want dedicated hostnames for them?
3. Should a push deploy keep MiroFish on when it is already running? Today a push deploy (or any dispatch without `activate_mirofish=true`) stops it, so every release needs a manual MiroFish-enabled dispatch. A small `deploy.sh` change (activate when a `mirofish` container is running) would remove the dance and the cross-lane hazard below; it changes the owner's opt-in design, so ask first.
4. Choice of option for the ai-hedge-fund data source (01k).

## 5. Recipes

**Release a phase** (the standing authorization covers all of it):

1. PR to `dev`. The ruleset requires only the check `Contracts, services, workers, frontends`, and the branch must be current: if `gh pr view` says `BEHIND`, run `gh pr update-branch <n>`, wait for that check, then `gh pr merge <n> --squash --match-head-commit <head sha>`. The 30-minute `Images and smoke tests` job is not a required check, but let it finish on the change itself before you update the branch; a merge of unrelated `dev` commits needs only the required check again.
2. Release to `main` carrying only the phase's `ai-trading/` paths, taken verbatim from `origin/dev` (Appendix B, `build-release.sh`). `main` has no protection and no PR checks, so the release PR merges at once.
3. Put `[skip ci]` in the squash-merge message so the push does not start an automatic deploy (which would stop MiroFish), then dispatch: `gh workflow run ai-trading-deploy.yml --ref main -f deploy_app=true -f activate_mirofish=true -f upload_hub_static=false -f upload_mirofish_static=false`. Verified on release #76 (2026-10-10): the squash commit `c9b7df5` started no workflow, and the manual dispatch ran normally; GitHub documents that `[skip ci]` only affects `push` and `pull_request` runs.
4. Verify live (below). Pushes to `main` that touch `ai-trading/**` (except `plans/` and `*.md`), `.gitmodules`, the deploy workflow, or `common/config/**` start an automatic MiroFish-off deploy; an expense release that touches `common/config/**` would do it too. After any such push, check MiroFish and re-dispatch if it was stopped.

**Reach the VPS** (read-only checks and one-off scripts), from the repo root of any checkout; the runner is in Appendix B:

```bash
common/config/family_config.py run ai-trading/deploy -- common/config/family_config.py \
  with-file shared/vps VPS_DEPLOY_SSH_PRIVATE_KEY -- python3 vps-run.py {} remote-script.sh
```

**Live verification** (what this session asserted, all through `docker exec`/`docker inspect` on the VPS, never printing values): `images.env` and `last-good-tag` equal the release; each app container is `running`, `healthy`, zero restarts, image tag equals the release; only the release and the previous good tag remain as `ai-trading-*` images; expense containers unchanged; provider keys inside the containers match Firestore via `secrets.compare_digest` fed on stdin; Vibe `/settings/llm` (with its `API_AUTH_KEY` from the container env) reports `openai`, `gpt-5.5`, `https://api.openai.com/v1`, key configured, nothing copied to the persisted `.env` (mode 600), and one real `build_llm().invoke(...)` returns; run `test-session-lifecycle.py` inside both terminal containers (`docker exec -i <container> python - < file`). Public (checked after `c9b7df5`): `trading.tobytran.dev` 200 and `/apps/vibe-trading` 200, the terminal routes and `vibe-trading.tobytran.dev` 401 without a session. Use `curl` with a browser User-Agent; Python `urllib` gets an edge 403.

## 6. Pitfalls we hit

- A full disk breaks the pull and the env-file rollback. If `deploy.sh` ever fails mid-rollback, check `/etc/family-app/ai-trading` (a failed `install` can leave a zero-byte temp file) and `images.env` before anything else. A residual gap: `restore_or_remove_secrets` aborts the rest of the rollback if one restore fails.
- `docker rmi` without `-f` refuses images any container uses; that is the prune's safety net. Never run a global prune: the expense stack shares the host (`/var/lib/docker` also held about 200 mostly-expense images and 4 GB of journal logs; tidying those is the owner's call).
- Each MiroFish image build produces new layers, so every deploy re-pulls about 12.5 GB. A reproducible build would remove that cost.
- `dev` ruleset is strict: any new commit on `dev` makes an open PR `BEHIND`, which restarts the required check.
- The OpenCode docs for V2: only `AGENTS.md` is read; `opencode.json` `instructions` and `CLAUDE.md` do nothing; nested `AGENTS.md` load when a file below them is read.
- The scripts in Appendix B live here because a session's temp directory does not survive. Remote `feature/*` and `release/*` branches from this session were left in place; only worktrees and local branches are removed.

## Appendix A: additions for the root `AGENTS.md` (after the Desk session's file lands)

```md
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
Stay inside your area, follow any plan another session has published in the repo, keep edits to shared files (such as `ai-trading/plans/STATUS.md`) small and additive, rebase before you push, and never stage or revert another session's changes.
```

## Appendix B: scripts used this session (recreate them in a temp directory, not in the repo)

`build-release.sh <release-branch> <commit-title> <path>...` builds a commit on `origin/main` carrying only the listed paths from `origin/dev`, without touching any working tree, and pushes the branch; then open a PR to `main` from it.

```sh
#!/bin/sh
set -eu
branch=$1 title=$2; shift 2
git fetch -q origin dev main
idx=$(mktemp -u "${TMPDIR:-/tmp}/release-index.XXXXXX"); export GIT_INDEX_FILE=$idx
git read-tree origin/main
for p in "$@"; do
  entry=$(git ls-tree origin/dev -- "$p" | cut -f1)
  [ -n "$entry" ] || { echo "not on origin/dev: $p" >&2; rm -f "$idx"; exit 1; }
  git update-index --add --cacheinfo "$(printf '%s' "$entry" | awk '{print $1","$3}'),$p"
done
tree=$(git write-tree); rm -f "$idx"; unset GIT_INDEX_FILE
[ "$tree" != "$(git rev-parse 'origin/main^{tree}')" ] || { echo "no changes versus origin/main" >&2; exit 1; }
commit=$(git commit-tree "$tree" -p origin/main -m "$title")
git push -q origin "$commit:refs/heads/$branch"
git diff --stat origin/main "$commit"
```

`vps-run.py` runs one reviewed shell script as root on the VPS over the deploy key, with strict host-key checking:

```python
import os, pathlib, subprocess, sys, tempfile
key_file, script = sys.argv[1:3]
cli = str(pathlib.Path.cwd() / "common/config/family_config.py")
hosts = subprocess.run([cli, "get", "shared/vps", "VPS_SSH_KNOWN_HOSTS"], capture_output=True, text=True, check=True).stdout
with tempfile.NamedTemporaryFile("w", suffix=".known_hosts", delete=False) as f:
    f.write(hosts); known = f.name
try:
    r = subprocess.run(["ssh", "-F", "/dev/null", "-i", key_file, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                        "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + known, "-p", os.environ["VPS_PORT"],
                        os.environ["VPS_USER"] + "@" + os.environ["VPS_HOST"], "sudo -n sh -s"],
                       input=pathlib.Path(script).read_text(), capture_output=True, text=True, timeout=900)
    print(r.stdout); print(r.stderr, file=sys.stderr); sys.exit(r.returncode)
finally:
    pathlib.Path(known).unlink(missing_ok=True)
```
