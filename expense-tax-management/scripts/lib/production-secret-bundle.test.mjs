import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  activeVersionIds,
  buildProductionBundle,
} from "./production-secret-bundle.mjs";

const databaseFixture = {
  APP_DATABASE_URL:
    "postgresql://app:app-password@127.0.0.1:15432/expense_tax_db",
  APP_MIGRATION_DATABASE_URL:
    "postgresql://migrator:migrator-password@127.0.0.1:15432/expense_tax_db",
  FOUNDRY_DATABASE_URL:
    "postgresql://foundry:foundry-password@127.0.0.1:15432/expense_tax_db",
  FOUNDRY_MIGRATION_DATABASE_URL:
    "postgresql://foundry-migrator:foundry-migrator-password@127.0.0.1:15432/expense_tax_db",
};

const requiredShellEnv = {
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
  CLERK_APP_MACHINE_SECRET_KEY: "ak_test_app_machine_secret",
  CLERK_FOUNDRY_MACHINE_SECRET_KEY: "ak_test_foundry_machine_secret",
  CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test_webhook_secret",
};

const productionClerkRuntime = {
  AUTH_PROVIDER: "clerk",
  CLERK_ISSUER_URL: "https://clerk.tobytran.dev",
  CLERK_JWKS_URL: "https://clerk.tobytran.dev/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "expense-app",
  CLERK_PLATFORM_AUDIENCE: "expense-foundry-platform",
  CLERK_APP_SERVICE_AUDIENCE: "mch_3JAI0juruFRPSkrE1rpcDKx1k1i",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "mch_3JAIAMNUiVXteVOki8QENYHvJjp",
  CLERK_APP_SERVICE_SUBJECT: "mch_3JAIPnx8itUTJsizuEGewr6NGBX",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "mch_3JAIi2BwnqBf8bNzbjTtjJa6nGw",
};

const clerkMachineIds = {
  CLERK_APP_SERVICE_AUDIENCE: "mch_3J9fsniGga4hUqUf65ZQqzeGX2b",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "mch_3J9g3CNoKL9q6KfbRy5zq1Rh2zT",
  CLERK_APP_SERVICE_SUBJECT: "mch_3J9Xg9Hu84Rn2oeqj7EMrv0ax19",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "mch_3J9gHBtDcxOE3fWE39Ay9uF7hFv",
};

const productionRoot = join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "deploy/production",
);
const syncScript = readFileSync(
  join(
    fileURLToPath(new URL("../..", import.meta.url)),
    "infrastructure/gcp/expense-tax/sync-production-secret.sh",
  ),
  "utf8",
);
const productionDeployScript = readFileSync(
  join(productionRoot, "deploy.sh"),
  "utf8",
);

