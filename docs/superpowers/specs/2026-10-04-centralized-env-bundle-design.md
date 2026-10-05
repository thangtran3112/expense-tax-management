# Centralized Runtime Env Bundle Design

**Date:** 2026-10-04
**Status:** Approved design; implementation pending
**Depends on:** `origin/dev` at `169bd55`; Cloudflare agent token update and GitHub `CLOUDFLARE_API_TOKEN` refresh (2026-10-05)

## Intent

The owner wants every Expense Tax environment value and secret to live in one GCP
Secret Manager entry with no version history. Both the laptop and the VPS read it
at runtime through the same mechanism. No env or key files remain inside
`expense-tax-management/`. GitHub may hold copies that CI needs. The rule must be
recorded in `expense-tax-management/AGENTS.md`.

Success means:

- `expense-tax-management/` contains no `.env`, `.env.local`, or `.keys/` files.
- Local development runs entirely from the bundle.
- Production deploys load the same bundle on the VPS at runtime.
- The laptop and the VPS use the same loader script and the same bundle.

## Decisions

- **VPS reads GCP itself** (owner choice). It uses a dedicated reader service
  account, not a value rendered by the deploy job.
- **Mirror rule** (owner): laptop and VPS follow the same centralized env. No
  host-specific env source exists.
- **One bundle, including operator values** (owner): the VPS reader key can read
  every key in the bundle. Secret Manager IAM is per secret, not per key. The owner
  accepted this trade-off.
- **Bash loader, not Node:** the VPS has `gcloud`, `jq`, and bash, but no Node. The
  laptop has the same three tools, so one bash script runs unchanged on both hosts.
- **Reader service account lives in `tobytran-portfolio`:** the organization
  that owns `expense-tax-tobytran-2026` enforces
  `iam.disableServiceAccountKeyCreation`. `tobytran-portfolio` has no
  organization and allows keys.

## Non-Goals

- Shared VPS infrastructure env files stay unchanged: `/etc/family-app/temporal.env`,
  the backup env, and the shared Postgres `.env`. They belong to family-app shared
  infrastructure, which has its own lifecycle.
- Services do not call Secret Manager in-process. Services keep reading
  `process.env` / `os.environ` unchanged.
- The Cloudflare Terraform workflow auth does not change. It keeps the GitHub
  secret.
- Transitional `expense-service` and `frontend/web` code stays untouched. It
  receives env from the launcher process.
- No automatic GitHub mirror sync.
- No deletion of GitHub variables, GitHub secrets, WIF pools, or service accounts.
  The owner performs deletions.

## Secret Layout

### `expense-tax-env-bundle` (project `tobytran-portfolio`)

The payload is UTF-8 text with LF line endings. Each line is one of:

- blank;
- `# comment`;
- `NAMESPACE__KEY=VALUE`.

Rules, enforced on every read:

- `NAMESPACE` is exactly `LOCAL`, `PRODUCTION`, or `OPS`.
- `KEY` matches `^[A-Za-z_][A-Za-z0-9_]*$`.
- `VALUE` is everything after the first `=`, taken literally. There is no quote
  stripping, no inline comments, and no interpolation. A value may be empty. It
  must not contain NUL or CR.
- Duplicate `NAMESPACE__KEY` entries are an error.
- An `export ` prefix is an error.
- Reserved keys are rejected in every namespace: `PATH`, `HOME`, `IFS`, `SHELL`,
  `USER`, `LOGNAME`, `PWD`, `OLDPWD`, `SHLVL`, `ENV`, `BASH_ENV`, `CDPATH`,
  `PS1`–`PS4`, any `BASH*`, `LD_*`, and `DYLD_*`.

Namespaces:

- `LOCAL__*`: the laptop development stack. Source: today's
  `expense-tax-management/.env` minus Cloudflare tokens.
- `PRODUCTION__*`: the VPS application runtime. It is a subset of the
  `deploy.sh` `KNOWN_ENV_KEYS` allowlist. Database URLs use the container form
  (`postgres:5432`).
- `OPS__*`: operator and infrastructure values. They are never injected into an
  application runtime unless an operator selects `ops`.

The secret keeps exactly one enabled version. Labels:
`app=expense-tax-management,versioning=single`.

### `expense-tax-env-files` (project `tobytran-portfolio`)

