# VPS Bootstrap (Infrastructure as Code)

Reusable, idempotent provisioning for a family-app VPS: SSH hardening,
firewall, Docker, and a **shared** PostgreSQL cluster (one Postgres
container, one database per app — see `../README.md` "why not per-app
postgres"). Written so switching VPS providers (OVH → Database Mart,
Hetzner, etc. — see `../../expense-tax-management/plans/ROADMAP.md`,
Feb 2027) takes a script run instead of a rediscovery exercise like the
one that produced this directory.

Plain bash, no new tooling dependency (no Ansible/Terraform). Runs from
your **operator machine** (Mac/CI), pushing each step to the VPS over
SSH/SCP — it does not need to be cloned onto the VPS itself.

## The manual bridge gap (cannot be automated)

**The very first connection to a brand-new VPS is not scriptable from
here.** Every provider hands you some initial access method — a
password emailed at signup, a provider-injected default key, cloud-init
defaults, etc. — and that varies per provider and isn't something this
repo can predict or store ahead of time. You must:

1. Get the provider's initial connection details (their control panel
   will tell you: usually `ssh <user>@<ip>` on port **22**).
2. Confirm you can connect **and** that the user has sudo.
3. *Then* run `bootstrap.sh` pointed at port 22, with `--target-ssh-port`
   set to whatever hardened port you want to land on (2222 by
   convention in this repo — see below).
4. From that point on, port 22 stops working (hardening disables
   password auth and moves sshd to the target port) — reconnect using
   the new port and your key for every future run, including re-running
   `bootstrap.sh` itself.

**Concrete cautionary tale (why this section exists):** the current OVH
box was hardened to port 2222 by hand, outside of any script, before
this IaC existed. Months later, nobody remembered the port had changed
— "SSH isn't working" looked like a provider firewall problem and took
real investigation (ping OK, ports 80/443 "connection refused" =
reachable but nothing listening, port 22 silently timed out = actually
just moved) before `nc -vz <ip> 2222` confirmed the real port. **Record
the hardened port and connection details somewhere durable the moment
you run this** (a password manager entry, `.keys/<provider>/README.md`,
wherever — anywhere except "memory"). This directory's job is to make
the *setup* reproducible; it can't make the *fact of which port you
chose* rediscoverable on its own.

## Provider network firewall (also manual, per provider)

Most VPS providers layer an **external** network firewall / security
group on top of the OS (OVH's "Network Firewall" panel, security groups
on other providers). `steps/00-firewall.sh` only configures UFW *on the
box* — it cannot reach a provider's control panel. If a port is allowed
in UFW but a fresh connection still times out (not "connection
refused" — refused means it reached the OS and nothing's listening;
timeout means something upstream is dropping it silently), check the
provider's panel next before doubting the script.

## Layout

```
vps/
├── README.md              # this file
├── bootstrap.sh            # orchestrator -- run this
├── steps/
│   ├── 00-firewall.sh      # UFW: default deny incoming, allow SSH port + 80/443
│   ├── 10-harden-ssh.sh    # SSH: target port, key-only auth, no root password login
│   ├── 20-docker.sh        # Docker Engine + Compose plugin
│   ├── 30-postgres.sh      # shared Postgres cluster + per-app DB/roles
│   └── 40-backup.sh        # backup state dirs, root-only secrets, systemd units (opt-in, see below)
└── apps/
    └── expense-tax-management.conf   # per-app config consumed by bootstrap.sh
```

Each `steps/*.sh` file is self-contained and idempotent: it checks the
current state first and prints "already ... no changes" when nothing
needs to happen, or applies the minimal change otherwise. They're
designed to also be copy/pasted and run directly on a box if you ever
need to without the orchestrator.

## Usage

```bash
cd infrastructure/vps

# Brand-new VPS, first-ever connection (see "manual bridge gap" above):
./bootstrap.sh --host 1.2.3.4 --ssh-user ubuntu --ssh-key ~/.ssh/id_ed25519 \
  --app apps/expense-tax-management.conf \
  --ssh-port 22 --target-ssh-port 2222 \
  --fetch-secrets-to ~/secure/postgres-vps.env

# Already-hardened box: safe idempotent re-run / dry-check:
./bootstrap.sh --host 1.2.3.4 --ssh-user ubuntu --ssh-key ~/.ssh/id_ed25519 \
  --app apps/expense-tax-management.conf --ssh-port 2222 --target-ssh-port 2222

# Onboard a second app onto the same already-running shared cluster:
./bootstrap.sh --host 1.2.3.4 --ssh-user ubuntu --ssh-key ~/.ssh/id_ed25519 \
  --app apps/some-other-app.conf --ssh-port 2222 --target-ssh-port 2222 --only postgres
```

`--fetch-secrets-to` copies the shared Postgres `.env` (superuser +
per-app role passwords, generated on the VPS — never invented locally)
to a local path, `chmod 600`. Omit it to leave secrets VPS-only and
fetch manually later: `ssh -p <port> ... cat /opt/family-app/postgres/.env`.

Postgres itself is bound to the VPS's own `127.0.0.1:5432` — never
public. Reach it from a dev machine via SSH tunnel:

