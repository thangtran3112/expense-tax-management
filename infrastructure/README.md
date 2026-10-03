# Shared Infrastructure

`infrastructure/` owns shared local services, VPS base provisioning, and Cloudflare production ingress.

## Production Sources

- `cloudflare/expense-tax/`: live Cloudflare Tunnel, product DNS/ingress, Clerk DNS, and GCS-backed Terraform state.
- `vps/bootstrap-cloudflared.sh`: installs the outbound Tunnel connector on an existing VPS.
- `vps/`: reusable SSH hardening, UFW, Docker, and shared-PostgreSQL bootstrap.
- `temporal/docker-compose.yml`: independently owned shared Temporal server and loopback-only UI.
- `temporal/dynamicconfig.yaml`: shared Temporal dynamic configuration.
- `expense-tax-management/deploy/production/`: application production Compose, deploy, migration, rollback, and health-check scripts.
- `.github/workflows/expense-tax-deploy.yml`: immutable-image build and main-only production deployment.

Production application origins bind to VPS loopback and are reachable publicly only through Cloudflare Tunnel.

## Local/Transitional Sources

- `docker-compose.common.yml`: local PostgreSQL and transitional Nginx only; Neo4j remains blocked by the Phase 9A graph evidence gate.
- `temporal/docker-compose.local.yml`: pinned local Temporal server/UI included by the Expense development Compose wrapper.
- `postgres/init-multiple-dbs.sh`: local shared-cluster database creation.
- `nginx/nginx.conf`: local gateway for transitional `expense-service`/`frontend/web` paths.
- `expense-tax-management/docker-compose.yml`: application-local development overlay.

Local Nginx and transitional Python/web services are not the current production edge or canonical application architecture.

## Local Usage

```bash
cd expense-tax-management
pnpm compose:up
pnpm compose:down
```

## Why Shared PostgreSQL

One VPS PostgreSQL cluster reduces memory and operations overhead. Each family app receives a separate database and service-owned roles, preserving application isolation without running duplicate PostgreSQL containers.

## Shared Temporal Activation (operator-only)

Source changes alone do not migrate the live Temporal server. Production activation needs a separately approved, coordinated cutover:

1. Keep the existing `temporal` and `temporal_visibility` PostgreSQL databases and the `expense_temporal` role. `expense-tax-management/deploy/production/bootstrap-temporal-db.sh` remains an operator-only database creation step; do not run it during normal deployment. Record the last known-good image tag and preserve the existing Expense Compose file, deploy scripts, and root-only production environment file in a root-only recovery directory before replacing anything.
2. Create `family_shared` once. Transfer `infrastructure/temporal/docker-compose.yml`, `dynamicconfig.yaml`, and `bootstrap-namespaces.sh` together into `/opt/family-app/temporal/` on the VPS. Provision `/etc/family-app/temporal.env` as root-owned mode `0600` with **only** `TEMPORAL_DB_PASSWORD` set to the existing `expense_temporal` role password. Keep that password in a separate shared-infrastructure secret bundle; do not generate a new password or take it from a new Expense bundle. The shared server also joins `postgres_default`.
3. In the approved downtime window, stop the old `expense-tax-production` Temporal service and verify no container with Compose labels `com.docker.compose.project=expense-tax-production` and `com.docker.compose.service=temporal` is running. **Never run both Temporal servers against the same databases.** Start the shared server and UI from the staged files:

   ```bash
   sudo docker compose --project-name family-temporal --env-file /etc/family-app/temporal.env -f /opt/family-app/temporal/docker-compose.yml up -d --wait
   sudo bash /opt/family-app/temporal/bootstrap-namespaces.sh
   sudo docker exec family-temporal temporal operator namespace describe --address temporal:7233 --namespace default
   ```

   Namespace bootstrap creates `expense-tax` once and leaves the Python worker's `default` histories intact.
4. After the shared server is healthy, publish an Expense production bundle without `TEMPORAL_DB_PASSWORD` using the existing protected secret sync procedure. The next Expense deployment attaches App API and the Python worker to `family_shared`; its preflight rejects a running legacy Temporal container and requires `expense-tax`. Confirm both applications resolve `temporal` to the running `family-temporal` container and that the Python worker continues to process `default` histories before resuming dispatch.

Application image rollback cannot recover a failed shared Temporal server. If shared activation fails, stop the shared server first. Restore the saved Expense Compose file, deploy scripts, environment file, and image tag; then restart the old Temporal service against the **same preserved databases**. Verify `default` namespace histories and Python worker polling before resuming dispatch. Never start the legacy server until the shared server is stopped. Rehearse this operator rollback in an isolated environment before live activation.

Future Stock Analysis onboarding may create `stock-analysis` with `temporal operator namespace create --address temporal:7233 --namespace stock-analysis --retention 72h` after its separate approval. No Stock service or namespace is provisioned in this task.

## Deferred

- Automated PostgreSQL backup/restore to GCS.
- Proven fresh-host restore and provider migration drill.
- Live proof of shared-cluster `vps/steps/30-postgres.sh` on a fresh VPS.
- Search/graph production infrastructure.

See `expense-tax-management/plans/ROADMAP.md` for current status and migration order.
