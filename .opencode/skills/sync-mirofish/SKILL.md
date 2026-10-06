---
name: sync-mirofish
description: Use when asked to update, sync, bump, or check the MiroFish upstream pin in ai-trading/packages/mirofish (666ghj/MiroFish, AGPL-3.0), including "is mirofish behind upstream", "bump the mirofish submodule", or a Dependabot PR touching that path. Does not trigger for TradingAgents, ai-hedge-fund, Vibe-Trading, or Family Desk work. If ai-trading/packages/mirofish does not yet exist as a real submodule (gitmodules entry, staged/committed gitlink, initialized checkout), this skill reports that dependency instead of acting — every time, regardless of whether the request is a status question or a sync.
---

# Sync MiroFish

MiroFish (`ai-trading/packages/mirofish`, upstream `666ghj/MiroFish`,
**AGPL-3.0**) is the fourth upstream app: an unmodified Vue static build
plus an unmodified single-process Flask backend, built via dedicated
external wrapper Dockerfiles (`ai-trading/deploy/upstream/mirofish/`,
`.../mirofish-frontend/`) — unlike Vibe-Trading, this package does **not**
build the submodule's own root `Dockerfile` directly. It is gated: usable
only once its submodule exists.

## 0. Check the activation gate first — every time, status or sync

An initialized submodule's `.git` is a **file** (`gitdir: ...`), never a
directory — never `test -d .../.git`. A staged-but-uncommitted submodule
add also makes `git rev-parse HEAD:path` unreliable, so check the index,
not `HEAD`. The gitlink check must require **stage 0** specifically — a
`160000` mode can also appear on stage 1/2/3 during an unresolved merge
conflict, which is not a usable gitlink:

```bash
grep -q '^\[submodule "ai-trading/packages/mirofish"\]' .gitmodules 2>/dev/null \
  && git ls-files --stage -- ai-trading/packages/mirofish 2>/dev/null \
       | awk '$1 == "160000" && $3 == "0" { found=1 } END { exit !found }' \
  && git -C ai-trading/packages/mirofish rev-parse HEAD >/dev/null 2>&1
```

All three must pass: a `.gitmodules` entry, a clean stage-0 gitlink, and an
initialized checkout (portable whether `.git` is a file or directory). If
any fails, **stop here**. Report: "MiroFish is not yet a submodule of this
repo (see `01d-mirofish-hub-design.md`); add it with `git submodule add
https://github.com/666ghj/MiroFish.git ai-trading/packages/mirofish` and
update `ai-trading/AGENTS.md`'s 'Upstream Apps' list to four paths in the
same commit before this skill can sync it." Do not create any file under
`ai-trading/packages/mirofish`, clone upstream elsewhere, or report
success — there is nothing to sync yet.

Also confirm **every** `.gitmodules` path is named in `ai-trading/AGENTS.md`
— a single hardcoded substring check for MiroFish's own path would miss an
onboarding commit that silently drops another package's protection:

```bash
MISSING_AGENTS_PATHS=""
for p in $(git config -f .gitmodules --get-regexp '\.path$' | awk '{print $2}'); do
  grep -q -- "${p#ai-trading/}" ai-trading/AGENTS.md || MISSING_AGENTS_PATHS="$MISSING_AGENTS_PATHS $p"
done
if [ -n "$MISSING_AGENTS_PATHS" ]; then
  printf 'STOP: ai-trading/AGENTS.md is missing protected-path coverage for:%s — report an incomplete submodule-add commit, do not proceed as if onboarding were complete\n' "$MISSING_AGENTS_PATHS" >&2
  exit 1
fi
```

(`AGENTS.md` documents paths relative to its own `ai-trading/` directory,
so strip that prefix first; the loop scales to whatever `.gitmodules`
lists — four paths today, or one on a single-submodule fixture.)

This gate runs for a status question exactly as for a sync.

## 1. Status question or sync request?

A status question ("is mirofish behind upstream?") makes **no** worktree,
gitlink, remote-creation, or submodule-`HEAD` edit — step 4 may still
update local `refs/remotes/{origin,upstream}/*` via fetch (refs, not
files). Mark `REQUEST_KIND=status` or `REQUEST_KIND=sync` before step 4.
Only "sync/update/bump mirofish" authorizes step 7; a Dependabot PR or "go
ahead" moves/verifies the pin, not by itself commit/push/merge permission
(step 10).

