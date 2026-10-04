import { execFileSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * Local Clerk Development Bootstrap, Item 4: a reproducible local smoke
 * exercising both Temporal-dispatch generations end to end against the
 * real local Compose stack (real Postgres, real Temporal, real ai-worker
 * / workflow-worker containers using real Development Clerk M2M
 * credentials for their own callback into App API).
 *
 * Ruling: job creation calls App API's own domain layer
 * (createProcessingJobsDomain.createJob/dispatchPendingJobs, the exact
 * code `/internal/v1/jobs/foundation-echo` calls) rather than that HTTP
 * route. That route's guard is `serviceGuard("platform-admin", [...])` --
 * a literal, hardcoded expected subject -- but every real Clerk M2M
 * token's `sub` claim is always the calling machine's own resource ID
 * (`mch_...`; confirmed against Clerk's M2M docs), which can never equal
 * the literal string "platform-admin". The route is therefore
 * unreachable via any genuine Clerk-issued token in AUTH_PROVIDER=clerk
 * mode (it predates Clerk and is only exercised today via the legacy
 * provider in CI, e.g. app-domain-0l-worker-loop.test.ts). Calling the
 * domain function directly -- against the SAME local Postgres the
 * containerized app-api reads/writes -- creates the job through App
 * API's own logic without requiring a fix to that unrelated, pre-existing
 * gap. The callback half of the loop (worker -> App API `/internal/v1/
 * jobs/:jobId/status`, guarded by `serviceGuard(appServiceSubject,
 * ["jobs:write"])`) IS satisfied by a real Clerk M2M token, because
 * `appServiceSubject` is configured to equal that real machine's own ID --
 * so this smoke still genuinely exercises the Development Clerk M2M flow
 * end to end on the half of the loop where Clerk auth actually governs.
 *
 * Every database mutation here runs *inside* the Compose network via
 * `compose.sh run --rm app-api-migrate ...`, never over a host TCP
 * connection -- so there is no dependency on the host's Postgres port
 * (5433 is sometimes squatted by an unrelated local proxy; see
 * .superpowers/sdd/runtime-typescript-temporal-migration/
 * task-7a-report.md "Fix Round 1") and the resolved database host is
 * always the Compose service itself, never operator-suppliable.
 *
 * Fix round 1 (credential-safety hardening): the host process running
 * this script must NEVER hold a real credential value in memory, not
 * even transiently. Concretely:
 *   - This script never runs `docker compose config --format json` (that
 *     resolves and prints every service's real environment, secrets
 *     included, into one JSON blob the host would then parse). The only
 *     `config` invocation left is `config --quiet`, a syntax-only
 *     validation that prints nothing.
 *   - Clerk credential presence and database-host checks instead run
 *     *inside* a one-off container (the exact credential-bearing service
 *     image itself), which prints only variable NAMES or a bare
 *     hostname -- never a secret value -- back to the host's stdout.
 */

export const SMOKE_CONFIRMATION = "I-understand-local-worker-smoke";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const composeScript = path.join(repoRoot, "scripts", "compose.sh");

export function isExecutionConfirmed(
  args = process.argv.slice(2),
  env = process.env,
) {
  return (
    args.includes("--execute") &&
    env.LOCAL_WORKER_SMOKE_CONFIRM === SMOKE_CONFIRMATION
  );
}

/**
 * Names only, never values: a var counts as "missing" when it is unset
 * or still carries the repo's documented not-configured placeholder
 * (docker-compose.yml's `${VAR:-default}` fallback or .env.example's own
 * placeholder), i.e. Development Clerk M2M credentials were never loaded.
 * Single source of truth: also used (via clerkCredentialCheckScript) to
 * generate the in-container check, so there is exactly one sentinel list.
 */
const CLERK_CREDENTIAL_CHECKS = [
  {
    key: "CLERK_ISSUER_URL",
    placeholders: ["https://clerk.not-configured.invalid"],
  },
  {
    key: "CLERK_JWKS_URL",
    placeholders: [
      "https://clerk.not-configured.invalid/.well-known/jwks.json",
    ],
  },
  {
    key: "CLERK_APP_MACHINE_SECRET_KEY",
    placeholders: ["not-yet-issued", "ak_test_not-configured"],
  },
  {
    key: "CLERK_FOUNDRY_MACHINE_SECRET_KEY",
    placeholders: ["not-yet-issued", "ak_test_not-configured"],
  },
];

/**
 * Pure logic, unit-tested in isolation against a fake object -- never
 * called by runLocalWorkerSmoke() against a real environment. The real
 * check runs this exact logic *inside* a container via
 * clerkCredentialCheckScript(); this export exists so the matching logic
 * itself has direct test coverage without Docker.
 */
export function missingClerkCredentials(serviceEnvironment = {}) {
  return CLERK_CREDENTIAL_CHECKS.filter(({ key, placeholders }) => {
    const value = serviceEnvironment[key];
    return (
      value === undefined || value === "" || placeholders.includes(value)
    );
  }).map(({ key }) => key);
}

/**
 * Refuses any hostname that is not the local Compose "postgres" service.
 * Takes a bare hostname (never a connection string) -- the caller must
 * extract it *inside* a container (checkDatabaseHostname), so a real
 * database password is never constructed on, or held by, the host.
 */
export function assertLocalDatabaseHost(hostname, label) {
  if (hostname !== "postgres") {
    throw new Error(
      `${label}: refusing to run against non-local database host "${hostname}" ` +
        `(expected the local Compose "postgres" service)`,
    );
  }
}

/**
 * Refuses to run unless Docker itself is local: a `postgres`-hostname
 * connection string is only actually local if the Docker daemon being
 * driven is local too -- otherwise "postgres" resolves inside someone
 * else's remote Docker network. Checks two independent signals: an
 * explicit DOCKER_HOST override, and the active Docker context's own
 * endpoint (`docker context inspect`, `Endpoints.docker.Host`). Neither
 * value is a credential; both are safe to read directly on the host.
 */
export function assertLocalDockerEndpoint(
  env = process.env,
  currentContextEndpoint = currentDockerContextEndpoint,
) {
  const dockerHost = env.DOCKER_HOST;
  if (dockerHost && !dockerHost.startsWith("unix://")) {
    throw new Error(
      `refusing to run: DOCKER_HOST is set to a non-local endpoint "${dockerHost}"`,
    );
  }
  const endpoint = currentContextEndpoint();
  if (!endpoint.startsWith("unix://")) {
    throw new Error(
      `refusing to run: current Docker context endpoint "${endpoint}" is not a local unix socket`,
    );
  }
}

/**
 * Refuses to proceed unless dispatch routing is still at its legacy
 * generation 1 (namespace "default" / queue "expense-tax-ai-worker").
 * Without this, a rerun after a prior smoke already advanced routing
 * would create "generation 1"'s job at generation 2+, so it would never
 * actually exercise the Python ai-worker's legacy-routing path, and the
 * second `advance` call would also fail the CLI's own stale-generation
 * guard. `status`'s fields carry no secrets (generation/namespace/queue
 * only), so this is safe to assert on the host.
 */
export function assertGeneration1Routing(status) {
  if (
    status.generation !== 1 ||
    status.namespace !== "default" ||
    status.taskQueue !== "expense-tax-ai-worker"
  ) {
    throw new Error(
      `refusing to run: dispatch routing is already at generation ${status.generation} ` +
        `(namespace ${status.namespace} / queue ${status.taskQueue}), not the expected ` +
        `legacy generation 1 (namespace default / queue expense-tax-ai-worker). Reset the ` +
        `disposable local stack first: ./scripts/compose.sh down -v`,
    );
  }
}

export function servicesToStart(alreadyRunning, desired) {
  return desired.filter((name) => !alreadyRunning.includes(name));
}

export function buildSmokePlan() {
  return [
    "guard:execution-confirmed",
    "guard:docker-endpoint-local",
    "guard:compose-config-valid",
    "guard:migration-database-host-local",
    "guard:runtime-database-host-local",
    "guard:clerk-credentials-present",
    "compose:start-generation-1-services",
    "database:run-app-api-migrations",
    "temporal:bootstrap-expense-tax-namespace",
    "dispatch-routing:assert-generation-1",
    "job:create-generation-1",
    "job:await-python-worker-callback",
    "dispatch-routing:advance-to-generation-2",
    "compose:start-workflow-worker",
    "job:create-generation-2",
    "job:await-typescript-worker-callback",
    "teardown:stop-started-services",
  ];
}

const GENERATION_1_SERVICES = [
  "postgres",
  "temporal",
  "app-api",
  "foundry-service",
  "ai-worker",
];
const WORKFLOW_WORKER_SERVICE = "workflow-worker";
const familyRoot = path.resolve(repoRoot, "..");
const bootstrapNamespacesScript = path.join(
  familyRoot,
  "infrastructure",
  "temporal",
  "bootstrap-namespaces.sh",
);

function currentDockerContextEndpoint() {
  const raw = execFileSync("docker", ["context", "inspect"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [context] = JSON.parse(raw);
  return context?.Endpoints?.docker?.Host ?? "";
}

/**
 * `infrastructure/temporal/bootstrap-namespaces.sh` (Task 6) idempotently
 * creates the "expense-tax" Temporal namespace the TypeScript worker and
 * generation-2 dispatch routing target. Plain `compose.sh up` never runs
 * it, and its own default container name (`family-temporal`, the shared
 * production container) does not match this repo's local container name
 * (`expense-tax-temporal`) -- overridden here via TEMPORAL_CONTAINER.
 */
function bootstrapExpenseTaxNamespace() {
  execFileSync("bash", [bootstrapNamespacesScript], {
    cwd: repoRoot,
    env: { ...process.env, TEMPORAL_CONTAINER: "expense-tax-temporal" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function composeArgs(extra, { profiles = [] } = {}) {
  return [...profiles.flatMap((profile) => ["--profile", profile]), ...extra];
}

function runCompose(args, options = {}) {
  return execFileSync(composeScript, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function runningServices() {
  return runCompose(["ps", "--services", "--filter", "status=running"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Runs `scriptSource` with `node --input-type=module -e` inside a
 * one-off, dependency-free (`--no-deps`) container of `service` -- the
 * exact image/environment the real compose service would get, so the
 * script sees the service's real resolved env vars, but ONLY inside the
 * container's own process. Whatever the script prints to stdout is all
 * the host ever receives.
 */
function runContainerCheck(service, scriptSource) {
  return runCompose([
    "run",
    "--rm",
    "-T",
    "--no-deps",
    service,
    "node",
    "--input-type=module",
    "-e",
    scriptSource,
  ]).trim();
}

/**
 * Generated from CLERK_CREDENTIAL_CHECKS (the same list
 * missingClerkCredentials uses) so there is exactly one sentinel list;
 * only the (non-secret) sentinel placeholders are embedded, never a real
 * credential. Prints a JSON array of missing variable NAMES only.
 */
function clerkCredentialCheckScript() {
  return `
const CHECKS = ${JSON.stringify(CLERK_CREDENTIAL_CHECKS)};
const missing = CHECKS.filter(({ key, placeholders }) => {
  const value = process.env[key];
  return value === undefined || value === "" || placeholders.includes(value);
}).map(({ key }) => key);
console.log(JSON.stringify(missing));
`;
}

/**
 * Runs inside workflow-worker's own image: it is the only compose
 * service that already declares all four CLERK_*_MACHINE_SECRET_KEY /
 * issuer / jwks vars this smoke needs to check (ai-worker declares the
 * same four but is a Python image with no Node; app-api/foundry-service
 * only hold audience/subject, not the machine secret keys).
 */
function checkClerkCredentials() {
  return JSON.parse(
    runContainerCheck(WORKFLOW_WORKER_SERVICE, clerkCredentialCheckScript()),
  );
}

/**
 * Prints only the hostname portion of `envVarName` (never the full
 * connection string, so the password never leaves the container).
 */
function checkDatabaseHostname(service, envVarName) {
  return runContainerCheck(
    service,
    `console.log(new URL(process.env.${envVarName}).hostname);`,
  );
}

/**
 * A fresh (or `down -v`'d) local Postgres volume has no `app` schema at
 * all until migrations run. Plain `compose.sh up` never runs them either
 * (same as CI's separate "Initialize service schemas" step); the default
 * `app-api-migrate` command is `node dist/database/migrate.js`.
 */
function runAppApiMigrations() {
  runCompose(["run", "--rm", "-T", "app-api-migrate"]);
}

/**
 * Inline script, executed with real migration credentials inside the
 * Compose network (never on the host), that creates one disposable
 * foundation-echo job through App API's own domain layer, dispatches it,
 * and polls until the responsible worker (Python on generation 1,
 * TypeScript after `advance`) reaches a terminal status.
 */
function createJobScriptSource() {
  return `
import { randomUUID } from "node:crypto";
import { createAppDatabase } from "./dist/database/client.js";
import { createProcessingJobsDomain } from "./dist/domain/processing-jobs.js";
import { createTemporalWorkflowStarter } from "./dist/temporal/client.js";

const runKey = process.env.LOCAL_SMOKE_RUN_KEY;
if (!runKey) throw new Error("LOCAL_SMOKE_RUN_KEY is required");

const db = createAppDatabase(process.env.APP_MIGRATION_DATABASE_URL);
const starter = createTemporalWorkflowStarter({
  address: process.env.TEMPORAL_HOST,
  namespace: process.env.TEMPORAL_NAMESPACE,
});
const domain = createProcessingJobsDomain(db, starter);

const userId = randomUUID();
const tenantId = randomUUID();
const profileId = randomUUID();
const slug = \`local-smoke-\${runKey}-\${tenantId.slice(0, 8)}\`;

try {
  await db.insertInto("app.users").values({
    id: userId,
    primary_email: \`local-smoke-\${runKey}-\${userId.slice(0, 8)}@example.test\`,
    display_name: "Local Worker Smoke",
  }).execute();
  await db.insertInto("app.tenants").values({
    id: tenantId,
    name: "Local Worker Smoke Tenant",
    slug,
  }).execute();
  await db.insertInto("app.tenant_memberships").values({
    tenant_id: tenantId,
    user_id: userId,
    role: "owner",
  }).execute();
  await db.insertInto("app.personal_profiles").values({
    id: profileId,
    tenant_id: tenantId,
    name: "Personal",
  }).execute();

  const job = await domain.createJob({
    tenantId,
    scope: { personalProfileId: profileId },
    workflowType: "FoundationEchoWorkflow",
    allowedResultSchemaVersion: "foundation-echo-v1",
    actorServicePrincipal: "local-worker-smoke",
    requestId: \`local-smoke-\${runKey}-create\`,
  });
  const dispatch = await domain.dispatchPendingJobs({});

  const deadline = Date.now() + 45_000;
  let row;
  while (Date.now() < deadline) {
    row = await db
      .selectFrom("app.processing_jobs")
      .selectAll()
      .where("id", "=", job.id)
      .executeTakeFirstOrThrow();
    if (row.status === "SUCCEEDED" || row.status === "FAILED") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // Always exit 0 here: a non-SUCCEEDED status is reported in this JSON
  // line for the orchestrator to judge, not a crash of this helper.
  console.log(JSON.stringify({
    jobId: job.id,
    slug,
    dispatchedCount: dispatch.dispatchedCount,
    status: row?.status ?? "PENDING",
    dispatchNamespace: row?.dispatch_namespace,
    taskQueue: row?.task_queue,
  }));
} finally {
  await db.destroy();
}
`;
}

function createJobAndAwaitCompletion(runKey) {
  let output;
  try {
    output = runCompose([
      "run",
      "--rm",
      "-T",
      "-e",
      `LOCAL_SMOKE_RUN_KEY=${runKey}`,
      "-e",
      "TEMPORAL_HOST=temporal:7233",
      "-e",
      "TEMPORAL_NAMESPACE=default",
      "app-api-migrate",
      "node",
      "--input-type=module",
      "-e",
      createJobScriptSource(),
    ]);
  } catch (error) {
    const stdout = error?.stdout?.toString() ?? "";
    const stderr = error?.stderr?.toString() ?? "";
    throw new Error(
      `job creation (run key ${runKey}) failed:\n${stdout}\n${stderr}`.trim(),
    );
  }
  const lastLine = output.trim().split("\n").at(-1) ?? "";
  return JSON.parse(lastLine);
}

/**
 * Prints only {generation, namespace, taskQueue, ...non-terminal counts}
 * -- routing metadata, never a credential -- so this output is safe to
 * parse and assert on here on the host (see getDispatchRoutingStatus).
 */
function dispatchRoutingCommand(...commandArgs) {
  const output = runCompose([
    "run",
    "--rm",
    "-T",
    "app-api-migrate",
    "node",
    "dist/temporal/dispatch-routing.js",
    ...commandArgs,
  ]);
  return JSON.parse(output.trim());
}

function log(message) {
  console.log(message);
}

export async function runLocalWorkerSmoke() {
  if (!isExecutionConfirmed()) {
    throw new Error(
      `refusing to run: pass --execute and LOCAL_WORKER_SMOKE_CONFIRM=${SMOKE_CONFIRMATION}`,
    );
  }

  assertLocalDockerEndpoint();
  log("PASS guard: Docker endpoint is a local unix socket");

  // Syntax/reference validation only -- never resolves or prints values.
  runCompose(["config", "--quiet"]);
  log("PASS guard: compose config is valid");

  assertLocalDatabaseHost(
    checkDatabaseHostname("app-api-migrate", "APP_MIGRATION_DATABASE_URL"),
    "APP_MIGRATION_DATABASE_URL",
  );
  assertLocalDatabaseHost(
    checkDatabaseHostname("app-api", "APP_DATABASE_URL"),
    "APP_DATABASE_URL",
  );
  log("PASS guard: database host is the local Compose postgres service");

  const missing = checkClerkCredentials();
  if (missing.length > 0) {
    throw new Error(
      `missing Development Clerk M2M credentials (never printing values): ${missing.join(", ")}`,
    );
  }
  log("PASS guard: Development Clerk M2M credentials present");

  const baseline = runningServices();
  const startedServices = [];

  try {
    const toStart = servicesToStart(baseline, GENERATION_1_SERVICES);
    if (toStart.length > 0) {
      runCompose(["up", "-d", "--wait", ...GENERATION_1_SERVICES]);
      startedServices.push(...toStart);
    }
    log(`PASS compose up (generation 1): ${GENERATION_1_SERVICES.join(", ")}`);

    runAppApiMigrations();
    log("PASS App API migrations applied");

    bootstrapExpenseTaxNamespace();
    log('PASS Temporal namespace "expense-tax" bootstrapped (idempotent)');

    const initialStatus = dispatchRoutingCommand("status");
    assertGeneration1Routing(initialStatus);
    log("PASS dispatch routing confirmed at generation 1 (namespace default / queue expense-tax-ai-worker)");

    const runKey1 = randomUUID().slice(0, 8);
    const generation1 = createJobAndAwaitCompletion(runKey1);
    if (generation1.status !== "SUCCEEDED") {
      throw new Error(`generation 1 job did not succeed: ${JSON.stringify(generation1)}`);
    }
    log(`PASS generation 1 job ${generation1.jobId} SUCCEEDED (Python ai-worker callback)`);

    dispatchRoutingCommand("advance", "--from-generation", String(initialStatus.generation));
    log(`PASS dispatch-routing advance --from-generation ${initialStatus.generation}`);

    const workflowWorkerAlreadyRunning = runningServices().includes(
      WORKFLOW_WORKER_SERVICE,
    );
    runCompose(
      composeArgs(["up", "-d", "--wait", WORKFLOW_WORKER_SERVICE], {
        profiles: [WORKFLOW_WORKER_SERVICE],
      }),
    );
    if (!workflowWorkerAlreadyRunning) startedServices.push(WORKFLOW_WORKER_SERVICE);
    log("PASS compose up (workflow-worker, profile-gated)");

    const runKey2 = randomUUID().slice(0, 8);
    const generation2 = createJobAndAwaitCompletion(runKey2);
    if (generation2.status !== "SUCCEEDED") {
      throw new Error(`generation 2 job did not succeed: ${JSON.stringify(generation2)}`);
    }
    if (
      generation2.dispatchNamespace !== "expense-tax" ||
      generation2.taskQueue !== "expense-tax-processing"
    ) {
      throw new Error(
        `generation 2 job did not route to the TypeScript worker: ${JSON.stringify(generation2)}`,
      );
    }
    log(
      `PASS generation 2 job ${generation2.jobId} SUCCEEDED on namespace expense-tax / queue expense-tax-processing (TypeScript workflow-worker callback)`,
    );

    return { generation1, generation2 };
  } finally {
    if (startedServices.length > 0) {
      runCompose(["stop", ...startedServices]);
      runCompose(["rm", "-f", ...startedServices]);
      log(`teardown: stopped and removed ${startedServices.join(", ")}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runLocalWorkerSmoke();
    process.exitCode = 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "local worker smoke failed");
    process.exitCode = 1;
  }
}
