# ai-trading Secret Manager bundle tool

Every ai-trading secret and environment value lives in one GCP Secret Manager
secret, `ai-trading-env-bundle`, project `tobytran-portfolio`. The bundle is
read and written only through `env-bundle.py`; nothing else touches it, and
no `.env` files, keys, or tokens ever live inside `ai-trading/`.

## Grammar

```
# comments and blank lines are ignored
[section-name]          # ^[a-z0-9][a-z0-9-]*$; every key belongs to a section
KEY=value               # KEY ^[A-Za-z_][A-Za-z0-9_]*$; value = rest of the line, never empty, never "replace-me", no NUL or CR
```

- Duplicate sections and duplicate keys within a section are errors.
- A section may be empty, in which case `render` writes an empty file.
- `=` inside a value is fine: the key/value split happens on the *first* `=`.

Current sections: `deploy` (VPS connection facts), `cloudflare` (the shared
API token and Terraform variables), and one section per upstream app
(`tradingagents`, `ai-hedge-fund`, `vibe-trading`).

## Commands

| Command | Behavior |
|---|---|
| `python3 env-bundle.py [--project P] pull APP OUT_FILE` | Writes the latest `APP-env-bundle` version to `OUT_FILE` (mode 0600). |
| `python3 env-bundle.py [--project P] push APP IN_FILE` | Validates, uploads, verifies the hash, and destroys every other version (see below). Prints `pushed APP-env-bundle version N`. |
| `python3 env-bundle.py [--project P] render APP --out-dir DIR [--bundle-file F] SECTION...` | Writes `DIR/SECTION.env` for each section (DIR mode 0700, files 0600). Fails if a requested section is missing. |
| `python3 env-bundle.py [--project P] exec APP [--bundle-file F] SECTION... -- CMD ARGS...` | Runs `CMD` with the sections' keys added to the environment (later sections win) and returns its exit code. |
| `python3 env-bundle.py [--project P] get-file SECRET KEY OUT_FILE` | Reads a JSON-map secret and writes the string at `KEY` byte-exact to `OUT_FILE` (mode 0600). |
| `python3 env-bundle.py check IN_FILE` | Validates a local file against the grammar. Never calls gcloud. |

`--project` defaults to `tobytran-portfolio` and every gcloud call passes
`--project` explicitly. `render` and `exec` accept `--bundle-file F` to read
a local file instead of calling gcloud (used by tests and anywhere a bundle
is already on disk).

## Editing the bundle

```bash
python3 infrastructure/secrets/env-bundle.py pull ai-trading /tmp/bundle.env
$EDITOR /tmp/bundle.env
python3 infrastructure/secrets/env-bundle.py check /tmp/bundle.env
python3 infrastructure/secrets/env-bundle.py push ai-trading /tmp/bundle.env
rm -f /tmp/bundle.env
```

## Single-version policy

`ai-trading-env-bundle` keeps exactly one non-destroyed version (label
`versioning=single`). `push`:

1. validates the file against the grammar;
2. uploads it as a new version;
3. reads that version back and compares its SHA-256 against the local file;
4. destroys every other non-destroyed version;
5. re-lists versions and asserts exactly one remains, equal to the new one.

Any failure at steps 3-5 leaves the new version in place and reports the
problem rather than silently leaving two live versions.

## Masking

Outside GitHub Actions (`GITHUB_ACTIONS` not `true`), any command that calls
gcloud refuses to run unless `CLOUDSDK_ACTIVE_CONFIG_NAME` is set to exactly
`personal` -- the operator machine's default gcloud configuration
(`chartflow`) is a different (work) account, and any other explicit value is
just as wrong a target as the default, so this guard stops a secret command
from silently running against it. `check` never calls gcloud and needs no
configuration.

Under GitHub Actions, `render`, `exec`, and `get-file` print
`::add-mask::<value>` for every value they read from Secret Manager, one
line per non-empty line of the value, so GitHub's log redaction picks up
multi-line secrets (e.g. SSH keys) as well as single-line ones. Values are
never otherwise printed, logged, or committed; variable and key names are
fine to print.

## Copy, never reuse -- with one exception

Values ai-trading needs from `expense-tax-management` (its `.env`,
`.keys/`, or its own Secret Manager bundle) are copied into
`ai-trading-env-bundle`. ai-trading never reads expense's bundle at
runtime; the two stay independent after the copy.

The one shared exception is the OVH deploy SSH key, which stays in
`expense-tax-env-files` (a JSON map secret in `tobytran-portfolio`) under
key `ovh/github-actions-expense-tax`. ai-trading reads it directly with
`get-file`, rather than copying it into its own bundle, because it is the
same VPS credential expense-tax-management already deploys with.
