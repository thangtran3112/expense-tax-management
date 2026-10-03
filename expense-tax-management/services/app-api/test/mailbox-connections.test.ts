/**
 * Phase 3D-A Task 2 — domain/mailbox-connections.ts: startConnection and
 * completeConnection.
 *
 * Real-PostgreSQL coverage uses a live DB (PHASE_3D_A_T2_INTEGRATION=1),
 * following the same ephemeral-database pattern as the existing
 * enrichment.test.ts / Task 7 Stage A integration suites. No Google or
 * Clerk network access is used anywhere -- the broker is a fake object.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppDatabase } from "../src/database/client.js";
import type { AppDatabase } from "../src/database/types.js";
import { runMigrations } from "../src/database/migrate.js";
import {
  createMailboxConnectionsDomain,
  type MailboxConnectionsDomain,
} from "../src/domain/mailbox-connections.js";
import { DomainError, registerErrorHandlers } from "../src/errors.js";
import type { MailboxBrokerClient } from "../src/integrations/mailbox-broker-client.js";
import { registerAuthPlugin } from "../src/plugins/auth.js";
import { registerMailboxConnectionRoutes } from "../src/routes/mailbox-connections.js";

const requested = process.env.PHASE_3D_A_T2_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_t2m_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

// Personal profiles are unique per tenant (personal_profiles_tenant_unique);
// a second "profile" for cross-connection tests needs a second tenant, not
// a second profile row under the same tenant.
const TENANT_ID = "7a000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "7a000000-0000-4000-8000-000000000002";
const OUTSIDER_USER_ID = "7a000000-0000-4000-8000-000000000003";
const PROFILE_ID = "7a000000-0000-4000-8000-000000000004";
const TENANT_ID_2 = "7a000000-0000-4000-8000-000000000006";
const PROFILE_ID_2 = "7a000000-0000-4000-8000-000000000005";
/** A second user with its own access to PROFILE_ID, distinct from OWNER_USER_ID -- lets tests vary actorUserId without tripping the scope-authorization check. */
const MEMBER_USER_ID = "7a000000-0000-4000-8000-000000000007";
/** A business under TENANT_ID (distinct from PROFILE_ID) -- lets tests vary scope kind without needing a second tenant. */
const BUSINESS_ID = "7a000000-0000-4000-8000-000000000008";
/** Dedicated tenants/profiles for concurrency tests -- guarantees no connection exists for the scope before each race. */
const TENANT_ID_3 = "7a000000-0000-4000-8000-000000000009";
const PROFILE_ID_3 = "7a000000-0000-4000-8000-00000000000a";
const TENANT_ID_4 = "7a000000-0000-4000-8000-00000000000b";
const PROFILE_ID_4 = "7a000000-0000-4000-8000-00000000000c";
/** Dedicated tenant/profile for Fix round 1's getConnection tests. */
const TENANT_ID_5 = "7a000000-0000-4000-8000-00000000000d";
const PROFILE_ID_5 = "7a000000-0000-4000-8000-00000000000e";

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

function fakeBrokerClient(): MailboxBrokerClient & { startOAuth: ReturnType<typeof vi.fn> } {
  const startOAuth = vi.fn(async (input: { attemptId: string }) => ({
    authorizationUrl: `https://accounts.google.test/auth?attempt=${input.attemptId}`,
    stateDigest: createHash("sha256").update(`state:${input.attemptId}`).digest("hex"),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }));
  return { startOAuth };
}

