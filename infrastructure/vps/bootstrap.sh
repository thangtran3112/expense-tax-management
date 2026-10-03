#!/usr/bin/env bash
# Reusable, idempotent VPS bootstrap for family-app: SSH hardening,
# firewall, Docker, and a shared Postgres cluster with one app's
# database/roles applied. Runs from your OPERATOR machine (not on the
# VPS) and pushes each step over SSH/SCP -- mirrors exactly how this was
# first done by hand against the OVH box on 2026-09-08.
#
# See README.md for the manual "bridge" step this script cannot automate
# (the very first connection to a brand-new VPS).
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bootstrap.sh --host HOST --ssh-user USER --ssh-key PATH --app APP_CONF
                     [--ssh-port PORT] [--target-ssh-port PORT]
                     [--shared-pg-dir PATH] [--only STEPS] [--fetch-secrets-to PATH]
                     [--backup-dir PATH] [--backup-gcs-uri URI] [--backup-host-id ID]
                     [--age-recipient AGE1KEY] [--receipt-volume VOLUME_NAME]
                     [--backup-writer-key-file PATH] [--backup-image IMAGE]

Required:
  --host              VPS hostname or IP
  --ssh-user          SSH username (e.g. ubuntu)
  --ssh-key           Path to private key
  --app               Path to an apps/*.conf file (see apps/expense-tax-management.conf)

Optional:
  --ssh-port          Port to CONNECT with right now. Default: 22.
                       Use whatever port is CURRENTLY live -- 22 for a
                       brand-new box's first-ever connection (see
                       README.md "manual bridge"), or the already-hardened
                       port (e.g. 2222) to safely re-run/dry-check.
  --target-ssh-port   Port SSH should end up on after hardening. Default: 2222.
  --shared-pg-dir     Remote dir for the shared Postgres stack.
                       Default: /opt/family-app/postgres
  --only              Comma-separated subset of: firewall,ssh,docker,postgres,backup
                       Default: firewall,ssh,docker,postgres (in that order --
                       firewall opens the target SSH port BEFORE sshd starts
                       requiring it exclusively). "backup" is NEVER in the
                       default set -- it needs secrets (see below) and is
                       opt-in only, run explicitly with --only backup once
                       Task 1's bucket/identities actually exist.
  --fetch-secrets-to  After the postgres step, copy the remote shared
                       postgres .env to this local path (chmod 600).
                       Optional -- omit to leave secrets on the VPS only.

Backup step only (all required together when --only includes backup):
  --backup-dir              Remote dir for backup state/ciphertext.
                              Default: /opt/family-app/backup
  --backup-gcs-uri           gs://bucket from Task 1's Terraform output
  --backup-host-id            Stable identifier embedded in backup object names
  --age-recipient              Public age1... recipient (Task 1 operator keeps the private half)
  --receipt-volume       Name of the app's receipt Docker volume (e.g.
                               expense-tax-production_expense_tax_production_storage)
                               -- a named volume, mounted by name regardless
                               of which Compose project created it, not a
                               host path
  --backup-writer-key-file    LOCAL path to the Task 1 writer service account
                               key JSON (see infrastructure/gcp/backup/README.md
                               for how it's created -- never committed, never
                               written to this script's own disk beyond what
                               the operator already has)
  --backup-image              Pinned backup image ref (a digest, not a mutable tag)

Examples:
  # Brand-new VPS from any provider, first-ever connection on port 22:
  ./bootstrap.sh --host 1.2.3.4 --ssh-user ubuntu --ssh-key ~/.ssh/id_ed25519 \
    --app apps/expense-tax-management.conf --ssh-port 22 --target-ssh-port 2222 \
    --fetch-secrets-to ~/secrets/postgres-vps.env

  # Already-hardened box: safe idempotent re-run / dry-check, or add a step:
  ./bootstrap.sh --host 1.2.3.4 --ssh-user ubuntu --ssh-key ~/.ssh/id_ed25519 \
    --app apps/expense-tax-management.conf --ssh-port 2222 --target-ssh-port 2222

  # Onboard a second app onto the same already-running shared cluster:
  ./bootstrap.sh --host 1.2.3.4 --ssh-user ubuntu --ssh-key ~/.ssh/id_ed25519 \
    --app apps/some-other-app.conf --ssh-port 2222 --target-ssh-port 2222 --only postgres
EOF
}

HOST=""
SSH_USER=""
SSH_KEY=""
APP_CONF=""
SSH_PORT="22"
TARGET_SSH_PORT="2222"
SHARED_PG_DIR="/opt/family-app/postgres"
ONLY="firewall,ssh,docker,postgres"
FETCH_SECRETS_TO=""
BACKUP_DIR="/opt/family-app/backup"
BACKUP_GCS_URI=""
BACKUP_HOST_ID=""
AGE_RECIPIENT=""
RECEIPT_VOLUME=""
BACKUP_WRITER_KEY_FILE=""
BACKUP_IMAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --ssh-user) SSH_USER="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --app) APP_CONF="$2"; shift 2 ;;
    --ssh-port) SSH_PORT="$2"; shift 2 ;;
    --target-ssh-port) TARGET_SSH_PORT="$2"; shift 2 ;;
    --shared-pg-dir) SHARED_PG_DIR="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --fetch-secrets-to) FETCH_SECRETS_TO="$2"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --backup-gcs-uri) BACKUP_GCS_URI="$2"; shift 2 ;;
    --backup-host-id) BACKUP_HOST_ID="$2"; shift 2 ;;
    --age-recipient) AGE_RECIPIENT="$2"; shift 2 ;;
    --receipt-volume) RECEIPT_VOLUME="$2"; shift 2 ;;
    --backup-writer-key-file) BACKUP_WRITER_KEY_FILE="$2"; shift 2 ;;
    --backup-image) BACKUP_IMAGE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

for required in HOST SSH_USER SSH_KEY APP_CONF; do
  if [[ -z "${!required}" ]]; then
    echo "Missing required --${required,,}" >&2
    usage
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ ! -f "$APP_CONF" ]]; then
  echo "App config not found: $APP_CONF" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$APP_CONF"
: "${APP_NAME:?$APP_CONF must set APP_NAME}"
: "${POSTGRES_DB_NAME:?$APP_CONF must set POSTGRES_DB_NAME}"
: "${POSTGRES_IMAGE:?$APP_CONF must set POSTGRES_IMAGE}"
: "${ROLE_INIT_SCRIPT_REPO_RELATIVE_PATH:?$APP_CONF must set ROLE_INIT_SCRIPT_REPO_RELATIVE_PATH}"
: "${REQUIRED_PASSWORD_VARS:?$APP_CONF must set REQUIRED_PASSWORD_VARS}"

ROLE_SCRIPT_LOCAL_PATH="$REPO_ROOT/$ROLE_INIT_SCRIPT_REPO_RELATIVE_PATH"
if [[ ! -f "$ROLE_SCRIPT_LOCAL_PATH" ]]; then
  echo "Role init script not found: $ROLE_SCRIPT_LOCAL_PATH" >&2
  exit 1
fi

# Current connect port -- updated in-place once the ssh step succeeds.
CURRENT_PORT="$SSH_PORT"

ssh_run() {
  ssh -p "$CURRENT_PORT" -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 "${SSH_USER}@${HOST}" "$@"
}

scp_to() {
  local local_path="$1" remote_path="$2"
  scp -P "$CURRENT_PORT" -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$local_path" "${SSH_USER}@${HOST}:${remote_path}"
}

should_run() {
  [[ ",${ONLY}," == *",${1},"* ]]
}

echo "== family-app VPS bootstrap: ${APP_NAME} @ ${SSH_USER}@${HOST} =="
echo "   connect port: ${CURRENT_PORT}  target ssh port: ${TARGET_SSH_PORT}  steps: ${ONLY}"

if should_run firewall; then
  echo "-- [firewall] --"
  scp_to "$SCRIPT_DIR/steps/00-firewall.sh" /tmp/00-firewall.sh
  ssh_run "sudo TARGET_SSH_PORT=${TARGET_SSH_PORT} bash /tmp/00-firewall.sh"
fi

if should_run ssh; then
  echo "-- [ssh hardening] --"
  scp_to "$SCRIPT_DIR/steps/10-harden-ssh.sh" /tmp/10-harden-ssh.sh
  ssh_run "sudo TARGET_SSH_PORT=${TARGET_SSH_PORT} bash /tmp/10-harden-ssh.sh"
  if [[ "$CURRENT_PORT" != "$TARGET_SSH_PORT" ]]; then
    echo "   verifying a FRESH connection on the new port ${TARGET_SSH_PORT}..."
    CURRENT_PORT="$TARGET_SSH_PORT"
    ssh_run "echo connected on \$(sudo sshd -T | awk '/^port /{print \$2; exit}')"
  fi
fi

if should_run docker; then
  echo "-- [docker] --"
  scp_to "$SCRIPT_DIR/steps/20-docker.sh" /tmp/20-docker.sh
  ssh_run "sudo bash /tmp/20-docker.sh"
fi

if should_run postgres; then
  echo "-- [postgres] --"
  role_script_name="$(basename "$ROLE_SCRIPT_LOCAL_PATH")"
  remote_role_script_name="${POSTGRES_DB_NAME}__${role_script_name}"
  ssh_run "sudo mkdir -p ${SHARED_PG_DIR}/initdb"
  scp_to "$ROLE_SCRIPT_LOCAL_PATH" "/tmp/${remote_role_script_name}"
  ssh_run "sudo mv /tmp/${remote_role_script_name} ${SHARED_PG_DIR}/initdb/${remote_role_script_name} && sudo chmod 644 ${SHARED_PG_DIR}/initdb/${remote_role_script_name}"
  scp_to "$SCRIPT_DIR/steps/30-postgres.sh" /tmp/30-postgres.sh
  ssh_run "sudo SHARED_PG_DIR=${SHARED_PG_DIR} POSTGRES_IMAGE=${POSTGRES_IMAGE} REQUIRED_PASSWORD_VARS='${REQUIRED_PASSWORD_VARS}' bash /tmp/30-postgres.sh"

  if [[ -n "$FETCH_SECRETS_TO" ]]; then
    echo "   fetching ${SHARED_PG_DIR}/.env -> ${FETCH_SECRETS_TO}"
    ssh_run "sudo cat ${SHARED_PG_DIR}/.env" > "$FETCH_SECRETS_TO"
    chmod 600 "$FETCH_SECRETS_TO"
  fi
fi

if should_run backup; then
  echo "-- [backup] --"
  for required in BACKUP_GCS_URI BACKUP_HOST_ID AGE_RECIPIENT RECEIPT_VOLUME BACKUP_WRITER_KEY_FILE BACKUP_IMAGE; do
    if [[ -z "${!required}" ]]; then
      echo "Missing required --${required,,} for --only backup" | tr '_' '-' >&2
      exit 1
    fi
  done
  if [[ ! -f "$BACKUP_WRITER_KEY_FILE" ]]; then
    echo "Backup writer key file not found: $BACKUP_WRITER_KEY_FILE" >&2
    exit 1
  fi
  BACKUP_DIR_REPO="$REPO_ROOT/infrastructure/backup"
  scp_to "$BACKUP_DIR_REPO/family-app-backup.service" /tmp/family-app-backup.service
  scp_to "$BACKUP_DIR_REPO/family-app-backup.timer" /tmp/family-app-backup.timer
  scp_to "$BACKUP_DIR_REPO/family-app-backup-retry.service" /tmp/family-app-backup-retry.service
  scp_to "$BACKUP_DIR_REPO/check-backup-freshness.sh" /tmp/check-backup-freshness.sh
  scp_to "$SCRIPT_DIR/steps/40-backup.sh" /tmp/40-backup.sh
  writer_key_json="$(cat "$BACKUP_WRITER_KEY_FILE")"
  ssh_run "sudo SHARED_PG_DIR=${SHARED_PG_DIR} BACKUP_DIR=${BACKUP_DIR} BACKUP_GCS_URI=${BACKUP_GCS_URI} \
    BACKUP_HOST_ID=${BACKUP_HOST_ID} AGE_RECIPIENT=${AGE_RECIPIENT} RECEIPT_VOLUME=${RECEIPT_VOLUME} \
    BACKUP_IMAGE=${BACKUP_IMAGE} UNIT_FILES_DIR=/tmp BACKUP_WRITER_KEY_JSON='${writer_key_json}' \
    bash /tmp/40-backup.sh"
fi

echo "== done =="
