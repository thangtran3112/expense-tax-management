/**
 * Phase 3D-A Task 2 — domain/mailbox-connections.ts: consumeOAuthState,
 * the broker's one-time OAuth state-consume CAS.
 *
 * Real-PostgreSQL coverage (PHASE_3D_A_T2_INTEGRATION=1), same ephemeral
 * -database pattern as mailbox-connections.test.ts / enrichment.test.ts.
 * No Google or Clerk network access -- the broker is a fake object.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAppDatabase } from "../src/database/client.js";
import type { AppDatabase } from "../src/database/types.js";
import { runMigrations } from "../src/database/migrate.js";
import {
  createMailboxConnectionsDomain,
  type MailboxConnectionsDomain,
} from "../src/domain/mailbox-connections.js";
import type { MailboxBrokerClient } from "../src/integrations/mailbox-broker-client.js";

const requested = process.env.PHASE_3D_A_T2_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_t2o_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

const TENANT_ID = "7b000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "7b000000-0000-4000-8000-000000000002";
const PROFILE_ID = "7b000000-0000-4000-8000-000000000003";
const ALLOWED_ORIGIN = "https://expense-office.test";
const UNTRUSTED_ORIGIN = "https://evil.test";

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase> | undefined;

function dockerPsql(dbName: string, username: string, password: string, sql: string): string {
  const result = spawnSync(
    "docker",
    [
      "exec", "-e", `PGPASSWORD=${password}`,
      postgresContainerId,
      "psql", "-X", "-v", "ON_ERROR_STOP=1",
      "--host", "127.0.0.1",
      "--username", username,
      "--dbname", dbName,
      "--tuples-only", "--no-align",
      "--pset", "footer=off",
      "--command", sql,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function adminSql(sql: string, db = "postgres"): string {
  return dockerPsql(db, "postgres", "postgrespassword", sql);
}

function runtimeSql(sql: string): string {
  return dockerPsql(databaseName, "expense_app_runtime", runtimePassword, sql);
}

function fakeBrokerClient(expiresAt = () => new Date(Date.now() + 10 * 60_000).toISOString()) {
  const startOAuth = vi.fn(async (input: { attemptId: string }) => ({
    authorizationUrl: `https://accounts.google.test/auth?attempt=${input.attemptId}`,
    stateDigest: createHash("sha256").update(`state:${input.attemptId}`).digest("hex"),
    expiresAt: expiresAt(),
  }));
  return { startOAuth } as MailboxBrokerClient & { startOAuth: typeof startOAuth };
}

describe.skipIf(!requested)("domain/mailbox-connections.ts — consumeOAuthState (live PostgreSQL)", () => {
  beforeAll(async () => {
    const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    if (!dockerAvailable) throw new Error("Mailbox Task 2 PostgreSQL prerequisites unavailable");

    let postgresRunning = false;
    try {
      postgresRunning =
        execFileSync(composeScript, ["ps", "-q", "postgres"], {
          cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim().length > 0;
    } catch {
      postgresRunning = false;
    }
    if (!postgresRunning) throw new Error("Mailbox Task 2 PostgreSQL prerequisites unavailable");

    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as ComposeConfig;
    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot, env: process.env, encoding: "utf8",
    }).trim();
    runtimePassword = config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    migratorPassword = config.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
    if (!postgresContainerId || !runtimePassword || !migratorPassword) {
      throw new Error("Mailbox Task 2 PostgreSQL prerequisites unavailable");
    }

    adminSql(`CREATE DATABASE ${databaseName};`);
    adminSql(
      `CREATE SCHEMA app AUTHORIZATION expense_app_migrator;
       CREATE SCHEMA app_migrations AUTHORIZATION expense_app_migrator;
       GRANT USAGE ON SCHEMA app TO expense_app_runtime;`,
      databaseName,
    );
    const migrationDatabaseUrl = `postgresql://expense_app_migrator:${encodeURIComponent(migratorPassword)}@127.0.0.1:5433/${databaseName}`;
    const runtimeDatabaseUrl = `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/${databaseName}`;
    await runMigrations(migrationDatabaseUrl);
    adminSql(
      `GRANT USAGE ON SCHEMA app TO expense_app_runtime;
       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO expense_app_runtime;
       GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app TO expense_app_runtime;
       REVOKE UPDATE, DELETE ON app.mailbox_operation_keys FROM expense_app_runtime;`,
      databaseName,
    );
    database = createAppDatabase(runtimeDatabaseUrl);
    seedFixtures();
  });

  afterAll(async () => {
    await database?.destroy();
    if (postgresContainerId && databaseName) {
      adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
    }
  });

  function seedFixtures(): void {
    runtimeSql(`
      INSERT INTO app.users (id, primary_email, display_name)
      VALUES ('${OWNER_USER_ID}', 't2o-owner@example.test', 'T2O Owner')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.tenants (id, name, slug, status)
      VALUES ('${TENANT_ID}', 'T2O Tenant', 't2o-tenant-${runKey}', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
      VALUES ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.personal_profiles (id, tenant_id, name)
      VALUES ('${PROFILE_ID}', '${TENANT_ID}', 'T2O Profile')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status)
      VALUES ('${PROFILE_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
      ON CONFLICT DO NOTHING;
    `);
  }

  function createDomain(
    broker: MailboxBrokerClient = fakeBrokerClient(),
    allowedRedirectOrigins: readonly string[] = [ALLOWED_ORIGIN],
  ): MailboxConnectionsDomain {
    return createMailboxConnectionsDomain(database!, broker, { allowedRedirectOrigins });
  }

  async function startAttempt(
    domain: MailboxConnectionsDomain,
    overrides: Record<string, unknown> = {},
  ) {
    return domain.startConnection({
      actorUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "personal", profileId: PROFILE_ID },
      sessionNonce: `session-nonce-${randomUUID()}`,
      redirectOrigin: ALLOWED_ORIGIN,
      timezone: "America/Los_Angeles",
      localScanTime: "07:30",
      requestId: randomUUID(),
      ...overrides,
    });
  }

  it("consumes a pending attempt exactly once (first consume succeeds)", async () => {
    const domain = createDomain();
    const started = await startAttempt(domain);

    const result = await domain.consumeOAuthState({
      attemptId: started.attempt.id,
      connectionId: started.connection.id,
      stateDigest: started.attempt.stateDigest,
      sessionNonceDigest: started.attempt.sessionNonceDigest,
      requestId: randomUUID(),
    });

    expect(result).toEqual({
      connectionId: started.connection.id,
      attemptId: started.attempt.id,
      redirectOrigin: ALLOWED_ORIGIN,
    });
    const status = runtimeSql(`SELECT status FROM app.mailbox_oauth_attempts WHERE id = '${started.attempt.id}'`);
    expect(status).toBe("consumed");
  });

  it("rejects a second consume of an already-consumed attempt", async () => {
    const domain = createDomain();
    const started = await startAttempt(domain);
    const consumeInput = {
      attemptId: started.attempt.id,
      connectionId: started.connection.id,
      stateDigest: started.attempt.stateDigest,
      sessionNonceDigest: started.attempt.sessionNonceDigest,
      requestId: randomUUID(),
    };

    await domain.consumeOAuthState(consumeInput);

    await expect(domain.consumeOAuthState(consumeInput)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejects a state digest mismatch without revealing which part failed", async () => {
    const domain = createDomain();
    const started = await startAttempt(domain);

    await expect(
      domain.consumeOAuthState({
        attemptId: started.attempt.id,
        connectionId: started.connection.id,
        stateDigest: "f".repeat(64),
        sessionNonceDigest: started.attempt.sessionNonceDigest,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a session nonce digest mismatch", async () => {
    const domain = createDomain();
    const started = await startAttempt(domain);

    await expect(
      domain.consumeOAuthState({
        attemptId: started.attempt.id,
        connectionId: started.connection.id,
        stateDigest: started.attempt.stateDigest,
        sessionNonceDigest: "f".repeat(64),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects and marks expired an attempt whose expiry has already passed", async () => {
    const pastExpiry = () => new Date(Date.now() - 60_000).toISOString();
    const domain = createDomain(fakeBrokerClient(pastExpiry));
    const started = await startAttempt(domain);

    await expect(
      domain.consumeOAuthState({
        attemptId: started.attempt.id,
        connectionId: started.connection.id,
        stateDigest: started.attempt.stateDigest,
        sessionNonceDigest: started.attempt.sessionNonceDigest,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "GONE" });

    const status = runtimeSql(`SELECT status FROM app.mailbox_oauth_attempts WHERE id = '${started.attempt.id}'`);
    expect(status).toBe("expired");
  });

  it("rejects a redirect origin that is no longer on the trusted allowlist (defense-in-depth)", async () => {
    const domain = createDomain();
    const started = await startAttempt(domain);
    // Simulate the allowlist narrowing between start and consume by
    // directly rewriting the persisted origin -- startConnection already
    // rejects an untrusted origin outright, so this exercises consume's
    // own independent re-check.
    runtimeSql(
      `UPDATE app.mailbox_oauth_attempts SET redirect_origin = '${UNTRUSTED_ORIGIN}' WHERE id = '${started.attempt.id}'`,
    );

    await expect(
      domain.consumeOAuthState({
        attemptId: started.attempt.id,
        connectionId: started.connection.id,
        stateDigest: started.attempt.stateDigest,
        sessionNonceDigest: started.attempt.sessionNonceDigest,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects a mismatched connectionId/attemptId pair (wrong connection/tenant)", async () => {
    const domain = createDomain();
    const started = await startAttempt(domain);

    await expect(
      domain.consumeOAuthState({
        attemptId: started.attempt.id,
        connectionId: randomUUID(),
        stateDigest: started.attempt.stateDigest,
        sessionNonceDigest: started.attempt.sessionNonceDigest,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
