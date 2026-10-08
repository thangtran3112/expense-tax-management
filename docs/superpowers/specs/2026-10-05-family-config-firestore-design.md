# Family Config in Firestore Design

**Date:** 2026-10-05
**Status:** Approved design; implementation pending
**Supersedes:** `2026-10-04-centralized-env-bundle-design.md` (Secret Manager bundle)
**Depends on:** `origin/dev` at `169bd55`

## Intent

The owner wants one place to look up and check every environment value, config value,
and key for all family-app apps: `expense-tax-management`, `ai-trading`, and future
apps. Values that several apps use, such as SSH keys and the Cloudflare API token, are
stored once and shared. The laptop and the VPS read the same store at runtime through
the same tool. No env or key files remain inside the repository. GitHub may keep
copies that CI needs. A small admin frontend and feature flags may come later; both
are parked, but the schema leaves room for them.

Success means:

- One Firestore database holds every family-app value; the owner can browse it in the
  Firestore console.
- `expense-tax-management/` contains no `.env`, `.env.local`, or `.keys/` files, and
  local development runs entirely from Firestore.
- Expense production deploys load their env on the VPS from Firestore at runtime.
- The ai-trading session receives a handoff that moves it onto the same store and tool.
- `expense-tax-management/AGENTS.md` carries the rule.

## Decisions

- **Firestore, one database** (owner): database `family-config` in project
  `tobytran-portfolio`. That project already has billing and the Firestore, Firebase,
  and Firebase Rules APIs enabled, and has no Firestore database yet. Unlike
  `expense-tax-tobytran-2026`, it allows service-account keys, which the VPS reader
  needs.
- **Region `northamerica-northeast1`** (Montréal), next to the OVH VPS.
- **Shared values stored once, referenced by apps** instead of copied.
- **Laptop and VPS mirror** (owner): both load env at runtime through the same CLI.
- **VPS reads Firestore itself** (owner) with a dedicated service account.
  It does not receive a rendered file from CI.
- **The VPS identity is deliberately broad** (owner decision, revised 2026-10-05): project-wide
  roles for the GCP services family-app uses, with no per-resource conditions.
- **No version history** (owner preference).
- **Python standard-library CLI:** the VPS has `python3` (3.12) and `gcloud` but no
  Node. The laptop and CI runners have the same two tools. Python makes reference
  resolution, validation, and tests far simpler than bash and jq.
- **Provisioning with an idempotent gcloud script**, not Terraform: Terraform is not
  installed on the operator laptop.

## Non-Goals

- No admin frontend, no light config service, no feature-flag evaluation. The `flags`
  collection name is reserved only.
- Services do not call Firestore in-process; they keep reading `process.env` /
  `os.environ`.
- Shared VPS infrastructure env files stay as they are: `/etc/family-app/temporal.env`,
  the backup env, and the shared Postgres `.env`.
- The Cloudflare Terraform workflows keep their GitHub secrets.
- No changes to ai-trading code in this phase; ai-trading receives a handoff.
- Transitional `expense-service` and `frontend/web` code stays untouched. It receives
  env from the launcher process.
- No deletion of GitHub variables, GitHub secrets, WIF pools, or service accounts by
  the agent. The owner performs those deletions.

## Firestore Database

| Setting | Value |
|---|---|
| Project | `tobytran-portfolio` |
| Database ID | `family-config` |
| Type | Firestore Native |
| Location | `northamerica-northeast1` |
| Delete protection | enabled |
| Point-in-time recovery | disabled |
| Security Rules | deny all (`allow read, write: if false;`) |

Client SDKs can never read or write the database. All access goes through IAM:

- The owner account (project owner) reads and writes.
- Service account `family-config-reader@tobytran-portfolio.iam.gserviceaccount.com`, the
  VPS identity, holds `roles/datastore.user`, `roles/secretmanager.secretAccessor`, and `roles/storage.objectAdmin` on `tobytran-portfolio`, plus
  `roles/secretmanager.secretAccessor` and `roles/storage.objectAdmin` on
  `expense-tax-tobytran-2026`. There are no per-resource conditions.

## Schema

```
shared/{group}
  description: string                (optional)
  values: map { NAME: string }       multi-line strings allowed

apps/{app}
  description: string                (optional)

apps/{app}/profiles/{profile}
  description: string                (optional)
  values: map { ENV_NAME: string | { ref: string, key?: string } }

flags/{flag}                         reserved for feature flags; unused
```

