# family-config

One Firestore database holds every environment value, config value, and key for all
family-app apps: `expense-tax-management`, `ai-trading`, and future apps. The laptop,
the VPS, and CI read it at runtime through one CLI, `family_config.py`. No env or key
files live in the repository.

Design: `docs/superpowers/specs/2026-10-05-family-config-firestore-design.md`.

## Where values live

Firestore database `family-config` in GCP project `tobytran-portfolio`
(`northamerica-northeast1`, delete protection on, deny-all client rules). Browse it in
the Firebase or Google Cloud console.

```
shared/{group}                    values reused by several apps
  description: string
  values: {NAME: string}          multi-line allowed (SSH keys)
apps/{app}                        one document per app
  description: string
apps/{app}/profiles/{profile}     one env set (local, production, ops, ...)
  description: string
  values: {ENV_NAME: string | {ref: "shared/<group>", key?: NAME}}
flags/{flag}                      reserved for feature flags; unused
```

- A shared value is stored once. A profile points to it with `{ref: "shared/<group>"}`,
  which uses the value of the same name, or `{ref, key}`, which renames it.
- Keys that only one app uses live under that app's profiles; no app prefix is needed.
- IDs match `^[a-z0-9][a-z0-9-]*$`. Names match `^[A-Za-z_][A-Za-z0-9_]*$`.
- Values are strings. Integers and booleans entered in the console are read as text.
- Profile values become env values, so they must be single-line. Profiles may not set
  `PATH`, `HOME`, `LD_*`, `DYLD_*`, `BASH*`, `FAMILY_CONFIG_*`, `CLOUDSDK_*`, or other
  reserved shell names.
- Top-level fields other than `values` are metadata, and the CLI ignores them.

## CLI

Python 3.10+, standard library only. `gcloud` supplies the access token.

| Command | What it does |
|---|---|
| `run <app>/<profile>... [--env-file-var VAR] -- <cmd>` | Runs `cmd` with the resolved env. Later profiles win; resolved values beat the parent env. `--env-file-var` also writes a `0600` temp env file and puts its path in `VAR`. |
| `render <app>/<profile>... --out-dir DIR` | Writes `DIR/<profile>.env` (`0600`) for compose `env_file:`. |
| `get <target> <NAME>` | Prints one value exactly. |
| `keys <target>` | Prints names only, with references as `NAME -> shared/<group>[:KEY]`. |
| `ls` | Prints every `shared/<group>` and `<app>/<profile>` target. |
| `set <target> <NAME> [--raw]` | Sets a value read from stdin. One trailing newline is stripped unless `--raw`. |
| `unset <target> <NAME>` | Removes a value. |
| `link <app>/<profile> <ENV_NAME> shared/<group> [<KEY>]` | Points a profile name at a shared value. |
| `import <target> <dotenv-file>` | Merges a dotenv file (quotes, `export`, and inline comments are handled). |
| `describe <target or app> <TEXT>` | Sets a document description. |
| `with-file <target> <NAME> -- <cmd> {}` | Writes one value to a `0600` temp file and passes its path in place of `{}`. |

Targets are `shared/<group>` or `<app>/<profile>`.

Writes send only the changed fields, carry a Firestore update-time precondition so a
concurrent edit is never silently overwritten, and read back to verify.

Examples:

```bash
CLI=common/config/family_config.py
$CLI ls
$CLI keys expense-tax-management/production
pnpm --dir expense-tax-management with-env node -e 'console.log(Boolean(process.env.CLERK_SECRET_KEY))'
printf '%s' "$NEW_VALUE" | $CLI set expense-tax-management/local CLERK_WEBHOOK_SIGNING_SECRET
$CLI link ai-trading/cloudflare TF_VAR_zone_name shared/cloudflare CLOUDFLARE_ZONE_NAME
$CLI with-file shared/vps VPS_OPERATOR_SSH_PRIVATE_KEY -- ssh -i {} -p 2222 ubuntu@<host>
```

## Authentication

| Where | How |
|---|---|
| Laptop | `gcloud auth print-access-token --configuration=personal` (override with `FAMILY_CONFIG_GCLOUD_CONFIG`). It never uses the active default configuration, which is a work account on the operator laptop. |
| VPS | `FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json`: the key of service account `family-config-reader`, which is read-only and limited to this database. gcloud runs with a throwaway config directory. |
| GitHub Actions | Ambient gcloud credentials; every value used is registered with `::add-mask::`. |

Other settings: `FAMILY_CONFIG_PROJECT`, `FAMILY_CONFIG_DATABASE`, and
`FAMILY_CONFIG_FIRESTORE_URL` (tests only).

## Provisioning

- `infrastructure/gcp/family-config/bootstrap.sh`: creates the database, releases the
  deny-all rules, creates `family-config-reader`, and grants it `roles/datastore.viewer`
  for this database only. Safe to re-run.
- `infrastructure/gcp/family-config/install-reader-key.sh`: streams a new reader key into
  the VPS at `/etc/family-app/config-reader.json` (root, `0600`), verifies a read on the
  VPS, then deletes the older keys. Re-run it to rotate.

## GitHub copies

GitHub keeps only the copies CI needs. Firestore is their source: update Firestore
first, then refresh the copy through stdin, for example:

```bash
common/config/family_config.py get shared/cloudflare CLOUDFLARE_API_TOKEN |
  gh secret set CLOUDFLARE_API_TOKEN --env production --repo thangtran3112/family-app
```

## Tests

```bash
python3 -m unittest discover -s common/config -p 'test_*.py'
```
