---
name: sync-ai-hedge-fund
description: Use when asked to update, sync, bump, or check the ai-hedge-fund upstream pin in ai-trading/packages/ai-hedge-fund (virattt/ai-hedge-fund), including "is ai-hedge-fund behind upstream", "bump the ai-hedge-fund submodule", or a Dependabot PR touching that path. Does not trigger for TradingAgents, Vibe-Trading, MiroFish, or Family Desk work.
---

# Sync ai-hedge-fund

ai-hedge-fund (`ai-trading/packages/ai-hedge-fund`, upstream
`virattt/ai-hedge-fund`, MIT) is deployed unmodified in the hub as a CLI
(`aihf`, Poetry-managed) behind a browser terminal (Textual TUI). Keep it
byte-for-byte identical to upstream; only the pinned commit moves.

## 0. Is this a status question or a sync request?

"Is ai-hedge-fund behind upstream?", "what's new upstream?", and similar
questions make **no worktree, gitlink, or submodule-`HEAD` edits** — but
they are not literally read-only: step 3's `git fetch origin` (or, for a
forked submodule with a verified `upstream` remote, `git fetch upstream`
instead — see "A status-only question about a fork" in step 3) still
updates this submodule's own local remote-tracking refs
(`refs/remotes/{origin,upstream}/*`), which is expected and scoped to
refs, not files. Run steps 1-3 below with that scope, report what you
find, and **stop** — never check out a new commit or stage the gitlink for
a status question. If `ai-trading/packages/ai-hedge-fund/DIVERGENCE.md`
exists and the `upstream` remote is missing, a status-only request **reports
that it is missing and does not add it** — only an actual sync request adds
it (step 3), and only after the origin-exact-match check there passes. If
`DIVERGENCE.md` exists and `upstream` **is** present, a status question is
answered against `upstream` (the original project), not `origin` (the
fork) — see step 3; don't conflate "behind the fork's own tip" with "behind
the original upstream", they're different questions with different
answers. Mark which kind this request is (`REQUEST_KIND=status` or
`REQUEST_KIND=sync`) before running step 3, since its upstream-remote
branch depends on it. Only "sync/update/bump ai-hedge-fund" authorizes
step 4. A Dependabot PR touching this path, or a user saying "go ahead",
is a request to move and verify the pin in the working tree — it is
**not**, by itself, permission to commit, push, or merge that PR; see
step 6.

## 1. Refuse on any dirty state — anywhere, before any fetch

```bash
git status --porcelain                              # superproject — ANY output, not just under ai-trading/packages/ai-hedge-fund
git -C ai-trading/packages/ai-hedge-fund status --porcelain
```

If either prints anything, **stop and report it to the user**, even if the
dirty file looks unrelated to this package (e.g. a stray file at the
superproject root, or an edit inside the submodule itself). Never run
`git stash`, `git clean -fd`, `git checkout -- .`, or `git reset --hard`
anywhere in the superproject or the submodule to tidy up before
proceeding. This applies even to a dirty **submodule**: do not
`stash push` a local edit, `checkout` the new pin, then `stash pop` it back
— a stash pop can conflict against upstream's own change to the same file,
and reconciling that conflict by restoring the file from the new `HEAD`
leaves the user's edit recoverable only from `git stash list`, effectively
discarded from the working tree. "The user asked me to sync it" is not
permission to clean up or relocate their uncommitted work first, and
"I'll stash it and put it back after" is not a refusal. Report the exact
`git status --porcelain` output (both commands) and ask the owner to
commit, stash, or discard it themselves before you run anything else.

## 2. Load context

Read `ai-trading/AGENTS.md` ("Upstream Apps"), `.gitmodules`, and the
`ai-hedge-fund` row in `ai-trading/plans/STATUS.md`'s "Upstream Pins" table
for the currently tracked commit and verdict notes.

## 3. Fetch and compare, including the lockfile — never skip the diff

If `ai-trading/packages/ai-hedge-fund/DIVERGENCE.md` exists (this submodule
was already forked per "If a fork becomes unavoidable" below), run these
two checks, **in this order, before the fetch below**, against **exact URL
equality** — not "is it the real upstream", which misses `origin` pointing
at some other, unrelated fork:

