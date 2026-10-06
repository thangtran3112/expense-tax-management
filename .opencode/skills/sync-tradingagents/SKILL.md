---
name: sync-tradingagents
description: Use when asked to update, sync, bump, or check the TradingAgents upstream pin in ai-trading/packages/trading-agents (TauricResearch/TradingAgents), including "is trading-agents behind upstream", "bump the trading-agents submodule", or a Dependabot PR touching that path. Does not trigger for ai-hedge-fund, Vibe-Trading, MiroFish, or Family Desk work.
---

# Sync TradingAgents

TradingAgents (`ai-trading/packages/trading-agents`, upstream
`TauricResearch/TradingAgents`, Apache-2.0) is deployed unmodified in the hub
as a CLI (`tradingagents`) behind a browser terminal. Keep it byte-for-byte
identical to upstream; only the pinned commit moves.

## 0. Set the request kind before anything else

Decide and hold this for every step below — it gates step 4 and the two
`exit` points in step 3:

```bash
REQUEST_KIND=status   # or: REQUEST_KIND=sync
```

"Is trading-agents behind upstream?", "what's new upstream?", "is the fork
behind ORIGINAL upstream?", and similar questions are `status` —
read-only. Only an explicit "sync/update/bump trading-agents" is `sync`.
When in doubt, treat it as `status`: a status answer can always be followed
by an explicit sync request, but an unwanted pin move cannot be un-synced
for free.

If `ai-trading/packages/trading-agents/DIVERGENCE.md` exists (this
submodule is forked) and the question specifically concerns the
**original** upstream (words like "original", "real", "actual upstream" —
not just "is the fork itself up to date"), also set:

```bash
ASKING_ABOUT_ORIGINAL=yes   # or: ASKING_ABOUT_ORIGINAL=no
```

If it's ambiguous which upstream the question means, treat this as `yes`
and report both freshness numbers (fork vs `origin`, and fork vs
`upstream` if configured) rather than guessing wrong and answering only
one.

## 1. Refuse on any dirty state — do not clean up to proceed

Before touching anything:

```bash
git status --porcelain                               # superproject
git -C ai-trading/packages/trading-agents status --porcelain
```

If either prints anything, **stop and report it to the user**. Never run
`git stash`, `git checkout -- .`, `git reset --hard`, or any other command
that discards or relocates a change to make the tree clean — that destroys
or hides work the user (or another agent) has in progress, inside or
outside the submodule. "The user asked me to sync it" is not permission to
clean up their uncommitted work first, and "I'll stash it and put it back
after" is not a refusal: a sync that cannot run on an unclean tree is a sync
that waits. Report the exact `git status --porcelain` output and ask the
owner to commit, stash, or discard it themselves before you run anything
else.

## 2. Load context

Read `ai-trading/AGENTS.md` ("Upstream Apps"), `.gitmodules`, and the
`trading-agents` row in `ai-trading/plans/STATUS.md`'s "Upstream Pins" table
for the currently tracked commit and verdict notes.

## 3. Fetch and compare — never skip the diff

If `ai-trading/packages/trading-agents/DIVERGENCE.md` exists (this submodule
was already forked per "If a fork becomes unavoidable" below), run these
checks, **in this order, before the fetch below**, against **exact URL
equality** — not "is it the real upstream", which misses origin pointing at
some other, unrelated fork:

1. **`origin` must exactly equal `.gitmodules`' recorded fork URL** — not
   merely "not the real upstream" (a stray other fork would wrongly pass
   that weaker test). This must **fail closed**: a bare variable
   comparison with no enforcement is not a check, it's a no-op that lets
   execution fall through to the fetch below regardless of the result —
   use a real nonzero exit, not just prose saying "stop":
   ```bash
   CONFIGURED_FORK_URL="$(git config -f .gitmodules --get submodule.ai-trading/packages/trading-agents.url)"
   ACTUAL_ORIGIN_URL="$(git -C ai-trading/packages/trading-agents remote get-url origin)"
   if [ "$ACTUAL_ORIGIN_URL" != "$CONFIGURED_FORK_URL" ]; then
     printf 'STOP: origin (%s) does not match .gitmodules fork URL (%s) — report this, do not fetch\n' \
       "$ACTUAL_ORIGIN_URL" "$CONFIGURED_FORK_URL" >&2
     exit 1
   fi
   ```
   This includes origin resolving to the real `TauricResearch/TradingAgents`
   URL *and* origin resolving to any other fork than the one `.gitmodules`
   configures. The printed message *is* the report; do not fetch after a
   nonzero exit here.

