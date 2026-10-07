import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const productionRoot = path.join(repoRoot, "deploy", "production");
const composePath = path.join(productionRoot, "docker-compose.yml");
const sharedTemporalPath = path.join(repoRoot, "../infrastructure/temporal/docker-compose.yml");

function readProductionFile(name: string): string {
  return readFileSync(path.join(productionRoot, name), "utf8");
}

describe("Phase 1B production deployment boundaries", () => {
  it("defines exactly seven immutable GHCR application images and no legacy database", () => {
    const compose = YAML.parse(readProductionFile("docker-compose.yml")) as {
      services: Record<string, Record<string, unknown>>;
      networks: Record<string, { external?: boolean; name?: string }>;
    };
    const applicationServices = [
      "app-api",
      "foundry-service",
      "ai-worker",
      "workflow-worker",
      "capture-web",
      "office-web",
      "foundry-web",
    ];

    expect(Object.keys(compose.services)).toEqual(
      expect.arrayContaining([
        ...applicationServices,
        "app-api-migrate",
        "foundry-service-migrate",
      ]),
    );
    expect(compose.services.temporal).toBeUndefined();
    expect(compose.services.postgres).toBeUndefined();
    expect(compose.services["expense-service"]).toBeUndefined();
    expect(compose.services["temporal-ui"]).toBeUndefined();
    expect(compose.networks.database).toEqual({
      external: true,
      name: "postgres_default",
    });

    const ghcrImages = new Set(
      Object.values(compose.services)
        .map((service) => service.image)
        .filter((image): image is string => image?.startsWith("ghcr.io/")),
    );
    expect(ghcrImages).toEqual(
      new Set(
        applicationServices.map(
          (serviceName) =>
            `ghcr.io/thangtran3112/family-app/expense-tax-${serviceName}:\${IMAGE_TAG}`,
        ),
      ),
    );

    for (const serviceName of applicationServices) {
      const service = compose.services[serviceName];
      expect(service.image).toBe(
        `ghcr.io/thangtran3112/family-app/expense-tax-${serviceName}:\${IMAGE_TAG}`,
      );
      expect(service.build).toBeUndefined();
      expect(JSON.stringify(service)).not.toContain(":latest");
    }
  });

  it("keeps published services and shared Temporal on loopback", () => {
    const compose = YAML.parse(readProductionFile("docker-compose.yml")) as {
      services: Record<string, { ports?: string[] }>;
    };
    const shared = YAML.parse(readFileSync(sharedTemporalPath, "utf8")) as {
      services: Record<string, { ports?: string[] }>;
    };
    const expectedPorts: Record<string, string> = {
      "app-api": "127.0.0.1:8100:8100",
      "foundry-service": "127.0.0.1:8200:8200",
      "capture-web": "127.0.0.1:7301:7301",
      "office-web": "127.0.0.1:7302:7302",
      "foundry-web": "127.0.0.1:7303:7303",
    };

    for (const [serviceName, port] of Object.entries(expectedPorts)) {
      expect(compose.services[serviceName].ports).toEqual([port]);
    }
    expect(compose.services.temporal).toBeUndefined();
    expect(shared.services.temporal.ports).toEqual(["127.0.0.1:7233:7233"]);
    expect(shared.services["temporal-ui"].ports).toEqual(["127.0.0.1:8233:8080"]);
  });

  it("skips Temporal database creation after operator bootstrap", () => {
    const compose = YAML.parse(readFileSync(sharedTemporalPath, "utf8")) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };

    expect(compose.services.temporal.environment?.SKIP_DB_CREATE).toBe("true");
  });

  it("permits only explicit pre-identity fail-closed auth values", () => {
    const composeText = readProductionFile("docker-compose.yml");
    const compose = YAML.parse(composeText) as {
      services: Record<string, { networks?: string[] }>;
    };

    expect(composeText).toContain("APP_TENANT_TOKEN_ISSUER: ${APP_TENANT_TOKEN_ISSUER:?");
    expect(composeText).toContain("APP_SERVICE_TOKEN_ISSUER: ${APP_SERVICE_TOKEN_ISSUER:?");
    expect(composeText).toContain("not-configured.invalid");
    expect(composeText).toContain("nonfunctional");
    expect(composeText).not.toMatch(/POSTGRES_PASSWORD:/);

    for (const [serviceName, service] of Object.entries(compose.services)) {
      if (["app-api", "app-api-migrate", "foundry-service", "foundry-service-migrate"].includes(serviceName)) {
        expect(service.networks).toContain("database");
      } else {
        expect(service.networks).not.toContain("database");
      }
    }
  });

  it("declares Clerk provider explicitly and requires public frontend build keys", () => {
    const composeText = readProductionFile("docker-compose.yml");
    expect(composeText).toContain("AUTH_PROVIDER: ${AUTH_PROVIDER:?AUTH_PROVIDER is required}");

    for (const name of ["capture-web", "office-web", "foundry-web"]) {
      const dockerfile = readFileSync(
        path.join(repoRoot, "frontend", name, "Dockerfile"),
        "utf8",
      );
      expect(dockerfile).toContain("ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
      expect(dockerfile).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required");
      expect(dockerfile).toContain("ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
    }

    const workflow = readFileSync(
      path.join(repoRoot, "../.github/workflows/expense-tax-deploy.yml"),
      "utf8",
    );
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain(
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${{ vars.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}",
    );
    expect(workflow).not.toContain("CLERK_SECRET_KEY");
  });

  it("allows and validates webhook secret, then scopes it to app-api", () => {
    const deploy = readProductionFile("deploy.sh");
    const allowlist = deploy.match(/KNOWN_ENV_KEYS=\(([^)]*)\)/s)?.[1] ?? "";
    const authValidation = deploy.slice(
      deploy.indexOf("validate_auth_values()"),
      deploy.indexOf("compose()"),
    );
    const compose = YAML.parse(readProductionFile("docker-compose.yml")) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };

    expect(allowlist).toContain("CLERK_WEBHOOK_SIGNING_SECRET");
    expect(authValidation).toContain("CLERK_WEBHOOK_SIGNING_SECRET");
    expect(authValidation).toContain("^whsec_[^[:space:]]+$");
    expect(compose.services["app-api"].environment?.CLERK_WEBHOOK_SIGNING_SECRET).toBe(
      "${CLERK_WEBHOOK_SIGNING_SECRET:?CLERK_WEBHOOK_SIGNING_SECRET is required}",
    );

    for (const serviceName of ["foundry-service", "ai-worker", "workflow-worker", "capture-web", "office-web", "foundry-web"]) {
      expect(compose.services[serviceName].environment).not.toHaveProperty(
        "CLERK_WEBHOOK_SIGNING_SECRET",
      );
    }
  });

  it("uses only a test Clerk key for CI frontend builds", () => {
    const workflow = readFileSync(
      path.join(repoRoot, "../.github/workflows/expense-tax-ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: pk_test_ci");
    expect(workflow).not.toMatch(/NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:\s*pk_live_/);
    expect(workflow).not.toContain("vars.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  });

  it("parses production dotenv as strict data without shell evaluation", () => {
    const deploy = readProductionFile("deploy.sh");
    expect(deploy).toContain("while IFS= read -r line");
    expect(deploy).toContain("KNOWN_ENV_KEYS");
    expect(deploy).toContain("printf -v");
    expect(deploy).toContain("od -An -v -tu1");
    expect(deploy).not.toMatch(/(^|[^#])\bsource\s+/);
    expect(deploy).not.toMatch(/(^|[^#])\beval\s+/);
    expect(deploy).toContain("unsafe");
  });

  it("executes control-byte validation for valid and forbidden dotenv bytes", () => {
    const deploy = readProductionFile("deploy.sh");
    const awkProgram = deploy.match(/od -An -v -tu1 [^|]+\| awk '([^']+)'/)?.[1];
    expect(awkProgram).toBeDefined();
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "expense-tax-env-bytes-"));
    const validFile = path.join(tempRoot, "valid.env");
    const controlFile = path.join(tempRoot, "control.env");

    try {
      writeFileSync(validFile, "APP_DATABASE_URL=postgresql://app/db\nSTORAGE_URL_SIGNING_KEY=test\n");
      writeFileSync(controlFile, Buffer.from("APP_DATABASE_URL=postgresql://app/db\nSTORAGE_URL_SIGNING_KEY=bad\x01\n", "binary"));
      const runValidator = (file: string) =>
        execFileSync("sh", ["-c", `od -An -v -tu1 "$1" | awk '${awkProgram}'`, "validator", file], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });

      expect(() => runValidator(validFile)).not.toThrow();
      expect(() => runValidator(controlFile)).toThrow();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps IMAGE_TAG exclusively outside transferred secret data", () => {
    const deploy = readProductionFile("deploy.sh");
    const allowlist = deploy.match(/KNOWN_ENV_KEYS=\(([^)]*)\)/s)?.[1] ?? "";
    expect(allowlist).not.toContain("IMAGE_TAG");
    expect(deploy).toContain("unknown production env key: $key");
    expect(deploy).toContain("export IMAGE_TAG");
  });

  it("keeps PostgreSQL superuser bootstrap outside normal deploy", () => {
    const deploy = readProductionFile("deploy.sh");
    expect(deploy).not.toContain("POSTGRES_SUPERUSER_PASSWORD");
    expect(deploy).not.toContain("bootstrap-temporal-db.sh");
    expect(deploy).not.toContain("compose exec");
  });

  it("refuses deployment while the Expense-owned Temporal server still runs", () => {
    const deploy = readProductionFile("deploy.sh");
    const preflight = deploy.match(/require_shared_temporal\(\) \{[\s\S]*?^\}/mu)?.[0];
    expect(preflight).toBeDefined();
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "expense-tax-temporal-preflight-"));
    const fakeDocker = path.join(tempRoot, "docker");

    try {
      writeFileSync(fakeDocker, `#!/usr/bin/env bash
case "$*" in
  "network inspect family_shared"|"exec family-temporal temporal operator cluster health --address temporal:7233"|"exec family-temporal temporal operator namespace describe --address temporal:7233 --namespace expense-tax") exit 0 ;;
  "ps --quiet --filter label=com.docker.compose.project=expense-tax-production --filter label=com.docker.compose.service=temporal")
    if [[ "\${LEGACY_RUNNING:-0}" == "1" ]]; then printf '%s\\n' legacy-container; fi ;;
  *) exit 1 ;;
esac
`);
      chmodSync(fakeDocker, 0o700);
      const run = (legacyRunning: string) => execFileSync("bash", ["-c", `PROJECT_NAME=expense-tax-production\n${preflight}\ndie() { exit 1; }\nrequire_shared_temporal`], {
        env: { ...process.env, PATH: `${tempRoot}:${process.env.PATH}`, LEGACY_RUNNING: legacyRunning },
        stdio: ["ignore", "pipe", "pipe"],
      });

      expect(() => run("1")).toThrow();
      expect(() => run("0")).not.toThrow();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("validates the family-config env file and never persists production env", () => {
    const deploy = readProductionFile("deploy.sh");
    expect(deploy).toContain("-f");
    expect(deploy).toContain("! -L");
    expect(deploy).toContain("0600");
    expect(deploy).toContain('COMPOSE_ENV_FILE="${DEPLOY_ENV_FILE:-}"');
    expect(deploy).toContain("DEPLOY_ENV_FILE is required");
    expect(deploy).toContain('validate_env_file "$COMPOSE_ENV_FILE"');
    expect(deploy).not.toContain("/etc/expense-tax-management/production.env");
    expect(deploy).not.toContain("env_backup");
    expect(deploy).not.toContain("install -o root -g root -m 0600");
    const health = readProductionFile("health-check.sh");
    expect(health).toContain('COMPOSE_ENV_FILE="${PRODUCTION_ENV_FILE:?PRODUCTION_ENV_FILE is required}"');
    expect(health).not.toContain("/etc/expense-tax-management/production.env");
  });

  it("requires production values and mailbox token invariants", () => {
    const deploy = readProductionFile("deploy.sh");
    const fn = (name: string): string => {
      const match = deploy.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "mu"));
      if (!match) throw new Error(`could not extract function: ${name}`);
      return match[0];
    };
    const hex = "a".repeat(64);
    const base: Record<string, string> = {
      OPENAI_API_KEY: "sk-test",
      OPENROUTER_API_KEY: "or-test",
      APP_DATABASE_URL: "postgresql://app-runtime@postgres:5432/app",
      APP_MIGRATION_DATABASE_URL: "postgresql://app-migrator@postgres:5432/app",
      FOUNDRY_DATABASE_URL: "postgresql://foundry-runtime@postgres:5432/foundry",
      FOUNDRY_MIGRATION_DATABASE_URL: "postgresql://foundry-migrator@postgres:5432/foundry",
      CLERK_APP_MACHINE_SECRET_KEY: "ak_app",
      CLERK_FOUNDRY_MACHINE_SECRET_KEY: "ak_foundry",
      CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test",
      STORAGE_URL_SIGNING_KEY: hex,
      INBOUND_WEBHOOK_SIGNING_KEY: hex,
      INBOUND_ROUTING_TOKEN_SECRET: hex,
    };
    const mailbox: Record<string, string> = {
      MAILBOX_FEATURE_ENABLED: "true",
      CLERK_ISSUER_URL: "https://clerk.example",
      CLERK_JWKS_URL: "https://clerk.example/.well-known/jwks.json",
      CLERK_MAILBOX_SERVICE_AUDIENCE: "mch_mailbox",
      CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY: "ak_mailbox_app",
      CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY: "ak_mailbox_worker",
      CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY: "ak_mailbox_broker",
      CLERK_MAILBOX_APP_API_SUBJECT: "app-api-mailbox",
      CLERK_MAILBOX_WORKER_SUBJECT: "workflow-worker-mailbox",
      CLERK_MAILBOX_BROKER_SUBJECT: "mailbox-broker-app",
      MAILBOX_VAULT_KEYS: "k1:base64key",
      MAILBOX_VAULT_ACTIVE_KEY_ID: "k1",
      MAILBOX_BROKER_PUBLIC_BASE_URL: "https://expense-mailbox.example",
      MAILBOX_ALLOWED_REDIRECT_ORIGINS: "https://expense.example",
      GOOGLE_OAUTH_CLIENT_ID: "client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://expense-mailbox.example/oauth/google/callback",
      MAILBOX_BROKER_DATABASE_URL: "postgresql://vault-runtime@postgres:5432/mailbox_vault",
      MAILBOX_BROKER_MIGRATION_DATABASE_URL: "postgresql://vault-migrator@postgres:5432/mailbox_vault",
      MAILBOX_SERVICE_TOKEN_ISSUER: "https://clerk.example",
      MAILBOX_SERVICE_JWKS_URL: "https://clerk.example/.well-known/jwks.json",
      MAILBOX_SERVICE_TOKEN_AUDIENCE: "mch_mailbox",
    };
    const run = (env: Record<string, string>) =>
      spawnSync(
        "bash",
        ["-c", `set -Eeuo pipefail\n${fn("die")}\n${fn("validate_required_values")}\nvalidate_required_values`],
        { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" },
      );

    expect(run(base).status).toBe(0);
    expect(run({ ...base, OPENAI_API_KEY: "" }).stderr).toContain("OPENAI_API_KEY is required");
    expect(run({ ...base, STORAGE_URL_SIGNING_KEY: "not-hex" }).stderr).toContain(
      "STORAGE_URL_SIGNING_KEY must be 64 lowercase hex characters",
    );
    expect(run({ ...base, ...mailbox }).status).toBe(0);
    expect(
      run({ ...base, ...mailbox, MAILBOX_SERVICE_TOKEN_ISSUER: "https://other.example" }).stderr,
    ).toContain("MAILBOX_SERVICE_TOKEN_ISSUER must equal CLERK_ISSUER_URL");
    expect(run({ ...base, MAILBOX_FEATURE_ENABLED: "true" }).stderr).toContain(
      "is required when MAILBOX_FEATURE_ENABLED=true",
    );
  });

  it("deploys migrations before services and rolls back to recorded prior tag", () => {
    const deploy = readProductionFile("deploy.sh");
    expect(deploy.indexOf("compose run --rm app-api-migrate")).toBeGreaterThan(-1);
    expect(deploy.indexOf("compose run --rm foundry-service-migrate")).toBeGreaterThan(-1);
    expect(deploy.indexOf("compose run --rm app-api-migrate")).toBeLessThan(
      deploy.lastIndexOf('compose up -d "${APPLICATION_SERVICES[@]}"'),
    );
    expect(deploy).toContain("deployed-image-tag");
    expect(deploy).toContain("previous_tag");
    expect(deploy).toContain("IMAGE_TAG=\"$previous_tag\"");
    expect(deploy).toContain("compose up -d");
    expect(deploy).toContain("verify_running_images");
    expect(deploy).toContain("health-check.sh");
    expect(deploy).toContain("rollback_status");
    expect(deploy).toContain("rollback failed");
    expect(deploy).not.toMatch(/docker\s+.*(?:PASSWORD|SECRET|TOKEN)=/);
  });

  it("keeps Temporal database bootstrap as an explicit operator-only Task 8 step", () => {
    const workflow = readFileSync(
      path.join(repoRoot, "../.github/workflows/expense-tax-deploy.yml"),
      "utf8",
    );
    const agents = readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
    const plan = readFileSync(
      path.join(repoRoot, "plans/sub-plans/phase-1b-production-cicd-implementation.md"),
      "utf8",
    );

    expect(workflow).not.toContain("bootstrap-temporal-db.sh");
    expect(agents).toContain("operator-only Task 8");
    expect(plan).toContain("Task 8 remains an explicit operator-only step");
  });

  it("transfers and installs docker-compose.mailbox.yml beside docker-compose.yml", () => {
    const workflow = readFileSync(
      path.join(repoRoot, "../.github/workflows/expense-tax-deploy.yml"),
      "utf8",
    );

    expect(workflow).toContain(
      "expense-tax-management/deploy/production/docker-compose.mailbox.yml",
    );
    expect(workflow).toContain(
      "sudo install -o root -g root -m 0644 /tmp/expense-tax-deploy/docker-compose.mailbox.yml /opt/expense-tax-management/app/docker-compose.mailbox.yml",
    );

    // Same staging directory that already gets wholesale-removed by "Clean
    // remote staging" -- the new file needs no separate cleanup line.
    const remoteCleanupIndex = workflow.indexOf("rm -rf /dev/shm/expense-tax-docker-config-* /tmp/expense-tax-deploy");
    expect(remoteCleanupIndex).toBeGreaterThan(-1);
  });

  it("loads production env on the VPS through family config, with no GCP credentials in CI", () => {
    const workflow = readFileSync(
      path.join(repoRoot, "../.github/workflows/expense-tax-deploy.yml"),
      "utf8",
    );

    expect(workflow).not.toContain("google-github-actions/auth");
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toContain("gcloud secrets");
    expect(workflow).not.toContain("expense-tax-production.env");
    expect(workflow).toContain("common/config/family_config.py");
    expect(workflow).toContain(
      "sudo install -o root -g root -m 0755 /tmp/expense-tax-deploy/family_config.py /opt/expense-tax-management/app/family_config.py",
    );
    expect(workflow).toContain(
      "FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json /opt/expense-tax-management/app/family_config.py run expense-tax-management/production --env-file-var DEPLOY_ENV_FILE -- /opt/expense-tax-management/app/deploy.sh",
    );
  });

  it("pins uv builder and requires frozen lockfile sync", () => {
    const dockerfile = readFileSync(
      path.join(repoRoot, "services/ai-worker/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      "ghcr.io/astral-sh/uv@sha256:73d2665b478d8fa2de1cf105c6841f8e9cb6b09e568fc7700440c09f8fcd7ac4",
    );
    expect(dockerfile).toContain("RUN uv sync --frozen --no-dev");
    expect(dockerfile).not.toContain("uv:latest");
    expect(dockerfile).not.toContain("|| uv sync");
  });

  it("bootstraps only the GCP project and pool: no deploy identity or repository key files", () => {
    const bootstrap = readFileSync(
      path.join(repoRoot, "infrastructure/gcp/expense-tax/bootstrap.sh"),
      "utf8",
    );
    const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    expect(bootstrap).not.toContain("expense-tax-github-deploy");
    expect(bootstrap).not.toContain("secrets create");
    expect(bootstrap).not.toContain(".keys/");
    expect(gitignore).toContain(".keys/*");
  });

  it("bootstraps Temporal credentials through stdin and fails on SQL errors", () => {
    const bootstrap = readProductionFile("bootstrap-temporal-db.sh");
    expect(bootstrap).toContain('POSTGRES_SUPERUSER_PASSWORD');
    expect(bootstrap).toContain('TEMPORAL_DB_PASSWORD');
    expect(bootstrap).toContain("docker exec -i");
    expect(bootstrap).toContain("ON_ERROR_STOP=1");
    expect(bootstrap).toContain("CREATE DATABASE temporal");
    expect(bootstrap).toContain("CREATE DATABASE temporal_visibility");
    expect(bootstrap).toContain("NOSUPERUSER");
    expect(bootstrap).toContain("NOCREATEDB");
    expect(bootstrap).toContain("NOCREATEROLE");
    expect(bootstrap).toContain("NOREPLICATION");
    expect(bootstrap).toContain("NOBYPASSRLS");
    expect(bootstrap).toContain("rolsuper = false");
    expect(bootstrap).toContain("datdba");
    expect(bootstrap).not.toMatch(/docker exec[^\n]*(PASSWORD|SECRET|TOKEN)=/);
  });

  it("bootstraps the mailbox vault's migrator role with NOCREATEDB, not CREATEDB (Task 5 fix round 1)", () => {
    const bootstrap = readProductionFile("bootstrap-mailbox-vault-db.sh");
    expect(bootstrap).toContain("POSTGRES_SUPERUSER_PASSWORD");
    expect(bootstrap).toContain("MAILBOX_VAULT_MIGRATOR_DB_PASSWORD");
    expect(bootstrap).toContain("MAILBOX_VAULT_RUNTIME_DB_PASSWORD");
    expect(bootstrap).toContain("docker exec -i");
    expect(bootstrap).toContain("ON_ERROR_STOP=1");
    expect(bootstrap).toContain("CREATE DATABASE mailbox_vault");
    expect(bootstrap).not.toMatch(/docker exec[^\n]*(PASSWORD|SECRET|TOKEN)=/);

    // The migrator role must never be able to create databases -- it owns
    // exactly one (mailbox_vault, granted via OWNER at CREATE DATABASE
    // time), never more. Match the exact CREATE/ALTER ROLE lines so a bare
    // substring check can't be fooled by NOCREATEDB itself containing the
    // substring "CREATEDB".
    expect(bootstrap).toContain(
      "CREATE ROLE mailbox_vault_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    expect(bootstrap).toContain(
      "ALTER ROLE mailbox_vault_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS",
    );
    expect(bootstrap).not.toMatch(/ROLE mailbox_vault_migrator LOGIN NOSUPERUSER CREATEDB\b/);

    // Each role's self-check must verify rolcreatedb = false exactly once
    // -- a duplicated condition in one role's check is not a substitute
    // for a missing check on the other role's.
    const runtimeCheck = bootstrap.match(/WHERE rolname = 'mailbox_vault_runtime'\s+AND rolsuper = false([\s\S]*?)\) THEN/);
    const migratorCheck = bootstrap.match(/WHERE rolname = 'mailbox_vault_migrator'\s+AND rolsuper = false([\s\S]*?)\) THEN/);
    expect(runtimeCheck?.[1].match(/rolcreatedb = false/g)).toHaveLength(1);
    expect(migratorCheck?.[1].match(/rolcreatedb = false/g)).toHaveLength(1);
  });

  it("health checks only loopback endpoints and scripts are strict shell", () => {
    const health = readProductionFile("health-check.sh");
    expect(health).toContain("127.0.0.1:8100/health/live");
    expect(health).toContain("127.0.0.1:8200/health/live");
    expect(health).toContain("127.0.0.1:7301/capture");
    expect(health).toContain("127.0.0.1:7302/dashboard");
    expect(health).toContain("127.0.0.1:7303/providers");
    expect(health).toContain("docker exec family-temporal temporal operator cluster health");
    expect(health).toContain("docker exec family-temporal temporal operator namespace describe");
    expect(health).toContain("temporal operator cluster health");
    expect(health).toContain("ai-worker");
    expect(health).toContain("--status running --services");
    for (const name of ["deploy.sh", "health-check.sh", "bootstrap-temporal-db.sh"]) {
      expect(readProductionFile(name)).toMatch(/^set -Eeuo pipefail/m);
      expect(statSync(path.join(productionRoot, name)).mode & 0o777).toBe(0o755);
    }
    expect(composePath).toContain("deploy/production/docker-compose.yml");
  });

  it("keeps ai-worker and workflow-worker liveness explicit and rollback-gated", () => {
    const compose = YAML.parse(readProductionFile("docker-compose.yml")) as {
      services: Record<string, { healthcheck?: { test?: string[] } }>;
    };
    for (const serviceName of ["ai-worker", "workflow-worker"]) {
      const workerHealthcheck = compose.services[serviceName].healthcheck;
      expect(workerHealthcheck?.test?.join(" ") ?? "").toContain("kill -0 1");
    }

    const deploy = readProductionFile("deploy.sh");
    expect(deploy).toContain("health-check.sh");
    expect(deploy).toContain("rollback failed");
  });

  it("renders normal production Compose config with no backup variables set", () => {
    // Backup (vps-backup-and-restore.md) is shared host infrastructure, not
    // an Expense application service -- it must never require its own env
    // vars just to parse/deploy the normal application stack. Compose
    // interpolates ${VAR:?} for every service before any --profile
    // filtering, so a required backup var anywhere in this file would break
    // every ordinary `docker compose up`/`config`/deploy, even when backup
    // itself was never installed on the host.
    const composeText = readProductionFile("docker-compose.yml");
    const requiredKeys = [
      ...new Set(
        [...composeText.matchAll(/\$\{([A-Z][A-Z0-9_]+):\?/gu)].map(([, key]) => key),
      ),
    ];
    expect(requiredKeys.some((key) => key.startsWith("BACKUP_") || key === "AGE_RECIPIENT")).toBe(
      false,
    );

    const dir = mkdtempSync(path.join(os.tmpdir(), "expense-tax-compose-no-backup-"));
    const envFile = path.join(dir, "normal.env");
    try {
      writeFileSync(envFile, requiredKeys.map((key) => `${key}=dummy-value`).join("\n"));
      execFileSync(
        "docker",
        [
          "compose",
          "--project-name",
          "fbk-test-compose-no-backup",
          "--env-file",
          envFile,
          "-f",
          composePath,
          "config",
          "--quiet",
        ],
        { stdio: "pipe" },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deploys the TypeScript workflow worker idle on expense-tax/expense-tax-processing, never on the database network", () => {
    const compose = YAML.parse(readProductionFile("docker-compose.yml")) as {
      services: Record<
        string,
        {
          image?: string;
          environment?: Record<string, string>;
          networks?: string[];
          deploy?: { resources?: { limits?: { cpus?: string; memory?: string } } };
          depends_on?: Record<string, { condition?: string }>;
          healthcheck?: { test?: string[] };
        }
      >;
    };
    const worker = compose.services["workflow-worker"];
    expect(worker).toBeDefined();
    expect(worker.image).toBe(
      "ghcr.io/thangtran3112/family-app/expense-tax-workflow-worker:${IMAGE_TAG}",
    );
    expect(worker.deploy?.resources?.limits).toEqual({ cpus: "0.5", memory: "512M" });

    // Idle by construction: generation 1 (Task 7 Stage A seed) routes new
    // jobs to namespace default / queue expense-tax-ai-worker (ai-worker).
    // This worker polls expense-tax / expense-tax-processing and receives
    // no work until an operator runs `advance`.
    expect(worker.environment?.TEMPORAL_HOST).toBe("temporal:7233");
    expect(worker.environment?.TEMPORAL_NAMESPACE).toBe("expense-tax");
    expect(worker.environment?.AI_WORKER_TASK_QUEUE).toBe("expense-tax-processing");
    expect(worker.environment?.APP_API_BASE_URL).toBe("http://app-api:8100");
    expect(worker.environment?.FOUNDRY_BASE_URL).toBe("http://foundry-service:8200");

    for (const key of [
      "CLERK_ISSUER_URL",
      "CLERK_JWKS_URL",
      "CLERK_APP_SERVICE_AUDIENCE",
      "CLERK_APP_MACHINE_SECRET_KEY",
      "CLERK_APP_SERVICE_SUBJECT",
      "CLERK_FOUNDRY_SERVICE_AUDIENCE",
      "CLERK_FOUNDRY_MACHINE_SECRET_KEY",
      "CLERK_FOUNDRY_SERVICE_SUBJECT",
    ]) {
      expect(worker.environment?.[key]).toBe(`\${${key}:?${key} is required}`);
    }

    expect(worker.networks).toEqual(["default", "shared"]);
    expect(worker.depends_on?.["app-api"]?.condition).toBe("service_healthy");
    expect(worker.depends_on?.["foundry-service"]?.condition).toBe("service_healthy");

    // ai-worker (namespace default / queue expense-tax-ai-worker) must stay
    // exactly as Stage A left it -- Stage B never changes the Python side.
    const pythonWorker = compose.services["ai-worker"];
    expect(pythonWorker.environment?.TEMPORAL_NAMESPACE).toBe("default");
    expect(pythonWorker.environment?.AI_WORKER_TASK_QUEUE).toBe("expense-tax-ai-worker");
  });

  it("includes workflow-worker in deploy.sh's image-tag verification and rollback set", () => {
    const deploy = readProductionFile("deploy.sh");
    const servicesMatch = deploy.match(/APPLICATION_SERVICES=\(([^)]*)\)/);
    expect(servicesMatch).not.toBeNull();
    const services = (servicesMatch?.[1] ?? "").trim().split(/\s+/);
    expect(services).toContain("workflow-worker");
  });

  it("creates and chowns every app-api volume destination before USER app (prevents root-owned named volumes)", () => {
    const compose = YAML.parse(readProductionFile("docker-compose.yml")) as {
      services: Record<string, { volumes?: string[] }>;
    };
    const dockerfile = readFileSync(
      path.join(repoRoot, "services/app-api/Dockerfile"),
      "utf8",
    );
    const userAppIndex = dockerfile.lastIndexOf("\nUSER app");
    expect(userAppIndex).toBeGreaterThan(-1);
    const beforeUserApp = dockerfile.slice(0, userAppIndex);

    const volumeDestinations = (compose.services["app-api"].volumes ?? []).map(
      (mount) => mount.split(":")[1],
    );
    expect(volumeDestinations.length).toBeGreaterThan(0);
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const destination of volumeDestinations) {
      const escaped = escape(destination);
      const mkdirLine = new RegExp(`mkdir -p[^\\n]*${escaped}(\\s|$)`, "m");
      const chownLine = new RegExp(`chown app:app[^\\n]*${escaped}(\\s|$)`, "m");
      expect(beforeUserApp).toMatch(mkdirLine);
      expect(beforeUserApp).toMatch(chownLine);
    }
  });

  it("requires both workers running in health-check.sh via a configurable, both-by-default list", () => {
    const health = readProductionFile("health-check.sh");
    expect(health).toContain("HEALTH_CHECK_REQUIRED_WORKERS");
    expect(health).toMatch(/HEALTH_CHECK_REQUIRED_WORKERS:-ai-worker workflow-worker/);
    expect(health).toMatch(/\$1 == worker \{ found=1 \}/);
    expect(health).not.toContain('$1 == "ai-worker"');
    expect(health).not.toContain('$1 == "workflow-worker"');
  });
});

describe("Task 7 Stage B fix round 1: rollback treats workflow-worker as the only optional service", () => {
  const deployScript = readProductionFile("deploy.sh");
  const composeFile = path.join(productionRoot, "docker-compose.yml");

  function extractFunction(source: string, name: string): string {
    const match = source.match(new RegExp(`${name}\\(\\) \\{[\\s\\S]*?^\\}`, "mu"));
    if (!match) throw new Error(`could not extract function: ${name}`);
    return match[0];
  }

  function extractArray(source: string, name: string): string {
    const match = source.match(new RegExp(`^${name}=\\([^)]*\\)`, "mu"));
    if (!match) throw new Error(`could not extract array: ${name}`);
    return match[0];
  }

  /**
   * Runs the REAL rollback() (plus the real helper functions it calls and
   * the real health-check.sh it shells out to) against a fake `docker` and
   * `curl` on PATH, mirroring the existing require_shared_temporal
   * extraction-and-eval technique above. previousTag selects which fixture
   * scenario the fake docker simulates (see FAKE_DOCKER env below).
   */
  function runRollback(options: {
    readonly workflowWorkerImageExists: boolean;
    readonly workflowWorkerLocalImageExists?: boolean;
    readonly workflowWorkerManifestSucceedOnAttempt?: number;
    readonly pullShouldFailFor?: string;
  }): { readonly status: number; readonly stderr: string; readonly stateDir: string } {
    const composeFn = extractFunction(deployScript, "compose");
    const workflowWorkerImageExistsFn = extractFunction(deployScript, "workflow_worker_image_exists");
    const verifyRunningImagesFn = extractFunction(deployScript, "verify_running_images");
    const rollbackFn = extractFunction(deployScript, "rollback");
    const applicationServices = extractArray(deployScript, "APPLICATION_SERVICES");

    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "expense-tax-rollback-"));
    const stateDir = path.join(tempRoot, "state");
    const fakeBin = path.join(tempRoot, "bin");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });

    const fakeDocker = path.join(fakeBin, "docker");
    writeFileSync(
      fakeDocker,
      `#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="\${FAKE_DOCKER_STATE_DIR:?}"
case "\$1" in
  image)
    if [[ "\$2" == "inspect" ]]; then
      case "\$3" in
        *expense-tax-workflow-worker:*)
          [[ "\${WORKFLOW_WORKER_LOCAL_IMAGE_EXISTS:-0}" == "1" ]] && exit 0 || exit 1 ;;
        *) exit 0 ;;
      esac
    fi
    exit 0
    ;;
  manifest)
    case "\$3" in
      *expense-tax-workflow-worker:*)
        counter_file="\$STATE_DIR/manifest-attempts"
        count=0
        [[ -f "\$counter_file" ]] && count=\$(cat "\$counter_file")
        count=\$((count + 1))
        printf '%s' "\$count" > "\$counter_file"
        succeed_on="\${WORKFLOW_WORKER_MANIFEST_SUCCEED_ON_ATTEMPT:-1}"
        if [[ "\${WORKFLOW_WORKER_IMAGE_EXISTS:-1}" == "1" ]] && ((count >= succeed_on)); then
          exit 0
        fi
        exit 1
        ;;
      *) exit 0 ;;
    esac
    ;;
  compose)
    shift
    while [[ "\$1" != "pull" && "\$1" != "up" && "\$1" != "ps" && "\$1" != "rm" ]]; do shift; done
    sub="\$1"; shift
    case "\$sub" in
      pull)
        for svc in "\$@"; do
          case ",\${PULL_SHOULD_FAIL_FOR:-}," in
            *",\$svc,"*) printf 'fake pull failed for %s\\n' "\$svc" >&2; exit 1 ;;
          esac
        done
        printf '%s\\n' "\$@" >> "\$STATE_DIR/pull-args"
        exit 0 ;;
      up)
        for arg in "\$@"; do
          [[ "\$arg" == "-d" ]] && continue
          printf '%s\\n' "\$arg" >> "\$STATE_DIR/up-args"
          printf '%s\\n' "\$arg" >> "\$STATE_DIR/running-services"
        done
        exit 0 ;;
      ps)
        if [[ "\${1:-}" == "-q" ]]; then
          svc="\$2"
          grep -qx "\$svc" "\$STATE_DIR/running-services" 2>/dev/null && printf 'fake-container-%s\\n' "\$svc"
          exit 0
        fi
        sort -u "\$STATE_DIR/running-services" 2>/dev/null || true
        exit 0 ;;
      rm)
        svc="\${*: -1}"
        if [[ -f "\$STATE_DIR/running-services" ]]; then
          grep -vx "\$svc" "\$STATE_DIR/running-services" > "\$STATE_DIR/running-services.tmp" 2>/dev/null || true
          mv "\$STATE_DIR/running-services.tmp" "\$STATE_DIR/running-services" 2>/dev/null || true
        fi
        printf '%s\\n' "\$svc" >> "\$STATE_DIR/rm-args"
        exit 0 ;;
    esac
    ;;
  inspect)
    container_id="\${*: -1}"
    svc="\${container_id#fake-container-}"
    printf 'ghcr.io/thangtran3112/family-app/expense-tax-%s:%s\\n' "\$svc" "\${IMAGE_TAG:-}"
    exit 0 ;;
  exec) exit 0 ;;
  *) exit 0 ;;
esac
`,
    );
    chmodSync(fakeDocker, 0o700);
    const fakeCurl = path.join(fakeBin, "curl");
    writeFileSync(fakeCurl, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeCurl, 0o700);

    const script = `
set -Eeuo pipefail
PROJECT_NAME=expense-tax-production
SCRIPT_DIR="${productionRoot}"
COMPOSE_FILE="${composeFile}"
COMPOSE_ENV_FILE=/dev/null
INCOMING_ENV_FILE=/dev/null
TARGET_ENV_FILE=/dev/null
had_target=0
env_backup=/dev/null
previous_tag="0000000000000000000000000000000000000000"
${applicationServices}
${composeFn}
${workflowWorkerImageExistsFn}
${verifyRunningImagesFn}
${rollbackFn}
rollback 1
`;
    const env: Record<string, string> = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_DOCKER_STATE_DIR: stateDir,
      WORKFLOW_WORKER_IMAGE_EXISTS: options.workflowWorkerImageExists ? "1" : "0",
      WORKFLOW_WORKER_LOCAL_IMAGE_EXISTS: options.workflowWorkerLocalImageExists ? "1" : "0",
      WORKFLOW_WORKER_PROBE_ATTEMPTS: "3",
      WORKFLOW_WORKER_PROBE_DELAY_SECONDS: "0",
      HEALTH_CHECK_ATTEMPTS: "1",
      HEALTH_CHECK_DELAY_SECONDS: "0",
    };
    if (options.workflowWorkerManifestSucceedOnAttempt !== undefined) {
      env.WORKFLOW_WORKER_MANIFEST_SUCCEED_ON_ATTEMPT = String(
        options.workflowWorkerManifestSucceedOnAttempt,
      );
    }
    if (options.pullShouldFailFor) env.PULL_SHOULD_FAIL_FOR = options.pullShouldFailFor;

    const result = spawnSync("bash", ["-c", script], {
      env,
      encoding: "utf8",
    });
    return { status: result.status ?? 1, stderr: result.stderr ?? "", stateDir };
  }

  function recorded(stateDir: string, file: string): string[] {
    try {
      return readFileSync(path.join(stateDir, file), "utf8")
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  it("rolls back all seven services when the previous tag's workflow-worker image exists", () => {
    const { stderr, stateDir } = runRollback({ workflowWorkerImageExists: true });
    expect(recorded(stateDir, "pull-args").sort()).toEqual(
      [...extractArray(deployScript, "APPLICATION_SERVICES").matchAll(/[a-z-]+/g)]
        .map((m) => m[0])
        .filter((name) => name !== "APPLICATION_SERVICES")
        .sort(),
    );
    expect(recorded(stateDir, "rm-args")).toEqual([]);
    expect(stderr).toContain(`rollback verified at prior image tag`);
    expect(stderr).not.toContain("rollback failed");
  });

  it("rolls back six services and stops workflow-worker when the previous tag predates its image", () => {
    const { stderr, stateDir } = runRollback({ workflowWorkerImageExists: false });
    const pulled = recorded(stateDir, "pull-args");
    expect(pulled).not.toContain("workflow-worker");
    expect(pulled.sort()).toEqual(
      [...extractArray(deployScript, "APPLICATION_SERVICES").matchAll(/[a-z-]+/g)]
        .map((m) => m[0])
        .filter((name) => name !== "APPLICATION_SERVICES" && name !== "workflow-worker")
        .sort(),
    );
    expect(recorded(stateDir, "rm-args")).toContain("workflow-worker");
    expect(stderr).toContain("rollback verified at prior image tag");
    expect(stderr).not.toContain("rollback failed");
  });

  it("keeps workflow-worker when its image exists locally even if the registry probe fails", () => {
    const { stderr, stateDir } = runRollback({
      workflowWorkerImageExists: false,
      workflowWorkerLocalImageExists: true,
    });
    expect(recorded(stateDir, "pull-args")).toContain("workflow-worker");
    expect(recorded(stateDir, "rm-args")).not.toContain("workflow-worker");
    expect(stderr).toContain("rollback verified at prior image tag");
    expect(stderr).not.toContain("rollback failed");
  });

  it("keeps workflow-worker after a transient registry probe failure that later succeeds", () => {
    const { stderr, stateDir } = runRollback({
      workflowWorkerImageExists: true,
      workflowWorkerLocalImageExists: false,
      workflowWorkerManifestSucceedOnAttempt: 2,
    });
    expect(recorded(stateDir, "pull-args")).toContain("workflow-worker");
    expect(recorded(stateDir, "rm-args")).not.toContain("workflow-worker");
    expect(readFileSync(path.join(stateDir, "manifest-attempts"), "utf8")).toBe("2");
    expect(stderr).toContain("rollback verified at prior image tag");
    expect(stderr).not.toContain("rollback failed");
  });

  it("fails rollback when a mandatory service's previous-tag image is missing", () => {
    const { stderr } = runRollback({ workflowWorkerImageExists: true, pullShouldFailFor: "app-api" });
    expect(stderr).toContain("rollback failed after original deployment failure");
  });
});