### Rules

- `group`, `app`, and `profile` IDs match `^[a-z0-9][a-z0-9-]*$`. The app ID `shared`
  is forbidden.
- `NAME` and `ENV_NAME` match `^[A-Za-z_][A-Za-z0-9_]*$`.
- A value is a Firestore string. Integer and boolean values are accepted and converted
  to their decimal or `true`/`false` text, so console edits that pick those types still
  work. Every other type is an error.
- No value may contain NUL. A profile value used as env must also not contain LF or CR.
- A reference is a map with exactly the field `ref` and an optional field `key`:
  - `ref` matches `^shared/[a-z0-9][a-z0-9-]*$`;
  - `key` matches the name pattern and defaults to the profile's own `ENV_NAME`;
  - the referenced group and key must exist.
- Shared values cannot be references, so references never chain or cycle.
- Profiles may not define these reserved env names: `PATH`, `HOME`, `IFS`, `SHELL`,
  `USER`, `LOGNAME`, `PWD`, `OLDPWD`, `SHLVL`, `ENV`, `BASH_ENV`, `CDPATH`, `PS1`–`PS4`,
  or any name starting with `BASH`, `LD_`, `DYLD_`, `FAMILY_CONFIG_`, or `CLOUDSDK_`.
- Top-level fields other than `values` are metadata. The CLI ignores them, so a future
  admin UI can add fields without breaking reads.
- Keys used by only one app live under that app's profiles; no app prefix such as
  `Expense_` is needed.

### Initial Content

| Document | Values |
|---|---|
| `shared/cloudflare` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_NAME`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_BROAD_ACCESS_API_TOKEN`, `CLOUDFLARE_ZONE_DNS_EDIT_API_TOKEN` |
| `shared/vps` | `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `VPS_IPV4_ADDRESS`, `VPS_IPV6_ADDRESS`, `VPS_SSH_KNOWN_HOSTS`, `VPS_DEPLOY_SSH_PRIVATE_KEY`, `VPS_DEPLOY_SSH_PUBLIC_KEY`, `VPS_OPERATOR_SSH_PRIVATE_KEY`, `VPS_OPERATOR_SSH_PUBLIC_KEY` |
| `shared/vps-postgres` | `POSTGRES_SUPERUSER_PASSWORD` |
| `shared/temporal` | `TEMPORAL_DB_PASSWORD` |
| `apps/expense-tax-management/profiles/local` | the laptop development stack |
| `apps/expense-tax-management/profiles/production` | the VPS application runtime; only `deploy.sh` `KNOWN_ENV_KEYS` names |
| `apps/expense-tax-management/profiles/ops` | operator values: VPS database role passwords and SSH-tunnel URLs, GCP and GitHub identifiers, references to shared Cloudflare, VPS, Postgres, and Temporal values |
| `apps/ai-trading/profiles/deploy` | references: `VPS_HOST`, `VPS_PORT`, `VPS_USER` |
| `apps/ai-trading/profiles/cloudflare` | references: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and the Terraform aliases `TF_VAR_cloudflare_api_token`, `TF_VAR_cloudflare_account_id`, `TF_VAR_zone_name` |

## CLI: `common/config/family_config.py`

One executable Python file (`#!/usr/bin/env python3`), Python 3.10 or newer, standard
library only. `gcloud` supplies access tokens. Every family-app app uses it on the
laptop, on the VPS, and in CI.

### Addressing

| Target | Document |
|---|---|
| `shared/<group>` | `shared/<group>` |
| `<app>/<profile>` | `apps/<app>/profiles/<profile>` |
| `<app>` | `apps/<app>` (`describe` and `ls` only) |

### Commands

- **`run <profile-target>... [--env-file-var VAR] -- <cmd> [args...]`**
  - Resolves the profiles. If several profiles define the same name, the later one
    wins. Resolved values override inherited environment values.
  - With `--env-file-var VAR`, it writes sorted `NAME=VALUE` lines to a file with mode
    `0600` inside a private `0700` directory and exports `VAR=<path>`. `VAR` follows the
    name and reserved-name rules.
  - It runs the command as a child process, forwards SIGINT, SIGTERM, and SIGHUP,
    removes its temporary directory, and exits with the child's status (128 + signal
    number if the child was killed by a signal).