2. **Validate the recorded upstream URL before using it for anything.** A
   missing or malformed `git remote add upstream <original-url>` line in
   `DIVERGENCE.md` must not silently produce an unusable remote —
   `git remote add upstream ""` **succeeds** (exit 0) and leaves a garbage
   remote with an empty URL behind, so check the extracted value is
   nonempty before it is used in either the compare branch or the add
   branch below:
   ```bash
   RECORDED_UPSTREAM_URL="$(grep -m1 -o 'git remote add upstream [^[:space:]]*' ai-trading/packages/trading-agents/DIVERGENCE.md | awk '{print $NF}')"
   if [ -z "$RECORDED_UPSTREAM_URL" ]; then
     printf 'STOP: DIVERGENCE.md has no usable "git remote add upstream <url>" line — cannot validate or restore upstream\n' >&2
     exit 1
   fi
   ```

3. **`upstream`, if present, must exactly equal `$RECORDED_UPSTREAM_URL`**
   — don't just check that some `upstream` remote exists, and don't let a
   mismatch fall through either. A bare `:` (the shell no-op builtin) in a
   mismatch branch is exactly this bug: valid syntax, changes nothing, and
   lets the script continue as if the URLs matched. **On `status`, never
   create a missing `upstream` remote** — not even to answer the question;
   only `REQUEST_KIND=sync` may restore it, and only after both the add
   command's exit status and the resulting URL are verified, never
   assumed:
   ```bash
   if git -C ai-trading/packages/trading-agents remote get-url upstream >/dev/null 2>&1; then
     EXISTING_UPSTREAM_URL="$(git -C ai-trading/packages/trading-agents remote get-url upstream)"
     if [ "$EXISTING_UPSTREAM_URL" != "$RECORDED_UPSTREAM_URL" ]; then
       printf 'STOP: existing upstream (%s) does not match DIVERGENCE.md recorded URL (%s) — report this, do not overwrite, do not fetch\n' \
         "$EXISTING_UPSTREAM_URL" "$RECORDED_UPSTREAM_URL" >&2
       exit 1
     fi
   elif [ "$REQUEST_KIND" = sync ]; then
     if ! git -C ai-trading/packages/trading-agents remote add upstream "$RECORDED_UPSTREAM_URL"; then
       printf 'STOP: "git remote add upstream %s" failed\n' "$RECORDED_UPSTREAM_URL" >&2
       exit 1
     fi
     ADDED_UPSTREAM_URL="$(git -C ai-trading/packages/trading-agents remote get-url upstream)"
     if [ "$ADDED_UPSTREAM_URL" != "$RECORDED_UPSTREAM_URL" ]; then
       printf 'STOP: upstream was added but reads back as %s, expected %s\n' "$ADDED_UPSTREAM_URL" "$RECORDED_UPSTREAM_URL" >&2
       exit 1
     fi
   else
     printf 'Original-upstream freshness unavailable: no verified "upstream" remote is configured, and a status-only request never creates one. Run an actual sync to establish it, or configure it yourself first.\n'
   fi
   ```
   If `upstream` exists but doesn't match, this **stops with a nonzero
   exit and reports both URLs** — never silently repoint or overwrite a
   remote the user (or a prior session) may have set deliberately. The add
   branch is the only one that writes anything, runs only on `sync`, and
   checks both its own exit status and the URL it produced.
   `exit 1` ends the current script/command invocation; if you are pasting
   these blocks one at a time into an interactive shell rather than
   running them as a script, treat the nonzero exit the same as the
   printed message: stop and report, do not proceed to the next block.