## 2. Refuse on any dirty state — anywhere, before any fetch

```bash
git status --porcelain
git -C ai-trading/packages/mirofish status --porcelain
```

If either prints anything, **stop and report it**, even if unrelated to
MiroFish. Never `git stash`/`clean -fd`/`checkout -- .`/`reset --hard` to
tidy up first — a stash-push/pop "preserve the edit" sequence can conflict
with upstream's own change and strand the edit in `git stash list`. Ask
the owner to commit, stash, or discard themselves.

## 3. Load context

Read `ai-trading/AGENTS.md` ("Upstream Apps", MiroFish's
`MIROFISH_ACTIVATE` opt-in), `.gitmodules`, the `MiroFish` row in
`ai-trading/plans/STATUS.md`, and `01d-mirofish-hub-design.md` for the
AGPL/Zep constraints. `MIROFISH_ACTIVATE` is a **deployment** gate,
separate from step 0's submodule gate — never treat it as a reason to
skip a sync check.

## 4. Fork URL guards, then status-vs-sync fetch split

If `ai-trading/packages/mirofish/DIVERGENCE.md` exists (already forked,
see "If a fork becomes unavoidable" below), run these **before any
fetch**, against **exact URL equality**:

1. **`origin` must exactly equal `.gitmodules`' recorded fork URL.** Fail
   closed:
   ```bash
   CONFIGURED_FORK_URL="$(git config -f .gitmodules --get submodule.ai-trading/packages/mirofish.url)"
   ACTUAL_ORIGIN_URL="$(git -C ai-trading/packages/mirofish remote get-url origin)"
   if [ "$ACTUAL_ORIGIN_URL" != "$CONFIGURED_FORK_URL" ]; then
     printf 'STOP: origin (%s) does not match .gitmodules fork URL (%s) — report this, do not fetch\n' \
       "$ACTUAL_ORIGIN_URL" "$CONFIGURED_FORK_URL" >&2
     exit 1
   fi
   ```
2. **`upstream`, if present, must exactly equal the URL recorded in
   `DIVERGENCE.md`'s `git remote add upstream <original-url>` line — and
   that recorded URL must be nonempty before any remote operation**
   (`git remote add upstream ""` **succeeds** silently — fail closed
   first). If missing on a **sync** request, restore idempotently:
   ```bash
   RECORDED_UPSTREAM_URL="$(grep -m1 -o 'git remote add upstream [^[:space:]]*' ai-trading/packages/mirofish/DIVERGENCE.md | awk '{print $NF}')"
   if [ -z "$RECORDED_UPSTREAM_URL" ]; then
     printf 'STOP: DIVERGENCE.md has no parseable "git remote add upstream <url>" line — report this, do not add any remote, do not fetch\n' >&2
     exit 1
   fi
   if git -C ai-trading/packages/mirofish remote get-url upstream >/dev/null 2>&1; then
     EXISTING_UPSTREAM_URL="$(git -C ai-trading/packages/mirofish remote get-url upstream)"
     if [ "$EXISTING_UPSTREAM_URL" != "$RECORDED_UPSTREAM_URL" ]; then
       printf 'STOP: existing upstream (%s) does not match DIVERGENCE.md recorded URL (%s) — report this, do not overwrite, do not fetch\n' \
         "$EXISTING_UPSTREAM_URL" "$RECORDED_UPSTREAM_URL" >&2
       exit 1
     fi
   elif [ "$REQUEST_KIND" = "sync" ]; then
     if ! git -C ai-trading/packages/mirofish remote add upstream "$RECORDED_UPSTREAM_URL"; then
       printf 'STOP: git remote add upstream exited nonzero — report this, do not continue\n' >&2
       exit 1
     fi
     VERIFY_UPSTREAM_URL="$(git -C ai-trading/packages/mirofish remote get-url upstream)"
     if [ "$VERIFY_UPSTREAM_URL" != "$RECORDED_UPSTREAM_URL" ]; then
       printf 'STOP: upstream after add (%s) does not match recorded URL (%s) — report this, do not fetch\n' \
         "$VERIFY_UPSTREAM_URL" "$RECORDED_UPSTREAM_URL" >&2
       exit 1
     fi
   else
     printf 'STATUS: upstream remote missing — reporting only, not adding it for a status-only request\n'
   fi
   ```