A JSON object that maps a file name to its raw content. It holds SSH key pairs
and the VPS `known_hosts` entry. Same single-version rule and labels. The VPS
reader has no access to it.

## Loader: `expense-tax-management/scripts/env.sh`

One bash script. Dependencies: `gcloud` and `jq`. It is portable to macOS bash
3.2 (no associative arrays, no `mapfile`, no `${var,,}`). It never uses `eval`.
It never prints values, except through `get`.

### Commands

- **`run <ns> [--env-file-var VAR] [--] <cmd> [args...]`**
  - Fetches the bundle once and parses it strictly.
  - Exports every `<NS>__KEY` as `KEY` with `printf -v` and `export`. Bundle
    values override inherited values. Secrets never appear in argv.
  - With `--env-file-var VAR`: writes `KEY=VALUE` lines to a file with mode
    `0600`, inside a private `0700` directory. It prefers `/dev/shm`, otherwise
    `${TMPDIR:-/tmp}`. It exports `VAR=<path>`.
  - Runs the command as a child process, forwards INT/TERM, removes the temp
    directory on exit, and exits with the child's status.
- **`get <ns> <KEY>`**: prints one value with no trailing newline. Exits non-zero
  if the key is absent.
- **`keys [<ns>]`**: prints key names only, sorted. With `<ns>`, it prints the
  stripped names; without it, the full `NS__KEY` names.
- **`set <ns> <KEY>`**: reads the value from stdin and strips one trailing LF.
  It rejects LF, CR, or NUL in the value, then writes.
- **`unset <ns> <KEY>`**: removes the line and writes. If the key is absent, it
  is a no-op and creates no version.
- **`import <ns> <dotenv-file>`**: parses the source leniently:
  - an optional `export ` prefix;
  - one layer of matching quotes;
  - for unquoted values, a ` #...` inline comment is stripped;
  - multi-line values are rejected.

  It then sets every key in one write and prints the count of imported key
  names. This is a merge: keys that are not in the file stay untouched.
- **`set-file <name>`**: reads raw content from stdin, without newline
  stripping. It sets entry `<name>` in `expense-tax-env-files` using the same
  write sequence as the bundle.
- **`with-file <name> [--] <cmd> [args...]`**: writes the entry `<name>` from
  `expense-tax-env-files` to a `0600` temp file, replaces each literal `{}`
  argument with that path, runs the command, and removes the file.

### Writes (single-version rule)

`set`, `unset`, `import`, and `set-file` follow this sequence:

1. Fetch the latest payload and the version list.
2. Compute the new payload. Keep untouched lines verbatim. Replace changed keys
   in place. Append new keys at the end. If nothing changed, exit without a new
   version.
3. Run `gcloud secrets versions add --data-file=<0600 temp file>`.
4. Read the new version back and compare its sha256 with the local payload.
5. Destroy every other ENABLED or DISABLED version.
6. Assert the postcondition: exactly one non-destroyed version, equal to the new
   version.

If two writers run at the same time, the last one wins. This is acceptable for a
single operator and is marked as a `ponytail:` ceiling in the code.

### Authentication and configuration

| Setting | Default | Override |
|---|---|---|
| Project | `tobytran-portfolio` | `EXPENSE_TAX_ENV_PROJECT` |
| Bundle secret | `expense-tax-env-bundle` | `EXPENSE_TAX_ENV_SECRET` |
| Files secret | `expense-tax-env-files` | `EXPENSE_TAX_ENV_FILES_SECRET` |
| Laptop gcloud configuration | `personal` | `EXPENSE_TAX_GCLOUD_CONFIG` |
| Service-account key (VPS) | unset | `EXPENSE_TAX_GCP_CREDENTIALS=<key path>` |

When `EXPENSE_TAX_GCP_CREDENTIALS` is set, the loader:

- sets `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` to that path;
- points `CLOUDSDK_CONFIG` to a throwaway private directory, which it removes on
  exit;
- does not select a configuration name.

Otherwise, it sets `CLOUDSDK_ACTIVE_CONFIG_NAME` to the laptop configuration.
Every gcloud call passes `--project`.

### Errors

The loader fails fast, before running any command, when:

- gcloud fails;
- the payload breaks a parse rule;
- the namespace is unknown;
- a reserved key is present.

Messages name keys, never values.

## Laptop Wiring

