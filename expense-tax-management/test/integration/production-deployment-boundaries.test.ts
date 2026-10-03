import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
  it("defines exactly six immutable GHCR application images and no legacy database", () => {
    const compose = YAML.parse(readProductionFile("docker-compose.yml")) as {
      services: Record<string, Record<string, unknown>>;
      networks: Record<string, { external?: boolean; name?: string }>;
    };
    const applicationServices = [
      "app-api",
      "foundry-service",
      "ai-worker",
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

    for (const serviceName of ["foundry-service", "ai-worker", "capture-web", "office-web", "foundry-web"]) {
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

  it("requires regular root-owned 0600 dotenv files before and after install", () => {
    const deploy = readProductionFile("deploy.sh");
    expect(deploy).toContain("-f");
    expect(deploy).toContain("! -L");
    expect(deploy).toContain("0600");
    expect(deploy).toContain("validate_env_file");
    expect(deploy).toContain("install -o root -g root -m 0600");
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

  it("uses gitignored .keys output by default for GCP bootstrap metadata", () => {
    const bootstrap = readFileSync(
      path.join(repoRoot, "infrastructure/gcp/expense-tax/bootstrap.sh"),
      "utf8",
    );
    const gitignore = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
    expect(bootstrap).toContain(".keys/gcp/expense-tax-bootstrap-outputs.json");
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

  it("keeps ai-worker liveness explicit and rollback-gated", () => {
    const compose = YAML.parse(readProductionFile("docker-compose.yml")) as {
      services: Record<string, { healthcheck?: { test?: string[] } }>;
    };
    const workerHealthcheck = compose.services["ai-worker"].healthcheck;
    expect(workerHealthcheck?.test?.join(" ") ?? "").toContain("kill -0 1");

    const deploy = readProductionFile("deploy.sh");
    expect(deploy).toContain("health-check.sh");
    expect(deploy).toContain("rollback failed");
  });
});