Only after the guards above (or immediately, if never forked), compute the
pin — local only, no network. Use the submodule's own checked-out `HEAD`,
not `git rev-parse HEAD:ai-trading/packages/mirofish`: a staged-but-
uncommitted submodule add makes the latter fail even though the submodule
is real and checked out:

```bash
OLD="$(git -C ai-trading/packages/mirofish rev-parse HEAD)"
```

### Status about a fork: compare against `upstream`, exit before Ordinary flow

```bash
if [ "$REQUEST_KIND" = "status" ] && [ -f ai-trading/packages/mirofish/DIVERGENCE.md ]; then
  if git -C ai-trading/packages/mirofish remote get-url upstream >/dev/null 2>&1; then
    UPSTREAM_SYMREF="$(git -C ai-trading/packages/mirofish ls-remote --symref upstream HEAD)"
    UPSTREAM_BRANCH="$(printf '%s\n' "$UPSTREAM_SYMREF" | awk '/^ref:/ {sub("refs/heads/", "", $2); print $2; exit}')"
    if [ -z "$UPSTREAM_BRANCH" ]; then
      printf 'STOP: could not resolve upstream HEAD symref — report this\n' >&2
      exit 1
    fi
    git -C ai-trading/packages/mirofish fetch upstream
    UPSTREAM_TIP="$(git -C ai-trading/packages/mirofish rev-parse --verify "upstream/$UPSTREAM_BRANCH")"
    read -r UPSTREAM_ONLY FORK_ONLY <<<"$(git -C ai-trading/packages/mirofish rev-list --left-right --count "$UPSTREAM_TIP...$OLD")"
    git -C ai-trading/packages/mirofish merge-base --is-ancestor "$OLD" "$UPSTREAM_TIP"
    ANCESTOR_STATUS=$?
    printf 'STATUS: upstream-only=%s fork-only=%s ancestor=%s — reporting, no checkout/stage/commit/push\n' \
      "$UPSTREAM_ONLY" "$FORK_ONLY" "$ANCESTOR_STATUS"
    exit 0
  elif [ "${ASK_ABOUT_FORK_TIP:-0}" != "1" ]; then
    printf 'STATUS: upstream remote missing — cannot determine freshness against the original project; status-only requests do not restore it\n'
    exit 0
  fi
fi
```

### Ordinary flow — sync requests; non-forked status; fork-tip-only status

```bash
git -C ai-trading/packages/mirofish fetch origin
```

Resolve `NEW` before comparing anything — never hard-code `origin/main`; a
fork may track a different branch:

- Named commit/tag/branch: `NEW="$(git -C ai-trading/packages/mirofish rev-parse --verify <what-they-named>)"`.
- Otherwise: `TARGET_BRANCH="$(git -C ai-trading/packages/mirofish symbolic-ref --short refs/remotes/origin/HEAD)"`
  (strip `origin/`; fall back to `.gitmodules`' `branch =` entry, or a
   fresh `ls-remote --symref origin HEAD`, or ask the owner).
   `NEW="$(git -C ai-trading/packages/mirofish rev-parse --verify "origin/$TARGET_BRANCH")"`.

## 5. Fetch and compare — the real risk surface, not just the submodule's own `Dockerfile`

```bash
git -C ai-trading/packages/mirofish log --oneline "$OLD..$NEW"
git -C ai-trading/packages/mirofish diff --name-status "$OLD" "$NEW"
git -C ai-trading/packages/mirofish diff "$OLD" "$NEW" -- \
  backend/app/config.py backend/app/__init__.py \
  backend/pyproject.toml backend/uv.lock \
  frontend/package.json frontend/package-lock.json \
  locales/ LICENSE
```

Wrapper Dockerfiles build `backend/`, `frontend/`, and `locales/`; upstream's
root `Dockerfile` is informational. Review:

