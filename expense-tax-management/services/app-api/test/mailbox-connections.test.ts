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
        ('${OUTSIDER_USER_ID}', 't2m-outsider@example.test', 'T2M Outsider')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.tenants (id, name, slug, status) VALUES
        ('${TENANT_ID}', 'T2M Tenant', 't2m-tenant-${runKey}', 'active'),
        ('${TENANT_ID_2}', 'T2M Tenant 2', 't2m-tenant2-${runKey}', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status) VALUES
        ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active'),
        ('${TENANT_ID_2}', '${OWNER_USER_ID}', 'owner', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.personal_profiles (id, tenant_id, name) VALUES
        ('${PROFILE_ID}', '${TENANT_ID}', 'T2M Profile'),
        ('${PROFILE_ID_2}', '${TENANT_ID_2}', 'T2M Profile 2')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status) VALUES
        ('${PROFILE_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active'),
        ('${PROFILE_ID_2}', '${TENANT_ID_2}', '${OWNER_USER_ID}', 'owner', 'active')
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
      sessionNonce: `session-nonce-${randomUUID()}`,
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

  it("passes the raw session nonce to the broker but persists only its sha256 digest", async () => {
    const broker = fakeBrokerClient();
    const domain = createDomain(broker);
    const input = startInput();

    const result = await domain.startConnection(input);

    expect(broker.startOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ sessionNonce: input.sessionNonce }),
    );
    const expectedDigest = createHash("sha256").update(input.sessionNonce).digest("hex");
    expect(result.attempt.sessionNonceDigest).toBe(expectedDigest);
    const storedRow = runtimeSql(
      `SELECT session_nonce_digest FROM app.mailbox_oauth_attempts WHERE id = '${result.attempt.id}'`,
    );
    expect(storedRow).toBe(expectedDigest);
    expect(storedRow).not.toContain(input.sessionNonce);
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

    it("replays an identical completion and rejects a changed one (OAUTH_REPLAY)", async () => {
      const domain = createDomain();
      const { consumed } = await consumedAttempt(domain);
      const input = completionInput(consumed.connectionId, consumed.attemptId);

      const first = await domain.completeConnection(input);
      const replay = await domain.completeConnection(input);
      expect(replay).toEqual(first);

      await expect(
        domain.completeConnection({ ...input, vaultReference: "vault-ref-DIFFERENT" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
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