- **`render <profile-target>... --out-dir DIR`**
  - Writes `DIR/<profile>.env` (sorted `NAME=VALUE` lines, mode `0600`, written to a
    temporary name and renamed) for each target, for compose `env_file:` use.
  - Creates `DIR` with mode `0700` if it is missing. Fails if two targets share a
    profile ID.
  - Prints the written paths, never values.
- **`get <target> <NAME>`**: prints one value exactly, with no added newline. Profile
  references are resolved. Exits non-zero if the name is absent.
- **`keys <target>`**: prints sorted names only. Profile references print as
  `NAME -> shared/<group>` or `NAME -> shared/<group>:<KEY>`.
- **`ls`**: prints every `shared/<group>` and `<app>/<profile>` target, names only. App
  documents that exist only as parents of profiles are included.
- **`set <target> <NAME> [--raw]`**: reads the value from stdin. Without `--raw`, it
  strips exactly one trailing LF; with `--raw`, it keeps the bytes exactly (SSH keys).
  The value must be valid UTF-8. Profile values must be single-line.
- **`unset <target> <NAME>`**: removes the name. If the name is absent, it prints
  `unchanged` and writes nothing.
- **`link <profile-target> <ENV_NAME> shared/<group> [<KEY>]`**: stores a reference
  after checking that the shared key exists.
- **`import <target> <dotenv-file>`**: parses the file leniently:
  - blank lines and `#` comment lines are skipped;
  - an optional `export ` prefix is removed;
  - one layer of matching single or double quotes is removed, with no escape
    processing;
  - for unquoted values, a whitespace-preceded `#` comment and trailing whitespace
    are removed;
  - an unterminated quote is an error.

  Every name is set in one write. Names absent from the file are untouched. It prints
  the number of names imported.
- **`describe <target> <TEXT>`**: sets the document's `description`.
- **`with-file <target> <NAME> [--] <cmd> [args...]`**: writes the value's exact bytes
  to a `0600` file in a private `0700` directory, replaces every argument equal to `{}`
  with that path, runs the command, removes the file, and exits with the child's
  status.

### Writes

`set`, `unset`, `link`, `import`, and `describe` follow this sequence:

1. Read the document and note its `updateTime`.
2. Compute the change. If nothing changes, print `unchanged` and stop.
3. Send one `PATCH` with an `updateMask` that lists only the changed field paths
   (`values.<NAME>` or `description`), plus a precondition:
   - `currentDocument.updateTime` equal to the time read in step 1 if the document
     exists;
   - `currentDocument.exists=false` otherwise.
4. On `FAILED_PRECONDITION`, exit non-zero with "changed concurrently; re-run". Another
   writer's change is never overwritten silently.
5. Read the document again and verify the changed names hold the intended values.

### Authentication and Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FAMILY_CONFIG_PROJECT` | `tobytran-portfolio` | GCP project |
| `FAMILY_CONFIG_DATABASE` | `family-config` | Firestore database ID |
| `FAMILY_CONFIG_GCLOUD_CONFIG` | `personal` | laptop gcloud configuration |
| `FAMILY_CONFIG_CREDENTIALS` | unset | service-account key file (VPS) |
| `FAMILY_CONFIG_FIRESTORE_URL` | `https://firestore.googleapis.com/v1` | API base URL (tests) |

The CLI gets one access token per invocation:

- **Key file:** if `FAMILY_CONFIG_CREDENTIALS` is set, it must be a regular file. The
  CLI runs `gcloud auth print-access-token` with `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`
  set to that path and `CLOUDSDK_CONFIG` set to a throwaway private directory, which it
  removes afterwards.
- **GitHub Actions:** if `GITHUB_ACTIONS=true`, it runs `gcloud auth print-access-token`
  with the ambient credentials.
- **Laptop:** otherwise, it runs
  `gcloud auth print-access-token --configuration=<FAMILY_CONFIG_GCLOUD_CONFIG>` and
  sends the header `x-goog-user-project: <project>`. It never uses the active default
  gcloud configuration, which is a work account on the operator laptop.

Tokens and values never appear in process arguments.

### Safety

- Under GitHub Actions, the CLI prints `::add-mask::<line>` to stderr for every
  non-empty line of every value it uses, before any other output, so stdout stays
  byte-exact (e.g. `get ... > key-file`).
- Temporary directories are created under `/dev/shm` when it is a writable directory,
  otherwise under the system temporary directory.
- Error messages name targets and keys, never values.
- Exit codes: `0` success, `1` error, `2` usage error; `run` and `with-file` return the
  child's status.