- `backend/app/config.py`'s `Config.validate()` — requires `LLM_API_KEY`/`ZEP_API_KEY` nonempty, rejects `ZEP_API_URL` ("Zep Cloud only"); flag any requirement change.
- `backend/app/__init__.py` — registered blueprints (`/api/graph`, `/api/simulation`, `/api/report`) and `/health`; flag a changed route set.
- `backend/pyproject.toml`/`backend/uv.lock` — what `uv sync --frozen --no-dev` installs.
- `frontend/package.json`/`frontend/package-lock.json` — what `npm ci && npm run build` depends on.
- `locales/` (whole directory, not just `languages.json`) — `locale.py` loads **every** `.json` file here at **import time**; the frontend globs the same directory at build time. A bad change to any locale file can crash Flask app creation before `/health` registers.
- `LICENSE` — AGPL-3.0; flag any relicensing.

Also review root `Dockerfile`/`README` and every path from `--name-status`.

### Status-only ordinary flow: report after all read-only review, then stop

```bash
if [ "$REQUEST_KIND" = "status" ]; then
  read -r ORIGIN_ONLY LOCAL_ONLY <<<"$(git -C ai-trading/packages/mirofish rev-list --left-right --count "$NEW...$OLD")"
  git -C ai-trading/packages/mirofish merge-base --is-ancestor "$OLD" "$NEW"
  ANCESTOR_STATUS=$?
  printf 'STATUS: origin-only=%s local-only=%s ancestor=%s — reviewed log and changed files; no checkout/stage/registry edit\n' \
    "$ORIGIN_ONLY" "$LOCAL_ONLY" "$ANCESTOR_STATUS"
  exit 0
fi
```

## 6. Preflight gate — license identity, public source URL, verification availability, before any write

All checks are read-only and must pass before step 7 writes.

### 6a. Candidate LICENSE must exist and identify as AGPL-3.0

```bash
if ! LICENSE_CONTENT="$(git -C ai-trading/packages/mirofish show "$NEW:LICENSE" 2>/dev/null)"; then
  printf 'STOP: candidate %s has no LICENSE file at its root — cannot confirm AGPL-3.0 identity before moving the pin or updating the hub link; report this\n' "$NEW" >&2
  exit 1
fi
if ! printf '%s\n' "$LICENSE_CONTENT" | grep -qi 'GNU AFFERO GENERAL PUBLIC LICENSE'; then
  printf 'STOP: candidate %s LICENSE does not identify as the GNU Affero General Public License — report a possible relicense, do not pin or update AGPL links\n' "$NEW" >&2
  exit 1
fi
```

### 6b. The hub's AGPL links derive from `origin` — never a hardcoded owner/repo — and a fork's origin must be validated public

```bash
ORIGIN_URL="$(git -C ai-trading/packages/mirofish remote get-url origin)"
NORMALIZED_URL="${ORIGIN_URL%.git}"
if [ -f ai-trading/packages/mirofish/DIVERGENCE.md ]; then
  # EXACT https://github.com/<owner>/<repo> only — no trailing slash, no
  # extra path segment, no query/fragment, no userinfo. A shell glob like
  # `https://github.com/*/*` wrongly accepts all of those; this does not.
  if ! printf '%s' "$NORMALIZED_URL" | grep -Eq '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'; then
    printf 'STOP: fork origin (%s) is not an exact https://github.com/<owner>/<repo> URL — cannot confirm AGPL-3.0 source availability for the hub link; report this and get owner approval before moving the pin\n' "$ORIGIN_URL" >&2
    exit 1
  fi
fi
HUB_SOURCE_URL="$NORMALIZED_URL/tree/$NEW"
HUB_LICENSE_URL="$NORMALIZED_URL/blob/$NEW/LICENSE"
```

Gate only forks: non-fork fixtures may use a local origin. Fork failure stops
before pin movement.

### 6c. The real verification targets must exist in this repo context

```bash
if [ ! -f ai-trading/deploy/docker-bake.hcl ] || [ ! -f ai-trading/deploy/ci/smoke-test.sh ]; then
  printf 'STOP: this repository context has no ai-trading/deploy/docker-bake.hcl or ai-trading/deploy/ci/smoke-test.sh — MiroFish verification is unavailable here (a synthetic/offline fixture, not the real repo); report the gap, do not move the pin or edit the hub AGPL links without a working verification path\n' >&2
  exit 1
fi
```

### 6d. Hub-record shape must be valid before checkout or staging

Find stable slug, bound one object, and require each field once before step 7:

```bash
APPS_FILE="ai-trading/frontend/lib/apps.ts"
SLUG_MATCHES="$(grep -c 'slug: "mirofish"' "$APPS_FILE")"
if [ "$SLUG_MATCHES" -ne 1 ]; then
  printf 'STOP: %s record count for slug "mirofish" is %s (expected exactly 1) — do not checkout or edit links\n' "$APPS_FILE" "$SLUG_MATCHES" >&2
  exit 1