```bash
ssh -p <port> -i <key> -N -f -L 127.0.0.1:15432:127.0.0.1:5432 <user>@<host>
```

Use a **local port other than 5432** for the tunnel if the app's own
integration tests hardcode `127.0.0.1:5432` for an ephemeral local
Postgres (expense-tax-management's do) — otherwise the tunnel and the
disposable test instance fight over the same local port.

## Backup (opt-in, Task 6 of `vps-backup-and-restore.md`)

`--only backup` is never in the default step set -- it needs secrets that
only exist once [Task 1](../gcp/backup/README.md)'s Terraform is actually
applied and a writer key is created by hand. Once both exist:

```bash
./bootstrap.sh --host 1.2.3.4 --ssh-user ubuntu --ssh-key ~/.ssh/id_ed25519 \
  --app apps/expense-tax-management.conf --ssh-port 2222 --target-ssh-port 2222 \
  --only backup \
  --backup-gcs-uri gs://expense-tax-tobytran-2026-backups \
  --backup-host-id expense-tax-vps-1 \
  --age-recipient age1... \
  --receipt-volume expense-tax-production_expense_tax_production_storage \
  --backup-writer-key-file ~/secure/backup-writer-key.json \
  --backup-image ghcr.io/thangtran3112/family-app/family-app-backup@sha256:...
```

This installs `/opt/family-app/backup/{state,ciphertext}` (root-only),
root-only `/etc/family-app/{backup.env,backup-pgpassword,backup-writer-key.json}`,
and enables `family-app-backup.timer`. See
[`../backup/README.md`](../backup/README.md) for the container/script
details and [`check-backup-freshness.sh`](../backup/check-backup-freshness.sh)
for the local health check. `--receipt-volume` is the Docker volume's
NAME (`docker volume ls`), mounted into the backup container by name --
Docker resolves it regardless of which Compose project created it, so no
host-path lookup is needed.

## Adding a new app

1. Ensure the app owns an idempotent Postgres role/schema init script
   (same pattern as `expense-tax-management/docker/postgres/zz-20-expense-tax-roles.sh`:
   `CREATE ROLE/SCHEMA IF NOT EXISTS`, safe to re-run).
2. Add `apps/<app-name>.conf` (copy `apps/expense-tax-management.conf`
   as a template) declaring `POSTGRES_DB_NAME`, the repo-relative path
   to that script, and the password env vars it needs.
3. Run `bootstrap.sh --only postgres` with that app's config against
   the already-running shared cluster. `30-postgres.sh` creates the new
   database and applies the new role script without touching existing
   apps' databases/roles/passwords.

## What this does NOT do (out of scope, by design, 2026-09-08)

- **Backup/restore**: the container, scripts, systemd units, and
  operator restore tooling are built (`../backup/`, `../gcp/backup/`) and
  proven against disposable PostgreSQL 17 + real `age` encryption
  end-to-end -- see `../backup/README.md`. What remains deferred:
  actually applying Task 1's Terraform (bucket/identities), creating the
  real writer key, and running `--only backup` against the live VPS
  (Task 6's own "install on the live box" and Task 8's recovery drill are
  explicitly operator-approved, out of scope for this implementation
  pass). `migrate-vps.sh`/a full provider-migration script is still not
  built; `../../expense-tax-management/plans/ROADMAP.md` tracks status.
- **Application deployment**: this base bootstrap does not install application
  containers. Production deployment is live through
  `.github/workflows/expense-tax-deploy.yml` and
  `expense-tax-management/deploy/production/`; Cloudflare Tunnel reaches only
  loopback application origins. Traefik is not the current production edge.
- **Provider VM creation itself** (no Terraform): OVH/Database
  Mart-tier VPS purchases are typically manual control-panel actions,
  not API/Terraform-driven, so this starts from "you already have a
  reachable Ubuntu box," not "create the box."

## Tested status (be honest with future-you)

- `00-firewall.sh`, `10-harden-ssh.sh`, `20-docker.sh`: run against the
  live OVH box on 2026-09-08 via `bootstrap.sh` itself, confirmed
  correctly idempotent (each reported "already ... no changes" on a
  second run) — **except** `10-harden-ssh.sh` was not a no-op the first
  time: it found `PasswordAuthentication` was effectively **enabled**
  despite an existing drop-in trying to disable it (see the file's own
  comment for the `sshd_config` first-value-wins precedence bug that
  caused this), fixed it, and a fresh SSH connection was used to
  confirm the fix before moving on.
- `30-postgres.sh`: written to the same idempotent standard and
  reasoned through carefully, but **not yet run against a real box**.
  The OVH box already has a working, hand-provisioned,
  already-migrated Postgres at `/opt/expense-tax-management/postgres/`
  (single-app container, predates this script) — running this script
  today would stand up a *second*, separate shared-cluster Postgres and
  collide with it on host port 5432 for no present benefit (there's
  only one app). Treat `30-postgres.sh` as designed-not-yet-proven until
  either a second app onboards or the Feb 2027 provider migration gives
  a real fresh-box test. Consolidating today's ad hoc instance into this
  shared-cluster layout is optional future follow-up, not required.