- `package.json` adds `"with-env": "./scripts/env.sh run"`. Usage:
  `pnpm with-env local -- <cmd>`.
- These existing scripts run through `./scripts/env.sh run local --`:
  `compose:up`, `compose:down`, `dev:app-api`, `dev:foundry`, `db:migrate:app`,
  `db:migrate:foundry`, `smoke:local-worker`. CI calls none of them.
- `scripts/compose.sh` stops reading `$PROJECT_DIR/.env`. It uses
  `EXPENSE_TAX_ENV_FILE` if set, otherwise `.env.example`. Real values come from
  the process env, which takes precedence over `--env-file` for interpolation.
  CI behavior is unchanged: it still uses `.env.example`.
- Next.js frontends, the Python ai-worker, and legacy apps run under
  `pnpm with-env local -- …`. Next.js `process.env` already takes precedence over
  its `.env*` files.
- Any other check or tool script that reads `.env` switches to `.env.example` or
  to the process env. This includes `scripts/audit-credential-boundaries.mjs`.
- `.env.example` gains a header saying it holds placeholders only and that real
  values come from `pnpm with-env local`.

## VPS Wiring

### Reader identity

- Service account `expense-tax-env-reader@tobytran-portfolio.iam.gserviceaccount.com`.
- Role `roles/secretmanager.secretAccessor`, bound on
  `projects/tobytran-portfolio/secrets/expense-tax-env-bundle` only.
- Key file `/etc/expense-tax-management/gcp-env-reader.json`, owner `root:root`,
  mode `0600`. It is created by
  `gcloud iam service-accounts keys create /dev/stdout` and streamed over SSH into
  `sudo install -o root -g root -m 0600 /dev/stdin <path>`. The key never touches
  the laptop disk.
- Rotation:
  1. Create a new key and install it.
  2. Verify with `env.sh keys production` on the VPS.
  3. Delete the old key.

### Deploy workflow (`.github/workflows/expense-tax-deploy.yml`, deploy job)

- Remove from the deploy job:
  - `id-token: write`;
  - the Google auth, gcloud setup, and bundle fetch steps;
  - the transfer and cleanup of `expense-tax-production.env`.
- Ship `expense-tax-management/scripts/env.sh` with the other deploy files. On
  the VPS, install it to `/opt/expense-tax-management/app/env.sh` with mode
  `0755`.
- Run the deploy as:
  `sudo env DOCKER_CONFIG=… IMAGE_TAG=… EXPENSE_TAX_GCP_CREDENTIALS=/etc/expense-tax-management/gcp-env-reader.json /opt/expense-tax-management/app/env.sh run production --env-file-var DEPLOY_ENV_FILE -- /opt/expense-tax-management/app/deploy.sh`.
- The build job is unchanged. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` remains a
  GitHub variable build argument.

### `deploy/production/deploy.sh`

- Requires `DEPLOY_ENV_FILE`, which `env.sh` sets. Keeps `validate_env_file`
  (regular file, root-owned, `0600`), `load_env_file` (strict parser and
  `KNOWN_ENV_KEYS`), and `validate_auth_values`.
- Stops persisting `/etc/expense-tax-management/production.env`:
  - removes the install, backup, and restore logic;
  - sets `COMPOSE_ENV_FILE` to the loader's temp file for the whole run,
    including rollback.
- Passes `PRODUCTION_ENV_FILE="$COMPOSE_ENV_FILE"` to every `health-check.sh`
  call.
- Adds `validate_required_values`, which carries forward the retired builder's
  checks:
  - `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, the four App/Foundry database URLs,
    `CLERK_APP_MACHINE_SECRET_KEY`, `CLERK_FOUNDRY_MACHINE_SECRET_KEY`, and
    `CLERK_WEBHOOK_SIGNING_SECRET` must be present;
  - `STORAGE_URL_SIGNING_KEY`, `INBOUND_WEBHOOK_SIGNING_KEY`, and
    `INBOUND_ROUTING_TOKEN_SECRET` must match `^[0-9a-f]{64}$`.
- When `MAILBOX_FEATURE_ENABLED=true`, `validate_required_values` also checks:
  - the mailbox secret, config, and database keys are present;
  - `MAILBOX_SERVICE_TOKEN_ISSUER == CLERK_ISSUER_URL`;
  - `MAILBOX_SERVICE_JWKS_URL == CLERK_JWKS_URL`;
  - `MAILBOX_SERVICE_TOKEN_AUDIENCE == CLERK_MAILBOX_SERVICE_AUDIENCE`.

  These invariants replace the builder's derivation.