fi
SLUG_LINE="$(grep -n 'slug: "mirofish"' "$APPS_FILE" | cut -d: -f1)"
RECORD_START="$(awk -v s="$SLUG_LINE" 'NR<=s && /^  \{$/ {start=NR} END{print start}' "$APPS_FILE")"
RECORD_END="$(awk -v s="$SLUG_LINE" 'NR>=s && /^  \},?$/ {print NR; exit}' "$APPS_FILE")"
if [ -z "$RECORD_START" ] || [ -z "$RECORD_END" ]; then
  printf 'STOP: could not bound the mirofish hub record — do not checkout or edit links\n' >&2
  exit 1
fi
RECORD="$(sed -n "${RECORD_START},${RECORD_END}p" "$APPS_FILE")"
for FIELD in sourceUrl licenseUrl pinnedCommit; do
  COUNT="$(printf '%s\n' "$RECORD" | grep -c "^\\s*${FIELD}: \\\"")"
  if [ "$COUNT" -ne 1 ]; then
    printf 'STOP: mirofish record has %s occurrences of "%s" (expected exactly 1) — do not checkout or edit links\n' "$COUNT" "$FIELD" >&2
    exit 1
  fi
done
OLD_SOURCE_LINE="$(printf '%s\n' "$RECORD" | grep '^\s*sourceUrl: "')"
OLD_LICENSE_LINE="$(printf '%s\n' "$RECORD" | grep '^\s*licenseUrl: "')"
OLD_PINNED_LINE="$(printf '%s\n' "$RECORD" | grep '^\s*pinnedCommit: "')"
NEW_SOURCE_LINE="$(printf '%s' "$OLD_SOURCE_LINE" | sed "s|\"[^\"]*\"|\"$HUB_SOURCE_URL\"|")"
NEW_LICENSE_LINE="$(printf '%s' "$OLD_LICENSE_LINE" | sed "s|\"[^\"]*\"|\"$HUB_LICENSE_URL\"|")"
NEW_PINNED_LINE="$(printf '%s' "$OLD_PINNED_LINE" | sed "s|\"[^\"]*\"|\"$NEW\"|")"
```

## 7. Move the pin — nothing else

Only for a sync request, step 4's guards clean, step 6 passed. Verify the
candidate is reachable from **`origin` specifically**:

```bash
if [ -z "$(git -C ai-trading/packages/mirofish for-each-ref --contains "$NEW" refs/remotes/origin/)" ]; then
  printf 'STOP: %s is not reachable from any refs/remotes/origin/* ref — report this, do not checkout\n' "$NEW" >&2
  exit 1
fi
```

Never use unscoped remote reachability. A sync never authorizes `rebase`,
`commit`, or `cherry-pick` inside the submodule.

If `DIVERGENCE.md` exists, origin reachability alone is not enough — the
candidate must also preserve the fork's patch:

```bash
if [ -f ai-trading/packages/mirofish/DIVERGENCE.md ]; then
  if git -C ai-trading/packages/mirofish merge-base --is-ancestor "$OLD" "$NEW"; then
    :
  elif git -C ai-trading/packages/mirofish show "$NEW:DIVERGENCE.md" >/dev/null 2>&1; then
    :
  else
    printf 'STOP: candidate %s neither descends from the current fork commit %s nor carries DIVERGENCE.md — report this and get owner approval\n' "$NEW" "$OLD" >&2
    exit 1
  fi