1. **`origin` must exactly equal `.gitmodules`' recorded fork URL.** This
   must **fail closed** — a real nonzero exit, not just prose saying
   "stop":
   ```bash
   CONFIGURED_FORK_URL="$(git config -f .gitmodules --get submodule.ai-trading/packages/ai-hedge-fund.url)"
   ACTUAL_ORIGIN_URL="$(git -C ai-trading/packages/ai-hedge-fund remote get-url origin)"
   if [ "$ACTUAL_ORIGIN_URL" != "$CONFIGURED_FORK_URL" ]; then
     printf 'STOP: origin (%s) does not match .gitmodules fork URL (%s) — report this, do not fetch\n' \
       "$ACTUAL_ORIGIN_URL" "$CONFIGURED_FORK_URL" >&2
     exit 1
   fi
   ```
2. **`upstream`, if present, must exactly equal the original URL recorded
   in `DIVERGENCE.md`'s own `git remote add upstream <original-url>`
   command.** Don't just check that some `upstream` remote exists, and
   don't let a mismatch fall through to a no-op. The add-when-missing
   branch below is a **write** (it creates a remote) and only ever runs
   for an actual sync request — for a status-only request (step 0), a
   missing `upstream` is reported, never created:
   ```bash
   RECORDED_UPSTREAM_URL="$(grep -m1 -o 'git remote add upstream [^[:space:]]*' ai-trading/packages/ai-hedge-fund/DIVERGENCE.md | awk '{print $NF}')"
   if git -C ai-trading/packages/ai-hedge-fund remote get-url upstream >/dev/null 2>&1; then
     EXISTING_UPSTREAM_URL="$(git -C ai-trading/packages/ai-hedge-fund remote get-url upstream)"
     if [ "$EXISTING_UPSTREAM_URL" != "$RECORDED_UPSTREAM_URL" ]; then
       printf 'STOP: existing upstream (%s) does not match DIVERGENCE.md recorded URL (%s) — report this, do not overwrite, do not fetch\n' \
         "$EXISTING_UPSTREAM_URL" "$RECORDED_UPSTREAM_URL" >&2
       exit 1
     fi
   elif [ "$REQUEST_KIND" = "sync" ]; then
     git -C ai-trading/packages/ai-hedge-fund remote add upstream "$RECORDED_UPSTREAM_URL"
   else
     printf 'STATUS: upstream remote missing — reporting only, not adding it for a status-only request\n'
   fi
   ```
   Only add `upstream` when it's missing entirely **and** this is a sync
   request, using the URL `DIVERGENCE.md` itself records, never a
   hard-coded literal. `exit 1` ends the current script/command
   invocation; if you are pasting these blocks one at a time into an
   interactive shell rather than running them as a script, treat the
   nonzero exit the same as the printed message: stop and report, do not
   proceed to the next block.

Compute the current pin now — it only reads the superproject's own index,
not a remote, so it doesn't depend on which branch below you take:

```bash
OLD="$(git rev-parse HEAD:ai-trading/packages/ai-hedge-fund)"
```

### A status-only question about a fork compares against `upstream`, not `origin`

