/**
 * Phase 3D-A Task 2 — domain/mailbox-connections.ts: the token-generation
 * pointer CAS (acquireTokenOperationLease / advanceTokenGeneration /
 * releaseTokenOperationLease).
 *
 * Real-PostgreSQL coverage (PHASE_3D_A_T2_INTEGRATION=1), same ephemeral
 * -database pattern as the other Task 2 integration suites. No Google or
 * Clerk network access -- the broker is a fake object.
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
const databaseName = `expense_tax_t2g_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

const TENANT_ID = "7c000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "7c000000-0000-4000-8000-000000000002";
const PROFILE_ID = "7c000000-0000-4000-8000-000000000003";
const ALLOWED_ORIGIN = "https://expense-office.test";

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

function fakeBrokerClient(): MailboxBrokerClient {
  return {
    startOAuth: vi.fn(async (input: { attemptId: string }) => ({
      authorizationUrl: `https://accounts.google.test/auth?attempt=${input.attemptId}`,
      stateDigest: createHash("sha256").update(`state:${input.attemptId}`).digest("hex"),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    })),
  };
}

describe.skipIf(!requested)(
  "domain/mailbox-connections.ts — token-generation lease/advance/release CAS (live PostgreSQL)",
  () => {
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
        VALUES ('${OWNER_USER_ID}', 't2g-owner@example.test', 'T2G Owner')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenants (id, name, slug, status)
        VALUES ('${TENANT_ID}', 'T2G Tenant', 't2g-tenant-${runKey}', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_profiles (id, tenant_id, name)
        VALUES ('${PROFILE_ID}', '${TENANT_ID}', 'T2G Profile')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status)
        VALUES ('${PROFILE_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;
      `);
    }

    function createDomain(): MailboxConnectionsDomain {
      return createMailboxConnectionsDomain(database!, fakeBrokerClient(), {
        allowedRedirectOrigins: [ALLOWED_ORIGIN],
      });
    }

    /**
     * Inserts a fresh, independent, already-active connection row directly
     * (connectionVersion=1, tokenGeneration=1) -- the lease/advance/release
     * CAS under test here does not depend on how a connection was created,
     * and each test needs its *own* connection (startConnection's
     * findOrCreateConnectionId deliberately reuses one non-revoked row per
     * scope, which would make concurrent lease tests interfere).
     */
    function createConnection(): Promise<string> | string {
      const connectionId = randomUUID();
      runtimeSql(`
        INSERT INTO app.mailbox_connections (
          id, tenant_id, personal_profile_id, owner_user_id, provider,
          provider_account_id, account_email, status, timezone, local_scan_time,
          vault_reference
        ) VALUES (
          '${connectionId}', '${TENANT_ID}', '${PROFILE_ID}', '${OWNER_USER_ID}', 'gmail',
          'provider-account-${connectionId}', 'mailbox-${connectionId}@example.test', 'active',
          'America/Los_Angeles', '07:30', 'vault-ref-initial'
        );
      `);
      return connectionId;
    }

    describe("acquireTokenOperationLease", () => {
      it("acquires a lease returning the current generation/version", async () => {
        const domain = createDomain();
        const connectionId = await createConnection();

        const lease = await domain.acquireTokenOperationLease({
          connectionId,
          operationId: randomUUID(),
          ttlSeconds: 60,
        });

        expect(lease.connectionId).toBe(connectionId);
        expect(lease.expectedConnectionVersion).toBe(1);
        expect(lease.currentTokenGeneration).toBe(1);
        expect(lease.leaseId).toMatch(/^[0-9a-f-]{36}$/);
      });

      it("rejects a second concurrent acquire while the first lease is unexpired", async () => {
        const domain = createDomain();
        const connectionId = await createConnection();
        await domain.acquireTokenOperationLease({ connectionId, operationId: randomUUID(), ttlSeconds: 60 });

        await expect(
          domain.acquireTokenOperationLease({ connectionId, operationId: randomUUID(), ttlSeconds: 60 }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      });

      it("allows a new acquire once the prior lease's TTL has expired", async () => {
        const domain = createDomain();
        const connectionId = await createConnection();
        const first = await domain.acquireTokenOperationLease({
          connectionId, operationId: randomUUID(), ttlSeconds: 60,
        });
        // Force the lease into the past directly (simulating TTL elapse)
        // without waiting 60 real seconds. A full day's margin (rather than
        // a few seconds) tolerates ordinary container/host clock skew
        // (observed ~2-3s on Docker Desktop for Mac after host sleep).
        runtimeSql(
          `UPDATE app.mailbox_connections SET token_operation_lease_expires_at = now() - interval '1 day' WHERE id = '${connectionId}'`,
        );

        const second = await domain.acquireTokenOperationLease({
          connectionId, operationId: randomUUID(), ttlSeconds: 60,
        });
        expect(second.leaseId).not.toBe(first.leaseId);
      });
    });

    describe("advanceTokenGeneration", () => {
      async function leasedConnection(domain: MailboxConnectionsDomain) {
        const connectionId = await createConnection();
        const lease = await domain.acquireTokenOperationLease({
          connectionId, operationId: randomUUID(), ttlSeconds: 60,
        });
        return { connectionId, lease };
      }

      it("advances only to currentTokenGeneration + 1 under the exact lease", async () => {
        const domain = createDomain();
        const { connectionId, lease } = await leasedConnection(domain);

        const result = await domain.advanceTokenGeneration({
          connectionId,
          leaseId: lease.leaseId,
          expectedConnectionVersion: lease.expectedConnectionVersion,
          newGeneration: lease.currentTokenGeneration + 1,
          vaultReference: "vault-ref-gen-2",
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
        });

        expect(result.tokenGeneration).toBe(2);
        expect(result.vaultReference).toBe("vault-ref-gen-2");
        expect(result.connectionVersion).toBe(2);
      });

      it("rejects a newGeneration that is not exactly currentTokenGeneration + 1", async () => {
        const domain = createDomain();
        const { connectionId, lease } = await leasedConnection(domain);

        await expect(
          domain.advanceTokenGeneration({
            connectionId,
            leaseId: lease.leaseId,
            expectedConnectionVersion: lease.expectedConnectionVersion,
            newGeneration: lease.currentTokenGeneration + 2,
            vaultReference: "vault-ref-skip",
            requestId: randomUUID(),
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      });

      it("rejects a stale expectedConnectionVersion", async () => {
        const domain = createDomain();
        const { connectionId, lease } = await leasedConnection(domain);

        await expect(
          domain.advanceTokenGeneration({
            connectionId,
            leaseId: lease.leaseId,
            expectedConnectionVersion: lease.expectedConnectionVersion + 1,
            newGeneration: lease.currentTokenGeneration + 1,
            vaultReference: "vault-ref-stale",
            requestId: randomUUID(),
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      });

      it("rejects the wrong leaseId", async () => {
        const domain = createDomain();
        const { connectionId, lease } = await leasedConnection(domain);

        await expect(
          domain.advanceTokenGeneration({
            connectionId,
            leaseId: randomUUID(),
            expectedConnectionVersion: lease.expectedConnectionVersion,
            newGeneration: lease.currentTokenGeneration + 1,
            vaultReference: "vault-ref-wrong-lease",
            requestId: randomUUID(),
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
      });

      it("replays an identical advance and rejects the same key with a different vaultReference (IDEMPOTENCY_CONFLICT)", async () => {
        const domain = createDomain();
        const { connectionId, lease } = await leasedConnection(domain);
        const input = {
          connectionId,
          leaseId: lease.leaseId,
          expectedConnectionVersion: lease.expectedConnectionVersion,
          newGeneration: lease.currentTokenGeneration + 1,
          vaultReference: "vault-ref-replay",
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
        };

        const first = await domain.advanceTokenGeneration(input);
        const replay = await domain.advanceTokenGeneration(input);
        expect(replay).toEqual(first);

        await expect(
          domain.advanceTokenGeneration({ ...input, vaultReference: "vault-ref-DIFFERENT" }),
        ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      });
    });

    describe("releaseTokenOperationLease", () => {
      it("clears the lease without advancing the generation", async () => {
        const domain = createDomain();
        const connectionId = await createConnection();
        const lease = await domain.acquireTokenOperationLease({
          connectionId, operationId: randomUUID(), ttlSeconds: 60,
        });

        await domain.releaseTokenOperationLease({ connectionId, leaseId: lease.leaseId });

        const row = runtimeSql(
          `SELECT token_operation_lease_id, token_generation FROM app.mailbox_connections WHERE id = '${connectionId}'`,
        );
        expect(row).toBe("|1");

        // A new acquire succeeds immediately -- the lease is gone, not just expired.
        const next = await domain.acquireTokenOperationLease({
          connectionId, operationId: randomUUID(), ttlSeconds: 60,
        });
        expect(next.leaseId).not.toBe(lease.leaseId);
      });

      it("is a no-op (not an error) when a successful advance already cleared the lease", async () => {
        const domain = createDomain();
        const connectionId = await createConnection();
        const lease = await domain.acquireTokenOperationLease({
          connectionId, operationId: randomUUID(), ttlSeconds: 60,
        });
        await domain.advanceTokenGeneration({
          connectionId,
          leaseId: lease.leaseId,
          expectedConnectionVersion: lease.expectedConnectionVersion,
          newGeneration: lease.currentTokenGeneration + 1,
          vaultReference: "vault-ref-already-advanced",
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
        });

        await expect(
          domain.releaseTokenOperationLease({ connectionId, leaseId: lease.leaseId }),
        ).resolves.toBeUndefined();
      });

      it("is a no-op the second time the same leaseId is released", async () => {
        const domain = createDomain();
        const connectionId = await createConnection();
        const lease = await domain.acquireTokenOperationLease({
          connectionId, operationId: randomUUID(), ttlSeconds: 60,
        });

        await domain.releaseTokenOperationLease({ connectionId, leaseId: lease.leaseId });
        await expect(
          domain.releaseTokenOperationLease({ connectionId, leaseId: lease.leaseId }),
        ).resolves.toBeUndefined();
      });
    });
  },
);