fi
```

Only then:

```bash
git -C ai-trading/packages/mirofish checkout "$NEW"
git add ai-trading/packages/mirofish
```

## 8. Verify — the real bake targets and smoke test, with dummy keys only; restore on failure

Do not reinvent a manual `npm ci`/`uv run` sequence — step 6c already
proved these targets exist:

```bash
if ! docker buildx bake -f ai-trading/deploy/docker-bake.hcl mirofish-backend --load \
   || ! docker buildx bake -f ai-trading/deploy/docker-bake.hcl mirofish-frontend \
   || ! ai-trading/deploy/ci/smoke-test.sh mirofish; then
  TOTAL_CHANGED="$(git status --porcelain | wc -l)"
  SUBMODULE_ONLY_CHANGED="$(git status --porcelain -- ai-trading/packages/mirofish | wc -l)"
  if [ "$TOTAL_CHANGED" -eq 1 ] && [ "$SUBMODULE_ONLY_CHANGED" -eq 1 ]; then
    # Only this agent's own gitlink move is present (step 9 runs only after
    # this step passes) — safe to restore, never a broader stash/reset.
    git -C ai-trading/packages/mirofish checkout "$OLD"
    git add ai-trading/packages/mirofish
    printf 'STOP: real bake/smoke-test verification failed for candidate %s — restored submodule to prior pin %s, nothing staged. Report the failure; do not retry a different candidate without the owner choosing one.\n' "$NEW" "$OLD" >&2
  else
    printf 'STOP: real bake/smoke-test verification failed for candidate %s, AND the tree has changes beyond this agent'"'"'s own gitlink move — do not auto-restore over a possible concurrent edit; report both findings and ask the owner how to proceed.\n' "$NEW" >&2
  fi
  exit 1
fi
```

Run from repo root. Frontend target exports locally, so only backend takes `--load`.

`smoke-test.sh mirofish` runs `smoke_mirofish_backend` (dummy
`LLM_API_KEY=sk-smoke-dummy`/`ZEP_API_KEY=z_smoke-dummy`, **only** `GET
/health`, HTTP 200 and `"status":"ok"`) and `smoke_mirofish_frontend`
(content-hashed `assets/index-*.js`, no leftover `localhost:5001`).
Never call `/api/graph`, `/api/simulation`, or `/api/report`, or pass real keys.

## 9. Atomically update and verify three AGPL fields

Only after step 8 passes. Step 6d already captured each exact old/new line.
Use one `apply_patch` operation with all three replacements in the MiroFish
record. It must match all three exact old lines or make no edit. Never use
`sed -i`, a global replacement, or three separate edits.

```diff
*** Begin Patch
*** Update File: ai-trading/frontend/lib/apps.ts
@@
-<exact OLD_SOURCE_LINE>
+<exact NEW_SOURCE_LINE>
@@
-<exact OLD_LICENSE_LINE>
+<exact NEW_LICENSE_LINE>
@@
-<exact OLD_PINNED_LINE>
+<exact NEW_PINNED_LINE>
*** End Patch
```

If post-edit recheck fails, first use one reverse `apply_patch` operation to
replace all three exact `NEW_*_LINE` values with their `OLD_*_LINE` values.
If reverse patch cannot match all three lines, stop loudly: concurrent work
made restoration unsafe; do not touch the gitlink. After reverse patch,
re-read the bounded record and verify each old line occurs exactly once and
no new line remains. Only then restore and stage the old pin:

```bash
RECORD_AFTER="$(sed -n "${RECORD_START},${RECORD_END}p" "$APPS_FILE")"
POST_EDIT_BAD=0
for FIELD in sourceUrl licenseUrl pinnedCommit; do
  case "$FIELD" in
    sourceUrl) NEW_LINE="$NEW_SOURCE_LINE"; OLD_LINE="$OLD_SOURCE_LINE" ;;
    licenseUrl) NEW_LINE="$NEW_LICENSE_LINE"; OLD_LINE="$OLD_LICENSE_LINE" ;;
    pinnedCommit) NEW_LINE="$NEW_PINNED_LINE"; OLD_LINE="$OLD_PINNED_LINE" ;;
  esac
  [ "$(printf '%s\n' "$RECORD_AFTER" | grep -c "^\\s*${FIELD}: \\\"")" -eq 1 ] || POST_EDIT_BAD=1
  [ "$(printf '%s\n' "$RECORD_AFTER" | grep -cxF "$NEW_LINE")" -eq 1 ] || POST_EDIT_BAD=1
  [ "$NEW_LINE" = "$OLD_LINE" ] || [ "$(printf '%s\n' "$RECORD_AFTER" | grep -cxF "$OLD_LINE")" -eq 0 ] || POST_EDIT_BAD=1
