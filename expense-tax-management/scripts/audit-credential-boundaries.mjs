import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const envFile = process.env.EXPENSE_TAX_ENV_FILE ?? path.join(repoRoot, ".env.example");

let failures = 0;

function report(pathName, keyName, passed) {
  console.log(`${passed ? "PASS" : "FAIL"} ${pathName} ${keyName}`);
  if (!passed) failures += 1;
}

function databaseKeys(environment) {
  return Object.keys(environment ?? {}).filter(
    (key) =>
      key === "DATABASE_URL" ||
      key.endsWith("DATABASE_URL") ||
      key.includes("POSTGRES") ||
      key.includes("MIGRATION"),
  );
}

function serviceKeys(config, serviceName) {
  return databaseKeys(config.services?.[serviceName]?.environment);
}

let config;
try {
  config = JSON.parse(
    execFileSync(composeScript, ["config", "--format", "json"], {
      cwd: repoRoot,
      env: { ...process.env, EXPENSE_TAX_ENV_FILE: envFile },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  report("scripts/compose.sh", "normalized-config", true);
} catch {
  report("scripts/compose.sh", "normalized-config", false);
  process.exitCode = 1;
  process.exit();
}

const expectedServiceKeys = {
  "app-api": ["APP_DATABASE_URL"],
  "app-api-migrate": ["APP_MIGRATION_DATABASE_URL"],
  "foundry-service": ["FOUNDRY_DATABASE_URL"],
  "foundry-service-migrate": ["FOUNDRY_MIGRATION_DATABASE_URL"],
  "expense-service": ["DATABASE_URL"],
};

for (const [serviceName, expectedKeys] of Object.entries(expectedServiceKeys)) {
  const actualKeys = serviceKeys(config, serviceName);
  report(
    `docker-compose.yml services.${serviceName}`,
    "database-key-set",
    actualKeys.length === expectedKeys.length &&
      expectedKeys.every((key) => actualKeys.includes(key)),
  );
}

for (const serviceName of [
  "app-api",
  "app-api-migrate",
  "foundry-service",
  "foundry-service-migrate",
]) {
  const actualKeys = serviceKeys(config, serviceName);
  report(
    `docker-compose.yml services.${serviceName}`,
    "no-superuser-or-other-service-database-key",
    !actualKeys.some(
      (key) =>
        key.includes("POSTGRES") ||
        (key.endsWith("MIGRATION_DATABASE_URL") &&
          key !==
            expectedServiceKeys[serviceName][0]),
    ),
  );
}

const legacyContext = config.services?.["expense-service"]?.build?.context ?? "";
report(
  "docker-compose.yml services.expense-service.build.context",
  "project-relative-legacy-path",
  legacyContext.endsWith(path.join("expense-tax-management", "expense-service")),
);

for (const [serviceName, port] of [
  ["app-api", 8100],
  ["foundry-service", 8200],
]) {
  const portConfig = config.services?.[serviceName]?.ports?.find(
    (entry) => entry.target === port,
  );
  report(
    `docker-compose.yml services.${serviceName}.ports`,
    `loopback-${port}`,
    portConfig?.host_ip === "127.0.0.1" && portConfig?.published === String(port),
  );
}

const envKeys = new Set(
  readFileSync(path.join(repoRoot, ".env.example"), "utf8")
    .split("\n")
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
    .filter(Boolean),
);
for (const key of [
  "APP_MIGRATOR_DB_PASSWORD",
  "APP_RUNTIME_DB_PASSWORD",
  "FOUNDRY_MIGRATOR_DB_PASSWORD",
  "FOUNDRY_RUNTIME_DB_PASSWORD",
  "APP_DATABASE_URL",
  "APP_MIGRATION_DATABASE_URL",
  "FOUNDRY_DATABASE_URL",
  "FOUNDRY_MIGRATION_DATABASE_URL",
]) {
  report(".env.example", key, envKeys.has(key));
}

const nginxConfig = readFileSync(
  path.resolve(repoRoot, "../infrastructure/nginx/nginx.conf"),
  "utf8",
);
report(
  "../infrastructure/nginx/nginx.conf",
  "no-phase-0i-public-route",
  !/app-api|foundry-service/.test(nginxConfig),
);

process.exitCode = failures === 0 ? 0 : 1;
