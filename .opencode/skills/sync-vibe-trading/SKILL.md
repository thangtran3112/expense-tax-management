---
name: sync-vibe-trading
description: Use when asked to update, sync, bump, or check the Vibe-Trading upstream pin in ai-trading/packages/vibe-trading (HKUDS/Vibe-Trading), including "is vibe-trading behind upstream", "bump the vibe-trading submodule", or a Dependabot PR touching that path. Does not trigger for TradingAgents, ai-hedge-fund, MiroFish, or Family Desk work.
---

# Sync Vibe-Trading

Vibe-Trading (`ai-trading/packages/vibe-trading`, upstream
`HKUDS/Vibe-Trading`, MIT + NOTICE) is deployed unmodified on its own
hostname (framing forbidden upstream). Keep it byte-for-byte identical to
upstream — only the pinned commit, and its two already-hash-pinned
lockfiles when upstream's own commit carries them, ever move.

## 0. Status question or sync request?

A status question ("is vibe-trading behind upstream?") makes **no
worktree, gitlink, remote-creation, or submodule-`HEAD` edit** — step 3 may
still update local `refs/remotes/{origin,upstream}/*` via fetch (refs, not
files). Mark `REQUEST_KIND=status` or `REQUEST_KIND=sync` before step 3.
Only "sync/update/bump vibe-trading" authorizes step 6; a Dependabot PR or
"go ahead" moves/verifies the pin, not by itself commit/push/merge
permission (step 8).

## 1. Refuse on any dirty state — anywhere, before any fetch

```bash
git status --porcelain                              # superproject — ANY output, not just under ai-trading/packages/vibe-trading
git -C ai-trading/packages/vibe-trading status --porcelain
```

If either prints anything, **stop and report it**, even if the dirty file
looks unrelated. Never run `git stash`, `git clean -fd`, `git checkout --
.`, or `git reset --hard` to tidy up first — including a stash-push/
checkout/stash-pop "preserve the edit" sequence: a stash pop can conflict
with upstream's own change to the same file, and keeping `HEAD`'s version
to resolve it strands the edit only in `git stash list`. Report both
`status --porcelain` outputs and ask the owner to commit, stash, or
discard it themselves.

## 2. Load context

Read `ai-trading/AGENTS.md` ("Upstream Apps"), `.gitmodules`, and the
`Vibe-Trading` row in `ai-trading/plans/STATUS.md`'s "Upstream Pins" table
for the currently tracked commit and verdict notes.

## 3. Fork URL guards, then status-vs-sync fetch split

If `ai-trading/packages/vibe-trading/DIVERGENCE.md` exists (already forked,
see "If a fork becomes unavoidable" below), run these **before any
fetch**, against **exact URL equality**, not "is it the real upstream"
(misses `origin` pointing at some other, unrelated fork):

1. **`origin` must exactly equal `.gitmodules`' recorded fork URL.** Fail
   closed, a real nonzero exit, not prose saying "stop":
   ```bash
   CONFIGURED_FORK_URL="$(git config -f .gitmodules --get submodule.ai-trading/packages/vibe-trading.url)"
   ACTUAL_ORIGIN_URL="$(git -C ai-trading/packages/vibe-trading remote get-url origin)"
   if [ "$ACTUAL_ORIGIN_URL" != "$CONFIGURED_FORK_URL" ]; then
     printf 'STOP: origin (%s) does not match .gitmodules fork URL (%s) — report this, do not fetch\n' \
       "$ACTUAL_ORIGIN_URL" "$CONFIGURED_FORK_URL" >&2
     exit 1
   fi
   ```