Only after those checks (or immediately, if this submodule has never been
forked), get the current pin, then **branch hard on `REQUEST_KIND` before
touching `origin` or any candidate** — the reachability and fork-ancestry
gates further down exist only to protect an actual pin move, and a
`status` request must never reach them:

```bash
OLD="$(git rev-parse HEAD:ai-trading/packages/trading-agents)"
```

### If `REQUEST_KIND` is not `sync` (status)

**If this is a fork and asking about the *original* upstream** — answer
**only** that question. Do not fetch `origin`, resolve a sync candidate,
or run the ancestry gate for this: none of it is relevant to "is this
behind the original", and running it anyway produces a confusing
"candidate does not descend..." refusal in answer to a question that never
asked to move anything (this is exactly what was observed and is now
fixed):

```bash
if [ "${ASKING_ABOUT_ORIGINAL:-no}" = yes ]; then
  if git -C ai-trading/packages/trading-agents remote get-url upstream >/dev/null 2>&1; then
    UPSTREAM_DEFAULT_BRANCH="$(git -C ai-trading/packages/trading-agents ls-remote --symref upstream HEAD | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2}')"
    git -C ai-trading/packages/trading-agents fetch upstream
    git -C ai-trading/packages/trading-agents log --oneline "$OLD..upstream/$UPSTREAM_DEFAULT_BRANCH"
    git -C ai-trading/packages/trading-agents log --oneline "upstream/$UPSTREAM_DEFAULT_BRANCH..$OLD"
    git -C ai-trading/packages/trading-agents diff "$OLD" "upstream/$UPSTREAM_DEFAULT_BRANCH" -- Dockerfile pyproject.toml cli/ tradingagents/ .github/workflows LICENSE NOTICE
  else
    printf 'Original-upstream freshness unavailable: no verified "upstream" remote is configured, and a status-only request never creates one. Run an actual sync to establish it, or configure it yourself first.\n'
  fi
  exit 0
fi
```