## Provisioning

### `infrastructure/gcp/family-config/bootstrap.sh`

An idempotent operator script that passes `--configuration=personal` (overridable with
`FAMILY_CONFIG_GCLOUD_CONFIG`) and `--project=tobytran-portfolio` to every gcloud call.
It:

1. Enables `firestore.googleapis.com`, `firebaserules.googleapis.com`, and
   `iam.googleapis.com`.
2. Creates database `family-config` (Native mode, `northamerica-northeast1`, delete
   protection) if it does not exist.
3. Releases the deny-all Security Rules for `family-config` through the Firebase Rules
   API, unless the current release already has identical source.
4. Creates service account `family-config-reader` if it does not exist.
5. Grants the VPS identity its project-wide roles (unconditional).

### `infrastructure/gcp/family-config/install-reader-key.sh`

An operator script that installs or rotates the VPS reader key:

1. Reads VPS host, port, user, known-hosts entry, and the operator SSH key from
   `shared/vps` through the CLI.
2. Creates a new service-account key with `gcloud iam service-accounts keys create`
   writing to stdout. It streams the key over SSH into
   `sudo install -o root -g root -m 0600 /dev/stdin /etc/family-app/config-reader.json`
   (directory `/etc/family-app` mode `0755`). The key never touches the laptop disk.
3. Copies the CLI to a temporary VPS directory and runs
   `sudo FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json python3 <tmp>/family_config.py keys expense-tax-management/production`.
4. Only if step 3 succeeds, deletes every other user-managed key of the service
   account, printing the deleted key IDs.

## Expense Wiring

### Laptop

- `package.json` adds `"with-env": "../common/config/family_config.py run expense-tax-management/local --"`.
  Usage: `pnpm with-env <cmd>`.
- These scripts are prefixed with
  `../common/config/family_config.py run expense-tax-management/local -- `:
  `compose:up`, `compose:down`, `dev:app-api`, `dev:foundry`, `db:migrate:app`,
  `db:migrate:foundry`, `smoke:local-worker`. CI calls none of them.
- `scripts/compose.sh` uses `EXPENSE_TAX_ENV_FILE` if set, otherwise `.env.example`,
  and never reads `.env`. Real values come from the process environment, which
  overrides `--env-file` for interpolation. CI behavior is unchanged.
- Next.js frontends, the Python ai-worker, and legacy apps run under
  `pnpm with-env …`.
- Any other script that reads `.env` switches to `.env.example` or the process env.
  This includes `scripts/audit-credential-boundaries.mjs`.
- `.env.example` gains a header: placeholders only; real values come from
  `pnpm with-env`.

### VPS deploy

- In the deploy job of `.github/workflows/expense-tax-deploy.yml`:
  - Remove `id-token: write`, the Google auth, gcloud setup, and bundle fetch steps,
    and the transfer and cleanup of `expense-tax-production.env`.
  - Copy `common/config/family_config.py` with the other deploy files and install it
    on the VPS as `/opt/expense-tax-management/app/family_config.py` (mode `0755`).
  - Run the deploy as:
    `sudo env DOCKER_CONFIG=… IMAGE_TAG=… FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json /opt/expense-tax-management/app/family_config.py run expense-tax-management/production --env-file-var DEPLOY_ENV_FILE -- /opt/expense-tax-management/app/deploy.sh`.
  - The build job is unchanged.