describe("buildProductionBundle", () => {
  it("keeps shared Temporal database credentials out of the Expense deployment bundle", () => {
    const bundle = buildProductionBundle({
      shellEnv: requiredShellEnv,
      databaseEnv: databaseFixture,
      currentEnv: { TEMPORAL_DB_PASSWORD: "11".repeat(32) },
      randomBytes: () => Buffer.alloc(32, 7),
    });
    const allowlist = productionDeployScript.match(/KNOWN_ENV_KEYS=\(([^)]*)\)/su)?.[1] ?? "";

    expect(bundle).not.toContain("TEMPORAL_DB_PASSWORD=");
    expect(allowlist).not.toContain("TEMPORAL_DB_PASSWORD");
  });

  it("allows and validates the webhook secret in production deploy input", () => {
    const allowlist = productionDeployScript.match(/KNOWN_ENV_KEYS=\(([^)]*)\)/su)?.[1] ?? "";
    const requiredAuthKeys = productionDeployScript.match(/validate_auth_values\(\)[\s\S]*?for key in \\\n([\s\S]*?); do/u)?.[1] ?? "";

    expect(allowlist).toContain("CLERK_WEBHOOK_SIGNING_SECRET");
    expect(requiredAuthKeys).toContain("CLERK_WEBHOOK_SIGNING_SECRET");
    expect(productionDeployScript).toContain(
      "! \"$value\" =~ ^whsec_[^[:space:]]+$",
    );
  });

  it("carries both Clerk secrets through protected sync input into the bundle", () => {
    for (const key of [
      "CLERK_APP_MACHINE_SECRET_KEY",
      "CLERK_FOUNDRY_MACHINE_SECRET_KEY",
    ]) {
      expect(syncScript).toContain(`: \"\${${key}:?`);
      expect(syncScript).toContain(`export ${key}=%q`);
      expect(syncScript).toContain(`${key}: process.env.${key}`);
    }
    for (const key of Object.keys(productionClerkRuntime)) {
      expect(syncScript).toContain(`: "\${${key}:?`);
      expect(syncScript).toContain(`export ${key}=%q`);
      expect(syncScript).toContain(`${key}: process.env.${key}`);
    }
    expect(syncScript).toContain('env -i PATH="$PATH" HOME="$HOME"');
    expect(syncScript).toContain(': "${CLERK_WEBHOOK_SIGNING_SECRET_FILE:?');
    expect(syncScript).toContain('must have mode 0600');
    expect(syncScript).toContain('must contain a nonempty whsec_ secret');
    expect(syncScript).toContain("=~ '^whsec_[^[:space:]]+$'");
    expect(syncScript).toContain('export CLERK_WEBHOOK_SIGNING_SECRET=%q');
    expect(syncScript).toContain('CLERK_ISSUER_URL" == "https://clerk.tobytran.dev"');
    expect(syncScript).toContain('CLERK_JWKS_URL" == "https://clerk.tobytran.dev/.well-known/jwks.json"');
    expect(syncScript).toContain('CLERK_TENANT_AUDIENCE" == "expense-app"');
    expect(syncScript).toContain('CLERK_PLATFORM_AUDIENCE" == "expense-foundry-platform"');

    const bundle = buildProductionBundle({
      shellEnv: requiredShellEnv,
      databaseEnv: databaseFixture,
      randomBytes: () => Buffer.alloc(32, 7),
    });
    expect(bundle).toContain(
      "CLERK_APP_MACHINE_SECRET_KEY=ak_test_app_machine_secret",
    );
    expect(bundle).toContain(
      "CLERK_FOUNDRY_MACHINE_SECRET_KEY=ak_test_foundry_machine_secret",
    );
    expect(bundle).toContain(
      "CLERK_WEBHOOK_SIGNING_SECRET=whsec_test_webhook_secret",
    );
  });

  it("carries production Clerk runtime values while preserving inert test defaults", () => {
    const bundle = buildProductionBundle({
      shellEnv: { ...requiredShellEnv, ...productionClerkRuntime },
      databaseEnv: databaseFixture,
      randomBytes: () => Buffer.alloc(32, 7),
    });

    for (const [key, value] of Object.entries(productionClerkRuntime)) {
      expect(bundle).toContain(`${key}=${value}`);
    }

    const inertBundle = buildProductionBundle({
      shellEnv: requiredShellEnv,
      databaseEnv: databaseFixture,
      randomBytes: () => Buffer.alloc(32, 7),
    });
    expect(inertBundle).toContain("CLERK_TENANT_AUDIENCE=phase-1b-inert-tenant");
  });

  it.each(Object.keys(productionClerkRuntime))(
    "requires production Clerk runtime key %s in protected sync input",
    (key) => {
      expect(syncScript).toContain(`: "\${${key}:?`);
    },
  );

  it("rewrites database URLs and preserves generated keys", () => {
    const bundle = buildProductionBundle({
      shellEnv: { ...requiredShellEnv, IMAGE_TAG: "attacker-supplied-tag" },
      databaseEnv: databaseFixture,
      currentEnv: { STORAGE_URL_SIGNING_KEY: "a".repeat(64) },
      randomBytes: () => Buffer.alloc(32, 7),
    });

    expect(bundle).toContain("@postgres:5432/expense_tax_db");
    expect(bundle).toContain(`STORAGE_URL_SIGNING_KEY=${"a".repeat(64)}`);
    expect(bundle).not.toContain("127.0.0.1:15432");
  });

  it("emits every required production Compose value with fail-closed defaults", () => {
    const bundle = buildProductionBundle({
      shellEnv: { ...requiredShellEnv, ...clerkMachineIds },
      databaseEnv: databaseFixture,
      randomBytes: () => Buffer.alloc(32, 7),
    });
    const keys = new Set(bundle.split("\n").filter(Boolean).map((line) => line.split("=", 1)[0]));
    const compose = readFileSync(join(productionRoot, "docker-compose.yml"), "utf8");
    const requiredComposeKeys = [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]+):\?/gu)]
      .map(([, key]) => key)
      .filter((key) => key !== "IMAGE_TAG");

    expect(new Set(requiredComposeKeys)).not.toContain("IMAGE_TAG");
    expect([...new Set(requiredComposeKeys)].filter((key) => !keys.has(key))).toEqual([]);
    expect(bundle).toContain("APP_TENANT_TOKEN_ISSUER=https://identity.not-configured.invalid");
    expect(bundle).toContain("STORAGE_BACKEND=local");
    expect(bundle).toContain(
      "CLERK_APP_MACHINE_SECRET_KEY=ak_test_app_machine_secret",
    );
    expect(bundle).toContain(
      "CLERK_FOUNDRY_MACHINE_SECRET_KEY=ak_test_foundry_machine_secret",
    );
    expect(bundle).not.toContain("IMAGE_TAG=");
  });

  it.each([
    "CLERK_APP_MACHINE_SECRET_KEY",
    "CLERK_FOUNDRY_MACHINE_SECRET_KEY",
    "CLERK_WEBHOOK_SIGNING_SECRET",
  ])("names only missing required key %s", (key) => {
    const shellEnv = { ...requiredShellEnv, ...clerkMachineIds };
    delete shellEnv[key];

    expect(() =>
      buildProductionBundle({ shellEnv, databaseEnv: databaseFixture }),
    ).toThrowError(new RegExp(`missing required environment keys: ${key}$`));
  });

  it("rewrites only database URL authority and preserves query text", () => {
    const url =
      "postgresql://app:password@127.0.0.1:15432/expense_tax_db?host=127.0.0.1:15432&marker=@127.0.0.1:15432#fragment";
    const bundle = buildProductionBundle({
      shellEnv: { ...requiredShellEnv, ...clerkMachineIds },
      databaseEnv: { ...databaseFixture, APP_DATABASE_URL: url },
      randomBytes: () => Buffer.alloc(32, 7),
    });

    expect(bundle).toContain(
      "APP_DATABASE_URL=postgresql://app:password@postgres:5432/expense_tax_db?host=127.0.0.1:15432&marker=@127.0.0.1:15432#fragment",
    );
  });

  it.each([
    ["APP_DATABASE_URL", "not-a-url"],
    ["APP_MIGRATION_DATABASE_URL", "https://app@127.0.0.1:15432/database"],
  ])("rejects invalid database URL %s without exposing its value", (key, value) => {
    expect(() =>
      buildProductionBundle({
        shellEnv: { ...requiredShellEnv, ...clerkMachineIds },
        databaseEnv: { ...databaseFixture, [key]: value },
      }),
    ).toThrowError(new RegExp(key));

    try {
      buildProductionBundle({
        shellEnv: { ...requiredShellEnv, ...clerkMachineIds },
        databaseEnv: { ...databaseFixture, [key]: value },
      });
    } catch (error) {
      expect(error.message).not.toContain(value);
    }
  });

  it("rejects missing required keys without exposing values", () => {
    expect(() =>
      buildProductionBundle({
        shellEnv: { OPENAI_API_KEY: "top-secret-openai" },
        databaseEnv: databaseFixture,
      }),
    ).toThrowError(/OPENROUTER_API_KEY/);

    try {
      buildProductionBundle({
        shellEnv: { OPENAI_API_KEY: "top-secret-openai" },
        databaseEnv: databaseFixture,
      });
    } catch (error) {
      expect(error.message).not.toContain("top-secret-openai");
    }
  });

  it("generates 32-byte hexadecimal keys on first run", () => {
    const bundle = buildProductionBundle({
      shellEnv: { ...requiredShellEnv, ...clerkMachineIds },
      databaseEnv: databaseFixture,
      randomBytes: () => Buffer.alloc(32, 7),
    });

    for (const key of [
      "STORAGE_URL_SIGNING_KEY",
      "INBOUND_WEBHOOK_SIGNING_KEY",
      "INBOUND_ROUTING_TOKEN_SECRET",
    ]) {
      expect(bundle).toContain(`${key}=${"07".repeat(32)}`);
    }
  });

  it("serializes keys in deterministic dotenv order", () => {
    const bundle = buildProductionBundle({
      shellEnv: { ...requiredShellEnv, ...clerkMachineIds },
      databaseEnv: databaseFixture,
      currentEnv: {
        INBOUND_ROUTING_TOKEN_SECRET: "22".repeat(32),
        INBOUND_WEBHOOK_SIGNING_KEY: "33".repeat(32),
        STORAGE_URL_SIGNING_KEY: "44".repeat(32),
      },
      randomBytes: () => Buffer.alloc(32),
    });

    expect(bundle.split("\n").filter(Boolean)).toEqual([
      "APP_DATABASE_URL=postgresql://app:app-password@postgres:5432/expense_tax_db",
      "APP_MIGRATION_DATABASE_URL=postgresql://migrator:migrator-password@postgres:5432/expense_tax_db",
      "APP_SERVICE_JWKS_URL=https://services.not-configured.invalid/.well-known/jwks.json",
      "APP_SERVICE_TOKEN_AUDIENCE=phase-1b-inert-service",
      "APP_SERVICE_TOKEN_ISSUER=https://services.not-configured.invalid",
      "APP_TENANT_JWKS_URL=https://identity.not-configured.invalid/.well-known/jwks.json",
      "APP_TENANT_TOKEN_AUDIENCE=phase-1b-inert-tenant",
      "APP_TENANT_TOKEN_ISSUER=https://identity.not-configured.invalid",
      "AUTH_PROVIDER=clerk",
      "CLERK_APP_MACHINE_SECRET_KEY=ak_test_app_machine_secret",
      "CLERK_APP_SERVICE_AUDIENCE=mch_3J9fsniGga4hUqUf65ZQqzeGX2b",
      "CLERK_APP_SERVICE_SUBJECT=mch_3J9Xg9Hu84Rn2oeqj7EMrv0ax19",
      "CLERK_FOUNDRY_MACHINE_SECRET_KEY=ak_test_foundry_machine_secret",
      "CLERK_FOUNDRY_SERVICE_AUDIENCE=mch_3J9g3CNoKL9q6KfbRy5zq1Rh2zT",
      "CLERK_FOUNDRY_SERVICE_SUBJECT=mch_3J9gHBtDcxOE3fWE39Ay9uF7hFv",
      "CLERK_ISSUER_URL=https://identity.not-configured.invalid",
      "CLERK_JWKS_URL=https://identity.not-configured.invalid/.well-known/jwks.json",
      "CLERK_PLATFORM_AUDIENCE=phase-1b-inert-platform",
      "CLERK_TENANT_AUDIENCE=phase-1b-inert-tenant",
      "CLERK_WEBHOOK_SIGNING_SECRET=whsec_test_webhook_secret",
      "FOUNDRY_DATABASE_URL=postgresql://foundry:foundry-password@postgres:5432/expense_tax_db",
      "FOUNDRY_MIGRATION_DATABASE_URL=postgresql://foundry-migrator:foundry-migrator-password@postgres:5432/expense_tax_db",
      "FOUNDRY_PLATFORM_JWKS_URL=https://identity.not-configured.invalid/.well-known/jwks.json",
      "FOUNDRY_PLATFORM_TOKEN_AUDIENCE=phase-1b-inert-platform",
      "FOUNDRY_PLATFORM_TOKEN_ISSUER=https://identity.not-configured.invalid",
      "FOUNDRY_SERVICE_JWKS_URL=https://services.not-configured.invalid/.well-known/jwks.json",
      "FOUNDRY_SERVICE_TOKEN_AUDIENCE=phase-1b-inert-service",
      "FOUNDRY_SERVICE_TOKEN_ISSUER=https://services.not-configured.invalid",
      "INBOUND_EMAIL_BASE_ADDRESS=receipts@inbound.expense-tax.local",
      `INBOUND_ROUTING_TOKEN_SECRET=${"22".repeat(32)}`,
      `INBOUND_WEBHOOK_SIGNING_KEY=${"33".repeat(32)}`,
      "OPENAI_API_KEY=openai",
      "OPENROUTER_API_KEY=openrouter",
      "STORAGE_BACKEND=local",
      "STORAGE_LOCAL_BASE_URL=http://127.0.0.1:8100",
      `STORAGE_URL_SIGNING_KEY=${"44".repeat(32)}`,
    ]);
  });

  it.each(["bad\nvalue", "bad\rvalue", "bad\u0000value"])(
    "rejects unsafe dotenv value %j",
    (unsafeValue) => {
      expect(() =>
        buildProductionBundle({
          shellEnv: { ...requiredShellEnv, OPENAI_API_KEY: unsafeValue },
          databaseEnv: databaseFixture,
          randomBytes: () => Buffer.alloc(32),
        }),
      ).toThrow(/unsafe|invalid/i);
    },
  );

  it.each([
    ["STORAGE_URL_SIGNING_KEY", "not-hex"],
    ["INBOUND_WEBHOOK_SIGNING_KEY", "a".repeat(63)],
    ["INBOUND_ROUTING_TOKEN_SECRET", "g".repeat(64)],
  ])("rejects malformed preserved secret %s without exposing its value", (key, value) => {
    expect(() =>
      buildProductionBundle({
        shellEnv: { ...requiredShellEnv, ...clerkMachineIds },
        databaseEnv: databaseFixture,
        currentEnv: { [key]: value },
        randomBytes: () => Buffer.alloc(32),
      }),
    ).toThrowError(new RegExp(key));

    try {
      buildProductionBundle({
        shellEnv: { ...requiredShellEnv, ...clerkMachineIds },
        databaseEnv: databaseFixture,
        currentEnv: { [key]: value },
        randomBytes: () => Buffer.alloc(32),
      });
    } catch (error) {
      expect(error.message).not.toContain(value);
    }
  });
});

describe("activeVersionIds", () => {
  it("returns enabled and disabled version IDs but excludes destroyed versions", () => {
    expect(
      activeVersionIds([
        { name: "projects/example/secrets/app/versions/1", state: "ENABLED" },
        { name: "projects/example/secrets/app/versions/2", state: "DISABLED" },
        { name: "projects/example/secrets/app/versions/3", state: "DESTROYED" },
      ]),
    ).toEqual(["1", "2"]);
  });
});
