import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionCompose = path.join(repoRoot, "deploy", "production", "docker-compose.yml");

const inertComposeEnv = {
  ...process.env,
  IMAGE_TAG: "0".repeat(64),
  AUTH_PROVIDER: "clerk",
  APP_TENANT_TOKEN_ISSUER: "https://identity.not-configured.invalid",
  APP_TENANT_TOKEN_AUDIENCE: "phase-1b-inert-tenant",
  APP_TENANT_JWKS_URL: "https://identity.not-configured.invalid/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: "https://services.not-configured.invalid",
  APP_SERVICE_TOKEN_AUDIENCE: "phase-1b-inert-service",
  APP_SERVICE_JWKS_URL: "https://services.not-configured.invalid/.well-known/jwks.json",
  APP_DATABASE_URL: "postgresql://inert:inert@postgres:5432/expense_tax_db",
  APP_MIGRATION_DATABASE_URL: "postgresql://inert:inert@postgres:5432/expense_tax_db",
  FOUNDRY_PLATFORM_TOKEN_ISSUER: "https://identity.not-configured.invalid",
  FOUNDRY_PLATFORM_TOKEN_AUDIENCE: "phase-1b-inert-platform",
  FOUNDRY_PLATFORM_JWKS_URL: "https://identity.not-configured.invalid/.well-known/jwks.json",
  FOUNDRY_SERVICE_TOKEN_ISSUER: "https://services.not-configured.invalid",
  FOUNDRY_SERVICE_TOKEN_AUDIENCE: "phase-1b-inert-service",
  FOUNDRY_SERVICE_JWKS_URL: "https://services.not-configured.invalid/.well-known/jwks.json",
  CLERK_ISSUER_URL: "https://identity.not-configured.invalid",
  CLERK_JWKS_URL: "https://identity.not-configured.invalid/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "phase-1b-inert-tenant",
  CLERK_PLATFORM_AUDIENCE: "phase-1b-inert-platform",
  CLERK_APP_SERVICE_AUDIENCE: "mch_3J9fsniGga4hUqUf65ZQqzeGX2b",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "mch_3J9g3CNoKL9q6KfbRy5zq1Rh2zT",
  CLERK_APP_SERVICE_SUBJECT: "mch_3J9Xg9Hu84Rn2oeqj7EMrv0ax19",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "mch_3J9gHBtDcxOE3fWE39Ay9uF7hFv",
  FOUNDRY_DATABASE_URL: "postgresql://inert:inert@postgres:5432/expense_tax_db",
  FOUNDRY_MIGRATION_DATABASE_URL: "postgresql://inert:inert@postgres:5432/expense_tax_db",
  STORAGE_BACKEND: "local",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  STORAGE_URL_SIGNING_KEY: "0".repeat(64),
  INBOUND_EMAIL_BASE_ADDRESS: "receipts@inbound.expense-tax.local",
  INBOUND_WEBHOOK_SIGNING_KEY: "1".repeat(64),
  INBOUND_ROUTING_TOKEN_SECRET: "2".repeat(64),
  CLERK_APP_MACHINE_SECRET_KEY: "ak_phase_1b_inert_app_machine_secret",
  CLERK_FOUNDRY_MACHINE_SECRET_KEY: "ak_phase_1b_inert_foundry_machine_secret",
  CLERK_WEBHOOK_SIGNING_SECRET: "whsec_phase_1b_inert_webhook_secret",
};

function run(label, command, args, env = process.env) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    console.error(`FAIL ${label}`);
    process.exit(result.status ?? 1);
  }
  console.log(`PASS ${label}`);
}

run("Production secret bundle tests", "pnpm", [
  "exec",
  "vitest",
  "run",
  "scripts/lib/production-secret-bundle.test.mjs",
]);
run("GCP infrastructure static policy", "node", [
  "scripts/check-phase-1b-infrastructure.mjs",
]);
run("Cloudflare infrastructure static policy", "node", [
  "scripts/check-cloudflare-infrastructure.mjs",
]);
run("GCP infrastructure mocked behavior", "pnpm", [
  "exec",
  "vitest",
  "run",
  "scripts/check-phase-1b-infrastructure.test.mjs",
]);
run("Production deployment boundaries", "pnpm", [
  "exec",
  "vitest",
  "run",
  "test/integration/production-deployment-boundaries.test.ts",
]);
run("Deployment workflow static policy", "node", [
  "scripts/check-phase-1b-workflow.mjs",
]);
run("Phase 1A source gates", "pnpm", ["verify:phase-1a"]);
run(
  "Production Compose config with inert values",
  "docker",
  ["compose", "-f", productionCompose, "config", "--quiet"],
  inertComposeEnv,
);

console.log("\nPASS Phase 1B aggregate verification: zero required checks skipped");