- `deploy/production/deploy.sh`:
  - Requires `DEPLOY_ENV_FILE`. Keeps `validate_env_file` (regular file, root-owned,
    `0600`), `load_env_file` (strict parser and `KNOWN_ENV_KEYS`), and
    `validate_auth_values`.
  - Stops persisting `/etc/expense-tax-management/production.env`: the install,
    backup, and restore logic goes away, and `COMPOSE_ENV_FILE` is the loader's file for
    the whole run, including rollback.
  - Passes `PRODUCTION_ENV_FILE="$COMPOSE_ENV_FILE"` to every `health-check.sh` call.
  - Adds `validate_required_values`:
    - `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `APP_DATABASE_URL`,
      `APP_MIGRATION_DATABASE_URL`, `FOUNDRY_DATABASE_URL`,
      `FOUNDRY_MIGRATION_DATABASE_URL`, `CLERK_APP_MACHINE_SECRET_KEY`,
      `CLERK_FOUNDRY_MACHINE_SECRET_KEY`, and `CLERK_WEBHOOK_SIGNING_SECRET` must be
      present;
    - `STORAGE_URL_SIGNING_KEY`, `INBOUND_WEBHOOK_SIGNING_KEY`, and
      `INBOUND_ROUTING_TOKEN_SECRET` must match `^[0-9a-f]{64}$`;
    - when `MAILBOX_FEATURE_ENABLED=true`: the mailbox secret, config, and database
      keys must be present, and `MAILBOX_SERVICE_TOKEN_ISSUER == CLERK_ISSUER_URL`,
      `MAILBOX_SERVICE_JWKS_URL == CLERK_JWKS_URL`,
      `MAILBOX_SERVICE_TOKEN_AUDIENCE == CLERK_MAILBOX_SERVICE_AUDIENCE`.
- `deploy/production/health-check.sh` requires `PRODUCTION_ENV_FILE`; the `/etc/...`
  default is removed.
- Manual operations on the VPS run through
  `sudo FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json /opt/expense-tax-management/app/family_config.py run expense-tax-management/production --env-file-var PRODUCTION_ENV_FILE -- <cmd>`.
  Running containers keep their env in Docker's root-only state, so a reboot needs no
  Firestore access.

## GitHub

- These stay as CI-only copies in the `production` environment:
  - secrets `CLOUDFLARE_API_TOKEN`, `VPS_DEPLOY_SSH_KEY`, `VPS_DEPLOY_KNOWN_HOSTS`;
  - variables `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`,
    `CLERK_PUBLISHABLE_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `GCP_CLOUDFLARE_*`,
    `TF_STATE_BUCKET`.
- Firestore is their source of truth. Refresh a copy through stdin, for example
  `family_config.py get shared/cloudflare CLOUDFLARE_API_TOKEN | gh secret set CLOUDFLARE_API_TOKEN --env production --repo thangtran3112/family-app`.
- These become unused after the expense cutover, and the owner deletes them:
  `GCP_PROJECT_ID`, `GCP_SECRET_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER`,
  `GCP_DEPLOY_SERVICE_ACCOUNT`.
- The expense CI `push` path filter adds `common/config/**`.

## Data Migration

The operator copies values with `import`, `set --raw`, and `link`. Values are never
printed.