2. **`upstream`, if present, must exactly equal the URL recorded in
   `DIVERGENCE.md`'s `git remote add upstream <original-url>` line — and
   that recorded URL must be nonempty before any remote operation** (a
   malformed `DIVERGENCE.md` missing that line extracts an empty string,
   and `git remote add upstream ""` **succeeds** silently — fail closed
   first). If missing on a **sync** request, restore idempotently from
   the recorded URL — never hard-coded, never on the status path, never
   overwriting a mismatched remote — verifying both the `remote add` exit
   status and the post-add URL:
   ```bash
   RECORDED_UPSTREAM_URL="$(grep -m1 -o 'git remote add upstream [^[:space:]]*' ai-trading/packages/vibe-trading/DIVERGENCE.md | awk '{print $NF}')"
   if [ -z "$RECORDED_UPSTREAM_URL" ]; then
     printf 'STOP: DIVERGENCE.md has no parseable "git remote add upstream <url>" line (empty/malformed) — report this, do not add any remote, do not fetch\n' >&2
     exit 1
   fi
   if git -C ai-trading/packages/vibe-trading remote get-url upstream >/dev/null 2>&1; then
     EXISTING_UPSTREAM_URL="$(git -C ai-trading/packages/vibe-trading remote get-url upstream)"
     if [ "$EXISTING_UPSTREAM_URL" != "$RECORDED_UPSTREAM_URL" ]; then
       printf 'STOP: existing upstream (%s) does not match DIVERGENCE.md recorded URL (%s) — report this, do not overwrite, do not fetch\n' \
         "$EXISTING_UPSTREAM_URL" "$RECORDED_UPSTREAM_URL" >&2
       exit 1
     fi
   elif [ "$REQUEST_KIND" = "sync" ]; then
     if ! git -C ai-trading/packages/vibe-trading remote add upstream "$RECORDED_UPSTREAM_URL"; then
       printf 'STOP: git remote add upstream exited nonzero — report this, do not continue\n' >&2
       exit 1
     fi
     VERIFY_UPSTREAM_URL="$(git -C ai-trading/packages/vibe-trading remote get-url upstream)"
     if [ "$VERIFY_UPSTREAM_URL" != "$RECORDED_UPSTREAM_URL" ]; then
       printf 'STOP: upstream after add (%s) does not match recorded URL (%s) — report this, do not fetch\n' \
         "$VERIFY_UPSTREAM_URL" "$RECORDED_UPSTREAM_URL" >&2
       exit 1
     fi
   else
     printf 'STATUS: upstream remote missing — reporting only, not adding it for a status-only request\n'
   fi
   ```
   A missing `upstream` with a valid recorded URL is not itself a reason
   to refuse a sync — this is the one write this step may make; a missing
   or unparseable recorded URL is always a hard stop.

Only after the guards above (or immediately, if never forked), compute the
pin — local only, no network, needed by every branch below:

```bash
OLD="$(git rev-parse HEAD:ai-trading/packages/vibe-trading)"
```

### Status about a fork: compare against `upstream`, exit before Ordinary flow