If `REQUEST_KIND=status`, `DIVERGENCE.md` exists, and the `upstream` remote
exists (verified above against `DIVERGENCE.md`'s recorded URL) — i.e. this
is a status question against a fork that already has a working `upstream`
remote — **answer it against `upstream`, never `origin`**, then stop
without running the ordinary origin-fetch/compare flow below at all. A
fork's `origin` is the fork's own history, which already includes the
fork's own patch commits; comparing the pin against `origin` can only ever
tell you "is this behind the fork's own tip", not "is this behind the
*original* upstream" — exactly the two different questions a forked
submodule's status can be asked about, and precisely what the dirty-
submodule/fork pressure runs on this skill found conflated before this
section existed.

**Resolve `upstream`'s branch with a fresh `ls-remote --symref` query every
time — never trust the local `refs/remotes/upstream/HEAD` symbolic-ref,
even if it's already set.** That local ref is written once, by a clone or
an explicit `remote set-head`, and **a plain `git fetch` never updates it**
— if the remote's own default branch changes afterward (its maintainers
repoint `HEAD` to a new branch, e.g. `master` → `main` or any rename), the
local symbolic-ref silently keeps pointing at the old name while the
remote has moved on. A guided run on a fixture built exactly this way
confirmed this is an active bug, not a theoretical one: the remote's `HEAD`
had moved to a new branch (`fresh`) after an earlier fetch had already
cached `refs/remotes/upstream/HEAD → upstream/master` locally; the old
code trusted that stale local ref, selected `upstream/master`, and reported
a divergence count (`1`/`1`) against the **wrong** candidate — one upstream
commit short and one divergence count off from the correct comparison
against the remote's actual current tip (`2`/`1`, against `upstream/fresh`,
confirmed independently via a direct `ls-remote --symref` query in the same
run). Resolve the branch name this way instead, validating the query
actually returned something parseable before trusting it:

```bash
UPSTREAM_SYMREF="$(git -C ai-trading/packages/ai-hedge-fund ls-remote --symref upstream HEAD)"
UPSTREAM_REF_LINE_COUNT="$(printf '%s\n' "$UPSTREAM_SYMREF" | grep -c '^ref:')"
if [ "$UPSTREAM_REF_LINE_COUNT" -ne 1 ]; then
  printf 'STOP: upstream HEAD symref query returned %s ref: line(s) (expected exactly 1) — cannot determine upstream default branch; report this\n' \
    "$UPSTREAM_REF_LINE_COUNT" >&2
  exit 1
fi
UPSTREAM_BRANCH="$(printf '%s\n' "$UPSTREAM_SYMREF" | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2; exit}')"
if [ -z "$UPSTREAM_BRANCH" ]; then
  printf 'STOP: upstream HEAD symref line did not contain a parseable refs/heads/* branch name — report this\n' >&2
  exit 1
fi
git -C ai-trading/packages/ai-hedge-fund fetch upstream
UPSTREAM_TIP="$(git -C ai-trading/packages/ai-hedge-fund rev-parse --verify "upstream/$UPSTREAM_BRANCH")"
read -r UPSTREAM_ONLY FORK_ONLY <<<"$(git -C ai-trading/packages/ai-hedge-fund rev-list --left-right --count "$UPSTREAM_TIP...$OLD")"
```

The `UPSTREAM_REF_LINE_COUNT` check covers both failure shapes, not just
"it's unset": **empty** output (zero `ref:` lines — e.g. the remote
reports no `HEAD` at all) and **ambiguous** output (more than one `ref:`
line — malformed or unexpected server response) both stop and report
rather than silently falling back to a guess. The `ls-remote` query runs
**before** `fetch upstream` specifically so the branch name it resolves is
never stale relative to the fetch that follows it — querying only *after*
fetching would still correctly answer "what does the remote say right
now", but running it first and using that name to select which ref to read
off the just-completed fetch is what ties the branch name and the fetched
tip to the same, single, current view of the remote. Do not reintroduce a
`symbolic-ref --short refs/remotes/upstream/HEAD` shortcut anywhere in this
branch — it is exactly the stale-cache mechanism this fix removes.