| Source | Target |
|---|---|
| `.env` `CLOUDFLARE_AGENT_API_TOKEN` | `shared/cloudflare` `CLOUDFLARE_API_TOKEN` |
| `.env` `CLOUDFLARE_BROAD_ACCESS_API_TOKEN`, `CLOUDFLARE_ZONE_DNS_EDIT_API_TOKEN` | `shared/cloudflare`, same names |
| GitHub variable `CLOUDFLARE_ACCOUNT_ID`; literal `tobytran.dev` | `shared/cloudflare` `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_NAME` |
| GitHub variables `VPS_HOST`, `VPS_PORT`, `VPS_USER` | `shared/vps`, same names |
| `.keys/ovh/.env` `IPV4_ADDRESS`, `IPV6_ADDRESS` | `shared/vps` `VPS_IPV4_ADDRESS`, `VPS_IPV6_ADDRESS` |
| laptop `known_hosts` lines for `[158.69.202.250]:2222` | `shared/vps` `VPS_SSH_KNOWN_HOSTS` |
| `.keys/ovh/github-actions-expense-tax` and `.pub` | `shared/vps` `VPS_DEPLOY_SSH_PRIVATE_KEY`, `VPS_DEPLOY_SSH_PUBLIC_KEY` |
| `.keys/ovh/id_ed25519_personal` and `.pub` | `shared/vps` `VPS_OPERATOR_SSH_PRIVATE_KEY`, `VPS_OPERATOR_SSH_PUBLIC_KEY` |
| `.keys/ovh/postgres-vps.env` `POSTGRES_SUPERUSER_PASSWORD` | `shared/vps-postgres`, same name |
| `expense-tax-production-env` `TEMPORAL_DB_PASSWORD` | `shared/temporal`, same name |
| `.env`, every other key | `apps/expense-tax-management/profiles/local` |
| `expense-tax-production-env`, every other key; literal `MAILBOX_FEATURE_ENABLED=false` | `apps/expense-tax-management/profiles/production` |
| `.keys/ovh/postgres-vps.env`, every other key | `apps/expense-tax-management/profiles/ops`, same names |
| `.keys/gcp/expense-tax-bootstrap-outputs.json` | `.../ops` `GCP_PROJECT_ID`, `GCP_SECRET_ID`, `GCP_DEPLOY_SERVICE_ACCOUNT`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GITHUB_REPOSITORY` |
| GitHub variables `CLERK_PUBLISHABLE_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `GCP_CLOUDFLARE_SERVICE_ACCOUNT`, `GCP_CLOUDFLARE_WORKLOAD_IDENTITY_PROVIDER`, `TF_STATE_BUCKET` | `.../ops`, same names |
| references | `.../ops`: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` to `shared/cloudflare`; `VPS_HOST`, `VPS_PORT`, `VPS_USER` to `shared/vps`; `POSTGRES_SUPERUSER_PASSWORD` to `shared/vps-postgres`; `TEMPORAL_DB_PASSWORD` to `shared/temporal` |
| references | `apps/ai-trading/profiles/deploy` and `.../cloudflare`, as listed in Initial Content |
| `frontend/*/.env.local` | none; identical to `local` values |
| `expense-tax-env-bundle`, `expense-tax-env-files` | none; same sources as above |

After the copy, the operator verifies:

- every target's key list matches its sources;
- every value's SHA-256 matches its source, compared locally without printing.

## Code Removal

- Delete `infrastructure/gcp/expense-tax/sync-production-secret.sh`.
- Delete `scripts/lib/production-secret-bundle.mjs` and its test, together with their
  `.gitignore` un-ignore lines and the `package.json` test reference.
- `infrastructure/gcp/expense-tax/bootstrap.sh` writes its outputs to stdout instead of
  `.keys/gcp/expense-tax-bootstrap-outputs.json`.
- `.gitignore` keeps its `.env` and `.keys/*` entries as a guard.
- Delete the superseded spec `2026-10-04-centralized-env-bundle-design.md`.

## Docs and Rule

`expense-tax-management/AGENTS.md` gains:

```
## Env and Secrets
- Single source for all family-app env and secrets: Firestore `family-config` (`tobytran-portfolio`): `shared/*` reused values, `apps/<app>/profiles/<profile>` app env; access only via `common/config/family_config.py`.
- Laptop and VPS mirror: both load env at runtime through that CLI; no env/key files in the repo; GitHub keeps CI copies only, refreshed from Firestore.
```

Other `AGENTS.md` changes:

- The Infrastructure Policy line "Current production GCP owns Secret
  Manager/IAM/GitHub OIDC/WIF" becomes: production GCP owns the Cloudflare Terraform
  WIF and state; family config lives in Firestore `family-config` in
  `tobytran-portfolio`.
- The line "Secret Manager production bundle retains exactly one non-destroyed
  version" is removed.

Also update:

- `common/config/README.md` (new): schema, CLI, and examples;
- `plans/production-activation-runbook.md`;
- `plans/sub-plans/local-clerk-development-bootstrap.md`;
- `infrastructure/gcp/expense-tax/README.md`;
- the `plans/PLAN.md` status line.

## ai-trading Handoff

`ai-trading/plans/handoffs/2026-10-05-family-config.md` tells the ai-trading session:

- the store, schema, CLI, and rule, and what already exists under `apps/ai-trading`
  and `shared/*`;
- to replace `infrastructure/secrets/env-bundle.py` and the planned
  `ai-trading-env-bundle` with the CLI, with a command mapping (`render` to `render`,
  `exec` to `run`, `get-file` to `with-file` / `get`, `pull`/`push` to `set` / `import`
  / the console);
- to remove the Secret Manager bundle and its accessor bindings from
  `infrastructure/gcp/ai-trading/`, including the `expense-tax-env-files` binding,
  because that secret is deleted;
- to follow the expense deploy pattern:
  - the VPS reads Firestore at deploy time with `/etc/family-app/config-reader.json`;
  - `write-secrets.sh` and the persistent `/etc/family-app/ai-trading/*.env` files go
    away;
  - if a workflow must read Firestore in CI, grant its service account
    `roles/datastore.viewer` (or `roles/datastore.user`) on `tobytran-portfolio`;
- to create the app-secret profiles (`tradingagents`, `ai-hedge-fund`, `vibe-trading`,
  and `cloudflared` if needed) and `TF_VAR_access_allowed_emails`; none of these values
  exist yet;
- to update `ai-trading/AGENTS.md`, whose secrets and Cloudflare token sections
  describe Secret Manager.

## Testing

- `common/config/test_family_config.py` (unittest, run by expense `ci:test` as
  `python3 -m unittest discover -s ../common/config -p 'test_*.py'`). It runs the real
  CLI as a subprocess against an in-process fake Firestore HTTP server, which handles
  document get, batch get, list with `showMissing`, and patch with update masks and
  preconditions. A fake `gcloud` on `PATH` records its arguments and environment.
  Cases:
  - validation: bad IDs and names, bad reference shapes, references outside `shared/`,
    missing groups or keys, multi-line profile values, reserved names, unsupported
    types, integer and boolean conversion;
  - `run`:
    - exports only resolved names;
    - later profiles win and resolved values beat the parent environment;
    - the exit status passes through;
    - the env file has mode `0600` and the expected content and is removed afterwards,
      including after a failing child;
  - `render` files, modes, and duplicate-profile rejection;
  - `get`, `keys`, and `ls` output; `keys` and `ls` never print values;
  - writes:
    - `set`, `unset`, `link`, `import`, and `describe` send minimal update masks and
      the correct precondition;
    - a no-op sends no write;
    - a concurrent change fails;
    - lenient `import` parsing;
    - `set --raw` keeps the trailing newline;
    - `link` checks that the target exists;
  - `with-file` content, mode, `{}` substitution, and cleanup;
  - authentication:
    - laptop mode passes `--configuration=personal` and sends `x-goog-user-project`;
    - key-file mode sets the credential override and a throwaway `CLOUDSDK_CONFIG`,
      which is removed afterwards;
    - GitHub Actions mode prints masks;
  - failure output never contains a known secret marker value.
- `test/integration/production-deployment-boundaries.test.ts`, updated:
  - the deploy job has no WIF, copies the CLI, and runs
    `run expense-tax-management/production` with `FAMILY_CONFIG_CREDENTIALS`;
  - `deploy.sh` requires `DEPLOY_ENV_FILE` and never persists the env file;
  - health-check env passing;
  - `validate_required_values` and the mailbox invariants.
- `scripts/check-centralized-env.test.mjs` (in `ci:test`) asserts:
  - `compose.sh` reads only `.env.example`;
  - the wrapped `package.json` scripts start with the CLI `run` prefix;
  - no file under `scripts/`, `deploy/`, `services/*/src`, or
    `infrastructure/gcp/expense-tax` references `.keys/` or `postgres-vps.env`;
  - `AGENTS.md` contains the Env and Secrets section;
  - the expense CI path filter contains `common/config/**`.
- `scripts/check-phase-1b-infrastructure.mjs` and its test are updated for the removed
  sync script and builder.

## Rollout

| Step | Action | Gate |
|---|---|---|
| 1 | Implement and test the CLI | none |
| 2 | Run `bootstrap.sh`: database, rules, reader service account, binding | owner-approved design |
| 3 | Migrate values; verify names and SHA-256 against sources | owner-authorized copy |
| 4 | Expense wiring, docs, rule, handoff; verify the laptop stack from Firestore | none |
| 5 | One pull request to `dev` | standing approval; required check green |
| 6 | Run `install-reader-key.sh` (VPS key install and verification) | explicit owner confirmation |
| 7 | Delete `expense-tax-env-bundle` and `expense-tax-env-files` | explicit owner confirmation |
| 8 | Move local env and key files to `~/.Trash/family-config-migration-<timestamp>/` | reversible |
| 9 | `dev`→`main` release; the expense deploy runs through the CLI | owner-gated release |
| 10 | Remove VPS `production.env`; disable `expense-tax-production-env`; owner deletes the 4 GitHub variables and the deploy WIF | explicit owner confirmation |

If the release ships before step 6, the deploy fails at the CLI token or read step,
before any container change. Step 9 also drops the stale `TEMPORAL_DB_PASSWORD` key
from the production env, which the current `deploy.sh` would reject.

## Trade-offs

- The VPS identity can read and write every app's values and use Secret Manager and
  Storage in both projects.
- There is no version history or backup. A deleted or overwritten value is gone.
  Firestore scheduled backups can be enabled later if wanted.
- The VPS service-account key is long-lived; `install-reader-key.sh` rotates it.
- While GCP is unreachable, new deploys and compose operations fail; running containers
  are unaffected.
- Each CLI run costs one token call and up to three Firestore round trips (about 1–2
  seconds).