Prose alone ("report and stop") is not enough — this block is
self-contained and **always exits before Ordinary flow's `fetch origin`**,
except its one explicit, deliberately-named escape (`ASK_ABOUT_FORK_TIP=1`,
set only when the question is explicitly about the fork's own tip):

```bash
if [ "$REQUEST_KIND" = "status" ] && [ -f ai-trading/packages/vibe-trading/DIVERGENCE.md ]; then
  if git -C ai-trading/packages/vibe-trading remote get-url upstream >/dev/null 2>&1; then
    # upstream present (verified above): fetch it only, never origin.
    UPSTREAM_SYMREF="$(git -C ai-trading/packages/vibe-trading ls-remote --symref upstream HEAD)"
    UPSTREAM_BRANCH="$(printf '%s\n' "$UPSTREAM_SYMREF" | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2; exit}')"
    if [ -z "$UPSTREAM_BRANCH" ]; then
      printf 'STOP: could not resolve upstream HEAD symref — report this\n' >&2
      exit 1
    fi
    git -C ai-trading/packages/vibe-trading fetch upstream
    UPSTREAM_TIP="$(git -C ai-trading/packages/vibe-trading rev-parse --verify "upstream/$UPSTREAM_BRANCH")"
    read -r UPSTREAM_ONLY FORK_ONLY <<<"$(git -C ai-trading/packages/vibe-trading rev-list --left-right --count "$UPSTREAM_TIP...$OLD")"
    git -C ai-trading/packages/vibe-trading merge-base --is-ancestor "$OLD" "$UPSTREAM_TIP"
    ANCESTOR_STATUS=$?  # 0 = clean "behind"; nonzero = genuine divergence
    printf 'STATUS: upstream-only=%s fork-only=%s ancestor=%s — reporting, no checkout/stage/commit/push\n' \
      "$UPSTREAM_ONLY" "$FORK_ONLY" "$ANCESTOR_STATUS"
    exit 0
  elif [ "${ASK_ABOUT_FORK_TIP:-0}" != "1" ]; then
    # upstream missing: nothing to compare the original project against;
    # status-only requests never restore it. Stop here — do not fetch origin.
    printf 'STATUS: upstream remote missing — cannot determine freshness against the original project; status-only requests do not restore it\n'
    exit 0
  fi
  # else: ASK_ABOUT_FORK_TIP=1 — question is explicitly about the fork's
  # own origin tip, not the original project; fall through, caveated.
fi
```

### Ordinary flow — sync requests; non-forked status; fork-tip-only status

```bash
git -C ai-trading/packages/vibe-trading fetch origin
```

Resolve `NEW` before comparing anything — never assume a branch name:

- Named commit/tag/branch: `NEW="$(git -C ai-trading/packages/vibe-trading rev-parse --verify <what-they-named>)"`.
- Otherwise resolve the remote's **actual** default branch:
  `TARGET_BRANCH="$(git -C ai-trading/packages/vibe-trading symbolic-ref --short refs/remotes/origin/HEAD)"`
  (strip `origin/`; fall back to `.gitmodules`' `branch =` entry, or a
  fresh `ls-remote --symref origin HEAD` if stale, or ask the owner —
  never hard-code `main`/`master`).
  `NEW="$(git -C ai-trading/packages/vibe-trading rev-parse --verify "origin/$TARGET_BRANCH")"`

Then run both and **read the output before doing anything else**:

```bash
git -C ai-trading/packages/vibe-trading log --oneline "$OLD..$NEW"
git -C ai-trading/packages/vibe-trading diff "$OLD" "$NEW" -- \
  Dockerfile agent/requirements.txt agent/requirements-channels.txt \
  requirements-lock.txt requirements-channels-lock.txt \
  agent/src/api/security.py agent/api_server.py \
  pyproject.toml frontend/package.json LICENSE NOTICE
```

A short log, or "docs only," is not a reason to skip the diff. Flag before
moving anything: a `Dockerfile` default with no env override (step 5); any
change to `agent/src/api/security.py`/`agent/api_server.py` (Bearer-token,
same-site/CORS, DNS-rebinding — the surface step 7's smoke test
exercises); any change to `agent/requirements.txt`/`-channels.txt` (step
4's lockfile rule, not auto-regenerate); a changed `frontend/package.json`
build script (its `npm run build` feeds the Dockerfile's frontend stage);
any `LICENSE`/`NOTICE` change. Never adopt an unrelated `latest`
tag/branch — move only to the named commit or resolved tip.

## 4. Lockfiles move only if upstream's own commit already carries them

Upstream commits `requirements-lock.txt`/`requirements-channels-lock.txt`
at the submodule root (autogenerated via `uv pip compile`, per each
file's own header). **Never run `uv pip compile` and never commit a
regenerated lockfile inside `ai-trading/packages/vibe-trading`** — even
when `agent/requirements*.txt` changed: that's a source edit to an
un-forked package, invisible to CI, the same unfetchable-commit problem
step 6's reachability gate catches.

When `agent/requirements.txt` or `agent/requirements-channels.txt` changed:

```bash
git -C ai-trading/packages/vibe-trading diff --stat "$OLD" "$NEW" -- requirements-lock.txt requirements-channels-lock.txt
```

- If `$NEW`'s own commit **also** updated the matching lock(s), step 6's
  pin move carries both forward automatically — report it.
- If not, this hub has no compatible committed lock to move to. **Stop
  and ask the owner** whether to fork (regenerate inside the fork, with
  `DIVERGENCE.md`) or adapt an external wrapper. Never pin to a commit
  whose requirements and committed locks disagree.

## 5. If a Dockerfile default needs an edit with no override anywhere

Vibe-Trading has **no** `ai-trading/deploy/upstream/vibe-trading/` wrapper
— unlike TradingAgents/ai-hedge-fund, `docker-bake.hcl`'s `vibe-trading`
target builds the submodule's own `Dockerfile` directly. The only override
points are that Dockerfile's `ENV`s, or
`ai-trading/deploy/production/docker-compose.yml`'s `vibe-trading`
`environment:`/`env_file:` entries. If neither absorbs the change, **do
not edit the submodule in place** — explain why (no wrapper to patch) and
ask whether to fork; see below first.

## 6. Move the pin — nothing else

Only for a sync request, step 3's guards clean, step 4 resolved. Verify
the candidate is reachable from **`origin` specifically** — not merely
local or reachable from *some* remote (once `upstream` exists, an
unscoped match would also match it):

```bash
if [ -z "$(git -C ai-trading/packages/vibe-trading for-each-ref --contains "$NEW" refs/remotes/origin/)" ]; then
  printf 'STOP: %s is not reachable from any refs/remotes/origin/* ref — it may exist only on another remote (e.g. upstream) or only locally; report this, do not checkout\n' "$NEW" >&2
  exit 1
fi
```

Never substitute `git branch -r --contains` or an unscoped `refs/remotes/`
match — both match *every* remote, so a candidate only on `upstream`
(never pushed to the fork's `origin`) would pass yet be unfetchable, like
a locally rebased commit. A plain sync never authorizes `git rebase`,
`commit`, or `cherry-pick` inside the submodule; fork reconciliation is
its own owner-approved task, pushed to `origin` and re-confirmed with this
check first.

If `DIVERGENCE.md` exists, origin reachability alone is not enough — the
candidate must also **preserve the fork's patch**, by descending from the
pinned commit or still carrying `DIVERGENCE.md`:

```bash
if [ -f ai-trading/packages/vibe-trading/DIVERGENCE.md ]; then
  if git -C ai-trading/packages/vibe-trading merge-base --is-ancestor "$OLD" "$NEW"; then
    : # descends from the current fork commit — patch history preserved
  elif git -C ai-trading/packages/vibe-trading show "$NEW:DIVERGENCE.md" >/dev/null 2>&1; then
    : # still carries DIVERGENCE.md — preserved by content
  else
    printf 'STOP: candidate %s neither descends from the current fork commit %s nor carries DIVERGENCE.md — moving the pin would silently drop the fork patch; report this and get owner approval\n' "$NEW" "$OLD" >&2
    exit 1
  fi
fi
```

Only then:

```bash
git -C ai-trading/packages/vibe-trading checkout "$NEW"
git add ai-trading/packages/vibe-trading
```

Never edit a file inside the submodule, regenerate a lockfile there (step
4), or add `DIVERGENCE.md` there while `origin` still resolves to the real
`HKUDS/Vibe-Trading` URL.

## 7. Verify

Against the real repository (not a disposable fixture), from the repo root:

```bash
docker buildx bake -f ai-trading/deploy/docker-bake.hcl vibe-trading --load
ai-trading/deploy/ci/smoke-test.sh vibe-trading
```

The bake target builds the static frontend and Python image together from
the submodule's own `Dockerfile`. The smoke test checks `/live`, Bearer
auth on `/auth/sse-ticket`, the same-site check (missing forwarded scheme,
cross-site `Origin`), and a wrong-key rejection — the surface step 3 flags
changes to. No real provider keys/LLM calls/live trades; the smoke key is
fake. Only report this as run if it actually ran against the real target.

## 8. Report, then stop

Summarize: old/new SHA, upstream commits in between, any Dockerfile/
auth-CORS/lockfile-source/license change, whether step 4 carried a
lockfile forward or stopped for fork approval, the smoke-test output, and
any fork decision needed. "Go ahead" is not, by itself, permission to
commit, push, merge, or deploy.

## If a fork becomes unavoidable

1. Get the owner's explicit decision to fork first.
2. Fork `HKUDS/Vibe-Trading`, point `.gitmodules`'
   `submodule.ai-trading/packages/vibe-trading.url` at the fork, run
   `git submodule sync -- ai-trading/packages/vibe-trading`.
3. Inside the fork's own clone, make the change — including any needed
   lockfile regeneration — and add `DIVERGENCE.md` **in the same commit**:
   original upstream URL and base commit, each modified path and why, how
   to reapply/drop on a future sync, tests run, upstream base after
   reconciliation. Must include the exact line
   `git remote add upstream https://github.com/HKUDS/Vibe-Trading.git`.
4. Every future sync re-runs step 3's fork-origin/idempotent-`upstream`
   checks first, against the **fork's** `origin` — never silently
   `upstream`, which would discard the patch.
5. Reconciling the fork's branch against new upstream commits is its own
   owner-approved step: push to `origin` (never force-push), re-confirm
   with step 6's check before the gitlink moves.
6. Record the decision in `ai-trading/plans/STATUS.md`.

## Rationalizations to reject

| Excuse | Reality |
|---|---|
| "No `upstream` exists, I'll just refuse and stop there" | A missing `upstream` on a **sync** request against a fork is restored from `DIVERGENCE.md`'s recorded line, not treated as a dead end. Only a status-only request reports it missing without adding it. |
| "It's a status question about the fork, fetching `origin` like usual is close enough" | `origin` already includes the fork's own patch — that answers "behind the fork's tip", not "behind the original upstream". When `upstream` is verified present, fetch and compare **it**, never `origin`, and never fetch `origin` first "just to check". If `upstream` is missing, report the original-upstream comparison unavailable and stop — don't silently fall back to `origin` unless the question is explicitly about the fork's own tip. |
| "Upstream changed `agent/requirements.txt`, I'll just run `uv pip compile` and commit the new lock here" | Any lockfile regeneration inside the un-forked submodule is a source edit, and a local-only commit is invisible to CI. Check whether upstream's own commit already carries a compatible lock; if not, stop and ask for fork approval or an adapter change. |
| "It's one bad Dockerfile line / a few moved lines in `agent/src/api/security.py`, not worth a callout" | Either is still a divergence (Dockerfile) or exactly the auth/CORS surface the smoke test exists to exercise (security.py) — report both explicitly; ask for fork approval before touching the Dockerfile. |
| "A malformed `DIVERGENCE.md`/`exit`-less prose 'stop' is close enough" | `git remote add upstream ""` **succeeds** silently — require a nonempty recorded URL, check the `remote add` exit status, and verify the post-add URL before trusting it. Likewise, "report and stop" in prose is not a terminator: the status-fork block ends every non-escape path in an explicit `exit 0`/`exit 1` so it can never fall through into `fetch origin`. |
| "`git branch -r --contains` shows it, so it's reachable, and that's enough to pin even if forked" | That (or any unscoped `refs/remotes/` match) matches *any* remote, including `upstream` — scope to `refs/remotes/origin/`. Origin-reachable also proves fetchable, not patch-preserving — check ancestry or `DIVERGENCE.md` presence too. |
| "The submodule's dirty, I'll stash it, sync, then pop it back" | A stash pop can conflict with upstream's own change; resolving it by keeping `HEAD`'s version strands the edit only in `git stash list`. Stop and report. |
| "The real upstream tracks `main`, so `origin/main` is a safe shortcut" | A fork or reconfigured remote may track another branch (this skill's own fixtures tracked `master`). Resolve `origin/HEAD` instead of hard-coding a name. |

## Red flags — stop and report instead

- `git stash`/`clean -fd`/`checkout -- .`/`reset --hard` anywhere; `git rebase`/`commit`/`cherry-pick` inside the submodule for a plain sync.
- `uv pip compile`, or writing/committing either lockfile, inside the submodule.
- Accepting `git branch -r --contains` (or an unscoped `refs/remotes/` match) instead of `refs/remotes/origin/`, or moving the gitlink to a commit failing reachability/patch-preservation or without having read step 3's diff.
- `git commit`/`push` without the user's current message explicitly asking for it; editing a file or adding `DIVERGENCE.md` inside the submodule while `origin` is the real upstream URL.
- Hard-coding `origin/main`/`origin/master`, or fetching before the exact-URL guards (`.gitmodules` vs. `origin`; `DIVERGENCE.md` vs. `upstream`).
- Treating an empty/malformed `DIVERGENCE.md`-recorded upstream URL as valid, skipping the `remote add` exit-status/post-add-URL check, or letting the status-fork block fall through to Ordinary flow instead of its own explicit `exit`.
- Leaving a missing `upstream` unrestored on a sync request, overwriting a mismatched one, or creating/adding `upstream` while answering a status-only question.
- Fetching `origin` — "just to check" included — before the status-fork block decides whether this is a question about a fork's *original* upstream.
