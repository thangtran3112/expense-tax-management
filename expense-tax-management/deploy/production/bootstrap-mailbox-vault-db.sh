#!/usr/bin/env bash
set -Eeuo pipefail

# Phase 3D-A Task 5: operator-only mailbox token-vault database bootstrap.
# Same invocation style as bootstrap-temporal-db.sh (credentials piped via
# PGPASSWORD/stdin SQL, never CLI arguments; idempotent CREATE ROLE/CREATE
# DATABASE guards) but a different shape: one database with two distinct
# roles -- a DML-only runtime role (used by the mailbox-broker container
# via MAILBOX_BROKER_DATABASE_URL) and a DDL-only migration role (used by
# mailbox-broker-migrate via MAILBOX_BROKER_MIGRATION_DATABASE_URL) --
# mirroring the runtime-vs-migration split already visible in this
# Compose file as APP_DATABASE_URL vs APP_MIGRATION_DATABASE_URL, not
# Temporal's single-role shape.
#
# Normal deploy never runs this script (same as Temporal's bootstrap).

: "${POSTGRES_SUPERUSER_PASSWORD:?POSTGRES_SUPERUSER_PASSWORD is required}"
: "${MAILBOX_VAULT_MIGRATOR_DB_PASSWORD:?MAILBOX_VAULT_MIGRATOR_DB_PASSWORD is required}"
: "${MAILBOX_VAULT_RUNTIME_DB_PASSWORD:?MAILBOX_VAULT_RUNTIME_DB_PASSWORD is required}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-expense-tax-postgres}"
POSTGRES_SUPERUSER="${POSTGRES_SUPERUSER_USER:-postgres}"

if [[ -z "$POSTGRES_CONTAINER" || -z "$POSTGRES_SUPERUSER" ]]; then
  printf '%s\n' "Mailbox vault database bootstrap configuration is incomplete" >&2
  exit 1
fi

export PGPASSWORD="$POSTGRES_SUPERUSER_PASSWORD"
migrator_password_sql=${MAILBOX_VAULT_MIGRATOR_DB_PASSWORD//\'/\'\'}
runtime_password_sql=${MAILBOX_VAULT_RUNTIME_DB_PASSWORD//\'/\'\'}

# SQL travels on stdin; credentials never appear in docker or psql arguments.
# The migrator role owns the database (full DDL, matching Temporal's
# owner-role pattern); the runtime role gets only DML on existing and
# future tables (no CREATE/ALTER/DROP), least-privilege for the
# long-running broker container.
docker exec -i -e PGPASSWORD "$POSTGRES_CONTAINER" psql \
  -U "$POSTGRES_SUPERUSER" \
  -d postgres \
  -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailbox_vault_migrator') THEN
    CREATE ROLE mailbox_vault_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$migrator_password_sql';
  ELSE
    ALTER ROLE mailbox_vault_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$migrator_password_sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailbox_vault_runtime') THEN
    CREATE ROLE mailbox_vault_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$runtime_password_sql';
  ELSE
    ALTER ROLE mailbox_vault_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$runtime_password_sql';
  END IF;
END
\$\$;
SELECT format('CREATE DATABASE mailbox_vault OWNER mailbox_vault_migrator')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'mailbox_vault')
\gexec
SQL

# DML-only grants run inside mailbox_vault itself (schema/table ownership
# is scoped per-database), as a second connection to that database.
docker exec -i -e PGPASSWORD "$POSTGRES_CONTAINER" psql \
  -U "$POSTGRES_SUPERUSER" \
  -d mailbox_vault \
  -v ON_ERROR_STOP=1 <<'SQL'
GRANT CONNECT ON DATABASE mailbox_vault TO mailbox_vault_runtime;
GRANT USAGE ON SCHEMA public TO mailbox_vault_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mailbox_vault_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mailbox_vault_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE mailbox_vault_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mailbox_vault_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE mailbox_vault_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mailbox_vault_runtime;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'mailbox_vault_runtime'
      AND rolsuper = false
      AND rolcreatedb = false
      AND rolcreaterole = false
      AND rolreplication = false
      AND rolbypassrls = false
  ) THEN
    RAISE EXCEPTION 'mailbox_vault_runtime role has unsafe attributes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'mailbox_vault_migrator'
      AND rolsuper = false
      AND rolcreatedb = false
      AND rolcreaterole = false
      AND rolreplication = false
      AND rolbypassrls = false
  ) THEN
    RAISE EXCEPTION 'mailbox_vault_migrator role has unsafe attributes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'mailbox_vault') THEN
    RAISE EXCEPTION 'Mailbox vault database is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_database d
    JOIN pg_roles r ON r.rolname = 'mailbox_vault_migrator'
    WHERE d.datname = 'mailbox_vault'
      AND d.datdba <> r.oid
  ) THEN
    RAISE EXCEPTION 'Mailbox vault database owner mismatch';
  END IF;
END
$$;
SQL