done
```

If `POST_EDIT_BAD=1`, run this one reverse patch, then run the restoration
check below. If `POST_EDIT_BAD=0`, continue to step 10.

```diff
*** Begin Patch
*** Update File: ai-trading/frontend/lib/apps.ts
@@
-<exact NEW_SOURCE_LINE>
+<exact OLD_SOURCE_LINE>
@@
-<exact NEW_LICENSE_LINE>
+<exact OLD_LICENSE_LINE>
@@
-<exact NEW_PINNED_LINE>
+<exact OLD_PINNED_LINE>
*** End Patch
```

If reverse patch cannot match all three lines, stop loudly and leave gitlink
unchanged. After a successful reverse patch, verify restoration before
reverting gitlink. Do not replace whole file or use `git checkout -- "$APPS_FILE"`:

```bash
RECORD_RESTORED="$(sed -n "${RECORD_START},${RECORD_END}p" "$APPS_FILE")"
RESTORE_BAD=0
for LINE in "$OLD_SOURCE_LINE" "$OLD_LICENSE_LINE" "$OLD_PINNED_LINE"; do
  [ "$(printf '%s\n' "$RECORD_RESTORED" | grep -cxF "$LINE")" -eq 1 ] || RESTORE_BAD=1
done
for LINE in "$NEW_SOURCE_LINE" "$NEW_LICENSE_LINE" "$NEW_PINNED_LINE"; do
  [ "$(printf '%s\n' "$RECORD_RESTORED" | grep -cxF "$LINE")" -eq 0 ] || RESTORE_BAD=1
done
if [ "$RESTORE_BAD" -eq 1 ]; then
  printf 'STOP: hub rollback could not be verified — leave gitlink untouched and report possible concurrent edits\n' >&2
  exit 1
fi
git -C ai-trading/packages/mirofish checkout "$OLD"
git add ai-trading/packages/mirofish
printf 'STOP: hub link edit for %s did not verify; restored three fields and gitlink %s. Report failure.\n' "$NEW" "$OLD" >&2
exit 1
```

Exclude `.next/`/`out/` build output from any search. Do not add a launch
link: per `01d-mirofish-hub-design.md`, the card stays "Experimental ·
Setup required" until a separate, owner-approved activation step.

## 10. Report, then stop
Summarize: old/new SHA, upstream commits in between, any
`config.py`/`__init__.py`/lockfile/`locales/`/`LICENSE` change (§5), the
step-6 preflight result, the bake+smoke-test output (or the restore
performed if it failed), the AGPL link status (all three fields), and any
fork decision needed. Do not commit, push, open a PR, merge, or deploy —
and never call Zep or an LLM provider — unless the current request
explicitly says so. MiroFish being deploy-disabled by default is unrelated
to whether this sync is safe to stage.

## If a fork becomes unavoidable

1. Get owner approval. Fork, update `.gitmodules`, and run `git submodule sync -- ai-trading/packages/mirofish`.
2. In same fork commit, add `DIVERGENCE.md`: original URL/base, paths/rationale, reapply/drop, tests, reconciled base, and `git remote add upstream https://github.com/666ghj/MiroFish.git`.
3. Keep source public at step 6b's origin-derived URL. Future syncs verify that fork origin/upstream; reconcile by pushing only to `origin`, never force-pushing. Record decision in `ai-trading/plans/STATUS.md`.

## Red flags — stop and report instead

- `test -d .../.git`, non-stage-0 `160000`, a single AGENTS.md substring, or a loose GitHub-URL glob as a "good enough" check.
- Checking out before step 6 (including §6d), or a status request continuing beyond its compare-and-exit.
- Owner-string lookup, `sed -i`/`.bak`, separate hub-field writes, or any unverified forward/reverse edit.
- Hardcoding `sourceUrl`/`licenseUrl` instead of deriving from validated `origin`; accepting a non-exact GitHub URL.
- Skipping bake/smoke-test because targets are absent while still completing the sync; leaving a gitlink or hub edit unrestored after step 8/9 fails.
- Calling `/api/graph`, `/api/simulation`, `/api/report`, or any real Zep/LLM key, anywhere in this skill's own verification.
- `git stash`/`clean -fd`/`checkout -- .`/`reset --hard` anywhere; `rebase`/`commit`/`cherry-pick` inside the submodule; diffing only the submodule's own `Dockerfile` instead of §5's wrapper-relevant files; diffing only `locales/languages.json`.
- `git commit`/`push` without explicit authorization; hard-coding `origin/main`; fetching before the exact-URL fork guards.
