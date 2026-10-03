/**
 * Phase 3D-A Task 5 — VPS Compose integration, static + rendered config
 * behavior. Controller ruling: mailbox production wiring is opt-in, so
 * these tests prove both halves of that contract:
 * - The base `docker-compose.yml` never requires a MAILBOX_ or
 *   CLERK_MAILBOX_ variable, and `docker compose config` passes against
 *   it alone with no such variables set.
 * - The `docker-compose.mailbox.yml` override, when included alongside
 *   the base file, adds the broker/migrate services and the
 *   mailbox-only env additions to `app-api`/`workflow-worker` without
 *   redefining those services.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const productionRoot = path.join(repoRoot, "deploy", "production");
const basePath = path.join(productionRoot, "docker-compose.yml");
const mailboxOverlayPath = path.join(productionRoot, "docker-compose.mailbox.yml");

function readProductionFile(name: string): string {
  return readFileSync(path.join(productionRoot, name), "utf8");
}

function renderCompose(files: readonly string[], env: Record<string, string>): {
  readonly services: Record<string, Record<string, unknown>>;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "expense-tax-mailbox-compose-"));
  const envFile = path.join(dir, "test.env");
  try {
    writeFileSync(
      envFile,
      Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n"),
    );
    const args = ["compose", "--project-name", "fbk-test-mailbox-compose", "--env-file", envFile];
    for (const file of files) args.push("-f", file);
    args.push("config");
    const output = execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString(
      "utf8",
    );
    return YAML.parse(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("docker-compose.yml (base, mailbox-disabled)", () => {
  it("never requires a MAILBOX_*/CLERK_MAILBOX_* variable", () => {
    const composeText = readProductionFile("docker-compose.yml");
    const requiredKeys = [
      ...new Set(
        [...composeText.matchAll(/\$\{([A-Z][A-Z0-9_]+):\?/gu)].map(([, key]) => key),
      ),
    ];

    expect(requiredKeys.some((key) => key.startsWith("MAILBOX_") || key.startsWith("CLERK_MAILBOX_"))).toBe(
      false,
    );
  });

  it("passes MAILBOX_FEATURE_ENABLED=false to app-api as a hardcoded literal, not a bundle variable", () => {
    const compose = YAML.parse(readProductionFile("docker-compose.yml")) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };

    expect(compose.services["app-api"].environment?.MAILBOX_FEATURE_ENABLED).toBe("false");
  });

  it("renders standalone with every base ${VAR:?} dummy-filled and no mailbox services present", () => {
    const composeText = readProductionFile("docker-compose.yml");
    const requiredKeys = [
      ...new Set(
        [...composeText.matchAll(/\$\{([A-Z][A-Z0-9_]+):\?/gu)].map(([, key]) => key),
      ),
    ];
    const env = Object.fromEntries(requiredKeys.map((key) => [key, "dummy-value"]));
    const rendered = renderCompose([basePath], env);

    expect(rendered.services["mailbox-broker"]).toBeUndefined();
    expect(rendered.services["mailbox-broker-migrate"]).toBeUndefined();
    expect(rendered.services["app-api"].environment).not.toHaveProperty("CLERK_MAILBOX_SERVICE_AUDIENCE");
  });
});

describe("docker-compose.mailbox.yml (opt-in override)", () => {
  function overlayEnv(): Record<string, string> {
    const baseText = readProductionFile("docker-compose.yml");
    const overlayText = readProductionFile("docker-compose.mailbox.yml");
    const requiredKeys = [
      ...new Set(
        [...baseText.matchAll(/\$\{([A-Z][A-Z0-9_]+):\?/gu), ...overlayText.matchAll(/\$\{([A-Z][A-Z0-9_]+):\?/gu)].map(
          ([, key]) => key,
        ),
      ),
    ];
    return Object.fromEntries(requiredKeys.map((key) => [key, "dummy-value"]));
  }

  it("adds mailbox-broker and mailbox-broker-migrate without redefining existing services", () => {
    const rendered = renderCompose([basePath, mailboxOverlayPath], overlayEnv());

    expect(rendered.services["mailbox-broker"]).toBeDefined();
    expect(rendered.services["mailbox-broker"].image).toBe(
      "ghcr.io/thangtran3112/family-app/expense-tax-mailbox-broker:dummy-value",
    );
    expect(rendered.services["mailbox-broker"].ports).toEqual([
      { mode: "ingress", host_ip: "127.0.0.1", target: 8300, published: "8300", protocol: "tcp" },
    ]);
    expect(rendered.services["mailbox-broker"].deploy).toEqual({
      resources: { limits: { cpus: 0.5, memory: String(512 * 1024 * 1024) } },
    });
    expect(rendered.services["mailbox-broker"].networks).toEqual({ default: null, database: null });
    expect(rendered.services["mailbox-broker-migrate"]).toBeDefined();
    expect(rendered.services["mailbox-broker-migrate"].command).toEqual([
      "node",
      "dist/database/migrate.js",
    ]);

    // Existing services keep their base-file identity (image/ports/healthcheck
    // untouched) -- only their `environment` map gained mailbox keys.
    expect(rendered.services["app-api"].image).toBe(
      "ghcr.io/thangtran3112/family-app/expense-tax-app-api:dummy-value",
    );
    expect(rendered.services["app-api"].ports).toEqual([
      { mode: "ingress", host_ip: "127.0.0.1", target: 8100, published: "8100", protocol: "tcp" },
    ]);
    expect((rendered.services["app-api"].environment as Record<string, string>).MAILBOX_FEATURE_ENABLED).toBe(
      "true",
    );
    expect((rendered.services["app-api"].environment as Record<string, string>).CLERK_MAILBOX_APP_API_SUBJECT).toBe(
      "dummy-value",
    );
    expect(
      (rendered.services["workflow-worker"].environment as Record<string, string>).CLERK_MAILBOX_WORKER_SUBJECT,
    ).toBe("dummy-value");
    expect(
      (rendered.services["workflow-worker"].environment as Record<string, string>).TEMPORAL_NAMESPACE,
    ).toBe("expense-tax");
  });

  it("uses the real broker env var names (MAILBOX_BROKER_DATABASE_URL / MAILBOX_BROKER_MIGRATION_DATABASE_URL), not the stale MAILBOX_VAULT_DATABASE_URL* names", () => {
    const overlayText = readProductionFile("docker-compose.mailbox.yml");

    expect(overlayText).toContain("MAILBOX_BROKER_DATABASE_URL");
    expect(overlayText).toContain("MAILBOX_BROKER_MIGRATION_DATABASE_URL");
    expect(overlayText).not.toContain("MAILBOX_VAULT_DATABASE_URL");
    expect(overlayText).not.toContain("MAILBOX_VAULT_MIGRATION_DATABASE_URL");
  });
});
