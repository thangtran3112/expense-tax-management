# Handoff: Trading Hub lane (open-source apps)

**Date:** 2026-10-10 (second session of the day; replaces the first session's handoff, which stays in git history)
**For:** the next Trading Hub session, started in `ai-trading/`
**Read first:** `ai-trading/AGENTS.md` (rules, hostnames, lanes), root `AGENTS.md` (shared checkout, Actions minutes), `ai-trading/plans/STATUS.md`, `ai-trading/deploy/production/README.md`

## 1. Start here

- Main sessions work in the main checkout on `feature/toby` (root `AGENTS.md`); worktrees only with the owner's approval, or for subagents.
- `git -C .. status --short --branch`, then `git -C .. fetch origin && git -C .. merge origin/dev`. Never reset or rebase `feature/toby`.
- One PR per finished phase or meaningful batch (Actions minutes). Docs ride along with the next phase's PR.
- Upstream submodules are not checked out by default: `git submodule update --init --depth 1 ai-trading/packages/<app>` before building their images. The `web` image and `pnpm build` need `CLERK_PUBLISHABLE_KEY` / `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (public; `common/config/family_config.py get ai-trading/clerk PUBLISHABLE_KEY`). Auth tests need `npm ci` first. Docker on the Mac cannot mount the session temp dir: use `ai-trading/temp/` (gitignored).

## 2. State (verified live, end of session)

| Area | State |
|---|---|
| Production | `main` image tag `c4db662`: all eight containers healthy, zero restarts, MiroFish on. Expense untouched. Disk about 29 GB free (the next deploy prunes the previous tag first). |
| Hostnames (01l, done) | `trading-hub.tobytran.dev` = hub (Worker + GCS); `tradingagents.` / `ai-hedge-fund.tobytran.dev` = full-screen terminals behind the Caddy/Clerk gate (signed-out navigation → hub login with `returnTo`); `trading-static` removed; `trading.tobytran.dev` still serves the hub from `web:3000` until Desk Phase 4. `ALLOWED_ORIGINS` in Firestore is now `trading` + `trading-hub` (the running `auth.env` still lists `trading-static` until the next deploy renders it; harmless, it no longer resolves). Clerk instance needs no origin list (`allowed_origins` empty). |
| MiroFish | Deploys keep it in its current state (`MIROFISH_ACTIVATE=keep`); `activate_mirofish` / `stop_mirofish` dispatch inputs turn it on or off. No more manual re-dispatch or `[skip ci]` dance. |
| Gateway | `deploy.sh` labels the gateway with the Caddyfile's sha256, so a changed Caddyfile recreates it. Before this, Caddyfile changes never reached the running gateway (single-file bind mount keeps the old inode). |
| PRs this session | #83 root AGENTS.md; #84/#86 MiroFish keep; #90/#91 hub move; #93/#94 gateway recreate. All merged to `dev` and released. |

## 3. Next work, in order

1. **01m market-data adapter** (owner-approved spec `plans/subplans/01m-market-data-adapter.md`; plan `plans/subplans/01m-market-data-adapter-plan.md`, written, not yet reviewed by the owner). Ask the owner to review the plan and pick an execution method. It rules one deviation from the spec: `period` other than `ttm` returns 501 in v1. Owner gates before go-live: a free Alpaca account and data key pair, and the SEC contact string (both into Firestore `ai-trading/market-data`; the plan's Task 6 has the commands). Create `MARKET_DATA_TOKEN` and the profile **before** the deploy that adds `market-data.env`, or `render_profiles` fails the whole deploy.
2. **Owner Safari check** on `trading-hub` (sign-in, reload, quit/reopen), the last open 01h Task 10 item for the new hostname.
3. **After Desk Phase 4 takes `trading.tobytran.dev`:** remove the `web` service and the four `hub_hostname` tunnel entries if Phase 4 did not.
4. Weekly Dependabot upstream bumps (sync skills under `.opencode/skills/`); MiroFish public hostname still open (staging `mirofish-static`).

## 4. Recipes

**Release a phase:** PR from `feature/toby` to `dev` (required check `Contracts, services, workers, frontends`; `gh pr update-branch` if `BEHIND`; merge with `--match-head-commit`). Then a scoped release to `main` of exactly the phase's paths with `build-release.sh` (Appendix B), PR to `main`, squash-merge. The push deploy keeps MiroFish. Infra changes: `gh workflow run ai-trading-infra.yml --ref main -f apply=true` after reading the push run's plan. Static hub: `gh workflow run ai-trading-deploy.yml --ref main -f upload_hub_static=true`.

**Reach the VPS** (from the repo root): `common/config/family_config.py run ai-trading/deploy -- common/config/family_config.py with-file shared/vps VPS_DEPLOY_SSH_PRIVATE_KEY -- python3 vps-run.py {} remote-script.sh`.

**Live checks used this session:** container state, image tag, restarts, disk, expense container count via `docker ps`/`docker inspect`; public probes with `curl -A '<browser UA>'`; signed-in checks in the agent browser (`agent-browser`, CDP via `browser-harness-js`): WebSocket 101 on `/u/*/ws` through `trading-hub` and on `/ws` at both terminal hostnames, and the `/login?returnTo=` round trip.

## 5. Pitfalls

- A Caddyfile-only change needs a deploy to reach the gateway (now automatic via the label); verify with `docker exec ai-trading-gateway-1 grep ... /etc/caddy/Caddyfile`.
- Releases that touch `infrastructure/cloudflare/**` also start `Expense Tax Cloudflare` on `main`; it only plans on push (apply needs a manual dispatch), so it cannot change expense resources.
- Tunnel ingress is a list: inserting entries shows the later ones as positional changes in `terraform plan`; check that the `trading.tobytran.dev` entries and `tunnel["hub"]` are not in the diff.
- `docker rmi` without `-f` is the prune's safety net; never run a global prune (shared VPS).

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
