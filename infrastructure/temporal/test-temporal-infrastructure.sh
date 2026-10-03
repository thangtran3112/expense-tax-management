#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)

node - "$ROOT" <<'JS'
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const YAML = require(process.argv[2] + "/expense-tax-management/node_modules/yaml");
const root = process.argv[2];
const read = (path) => readFileSync(`${root}/${path}`, "utf8");
const shared = YAML.parse(read("infrastructure/temporal/docker-compose.yml"));
const local = YAML.parse(read("infrastructure/temporal/docker-compose.local.yml"));
const common = YAML.parse(read("infrastructure/docker-compose.common.yml"));
const expense = YAML.parse(read("expense-tax-management/deploy/production/docker-compose.yml"));
const scripts = JSON.parse(read("expense-tax-management/package.json")).scripts;
const temporal = shared.services.temporal;

assert.equal(temporal.image, "temporalio/auto-setup:1.29.1");
assert.equal(shared.services["temporal-ui"].image, "temporalio/ui:2.54.1");
assert.deepEqual(temporal.ports, ["127.0.0.1:7233:7233"]);
assert.deepEqual(shared.services["temporal-ui"].ports, ["127.0.0.1:8233:8080"]);
assert.equal(temporal.environment.DB, "postgres12");
assert.equal(temporal.environment.SKIP_DB_CREATE, "true");
assert.equal(temporal.environment.POSTGRES_USER, "expense_temporal");
assert.match(temporal.environment.POSTGRES_PWD, /^\$\{TEMPORAL_DB_PASSWORD:\?/);
assert.equal(temporal.environment.POSTGRES_SEEDS, "postgres");
assert.ok(temporal.healthcheck?.test?.includes("health"));
assert.ok(temporal.volumes?.some((mount) => mount.includes("dynamicconfig.yaml")));
assert.deepEqual(temporal.networks, ["shared", "database"]);
assert.equal(shared.networks.shared.external, true);
assert.equal(shared.networks.shared.name, "family_shared");
assert.equal(shared.networks.database.external, true);
assert.equal(shared.networks.database.name, "postgres_default");
assert.equal(shared.services["temporal-ui"].depends_on.temporal.condition, "service_healthy");
assert.equal(Object.keys(temporal.environment).some((key) =>
  /^(APP_|FOUNDRY_|CLERK_|POSTGRES_SUPERUSER_PASSWORD)/.test(key)), false);
assert.equal(YAML.parse(read("infrastructure/temporal/dynamicconfig.yaml"))["limit.maxIDLength"][0].value, 255);

assert.equal(common.services.temporal, undefined);
assert.equal(common.services["temporal-ui"], undefined);
assert.equal(common.services.neo4j, undefined);
assert.equal(common.volumes.neo4j_data, undefined);
assert.equal(local.services.temporal.image, "temporalio/auto-setup:1.29.1");
assert.equal(local.services.temporal.depends_on.postgres.condition, "service_healthy");
assert.deepEqual(local.services.temporal.ports, ["127.0.0.1:7233:7233"]);
assert.equal(expense.services.temporal, undefined);
assert.equal(expense.networks.shared.external, true);
assert.equal(expense.networks.shared.name, "family_shared");
for (const name of ["app-api", "ai-worker"]) {
  assert.ok(expense.services[name].networks.includes("shared"));
  assert.equal(expense.services[name].depends_on?.temporal, undefined);
}
assert.ok(expense.services["ai-worker"]);
assert.equal(expense.services["workflow-worker"], undefined);
assert.equal(/compose up[^\n]*\btemporal\b/.test(read("expense-tax-management/deploy/production/deploy.sh")), false,
  "Expense deployment must not start the shared Temporal server");
assert.equal(/bootstrap-temporal-db\.sh/.test(read(".github/workflows/expense-tax-deploy.yml")), false,
  "normal deployment must not bootstrap the Temporal database");
assert.match(read("expense-tax-management/deploy/production/health-check.sh"), /docker exec[^\n]*family-temporal[^\n]*operator cluster health/);
assert.match(scripts["ci:test"], /pnpm check:temporal-infrastructure/);
console.log("PASS shared Temporal Compose and production boundaries");
JS

TEMPORAL_DB_PASSWORD=test-placeholder docker compose --project-name task6-validation \
  --env-file /dev/null -f "$ROOT/infrastructure/temporal/docker-compose.yml" config --quiet
EXPENSE_TAX_ENV_FILE="$ROOT/expense-tax-management/.env.example" \
  "$ROOT/expense-tax-management/scripts/compose.sh" config --quiet

sandbox=$(mktemp -d)
trap 'rm -f "$sandbox/docker" "$sandbox/created" "$sandbox/calls"; rmdir "$sandbox"' EXIT
cat > "$sandbox/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"cluster health"*) [[ "${FAIL_HEALTH:-0}" != 1 ]] ;;
  *"namespace describe"*) [[ -f "$STATE_FILE" ]] ;;
  *"namespace create"*)
    [[ "$*" == *"--namespace expense-tax"* && "$*" == *"--retention 72h"* ]] || exit 1
    [[ ! -f "$STATE_FILE" ]] || exit 1
    : > "$STATE_FILE"
    printf 'create\n' >> "$COUNT_FILE"
    ;;
  *) exit 1 ;;
esac
SH
chmod 700 "$sandbox/docker"
for run in 1 2; do
  PATH="$sandbox:$PATH" STATE_FILE="$sandbox/created" COUNT_FILE="$sandbox/calls" \
    bash "$ROOT/infrastructure/temporal/bootstrap-namespaces.sh" >/dev/null
done
[[ $(wc -l < "$sandbox/calls") -eq 1 ]] || { printf '%s\n' "namespace bootstrap was not idempotent" >&2; exit 1; }
rm -f "$sandbox/created"
if PATH="$sandbox:$PATH" STATE_FILE="$sandbox/created" COUNT_FILE="$sandbox/calls" FAIL_HEALTH=1 \
  bash "$ROOT/infrastructure/temporal/bootstrap-namespaces.sh" >/dev/null 2>&1; then
  printf '%s\n' "namespace bootstrap ignored unhealthy Temporal" >&2
  exit 1
fi
[[ ! -f "$sandbox/created" && $(wc -l < "$sandbox/calls") -eq 1 ]] || {
  printf '%s\n' "namespace bootstrap mutated unhealthy Temporal" >&2
  exit 1
}
printf '%s\n' "PASS namespace bootstrap creates expense-tax exactly once"
