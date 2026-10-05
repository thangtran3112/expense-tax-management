import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const familyRoot = path.dirname(repoRoot);
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const envFile = path.join(repoRoot, ".env.example");

interface ComposeConfig {
  readonly services: Record<string, ComposeService>;
}

interface ComposeService {
  readonly build?: {
    readonly context?: string;
  };
  readonly environment?: Record<string, string | null>;
  readonly ports?: readonly ComposePort[];
}

interface ComposePort {
  readonly host_ip?: string;
  readonly published?: string;
  readonly target?: number;
}

function composeConfig(cwd: string): ComposeConfig {
  const output = execFileSync(
    composeScript,
    ["config", "--format", "json"],
    {
      cwd,
      env: {
        ...process.env,
        EXPENSE_TAX_ENV_FILE: envFile,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  return JSON.parse(output) as ComposeConfig;
}

function databaseEnvironmentKeys(
  environment: Record<string, string | null> | undefined,
): string[] {
  return Object.keys(environment ?? {}).filter(
    (key) =>
      key === "DATABASE_URL" ||
      key.endsWith("DATABASE_URL") ||
      key.includes("POSTGRES") ||
      key.includes("MIGRATION"),
  );
}

function expectLoopbackPort(
  service: ComposeService | undefined,
  target: number,
): void {
  const port = service?.ports?.find((entry) => entry.target === target);
  expect(port).toMatchObject({
    host_ip: "127.0.0.1",
    published: String(target),
    target,
  });
}

describe("Phase 0I Compose boundaries", () => {
  it("resolves the same normalized Compose config from project and unrelated cwd", () => {
    const temporaryCwd = mkdtempSync(path.join(os.tmpdir(), "expense-tax-compose-"));

    try {
      expect(composeConfig(repoRoot)).toEqual(composeConfig(temporaryCwd));
    } finally {
      rmSync(temporaryCwd, { recursive: true, force: true });
    }
  });

  it("normalizes legacy paths and isolates runtime versus migration URLs", () => {
    const config = composeConfig(repoRoot);
    const services = config.services;
    const legacy = services["expense-service"];
    const app = services["app-api"];
    const appMigration = services["app-api-migrate"];
    const foundry = services["foundry-service"];
    const foundryMigration = services["foundry-service-migrate"];

    expect(legacy?.build?.context).toMatch(
      /\/expense-tax-management\/expense-service$/,
    );
    expect(legacy?.build?.context).not.toMatch(/\/infrastructure\/expense-service$/);

    expect(databaseEnvironmentKeys(app?.environment)).toEqual([
      "APP_DATABASE_URL",
    ]);
    expect(databaseEnvironmentKeys(appMigration?.environment)).toEqual([
      "APP_MIGRATION_DATABASE_URL",
    ]);
    expect(databaseEnvironmentKeys(foundry?.environment)).toEqual([
      "FOUNDRY_DATABASE_URL",
    ]);
    expect(databaseEnvironmentKeys(foundryMigration?.environment)).toEqual([
      "FOUNDRY_MIGRATION_DATABASE_URL",
    ]);
    const productionCompose = readFileSync(
      path.join(repoRoot, "deploy/production/docker-compose.yml"),
      "utf8",
    );
    // Two matches per service (key and interpolation) across app-api,
    // foundry-service, ai-worker, and workflow-worker.
    expect(
      productionCompose.match(/CLERK_APP_SERVICE_SUBJECT:/g),
    ).toHaveLength(8);
    expect(
      productionCompose.match(/CLERK_FOUNDRY_SERVICE_SUBJECT:/g),
    ).toHaveLength(8);

    expect(databaseEnvironmentKeys(legacy?.environment)).toEqual(["DATABASE_URL"]);
    expect(Object.keys(legacy?.environment ?? {})).not.toContain(
      "APP_DATABASE_URL",
    );
    expect(Object.keys(legacy?.environment ?? {})).not.toContain(
      "FOUNDRY_DATABASE_URL",
    );
    expectLoopbackPort(app, 8100);
    expectLoopbackPort(foundry, 8200);

    const nginxConfig = readFileSync(
      path.join(familyRoot, "infrastructure", "nginx", "nginx.conf"),
      "utf8",
    );
    expect(nginxConfig).not.toMatch(/app-api|foundry-service/);
  });

  it("passes every Clerk startup variable to local and production workers", () => {
    const local = composeConfig(repoRoot).services["ai-worker"]?.environment ?? {};
    const productionText = readFileSync(
      path.join(repoRoot, "deploy/production/docker-compose.yml"),
      "utf8",
    );
    for (const key of [
      "CLERK_ISSUER_URL",
      "CLERK_JWKS_URL",
      "CLERK_TENANT_AUDIENCE",
      "CLERK_PLATFORM_AUDIENCE",
      "CLERK_APP_SERVICE_AUDIENCE",
      "CLERK_FOUNDRY_SERVICE_AUDIENCE",
      "CLERK_APP_MACHINE_SECRET_KEY",
      "CLERK_FOUNDRY_MACHINE_SECRET_KEY",
      "CLERK_APP_SERVICE_SUBJECT",
      "CLERK_FOUNDRY_SERVICE_SUBJECT",
    ]) {
      expect(local).toHaveProperty(key);
      expect(productionText).toMatch(new RegExp(`ai-worker:[\\s\\S]*${key}:`));
    }
  });

  it("passes complete fail-closed Clerk config to local API services", () => {
    const services = composeConfig(repoRoot).services;
    const expectedClerk = {
      CLERK_ISSUER_URL: "https://clerk.not-configured.invalid",
      CLERK_JWKS_URL:
        "https://clerk.not-configured.invalid/.well-known/jwks.json",
      CLERK_TENANT_AUDIENCE: "expense-app",
      CLERK_PLATFORM_AUDIENCE: "expense-foundry-platform",
      CLERK_APP_SERVICE_AUDIENCE: "mch_3J9fsniGga4hUqUf65ZQqzeGX2b",
      CLERK_FOUNDRY_SERVICE_AUDIENCE: "mch_3J9g3CNoKL9q6KfbRy5zq1Rh2zT",
      CLERK_APP_SERVICE_SUBJECT: "mch_3J9Xg9Hu84Rn2oeqj7EMrv0ax19",
      CLERK_FOUNDRY_SERVICE_SUBJECT: "mch_3J9gHBtDcxOE3fWE39Ay9uF7hFv",
    };

    for (const serviceName of ["app-api", "foundry-service"]) {
      expect(services[serviceName]?.environment).toMatchObject(expectedClerk);
    }
  });

  it("does not fall back when an explicit env file is missing", () => {
    const missingEnvFile = path.join(
      mkdtempSync(path.join(os.tmpdir(), "expense-tax-missing-env-")),
      "missing.env",
    );

    expect(() =>
      execFileSync(composeScript, ["config", "--quiet"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          EXPENSE_TAX_ENV_FILE: missingEnvFile,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow();
  });
});