describe.skipIf(!requested)("domain/mailbox-connections.ts — startConnection / completeConnection (live PostgreSQL)", () => {
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
      INSERT INTO app.users (id, primary_email, display_name) VALUES
        ('${OWNER_USER_ID}', 't2m-owner@example.test', 'T2M Owner'),
        ('${OUTSIDER_USER_ID}', 't2m-outsider@example.test', 'T2M Outsider'),
        ('${MEMBER_USER_ID}', 't2m-member@example.test', 'T2M Member')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.tenants (id, name, slug, status) VALUES
        ('${TENANT_ID}', 'T2M Tenant', 't2m-tenant-${runKey}', 'active'),
        ('${TENANT_ID_2}', 'T2M Tenant 2', 't2m-tenant2-${runKey}', 'active'),
        ('${TENANT_ID_3}', 'T2M Tenant 3', 't2m-tenant3-${runKey}', 'active'),
        ('${TENANT_ID_4}', 'T2M Tenant 4', 't2m-tenant4-${runKey}', 'active'),
        ('${TENANT_ID_5}', 'T2M Tenant 5', 't2m-tenant5-${runKey}', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status) VALUES
        ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active'),
        ('${TENANT_ID}', '${MEMBER_USER_ID}', 'member', 'active'),
        ('${TENANT_ID_2}', '${OWNER_USER_ID}', 'owner', 'active'),
        ('${TENANT_ID_3}', '${OWNER_USER_ID}', 'owner', 'active'),
        ('${TENANT_ID_4}', '${OWNER_USER_ID}', 'owner', 'active'),
        ('${TENANT_ID_5}', '${OWNER_USER_ID}', 'owner', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.personal_profiles (id, tenant_id, name) VALUES
        ('${PROFILE_ID}', '${TENANT_ID}', 'T2M Profile'),
        ('${PROFILE_ID_2}', '${TENANT_ID_2}', 'T2M Profile 2'),
        ('${PROFILE_ID_3}', '${TENANT_ID_3}', 'T2M Profile 3'),
        ('${PROFILE_ID_4}', '${TENANT_ID_4}', 'T2M Profile 4'),
        ('${PROFILE_ID_5}', '${TENANT_ID_5}', 'T2M Profile 5')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status) VALUES
        ('${PROFILE_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active'),
        ('${PROFILE_ID}', '${TENANT_ID}', '${MEMBER_USER_ID}', 'editor', 'active'),
        ('${PROFILE_ID_2}', '${TENANT_ID_2}', '${OWNER_USER_ID}', 'owner', 'active'),
        ('${PROFILE_ID_3}', '${TENANT_ID_3}', '${OWNER_USER_ID}', 'owner', 'active'),
        ('${PROFILE_ID_4}', '${TENANT_ID_4}', '${OWNER_USER_ID}', 'owner', 'active'),
        ('${PROFILE_ID_5}', '${TENANT_ID_5}', '${OWNER_USER_ID}', 'owner', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.businesses (id, tenant_id, name, industry_code, timezone, base_currency, status)
      VALUES ('${BUSINESS_ID}', '${TENANT_ID}', 'T2M Business', 'restaurant', 'America/Los_Angeles', 'USD', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.business_memberships (business_id, tenant_id, user_id, role, status)
      VALUES ('${BUSINESS_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active')
      ON CONFLICT DO NOTHING;
    `);
  }

  function createDomain(broker: MailboxBrokerClient = fakeBrokerClient()): MailboxConnectionsDomain {
    return createMailboxConnectionsDomain(database!, broker, {
      allowedRedirectOrigins: [ALLOWED_ORIGIN],
    });
  }

  function startInput(overrides: Partial<Parameters<MailboxConnectionsDomain["startConnection"]>[0]> = {}) {
    return {
      actorUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "personal" as const, profileId: PROFILE_ID },
      redirectOrigin: ALLOWED_ORIGIN,
      timezone: "America/Los_Angeles",
      localScanTime: "07:30",
      requestId: randomUUID(),
      ...overrides,
    };
  }

  it("rejects an actor with no access to the requested scope (entitlement/scope check)", async () => {
    const domain = createDomain();
    await expect(
      domain.startConnection(startInput({ actorUserId: OUTSIDER_USER_ID })),
    ).rejects.toThrow(DomainError.notFound().message);
  });

  it("rejects a redirect origin outside the trusted allowlist", async () => {
    const domain = createDomain();
    await expect(
      domain.startConnection(startInput({ redirectOrigin: "https://evil.test" })),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  // Fix round 1 (Critical): the session nonce is generated by this
  // function itself -- Office JavaScript cannot securely bind the browser
  // to an OAuth attempt via a cookie it sets itself (host-only on the
  // Office origin, never reaches the broker's callback origin, and can't
  // be HttpOnly). It is returned once (StartConnectionResult.sessionNonce,
  // for the route layer to build the broker's begin-ticket URL), passed
  // to the broker raw, and persisted only as its sha256 digest.
  it("generates the session nonce itself, passes it raw to the broker, and persists only its sha256 digest", async () => {
    const broker = fakeBrokerClient();
    const domain = createDomain(broker);
    const input = startInput();

    const result = await domain.startConnection(input);

    expect(result.sessionNonce).toMatch(/^[a-f0-9]{64}$/);
    expect(broker.startOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ sessionNonce: result.sessionNonce }),
    );
    const expectedDigest = createHash("sha256").update(result.sessionNonce).digest("hex");
    expect(result.attempt.sessionNonceDigest).toBe(expectedDigest);
    const storedRow = runtimeSql(
      `SELECT session_nonce_digest FROM app.mailbox_oauth_attempts WHERE id = '${result.attempt.id}'`,
    );
    expect(storedRow).toBe(expectedDigest);
    expect(storedRow).not.toContain(result.sessionNonce);
  });

  it("generates a different session nonce for two distinct (non-replay) start calls", async () => {
    const domain = createDomain();
    const first = await domain.startConnection(
      startInput({ tenantId: TENANT_ID_2, scope: { kind: "personal", profileId: PROFILE_ID_2 } }),
    );
    const second = await domain.startConnection(
      startInput({ tenantId: TENANT_ID_3, scope: { kind: "personal", profileId: PROFILE_ID_3 } }),
    );
    expect(first.sessionNonce).not.toBe(second.sessionNonce);
  });

  it("creates a pending connection and attempt, returning the broker's authorizationUrl", async () => {
    const domain = createDomain();
    const input = startInput({
      tenantId: TENANT_ID_2,
      scope: { kind: "personal", profileId: PROFILE_ID_2 },
    });

    const result = await domain.startConnection(input);

    expect(result.connection.status).toBe("pending");
    expect(result.connection.scope).toEqual({ kind: "personal", profileId: PROFILE_ID_2 });
    expect(result.attempt.status).toBe("pending");
    expect(result.attempt.connectionId).toBe(result.connection.id);
    expect(result.authorizationUrl).toContain(result.attempt.id);
  });

  it("replays an identical start request (same requestId) without calling the broker again", async () => {
    const broker = fakeBrokerClient();
    const domain = createDomain(broker);
    const input = startInput();

    const first = await domain.startConnection(input);
    const replay = await domain.startConnection(input);

    expect(replay).toEqual(first);
    expect(broker.startOAuth).toHaveBeenCalledTimes(1);
  });

  it("rejects the same requestId with a different payload (IDEMPOTENCY_CONFLICT)", async () => {
    const domain = createDomain();
    const input = startInput();

    await domain.startConnection(input);

    await expect(
      domain.startConnection({ ...input, timezone: "UTC" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  // Fix Round 2: the normalized request hash must cover every semantic
  // input the operation consumes, not just a subset -- otherwise the same
  // requestId can silently replay a *different* request's cached result.
  //
  // Fix round 1 (Critical): the "different sessionNonce (same requestId)"
  // case this list used to cover no longer applies -- sessionNonce is not
  // a caller-supplied input anymore (StartConnectionInput no longer has
  // one; it's generated inside startConnection and deliberately excluded
  // from the idempotency hash, since it's an implementation detail of
  // *how* the request is satisfied, not *what* was requested).
  it.each([
    [
      "a different actorUserId (same requestId)",
      (input: ReturnType<typeof startInput>) => ({ ...input, actorUserId: MEMBER_USER_ID }),
    ],
    [
      "a different scope (same requestId)",
      (input: ReturnType<typeof startInput>) => ({
        ...input,
        scope: { kind: "business" as const, businessId: BUSINESS_ID },
      }),
    ],
  ])("rejects the same requestId with %s (IDEMPOTENCY_CONFLICT)", async (_label, mutate) => {
    const domain = createDomain();
    const requestId = randomUUID();
    const input = startInput({ requestId });

    await domain.startConnection(input);

    await expect(domain.startConnection(mutate(input))).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  // Fix Round 2: concurrent first startConnection calls for a scope with
  // no existing connection must not crash on the scope-specific unique
  // index inside findOrCreateConnectionId -- it must race-safely converge
  // on exactly one connection row.
  it("two concurrent identical starts (same requestId) create exactly one connection and both callers get the same result", async () => {
    const domain = createDomain();
    const input = startInput({
      tenantId: TENANT_ID_3,
      scope: { kind: "personal", profileId: PROFILE_ID_3 },
    });

    const [first, second] = await Promise.all([
      domain.startConnection(input),
      domain.startConnection(input),
    ]);

    expect(second).toEqual(first);
    const connectionCount = runtimeSql(
      `SELECT count(*) FROM app.mailbox_connections WHERE tenant_id = '${TENANT_ID_3}' AND personal_profile_id = '${PROFILE_ID_3}'`,
    );
    expect(connectionCount).toBe("1");
  });

  it("two concurrent starts with different requestIds for the same scope converge on one connection row without crashing", async () => {
    const domain = createDomain();
    const inputA = startInput({
      tenantId: TENANT_ID_4,
      scope: { kind: "personal", profileId: PROFILE_ID_4 },
      requestId: randomUUID(),
    });
    const inputB = { ...inputA, requestId: randomUUID() };

    const [resultA, resultB] = await Promise.all([
      domain.startConnection(inputA),
      domain.startConnection(inputB),
    ]);

    // Different requestIds -> each gets its own ledger entry/attempt, but
    // find-or-create's contract means they must share the same
    // underlying connection -- never two rows for one scope, never an
    // unhandled unique-violation crash.
    expect(resultA.connection.id).toBe(resultB.connection.id);
    const connectionCount = runtimeSql(
      `SELECT count(*) FROM app.mailbox_connections WHERE tenant_id = '${TENANT_ID_4}' AND personal_profile_id = '${PROFILE_ID_4}'`,
    );
    expect(connectionCount).toBe("1");
  });

  describe("completeConnection", () => {
    async function consumedAttempt(domain: MailboxConnectionsDomain) {
      const started = await domain.startConnection(
        startInput({ scope: { kind: "personal", profileId: PROFILE_ID } }),
      );
      const consumed = await domain.consumeOAuthState({
        attemptId: started.attempt.id,
        connectionId: started.connection.id,
        stateDigest: started.attempt.stateDigest,
        sessionNonceDigest: started.attempt.sessionNonceDigest,
        requestId: randomUUID(),
      });
      return { started, consumed };
    }

    function completionInput(connectionId: string, attemptId: string, overrides: Record<string, unknown> = {}) {
      return {
        attemptId,
        connectionId,
        vaultReference: "vault-ref-1",
        providerAccountId: "provider-account-1",
        accountEmail: "mailbox@example.test",
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        initialHistoryId: "history-1",
        tokenGeneration: 1,
        requestId: randomUUID(),
        ...overrides,
      };
    }

    it("activates the connection via CAS only from 'consumed'", async () => {
      const domain = createDomain();
      const { started, consumed } = await consumedAttempt(domain);

      const record = await domain.completeConnection(
        completionInput(consumed.connectionId, consumed.attemptId),
      );

      expect(record.id).toBe(started.connection.id);
      expect(record.status).toBe("active");
      expect(record.vaultReference).toBe("vault-ref-1");
      expect(record.tokenGeneration).toBe(1);
      expect(record.providerAccountId).toBe("provider-account-1");
      expect(record.connectionVersion).toBe(2);
    });

    it("rejects completion before the attempt has been consumed", async () => {
      const domain = createDomain();
      const started = await domain.startConnection(
        startInput({ scope: { kind: "personal", profileId: PROFILE_ID } }),
      );

      await expect(
        domain.completeConnection(completionInput(started.connection.id, started.attempt.id)),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("replays an identical completion (same requestId) and rejects a changed one (IDEMPOTENCY_CONFLICT)", async () => {
      const domain = createDomain();
      const { consumed } = await consumedAttempt(domain);
      const input = completionInput(consumed.connectionId, consumed.attemptId);

      const first = await domain.completeConnection(input);
      const replay = await domain.completeConnection(input);
      expect(replay).toEqual(first);

      await expect(
        domain.completeConnection({ ...input, vaultReference: "vault-ref-DIFFERENT" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });

    it("rejects a mismatched connectionId/attemptId pair (wrong connection/tenant)", async () => {
      const domain = createDomain();
      const first = await domain.startConnection(
        startInput({ scope: { kind: "personal", profileId: PROFILE_ID } }),
      );
      const second = await domain.startConnection(
        startInput({
          tenantId: TENANT_ID_2,
          scope: { kind: "personal", profileId: PROFILE_ID_2 },
        }),
      );

      await expect(
        domain.completeConnection(
          completionInput(second.connection.id, first.attempt.id),
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  // Phase 3D-A Task 4 -- closes the gap flagged by Task 2 Ruling 3 / Task 3
  // Ruling 4: services/mailbox-broker/src/app-client.ts's recordRevocation
  // had no App-side domain function until now.
  describe("recordRevocation", () => {
    async function activeConnection(domain: MailboxConnectionsDomain, tenantId: string, profileId: string) {
      const started = await domain.startConnection(
        startInput({ tenantId, scope: { kind: "personal", profileId } }),
      );
      const consumed = await domain.consumeOAuthState({
        attemptId: started.attempt.id,
        connectionId: started.connection.id,
        stateDigest: started.attempt.stateDigest,
        sessionNonceDigest: started.attempt.sessionNonceDigest,
        requestId: randomUUID(),
      });
      await domain.completeConnection({
        attemptId: consumed.attemptId,
        connectionId: consumed.connectionId,
        vaultReference: "vault-ref-revoke",
        providerAccountId: "provider-account-revoke",
        accountEmail: "mailbox-revoke@example.test",
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        initialHistoryId: "history-revoke",
        tokenGeneration: 1,
        requestId: randomUUID(),
      });
      return started.connection.id;
    }

    it("marks a connection revoked and sets revokedAt", async () => {
      const domain = createDomain();
      const connectionId = await activeConnection(domain, TENANT_ID_2, PROFILE_ID_2);

      const result = await domain.recordRevocation({
        connectionId,
        operationId: randomUUID(),
        status: "revoked",
      });

      expect(result.id).toBe(connectionId);
      expect(result.status).toBe("revoked");
      expect(result.revokedAt).not.toBeNull();
    });

    it("marks revocation_pending without setting revokedAt", async () => {
      const domain = createDomain();
      const connectionId = await activeConnection(domain, TENANT_ID_3, PROFILE_ID_3);

      const result = await domain.recordRevocation({
        connectionId,
        operationId: randomUUID(),
        status: "revocation_pending",
      });

      expect(result.status).toBe("revocation_pending");
      expect(result.revokedAt).toBeNull();
    });

    it("replays an identical revocation (same operationId) and rejects a changed one (IDEMPOTENCY_CONFLICT)", async () => {
      const domain = createDomain();
      const connectionId = await activeConnection(domain, TENANT_ID_4, PROFILE_ID_4);
      const operationId = randomUUID();

      const first = await domain.recordRevocation({ connectionId, operationId, status: "revoked" });
      const replay = await domain.recordRevocation({ connectionId, operationId, status: "revoked" });
      expect(replay).toEqual(first);

      await expect(
        domain.recordRevocation({ connectionId, operationId, status: "revocation_pending" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });

    it("rejects an unknown connectionId", async () => {
      const domain = createDomain();
      await expect(
        domain.recordRevocation({ connectionId: randomUUID(), operationId: randomUUID(), status: "revoked" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  // Fix round 1 (Important) -- the minimal authenticated, scope-authorized
  // read the Office mailbox page needs instead of static scaffolding.
  describe("getConnection", () => {
    it("returns null for a scope with no connection", async () => {
      const domain = createDomain();
      const result = await domain.getConnection({
        actorUserId: OWNER_USER_ID,
        tenantId: TENANT_ID_5,
        scope: { kind: "personal", profileId: PROFILE_ID_5 },
      });
      expect(result).toBeNull();
    });

    it("returns the connection once one exists for the scope", async () => {
      const domain = createDomain();
      const started = await domain.startConnection(
        startInput({ tenantId: TENANT_ID_5, scope: { kind: "personal", profileId: PROFILE_ID_5 } }),
      );

      const result = await domain.getConnection({
        actorUserId: OWNER_USER_ID,
        tenantId: TENANT_ID_5,
        scope: { kind: "personal", profileId: PROFILE_ID_5 },
      });

      expect(result?.id).toBe(started.connection.id);
      expect(result?.status).toBe("pending");
    });

    it("rejects an actor with no access to the requested scope", async () => {
      const domain = createDomain();
      await expect(
        domain.getConnection({
          actorUserId: OUTSIDER_USER_ID,
          tenantId: TENANT_ID,
          scope: { kind: "personal", profileId: PROFILE_ID },
        }),
      ).rejects.toThrow(DomainError.notFound().message);
    });
  });
});

// -------------------------------------------------------------------- //
// routes/mailbox-connections.ts — negative-auth coverage (no live DB).
//
// Unit-tested directly against a minimal Fastify instance (no buildApp --
// this route module isn't wired into app.ts until Task 4). Proves every
// one of the four internal routes rejects a wrong subject, the existing
// App worker's own subject/audience, and a tenant token -- same pattern as
// test/auth.test.ts's "rejects a tenant token on the service guard".
// -------------------------------------------------------------------- //

const BROKER_SUBJECT = "mailbox-broker-app";
const SERVICE_AUDIENCE = "expense-app-internal";

function servicePrincipal(subject: string, scopes: readonly string[]): AuthPrincipal {
  return {
    tokenType: "service",
    subject,
    clientId: subject,
    audience: SERVICE_AUDIENCE,
    issuer: "https://services.test",
    roles: [],
    scopes,
    tokenId: `${subject}-token-id`,
    email: null,
    emailVerified: null,
    displayName: null,
  };
}

describe("routes/mailbox-connections.ts — broker-only auth guard (no live DB)", () => {
  const apps = new Set<ReturnType<typeof Fastify>>();

  afterAll(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const mailboxConnectionsDomain: MailboxConnectionsDomain = {
      startConnection: vi.fn(),
      getConnection: vi.fn(),
      consumeOAuthState: vi.fn(async () => ({
        connectionId: randomUUID(),
        attemptId: randomUUID(),
        redirectOrigin: ALLOWED_ORIGIN,
      })),
      completeConnection: vi.fn(),
      acquireTokenOperationLease: vi.fn(async () => ({
        connectionId: randomUUID(),
        leaseId: randomUUID(),
        expiresAt: new Date().toISOString(),
        expectedConnectionVersion: 1,
        currentTokenGeneration: 1,
      })),
      advanceTokenGeneration: vi.fn(async () => ({
        connectionVersion: 2,
        tokenGeneration: 2,
        vaultReference: "vault-ref",
      })),
      releaseTokenOperationLease: vi.fn(async () => undefined),
      recordRevocation: vi.fn(),
    };

    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => {
        if (token === "broker-token") {
          return servicePrincipal(BROKER_SUBJECT, ["mailbox:write"]);
        }
        if (token === "wrong-subject-token") {
          return servicePrincipal("some-other-service", ["mailbox:write"]);
        }
        if (token === "app-worker-token") {
          // The existing App worker's own real subject -- must not
          // accidentally satisfy the broker-only guard.
          return servicePrincipal("ai-worker-app-machine", ["mailbox:write", "jobs:write"]);
        }
        if (token === "missing-scope-token") {
          return servicePrincipal(BROKER_SUBJECT, []);
        }
        if (token === "tenant-token") {
          // A real tenant token fails the *service* verifier outright
          // (wrong issuer/audience/signing key) -- never reaches subject
          // comparison. Simulated here the same way test/jobs.test.ts
          // simulates an audience mismatch: throw before the guard runs.
          throw new Error("tenant token rejected by service verifier");
        }
        throw new Error("unknown token");
      }),
    };

    const app = Fastify({ logger: false });
    apps.add(app);
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerErrorHandlers(app);
    registerAuthPlugin(app, {
      authVerifiers: {
        tenant: { verify: vi.fn(async () => { throw new Error("no tenant tokens in this test"); }) },
        service: serviceVerifier,
      },
    });
    app.register(registerMailboxConnectionRoutes, { mailboxConnectionsDomain });

    return { app: app.withTypeProvider<ZodTypeProvider>(), mailboxConnectionsDomain };
  }

  const ROUTES = [
    {
      name: "consume",
      method: "POST" as const,
      url: `/internal/v1/mailbox/oauth/attempts/${randomUUID()}/consume`,
      payload: {
        connectionId: randomUUID(),
        stateDigest: "a".repeat(64),
        sessionNonceDigest: "a".repeat(64),
        requestId: randomUUID(),
      },
    },
    {
      name: "lease",
      method: "POST" as const,
      url: `/internal/v1/mailbox/connections/${randomUUID()}/token-operations/lease`,
      payload: { operationId: randomUUID(), ttlSeconds: 60 },
    },
    {
      name: "advance",
      method: "POST" as const,
      url: `/internal/v1/mailbox/connections/${randomUUID()}/token-operations/advance`,
      payload: {
        leaseId: randomUUID(),
        expectedConnectionVersion: 1,
        newGeneration: 2,
        vaultReference: "vault-ref",
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      },
    },
    {
      name: "release",
      method: "POST" as const,
      url: `/internal/v1/mailbox/connections/${randomUUID()}/token-operations/release`,
      payload: { leaseId: randomUUID() },
    },
  ];

  for (const route of ROUTES) {
    describe(route.name, () => {
      it("accepts the broker's own service principal", async () => {
        const { app } = createTestApp();
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers: { authorization: "Bearer broker-token" },
          payload: route.payload,
        });
        expect([200, 204]).toContain(response.statusCode);
      });

      it("rejects a wrong subject", async () => {
        const { app, mailboxConnectionsDomain } = createTestApp();
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers: { authorization: "Bearer wrong-subject-token" },
          payload: route.payload,
        });
        expect(response.statusCode).toBe(403);
        expect(Object.values(mailboxConnectionsDomain).every((fn) => !(fn as ReturnType<typeof vi.fn>).mock?.calls.length)).toBe(true);
      });

      it("rejects the existing App worker's own subject/audience", async () => {
        const { app } = createTestApp();
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers: { authorization: "Bearer app-worker-token" },
          payload: route.payload,
        });
        expect(response.statusCode).toBe(403);
      });

      it("rejects a service principal missing the mailbox:write scope", async () => {
        const { app } = createTestApp();
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers: { authorization: "Bearer missing-scope-token" },
          payload: route.payload,
        });
        expect(response.statusCode).toBe(403);
      });

      it("rejects a tenant token on the service guard", async () => {
        const { app } = createTestApp();
        const response = await app.inject({
          method: route.method,
          url: route.url,
          headers: { authorization: "Bearer tenant-token" },
          payload: route.payload,
        });
        expect(response.statusCode).toBe(401);
      });
    });
  }
});