- `health-check.sh` requires `PRODUCTION_ENV_FILE`. The `/etc/...` default is
  removed.

### Manual operations on the VPS

Operators run every compose or health-check command through
`sudo EXPENSE_TAX_GCP_CREDENTIALS=/etc/expense-tax-management/gcp-env-reader.json /opt/expense-tax-management/app/env.sh run production --env-file-var PRODUCTION_ENV_FILE -- …`.

Containers that are already running keep their env in Docker's root-only
container state, so a reboot needs no GCP access.

## GitHub

- These stay as CI-only copies:
  - secrets: `CLOUDFLARE_API_TOKEN`, `VPS_DEPLOY_SSH_KEY`, `VPS_DEPLOY_KNOWN_HOSTS`;
  - variables: `VPS_HOST`, `VPS_PORT`, `VPS_USER`,
    `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_PUBLISHABLE_KEY`,
    `CLOUDFLARE_ACCOUNT_ID`, `GCP_CLOUDFLARE_*`, `TF_STATE_BUCKET`.
- Their source of truth is the bundle (`OPS__*`) and `expense-tax-env-files`.
  On rotation, update the bundle first. Then pipe `env.sh get` into
  `gh secret set` or `gh variable set` through stdin.
- These become unused after cutover, and the owner deletes them:
  `GCP_PROJECT_ID`, `GCP_SECRET_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER`,
  `GCP_DEPLOY_SERVICE_ACCOUNT`.

## Data Migration Mapping

The bundle is rebuilt as version 2 with `import`. Values are never printed.
Version 1 is destroyed afterwards.

| Source | Target |
|---|---|
| `.env` keys except `CLOUDFLARE_*` | `LOCAL__<KEY>` (inline comments stripped) |
| `.env` `CLOUDFLARE_*` | `OPS__<KEY>` |
| `frontend/*/.env.local` | none (verified identical to `LOCAL__` values) |
| `expense-tax-production-env` except `TEMPORAL_DB_PASSWORD` | `PRODUCTION__<KEY>` |
| `expense-tax-production-env` `TEMPORAL_DB_PASSWORD` | `OPS__TEMPORAL_DB_PASSWORD` |
| (new) | `PRODUCTION__MAILBOX_FEATURE_ENABLED=false` |
| `.keys/ovh/postgres-vps.env` | `OPS__VPS_<KEY>` (tunnel-form URLs, role and superuser passwords) |
| `.keys/ovh/.env` | `OPS__VPS_IPV4_ADDRESS`, `OPS__VPS_IPV6_ADDRESS` |
| `.keys/gcp/expense-tax-bootstrap-outputs.json` | `OPS__GCP_BOOTSTRAP_<UPPER_SNAKE>` |
| GitHub production variables, except the four retired deploy-WIF variables | `OPS__<NAME>` |
| `.keys/ovh/*` SSH key pairs | `expense-tax-env-files` (already present) |
| laptop `known_hosts` entry for the VPS `[host]:port` | `expense-tax-env-files` `ovh/known_hosts` |

## Code Removal

- Delete `infrastructure/gcp/expense-tax/sync-production-secret.sh`.
- Delete `scripts/lib/production-secret-bundle.mjs` and its test.
- Remove the related `.gitignore` un-ignore lines and the `package.json` test
  reference.
- `infrastructure/gcp/expense-tax/bootstrap.sh`: change the default output from
  `.keys/gcp/expense-tax-bootstrap-outputs.json` to stdout, so a re-run never
  creates repository key files. The file is otherwise unchanged until the owner
  retires the deploy WIF.
- `.gitignore` keeps its `.env` and `.keys/*` entries as a guard.

## Docs and Rule

`expense-tax-management/AGENTS.md` gains:

```
## Env and Secrets
- Single source: GCP Secret Manager `expense-tax-env-bundle` (`tobytran-portfolio`; `LOCAL__`/`PRODUCTION__`/`OPS__`); SSH keys in `expense-tax-env-files`; each keeps exactly one enabled version.
- Laptop and VPS mirror: both read the bundle at runtime via `scripts/env.sh`; no host-specific env source.
- No env or key files in this repo; `.env.example` holds placeholders only; GitHub holds only CI copies; update the bundle first.
```