Report **divergence, not just a "behind" count**: `$UPSTREAM_ONLY` is how
many upstream commits the pin is missing; `$FORK_ONLY` is how many commits
the pin carries that `upstream` doesn't — almost always the fork's own
patch, but confirm with
`git -C ai-trading/packages/ai-hedge-fund merge-base --is-ancestor "$OLD" "$UPSTREAM_TIP"`
(exit `0` means the pin is a clean ancestor of `upstream` — purely behind,
no divergence; nonzero means the histories have actually forked and a
simple fast-forward won't reconcile them). State both numbers and which
case applies in the report.

**Then stop.** Do not run the `fetch origin`/`NEW` resolution/diff flow
below for this request — that flow answers "what would the fork's own
`origin` sync to", a different question already answered by step 4's
reachability and patch-preservation gates when an actual sync is
requested. This branch never fetches `origin` at all (the exact-URL checks
above only read remote *configuration*, `remote get-url`, not network); the
only writes it performs are read-only network queries (`ls-remote`) and
`fetch upstream`'s local `refs/remotes/upstream/*` tracking-ref update —
nothing in `.git/config` or any remote's own `HEAD` is modified. Do not
checkout, stage, commit, or push anything — no worktree file, superproject
gitlink, or submodule `HEAD` changes.

If `upstream` is missing instead, the existing behavior above already
applies (reported, not added) — in that case, fall through to the ordinary
origin-based flow below and caveat the comparison as being against the
fork's own `origin`, not the original upstream, since there is no verified
`upstream` remote to compare against.

For an actual **sync request**, the candidate always resolves from the
fork's own `origin` — never `upstream` directly, even once this status
branch has fetched it — so the pin only ever moves to a commit the fork's
`origin` (and therefore every other clone and CI) can actually fetch; see
step 4's origin-scoped reachability gate.

### Ordinary origin-based flow (sync requests; status requests with no `upstream` remote; non-forked submodules)

```bash
git -C ai-trading/packages/ai-hedge-fund fetch origin
```

Resolve `NEW` before comparing anything:

- If the user, or the Dependabot PR, names a commit, tag, or branch,
  resolve exactly that:
  `NEW="$(git -C ai-trading/packages/ai-hedge-fund rev-parse --verify <what-they-named>)"`.
- Otherwise, resolve the remote's **actual** default branch — do not
  assume `origin/main`:
  `TARGET_BRANCH="$(git -C ai-trading/packages/ai-hedge-fund symbolic-ref --short refs/remotes/origin/HEAD)"`
  (strip the `origin/` prefix) and fall back to `.gitmodules`' own
  `submodule.ai-trading/packages/ai-hedge-fund.branch` entry, or ask the
  owner, if `origin/HEAD` isn't set. The real upstream may track `main`,
  but a differently-configured remote may not — resolve it, don't
  hard-code it.
  `NEW="$(git -C ai-trading/packages/ai-hedge-fund rev-parse --verify "origin/$TARGET_BRANCH")"`

Then run both of these and **read the output before doing anything else**:

```bash
git -C ai-trading/packages/ai-hedge-fund log --oneline "$OLD..$NEW"
git -C ai-trading/packages/ai-hedge-fund diff "$OLD" "$NEW" -- pyproject.toml poetry.lock Dockerfile LICENSE
```

Running `diff` between the two endpoints already covers every commit in
between — a short log, or one that looks "docs only", is not a reason to
skip reading the diff output. `pyproject.toml`'s `[tool.poetry.scripts]`
defines the `aihf` CLI entry point — flag any change to that section, to
`Dockerfile`, or to `LICENSE` before moving the pin. For `poetry.lock`: a
hash-churn-only change is routine, but report it anyway so a human decides
if churn-only is safe; a dependency **removed** or a Python version floor
**raised** is not routine and must be reported before moving anything. Do
not adopt an unrelated `latest` tag or branch — move only to the commit
the user/Dependabot named or the resolved default branch's tip.

## 4. Move the pin — nothing else

Only if both checks in step 1 were clean, and only for an actual sync
request (not a status question):

Before checking anything out, verify the candidate is **reachable from
`origin` specifically** — not merely present in the local object database,
and not merely reachable from *some* configured remote:

```bash
if [ -z "$(git -C ai-trading/packages/ai-hedge-fund for-each-ref --contains "$NEW" refs/remotes/origin/)" ]; then
  printf 'STOP: %s is not reachable from any refs/remotes/origin/* ref — it may exist only on another remote (e.g. upstream) or only locally; report this, do not checkout\n' "$NEW" >&2
  exit 1
fi
```

**Scope this to `refs/remotes/origin/` exactly — never `git branch -r
--contains` or an unscoped `refs/remotes/` match.** Both of those match
against *any* configured remote, including `upstream` once step 3 has
added it for a fork: a candidate that exists only on the real upstream
remote, and was never pushed to the fork's own `origin`, would pass an
unscoped check even though `.gitmodules`' recorded URL — what every other
clone and CI actually fetch from — has never seen it. Pinning to such a
commit is exactly as unfetchable as a locally rebased, unpushed one. If the
origin-scoped check above prints the `STOP` line, `$NEW` is not safe to
check out, whether because of a local-only commit (rebase, cherry-pick, or
one you just made) or because it only exists on a different remote. A
plain sync request never authorizes creating a new commit inside the
submodule by any means, including `git rebase`: never run `git rebase`,
`git commit`, `git cherry-pick`, or any other history-writing command
inside `ai-trading/packages/ai-hedge-fund` during a sync. If this submodule
is forked and its `fork-divergence` branch needs upstream's new commits
reconciled onto it, that rebase is its own explicit, owner-approved task —
and even then the rebased branch must be pushed to the fork's `origin`
(never force-pushed if shared), confirmed reachable by the same
origin-scoped check, **before** the gitlink moves to it; see "If a fork
becomes unavoidable" below.

If `ai-trading/packages/ai-hedge-fund/DIVERGENCE.md` exists, reachability
via `origin` alone is not enough — the candidate must also **preserve the
fork's patch**, either by descending from the currently pinned commit or by
still carrying `DIVERGENCE.md` itself:

```bash
if [ -f ai-trading/packages/ai-hedge-fund/DIVERGENCE.md ]; then
  if git -C ai-trading/packages/ai-hedge-fund merge-base --is-ancestor "$OLD" "$NEW"; then
    : # candidate descends from the current fork commit — patch history preserved
  elif git -C ai-trading/packages/ai-hedge-fund show "$NEW:DIVERGENCE.md" >/dev/null 2>&1; then
    : # candidate itself still carries DIVERGENCE.md — preserved by content, even off the current lineage
  else
    printf 'STOP: candidate %s neither descends from the current fork commit %s nor carries DIVERGENCE.md — moving the pin would silently drop the fork patch; report this and get owner approval before reconciling\n' "$NEW" "$OLD" >&2
    exit 1
  fi
fi
```

This is the automated form of the same judgment §3's diff already asks you
to make by reading `Dockerfile`/`DIVERGENCE.md` content — it exists so a
candidate that happens to be `origin`-reachable (e.g. upstream's own
default branch, once pushed or mirrored onto the fork's `origin`) can't
still silently drop the patch just because the weaker reachability check
alone would have passed it.

```bash
git -C ai-trading/packages/ai-hedge-fund checkout "$NEW"
git add ai-trading/packages/ai-hedge-fund
```

Do not edit any file inside `ai-trading/packages/ai-hedge-fund`, and never
add a `DIVERGENCE.md` there while its `origin` remote still resolves to the
real `virattt/ai-hedge-fund` URL — `DIVERGENCE.md` and any source edit only
ever belong inside a fork, never inside the original upstream submodule. If
the candidate needs a source change the wrapper
(`ai-trading/deploy/upstream/ai-hedge-fund/Dockerfile`) can't absorb, stop
and ask the owner whether to fork `virattt/ai-hedge-fund` — follow the fork
protocol below.

## 5. Verify

Against the real repository (not a disposable fixture), run:

```bash
docker buildx bake -f ai-trading/deploy/docker-bake.hcl ahf-terminal --load   # from the repo root
ai-trading/deploy/ci/smoke-test.sh ahf-terminal
```

This checks `aihf --help` (CLI still imports), a tmux probe, the Textual UI
rendering inside the terminal image, and the 407/200/302 Access behavior.
No provider keys or paid calls are needed. Only report these commands as
run if they actually ran against the real `ahf-terminal` build target — a
scratch or offline fixture has no such target, so never claim this step
passed there.

## 6. Report, then stop

Summarize: old SHA, new SHA, upstream commits in between, any
`pyproject.toml`/`poetry.lock`/`Dockerfile`/`LICENSE` changes, the exact
smoke-test output, and any fork decision needed. A Dependabot PR or "go
ahead" is not, by itself, permission to `git commit`, `git push`, merge the
PR, or deploy — do those only if the current request explicitly says so.

## If a fork becomes unavoidable

1. Get the owner's explicit decision to fork before touching anything.
2. Fork `virattt/ai-hedge-fund`, then point `.gitmodules`'
   `submodule.ai-trading/packages/ai-hedge-fund.url` at the fork and run
   `git submodule sync -- ai-trading/packages/ai-hedge-fund`.
3. Inside the fork's own clone (not the superproject), make the source
   change and add `DIVERGENCE.md` **in the same commit**. `DIVERGENCE.md`
   records: the original upstream URL and base commit, each modified path
   and why, how to reapply/drop the change on a future sync, tests run,
   and the upstream base after reconciliation. It must include the exact
   line `git remote add upstream https://github.com/virattt/ai-hedge-fund.git`.
4. After forking, step 3's fork-origin and idempotent-`upstream`-remote
   checks run before every future fetch — see step 3 above. Sync this
   skill against the **fork's** `origin`, never silently against the
   `upstream` remote — that would discard the fork's patch.
5. Reconciling the fork's divergent branch against new upstream commits
   (e.g. rebasing `fork-divergence` onto `upstream/master`) is its own
   explicit, owner-approved step, separate from a plain sync request. Push
   the result to the fork's `origin` — never force-push a shared branch —
   and confirm it with the same origin-scoped check step 4 uses
   (`git for-each-ref --contains <new-HEAD> refs/remotes/origin/`, nonempty)
   **before** moving the superproject's gitlink to it, so CI and every
   other clone can actually fetch what the gitlink now points at. Do not
   use `git branch -r --contains` or an unscoped `refs/remotes/` match here
   — either would also match the just-added `upstream` remote and could
   pass on a commit `origin` still doesn't have.
6. Never force-push the fork's branch. Record the fork decision in
   `ai-trading/plans/STATUS.md`.

## Rationalizations to reject

| Excuse | Reality |
|---|---|
| "It's a Dependabot PR, that already means commit/merge it" | Dependabot opens the PR; moving and verifying the pin in the working tree is this skill's job, merging is a separate, explicit decision. |
| "This dirty file isn't inside ai-trading/packages/ai-hedge-fund, it's fine to clean it" | A dirty superproject blocks any submodule change this skill makes, regardless of where the dirt is — report it, don't discard it. |
| "The submodule's dirty, I'll stash the edit, sync, then pop it back" | A stash pop can conflict against upstream's own change to the same file; reconciling that conflict by restoring the new `HEAD`'s version leaves the user's edit stranded only in `git stash list`, not in the working tree. Stop and report instead. |
| "poetry.lock just has hash churn, no need to mention it" | Report the diff anyway; a human (or Dependabot's own CI) decides if churn-only is safe. |
| "The fork's branch needs upstream's new commits, I'll just rebase it locally and move the gitlink" | A locally rebased, unpushed commit cannot be fetched by CI or any other clone. Reconciliation needs explicit owner approval and must be pushed to the fork's `origin` before the gitlink moves to it. |
| "The real upstream tracks `main`, so `origin/main` is a safe shortcut" | A reconfigured remote (or a fork) may track a different branch (e.g. `master`). Resolve `origin/HEAD` (or `.gitmodules`' `branch =` entry) instead of hard-coding `main`. |
| "Origin isn't the real upstream, so it must be our fork" | Origin could resolve to some other, unrelated fork instead. Compare `origin` against `.gitmodules`' exact recorded URL, not merely against "is it upstream". |
| "An `upstream` remote already exists, so the idempotent check passed" | An existing `upstream` could point at the wrong place. Compare its URL against `DIVERGENCE.md`'s recorded original URL; stop and report a mismatch instead of trusting mere presence or silently overwriting it. |
| "The candidate shows up under `git branch -r --contains`, so it's reachable" | `branch -r --contains` (and an unscoped `refs/remotes/` match) matches against *any* configured remote, including `upstream`. A candidate that exists only on `upstream` — never pushed to the fork's own `origin` — would pass that check yet be unfetchable by `.gitmodules`' recorded URL. Scope the check to `refs/remotes/origin/` specifically. |
| "It's forked, `origin` matches, and the candidate is origin-reachable, so it's safe to pin" | Being reachable via `origin` proves it's fetchable, not that it preserves the fork's patch. Check that the candidate descends from the current pin or still carries `DIVERGENCE.md` before moving the gitlink. |
| "It's just a status question, I might as well add the missing `upstream` remote while I'm checking" | A status-only request must not create or modify any remote. Report that `upstream` is missing; only an actual sync request adds it, and only after the origin-exact-match check passes. |
| "The user asked if this fork is behind upstream, I'll just fetch `origin` like usual, it's close enough" | The fork's `origin` already includes the fork's own patch commits — comparing against it answers "behind the fork's own tip", not "behind the original upstream". When `upstream` is verified and present, fetch and compare against **it** instead, and stop before the ordinary `origin`-based flow. |
| "Only one commit showed up as different, so I can report it as simply 'one behind'" | A forked history isn't linear against upstream — the pin may also carry commits upstream doesn't have (the fork's own patch). Use `rev-list --left-right --count` to report both directions, and `merge-base --is-ancestor` to say whether it's a clean behind or an actual divergence. |
| "`upstream/HEAD` isn't set, I'll just assume its default branch is `main`" | Never guess a branch name. Resolve it with `git ls-remote --symref upstream HEAD` — the same hard-coded-branch mistake this skill already forbids for `origin`. |
| "`refs/remotes/upstream/HEAD` is already set locally, I can just read that instead of querying again" | A local symbolic-ref is written once (by a clone or `remote set-head`) and a plain `fetch` never refreshes it — if the remote's actual default branch changes later, the cached local ref goes stale while still looking valid. A guided run confirmed this: the remote's `HEAD` had moved to a new branch after an earlier fetch cached the old name, and trusting the stale cache picked the wrong candidate and under-reported the divergence. Query `ls-remote --symref upstream HEAD` fresh every time this branch runs; never shortcut through the local symbolic-ref. |

## Red flags — stop and report instead

- About to run `git stash`, `git clean -fd`, `git checkout -- .`, or `git reset --hard` anywhere in the superproject or the submodule.
- About to run `git rebase`, `git commit`, or `git cherry-pick` inside `ai-trading/packages/ai-hedge-fund` for a plain sync request.
- About to accept `git branch -r --contains` (or any unscoped `refs/remotes/` match) as proof of reachability instead of scoping the check to `refs/remotes/origin/`.
- About to move the gitlink to a commit the origin-scoped `refs/remotes/origin/` check doesn't show.
- About to move a `DIVERGENCE.md`-tracked pin to a candidate that neither descends from the current fork commit nor itself carries `DIVERGENCE.md`.
- About to move the gitlink without having run and read the step-3 `diff` output first (including `poetry.lock`).
- About to run `git commit` or `git push` in the superproject without the user's current message explicitly asking for it.
- About to merge or close the Dependabot PR without the user asking for that specifically.
- About to edit a file, or add `DIVERGENCE.md`, inside `ai-trading/packages/ai-hedge-fund` while its `origin` is the real `virattt/ai-hedge-fund` URL.
- About to hard-code `origin/main` instead of resolving the remote's actual default branch.
- About to fetch without first comparing `origin`'s exact URL against `.gitmodules` and, if `DIVERGENCE.md` exists, `upstream`'s exact URL against its recorded original URL.
- About to add, or create, the `upstream` remote (or any remote) while answering a status-only question.
- About to answer "is this fork behind upstream?" by fetching/comparing `origin` when a verified `upstream` remote already exists — compare against `upstream` instead, and stop before the ordinary `origin`-based flow.
- About to report a forked pin's status as a single "N behind" count without checking both directions (`rev-list --left-right --count`) and whether it's a clean ancestor (`merge-base --is-ancestor`) or an actual divergence.
- About to assume `upstream`'s default branch is `main`, or to trust a locally cached `refs/remotes/upstream/HEAD`, instead of querying `git ls-remote --symref upstream HEAD` fresh every time this branch runs.
- About to use `upstream` (rather than `origin`) as the source for an actual sync request's candidate commit.