`git ls-remote --symref upstream HEAD` queries the remote's **current**
default branch directly from the remote — resolve it this way, not from a
local `refs/remotes/upstream/HEAD` symref, which can go stale if the
original's default branch changed since the last fetch. Report both log
directions (commits the pin is behind by, and — usually zero — commits the
pin has that the original doesn't) plus the scoped diff; this is the whole
answer for this case. Nothing below this `if` block runs when it fires.

**Otherwise** (status, not asking about the original — either this
submodule isn't forked, or the question is about the fork/current pin's
own freshness against its own `origin`):

```bash
git -C ai-trading/packages/trading-agents fetch origin
TARGET_BRANCH="$(git -C ai-trading/packages/trading-agents symbolic-ref --short refs/remotes/origin/HEAD)"
TARGET_BRANCH="${TARGET_BRANCH#origin/}"
git -C ai-trading/packages/trading-agents log --oneline "$OLD..origin/$TARGET_BRANCH"
git -C ai-trading/packages/trading-agents diff "$OLD" "origin/$TARGET_BRANCH" -- Dockerfile pyproject.toml cli/ tradingagents/ .github/workflows LICENSE NOTICE
exit 0
```

Report what the diff and log show, then **stop** — the candidate
reachability and fork-ancestry gates in the `sync` branch below must never
run here. The one time this skill ran them anyway on a status request
nothing was actually staged or written, but it produced an alarming
"STOP: candidate does not descend..." message answering a question that
never asked to move anything. That confusion is itself the bug this
branch fixes.

### If `REQUEST_KIND` is `sync`

```bash
git -C ai-trading/packages/trading-agents fetch origin
```

Resolve `NEW` before comparing anything:

- If the user named a commit, tag, or branch, resolve exactly that, then
  **verify it is actually reachable from a fetched `origin` ref** — a
  commit that merely resolves in the local object database (for example
  one that was checked out locally once but never pushed) is not
  something CI or a fresh clone can fetch. Scope this to
  `refs/remotes/origin/*` specifically, not "any ref": a local branch, a
  stray `upstream/*` ref, or a tag you made yourself can all satisfy
  `rev-parse --verify` without proving `origin` can hand the commit to
  anyone else:
  ```bash
  NEW="$(git -C ai-trading/packages/trading-agents rev-parse --verify <what-they-named>)"
  if [ -z "$(git -C ai-trading/packages/trading-agents for-each-ref --contains="$NEW" --format='%(refname)' refs/remotes/origin)" ]; then
    printf 'STOP: %s is not reachable from any fetched origin ref — unfetchable by CI or a fresh clone, refusing to pin it\n' "$NEW" >&2
    exit 1
  fi
  ```
- If the user said "latest" (or didn't name anything), resolve the remote's
  **actual** default branch — do not assume `origin/main`:
  `TARGET_BRANCH="$(git -C ai-trading/packages/trading-agents symbolic-ref --short refs/remotes/origin/HEAD)"`
  (strip the `origin/` prefix) and fall back to `.gitmodules`' own
  `submodule.ai-trading/packages/trading-agents.branch` entry, or ask the
  owner, if `origin/HEAD` isn't set. The real upstream may track `main`, but
  a fork or a differently-configured remote may not — resolve it, don't
  hard-code it.
  `NEW="$(git -C ai-trading/packages/trading-agents rev-parse --verify "origin/$TARGET_BRANCH")"`
  (This path is already scoped to `refs/remotes/origin/*` by construction
  — no separate reachability check needed.)

Then run both of these and **read the output before doing anything else**:

```bash
git -C ai-trading/packages/trading-agents log --oneline "$OLD..$NEW"
git -C ai-trading/packages/trading-agents diff "$OLD" "$NEW" -- Dockerfile pyproject.toml cli/ tradingagents/ .github/workflows LICENSE NOTICE
```

Running `diff` between the two endpoints already covers every commit in
between, including ones the log makes easy to skim past — a short log is not
a reason to skip reading the diff output. Report any change to the CLI
entrypoint (`[project.scripts] tradingagents =` in `pyproject.toml`), the
Dockerfile, dependency pins, or license/notice files before moving anything,
even if the surrounding commits look like "docs only". Do not adopt an
unrelated `latest` tag or branch — move only to the commit the user named or
the resolved default branch's tip.

**Fork-ancestry gate.** If this submodule is forked, run this
**regardless of what the scoped diff above shows** — the scoped diff only
looks at the seven named paths, and a fork's patch could live anywhere
else, so content-diffing those paths alone is not sufficient to prove the
patch survives. This gate belongs to the `sync` branch only — a `status`
request already exited above and must never reach it:
```bash
if [ -f ai-trading/packages/trading-agents/DIVERGENCE.md ]; then
  if ! git -C ai-trading/packages/trading-agents merge-base --is-ancestor "$OLD" "$NEW"; then
    printf 'STOP: candidate %s does not descend from the current fork pin %s — adopting it could silently drop the forks patch outside the files this skill diffs. Stop for explicit owner reconciliation.\n' "$NEW" "$OLD" >&2
    exit 1
  fi
fi
```
"Owner reconciliation" means: ask the owner whether to rebase the fork's
patch onto the candidate, deliberately drop the patch (recorded in an
updated `DIVERGENCE.md`), or hold the current pin — never pick one
silently.

## 4. Move the pin — nothing else

Only reachable when `REQUEST_KIND=sync` and every gate in steps 1 and 3
passed (dirty check, origin/upstream URL checks, candidate reachability,
fork-ancestry). Re-assert the gate here too, so this block is safe even if
run on its own, out of order:

```bash
if [ "$REQUEST_KIND" != sync ]; then
  printf 'STOP: REQUEST_KIND is not sync — step 4 must never run for a status-only request\n' >&2
  exit 1
fi
git -C ai-trading/packages/trading-agents checkout "$NEW"
git add ai-trading/packages/trading-agents
```

Do not edit any file inside `ai-trading/packages/trading-agents`. If the
candidate revision needs a source change to work in this hub (a default that
no Dockerfile `ENV`, no wrapper in `ai-trading/deploy/upstream/trading-agents/`,
and no hub-side config can override), **stop**: explain exactly why the
wrapper/config route won't work, and ask the owner whether to fork
`TauricResearch/TradingAgents`. Never edit the submodule's source in place
and never commit inside it while its `origin` still points at the real
upstream — see "If a fork becomes unavoidable" below.

## 5. Verify

Against the real repository (not a disposable fixture), run:

```bash
docker buildx bake -f ai-trading/deploy/docker-bake.hcl ta-terminal --load   # from the repo root
ai-trading/deploy/ci/smoke-test.sh ta-terminal
```

This checks `tradingagents --help` (CLI still imports), a tmux probe inside
the image, and the embedded browser terminal's 407 (no Access header) / 200
(with it) / 302 (reattach) behavior. No provider keys or paid calls are
needed for this check. Only report these commands as run if they actually
ran against the real build target — a scratch or offline fixture has no
`ta-terminal` Docker target to build, so never claim this step passed there.

## 6. Report, then stop

Summarize: old SHA, new SHA, upstream commits in between, any Dockerfile/
dependency/license changes, the exact smoke-test output, and whether
anything needs a human decision (e.g., a fork). **Do not run `git commit`,
`git push`, open a PR, merge, or deploy** unless the user's current message
explicitly asks for that action — "sync it" or "make sure it's updated" asks
for the pin to be moved and verified in the working tree, not for it to be
committed. Never rebase, amend, or force-push anything, in the submodule or
the fork, at any step of this skill.

## If a fork becomes unavoidable

1. Get the owner's explicit decision to fork before touching anything.
2. Fork `TauricResearch/TradingAgents`, then point `.gitmodules`'
   `submodule.ai-trading/packages/trading-agents.url` at the fork and run
   `git submodule sync -- ai-trading/packages/trading-agents`.
3. Inside the fork's own clone (not the superproject), make the source
   change and add `DIVERGENCE.md` **in the same commit**. `DIVERGENCE.md`
   records: the original upstream URL and base commit, each modified path
   and why, how to reapply/drop the change on a future sync, tests run, and
   the upstream base after reconciliation. It must include the exact line
   `git remote add upstream https://github.com/TauricResearch/TradingAgents.git`.
4. After forking, step 3's fork-origin, upstream-URL, and ancestry checks
   run on every future sync — see step 3 above. Sync this skill against the
   **fork's** `origin`, never silently against the `upstream` remote — that
   would discard the fork's patch.
5. Never force-push the fork's branch. Record the fork decision in
   `ai-trading/plans/STATUS.md`.

## Rationalizations to reject

| Excuse | Reality |
|---|---|
| "The submodule's dirty, I'll just stash it and sync, I can pop it back after" | The user never asked for their uncommitted work to be touched, and reapplying a stash yourself can silently reorder or duplicate lines. Stop and report; don't stash. |
| "They said 'make sure it's updated', that covers committing it" | That authorizes moving the pin and verifying it, not creating a commit. Ask, or stop at "staged, ready to commit" and report. |
| "The candidate needs one small source tweak, I'll just patch it, it's tiny" | Any in-place edit to an un-forked submodule is exactly the divergence this skill exists to prevent. Get fork approval first. |
| "origin already points at the fork, so `git fetch origin` is enough" | Only if `origin` is still the fork. If a sync ever silently re-pointed `origin` back at the real upstream, the fork's patch would vanish on the next build — verify `origin` before every fetch. |
| "The log between old and new is short / says 'docs only', I don't need to read the diff" | A short commit log can still carry a Dockerfile or CLI entrypoint change in an intermediate commit. Always run and read the `diff`, not just the `log`, before moving the pin. |
| "The real upstream tracks `main`, so `origin/main` is a safe shortcut" | A fork or a reconfigured remote may track a different branch (e.g. `master`). Resolve `origin/HEAD` (or `.gitmodules`' `branch =` entry) instead of hard-coding `main`. |
| "Origin isn't the real upstream, so it must be our fork" | Origin could resolve to some other, unrelated fork instead — neither the real upstream nor the one `.gitmodules` configures. Compare `origin` against `.gitmodules`' exact recorded URL, not merely against "is it upstream". |
| "An `upstream` remote already exists, so the idempotent check passed" | An existing `upstream` could point at the wrong place. Compare its URL against `DIVERGENCE.md`'s recorded original URL; stop and report a mismatch instead of trusting mere presence or silently overwriting it. |
| "It's just a status question, but I'll add the missing upstream remote so I can give a real answer" | A status request never creates a remote. Report that original-upstream freshness is unavailable and stop; only an explicit sync may restore `upstream`. |
| "`DIVERGENCE.md`'s upstream line didn't parse, but the add command still returned success" | `git remote add upstream ""` exits 0 and leaves a garbage, empty-URL remote. Validate the extracted URL is nonempty before using it anywhere, add or compare. |
| "`rev-parse --verify` resolved the named commit, so it must be real" | Local object-database resolution isn't proof `origin` can serve it. Require the commit to appear under a fetched `refs/remotes/origin/*` ref before staging it. |
| "The scoped diff didn't flag anything, so the fork candidate is safe" | The scoped diff only covers seven named paths. A patch elsewhere survives unnoticed by that diff but is still lost if the candidate isn't a descendant of the current fork pin — check `merge-base --is-ancestor` too. |
| "It's a status question, but I already resolved a candidate, so I might as well run the ancestry/reachability gates on it" | Those gates exist to protect a pin move that was never requested. Running them on a status-only question produces a false "STOP: candidate does not descend..." refusal answering a question that never asked to move anything. A `status` request must exit before either gate runs. |
| "I'll resolve the original upstream's default branch from the local `upstream/HEAD` I fetched earlier" | A locally cached `refs/remotes/upstream/HEAD` can be stale if the original's default branch changed since that fetch. Use `git ls-remote --symref upstream HEAD` to ask the remote directly before comparing. |

## Red flags — stop and report instead

- About to run `git stash`, `git checkout -- .`, or `git reset --hard` inside `ai-trading/packages/trading-agents` or the superproject.
- About to move the gitlink without having run and read the step-3 `diff` output first.
- About to run `git commit`, `git push`, `git rebase`, `git commit --amend`, or any force-push without the user's current message explicitly asking for it.
- About to edit a file inside `ai-trading/packages/trading-agents` while its `origin` remote is the real `TauricResearch/TradingAgents` URL.
- About to adopt a revision the user didn't name without saying so in the report.
- About to hard-code `origin/main` instead of resolving the remote's actual default branch.
- About to fetch without first comparing `origin`'s exact URL against `.gitmodules` and, if `DIVERGENCE.md` exists, `upstream`'s exact URL against its recorded original URL.
- About to add or overwrite the `upstream` remote without first checking whether it already points somewhere else.
- About to add or restore the `upstream` remote during a `status`-only request.
- About to use `RECORDED_UPSTREAM_URL` (compare or add) without first checking it is nonempty.
- About to stage or check out a named candidate without confirming it is reachable from a fetched `refs/remotes/origin/*` ref.
- About to adopt a fork candidate without checking `merge-base --is-ancestor "$OLD" "$NEW"` first — a clean scoped diff is not enough on its own.
- About to run the candidate-reachability or fork-ancestry gate, or resolve/fetch `origin` at all, for a `status`-only request — those belong to the `sync` branch only.
- About to resolve the original upstream's default branch from a cached local `upstream/HEAD` symref instead of a live `git ls-remote --symref upstream HEAD`.
- About to answer an "is this behind the ORIGINAL upstream" question using the fork-vs-`origin` comparison instead of a verified fork-vs-`upstream` comparison.