Other `AGENTS.md` changes:

- Replace the Infrastructure Policy line "Current production GCP owns Secret
  Manager/IAM/GitHub OIDC/WIF" with a line saying that production GCP owns the
  Cloudflare Terraform WIF and state, and that the env bundle lives in
  `tobytran-portfolio`.
- Delete the line "Secret Manager production bundle retains exactly one
  non-destroyed version".

Also update:

- `plans/production-activation-runbook.md`: the Secret Manager procedure becomes
  bundle editing, reader key install and rotation, and retirement steps.
- `plans/sub-plans/local-clerk-development-bootstrap.md`: replace `.env` and
  `.env.local` instructions with `env.sh set local`.
- `infrastructure/gcp/expense-tax/README.md`.
- The `plans/PLAN.md` status line.

## Testing

- `scripts/env-loader.test.mjs` (node:test, added to `ci:test`). It runs the real
  `env.sh` against a fake `gcloud` on `PATH`, which stores payloads and versions
  in a temp directory, together with the real `jq`. Cases:
  - Every strict-parse rule fails with a key-only message.
  - `run`:
    - exports only the selected namespace;
    - bundle values override parent values;
    - exit status passes through;
    - the `--env-file-var` file has mode `0600` and the expected content, and is
      gone after exit.
  - `get` and `keys`.
  - `set`, `unset`, `import`, and `set-file`:
    - produce a new version, verify it, and destroy older versions;
    - a no-op creates no version;
    - a failed postcondition exits non-zero;
    - lenient import normalization.
  - `with-file`: placeholder substitution and cleanup.
  - Auth selection: configuration name versus credential override with a
    throwaway `CLOUDSDK_CONFIG`.
- `test/integration/production-deployment-boundaries.test.ts` updated for the
  new `deploy.sh` and workflow contract:
  - `DEPLOY_ENV_FILE` is required;
  - no persisted env file;
  - health-check env passing;
  - the new required-value and mailbox invariant checks;
  - the deploy job has no WIF and invokes `env.sh`.
- `scripts/check-centralized-env.test.mjs` (in `ci:test`) asserts:
  - `compose.sh` reads only `.env.example`;
  - the wrapped `package.json` scripts start with `./scripts/env.sh run local --`;
  - no file under `scripts/`, `deploy/`, `services/*/src`, or
    `infrastructure/gcp/expense-tax` references `.keys/` or `postgres-vps.env`;
  - `AGENTS.md` contains the Env and Secrets section.
- `scripts/check-phase-1b-infrastructure.mjs` and its test: static assertions
  updated for the removed sync script and builder.

## Rollout

| Step | Action | Gate |
|---|---|---|
| 1 | Code PR to `dev` | standing approval; required check green |
| 2 | Build bundle v2 with `import`; destroy v1; add `ovh/known_hosts` | owner already authorized copying |
| 3 | Verify laptop: compose, dev servers, `keys local` | none |
| 4 | Move local env and key files to `~/.Trash/expense-tax-env-<timestamp>/` | reversible |
| 5 | Create the reader service account and binding; stream its key to the VPS | explicit owner confirmation |
| 6 | VPS dry run: `env.sh keys production` with the reader key | read-only |
| 7 | `dev→main` release; deploy runs through `env.sh` | owner-gated release |
| 8 | Delete VPS `production.env`; disable `expense-tax-production-env`; owner deletes the 4 GitHub variables and the deploy WIF | explicit owner confirmation |

If the release ships before step 5, the deploy fails at the `env.sh` fetch,
before any container change. Step 7 also clears the stale `TEMPORAL_DB_PASSWORD`
in `expense-tax-production-env`. The current `deploy.sh` would otherwise reject
that key.

## Trade-offs

- The VPS reader key can read the whole bundle, including `OPS__` (Cloudflare
  tokens, the database superuser). The owner accepted this.
- The service-account key is long-lived. Rotation is manual and documented.
- While GCP is unreachable, new deploys and compose operations fail. Running
  containers are unaffected.
- Each `env.sh run` costs one gcloud call (about 1–2 seconds).
- Concurrent writes resolve as last writer wins.
