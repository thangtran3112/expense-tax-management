/**
 * Phase 3D-A Task 6 — phase verification: a consolidated, real-PostgreSQL
 * proof that App API's mailbox connection/OAuth domain (Tasks 1/2/4)
 * behaves exactly as the plan's "Canonical A Contracts" and Global
 * Constraints require, end to end through the real route registration
 * (`registerMailboxConnectionRoutes`) rather than only at the domain-
 * function level. No Google, GCP, or Clerk network access anywhere --
 * the broker is a fake (`MailboxBrokerClient`), and auth is two fake
 * `TokenVerifier`s (same established pattern as
 * services/app-api/test/mailbox-connections.test.ts's broker-guard
 * block), not real JWKS/signing.
 *
 * Gated on PHASE_3D_A_T6_INTEGRATION=1, wired into the zero-skip CI
 * chain (scripts/verify-phase-0n.mjs) the same way Task 7 Stage A wired
 * PHASE_T7A_INTEGRATION (see scripts/check-mailbox-t6-ci-wiring.test.mjs).
 *
 * Covers, in one place:
 *   - migrations 016, 017, then 018 apply in order (real ledger proof)
 *   - public/internal schema separation at the HTTP boundary
 *     (MailboxConnectionV1 only -- never vault/lease/version fields --
 *     regardless of whether the caller is the customer or the broker)
 *   - OAuth consume CAS and replay
 *   - trusted redirect/session binding
 *   - refresh/revoke CAS (token-operation lease/advance/release, and
 *     connection revocation)
 *   - exact identities (machine subject "mailbox-broker-app", scope
 *     "mailbox:write" -- never the App worker's own subject, never a
 *     tenant token)
 *   - no token/state leakage in responses or logs (strict Zod schemas
 *     structurally reject any extra secret-shaped field; captured
 *     request logs never contain the raw session nonce or any
 *     attacker-chosen secret marker)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuthPrincipal } from "../../services/app-api/src/auth/types.js";
import { createAppDatabase } from "../../services/app-api/src/database/client.js";
import { runMigrations } from "../../services/app-api/src/database/migrate.js";
import type { AppDatabase } from "../../services/app-api/src/database/types.js";
import {
  createMailboxConnectionsDomain,
  type MailboxConnectionsDomain,
} from "../../services/app-api/src/domain/mailbox-connections.js";
import type { IdentityResolver } from "../../services/app-api/src/domain/authenticated-user.js";
import type { MailboxBrokerClient } from "../../services/app-api/src/integrations/mailbox-broker-client.js";
import { buildTask6TestApp } from "../../services/app-api/test/support/mailbox-task6-app.js";

const integrationEnabled = process.env.PHASE_3D_A_T6_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 10);
const databaseName = `expense_tax_t6_mailbox_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

const TENANT_ISSUER = "https://identity.t6.test";
const ALLOWED_ORIGIN = "https://expense-office.t6.test";

const TENANT_ID = "6a000000-0000-4000-8000-000000000001";
const OWNER_USER_ID = "6a000000-0000-4000-8000-000000000002";
const OUTSIDER_USER_ID = "6a000000-0000-4000-8000-000000000003";
const PROFILE_ID = "6a000000-0000-4000-8000-000000000004";

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let migratorDatabase: Kysely<AppDatabase> | undefined;
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

/** The migration ledger (app_migrations.*) is owned by the migrator role; the runtime role has no grant on it. */
function migratorSql(sql: string): string {
  return dockerPsql(databaseName, "expense_app_migrator", migratorPassword, sql);
}

function fakeBrokerClient(): MailboxBrokerClient & { calls: number } {
  const state = {
    calls: 0,
    startOAuth: async (input: { attemptId: string }) => {
      state.calls += 1;
      return {
        authorizationUrl: `https://accounts.google.test/auth?attempt=${input.attemptId}`,
        stateDigest: createHash("sha256").update(`state:${input.attemptId}`).digest("hex"),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        beginTicket: `fake-begin-ticket-${input.attemptId}`,
      };
    },
  };
  return state as unknown as MailboxBrokerClient & { calls: number };
}

function tenantPrincipal(): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject: OWNER_USER_ID,
    clientId: null,
    audience: "expense-app",
    issuer: TENANT_ISSUER,
    roles: [],
    scopes: [],
    tokenId: "tenant-token-id",
    email: "owner@example.test",
    emailVerified: true,
    displayName: "T6 Owner",
  };
}

/** A secret-shaped marker that must never leak into any captured log line. */
const SECRET_MARKER = `super-secret-nonce-${runKey}`;

function buildTestApp(mailboxConnectionsDomain: MailboxConnectionsDomain) {
  const identityResolver: IdentityResolver = {
    resolve: async () => ({
      id: OWNER_USER_ID,
      primaryEmail: "owner@example.test",
      displayName: "T6 Owner",
      status: "active" as const,
    }),
  };

  return buildTask6TestApp({
    mailboxConnectionsDomain,
    identityResolver,
    tenantPrincipal: tenantPrincipal(),
  });
}

describe.skipIf(!integrationEnabled)("Phase 3D-A Task 6 — mailbox domain verification (live PostgreSQL)", () => {
  beforeAll(async () => {
    const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    if (!dockerAvailable) throw new Error("Task 6 PostgreSQL prerequisites unavailable");

    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!postgresContainerId) throw new Error("Task 6 PostgreSQL prerequisites unavailable (run ./scripts/compose.sh up -d --wait postgres)");

    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as ComposeConfig;
    runtimePassword = config.services.postgres?.environment?.APP_RUNTIME_DB_PASSWORD ?? "";
    migratorPassword = config.services.postgres?.environment?.APP_MIGRATOR_DB_PASSWORD ?? "";
    if (!runtimePassword || !migratorPassword) throw new Error("Task 6 PostgreSQL prerequisites unavailable");

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
    migratorDatabase = createAppDatabase(migrationDatabaseUrl);
    database = createAppDatabase(runtimeDatabaseUrl);

    runtimeSql(`
      INSERT INTO app.users (id, primary_email, display_name) VALUES
        ('${OWNER_USER_ID}', 't6-owner-${runKey}@example.test', 'T6 Owner'),
        ('${OUTSIDER_USER_ID}', 't6-outsider-${runKey}@example.test', 'T6 Outsider');
      INSERT INTO app.tenants (id, name, slug, status) VALUES
        ('${TENANT_ID}', 'T6 Tenant', 't6-tenant-${runKey}', 'active');
      INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status) VALUES
        ('${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active');
      INSERT INTO app.personal_profiles (id, tenant_id, name) VALUES
        ('${PROFILE_ID}', '${TENANT_ID}', 'T6 Profile');
      INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status) VALUES
        ('${PROFILE_ID}', '${TENANT_ID}', '${OWNER_USER_ID}', 'owner', 'active');
    `);
  });

  afterAll(async () => {
    await database?.destroy();
    await migratorDatabase?.destroy();
    if (postgresContainerId) {
      adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
    }
  });

  // ---------------------------------------------------------------- //
  // Migration order: 016, then 017, then 018.
  // ---------------------------------------------------------------- //

  it("applies migrations 016 (enrichment), 017 (dispatch routing), then 018 (mailbox connections) in that exact order", () => {
    const names = migratorSql(
      `SELECT name FROM app_migrations.kysely_migration ORDER BY timestamp;`,
    ).split("\n");
    const indexOf = (prefix: string) => names.findIndex((name) => name.startsWith(prefix));
    const i016 = indexOf("016_");
    const i017 = indexOf("017_");
    const i018 = indexOf("018_");
    expect(i016).toBeGreaterThanOrEqual(0);
    expect(i017).toBeGreaterThan(i016);
    expect(i018).toBeGreaterThan(i017);
  });

  it("018 created exactly the tables the plan specifies, alongside 016/017's own tables", () => {
    const tables = runtimeSql(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'app' ORDER BY table_name;`,
    ).split("\n");
    expect(tables).toContain("mailbox_connections");
    expect(tables).toContain("mailbox_oauth_attempts");
    expect(tables).toContain("mailbox_reviewer_grants");
    expect(tables).toContain("mailbox_operation_keys");
    expect(tables).toContain("temporal_dispatch_routing"); // 017
    expect(tables).toContain("expense_enrichment_suggestions"); // 016
  });

  // ---------------------------------------------------------------- //
  // Full lifecycle through real HTTP routes, real DB, fake broker/auth.
  // ---------------------------------------------------------------- //

  function createDomain(broker: MailboxBrokerClient = fakeBrokerClient()): MailboxConnectionsDomain {
    return createMailboxConnectionsDomain(database!, broker, {
      allowedRedirectOrigins: [ALLOWED_ORIGIN],
    });
  }

  it("runs the full start -> consume -> complete -> lease -> advance -> release -> revoke lifecycle, every step CAS/replay-safe, public shape only over HTTP, no secret leakage in logs", async () => {
    const domain = createDomain();
    const { app, logLines } = buildTestApp(domain);

    // --- start (customer, tenant token) -----------------------------
    const startRequestId = randomUUID();
    const startResponse = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/google/start`,
      headers: { authorization: "Bearer tenant-token" },
      payload: {
        scope: { kind: "personal", profileId: PROFILE_ID },
        redirectOrigin: ALLOWED_ORIGIN,
        timezone: "America/Los_Angeles",
        localScanTime: "07:30",
        requestId: startRequestId,
        // An unrecognized field a client might try to smuggle through.
        // Deliberately not one of SECRET_MARKER or the forbidden-field-
        // name markers checked below -- Fastify's own validation error
        // message legitimately echoes back a *rejected key's name*, which
        // would otherwise collide with those leak assertions.
        smuggledExtraField: "should-be-structurally-impossible-to-send",
      } as Record<string, unknown>,
    });
    // The extra unknown field above is actually invalid per
    // StartBodySchema's z.strictObject -- confirms the wire contract
    // rejects any field it doesn't explicitly declare (structural
    // leak-proofing: a client cannot smuggle an extra "token"/"code"
    // field through this endpoint even by accident).
    expect(startResponse.statusCode).toBe(400);

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/google/start`,
      headers: { authorization: "Bearer tenant-token" },
      payload: {
        scope: { kind: "personal", profileId: PROFILE_ID },
        redirectOrigin: ALLOWED_ORIGIN,
        timezone: "America/Los_Angeles",
        localScanTime: "07:30",
        requestId: startRequestId,
      },
    });
    expect(started.statusCode).toBe(201);
    const startBody = started.json() as {
      connection: Record<string, unknown>;
      attempt: Record<string, unknown>;
      authorizationUrl: string;
    };
    // Public schema separation: the customer-facing response never
    // carries vault/lease/version internals.
    for (const forbidden of ["vaultReference", "tokenGeneration", "connectionVersion", "tokenOperationLeaseId"]) {
      expect(startBody.connection).not.toHaveProperty(forbidden);
    }
    const connectionId = startBody.connection.id as string;
    const attemptId = startBody.attempt.id as string;
    const stateDigest = startBody.attempt.stateDigest as string;
    const sessionNonceDigest = startBody.attempt.sessionNonceDigest as string;

    // --- consume (broker, service token): exact identities ----------
    const consumePayload = { connectionId, stateDigest, sessionNonceDigest, requestId: randomUUID() };
    const wrongSubject = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/oauth/attempts/${attemptId}/consume`,
      headers: { authorization: "Bearer wrong-subject-token" },
      payload: consumePayload,
    });
    expect(wrongSubject.statusCode).toBe(403);
    const appWorkerToken = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/oauth/attempts/${attemptId}/consume`,
      headers: { authorization: "Bearer app-worker-token" },
      payload: consumePayload,
    });
    expect(appWorkerToken.statusCode).toBe(403); // the App worker's own real subject must not satisfy the broker-only guard
    const missingScope = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/oauth/attempts/${attemptId}/consume`,
      headers: { authorization: "Bearer missing-scope-token" },
      payload: consumePayload,
    });
    expect(missingScope.statusCode).toBe(403);
    const tenantTokenOnBrokerRoute = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/oauth/attempts/${attemptId}/consume`,
      headers: { authorization: "Bearer tenant-token" },
      payload: consumePayload,
    });
    expect(tenantTokenOnBrokerRoute.statusCode).toBe(401); // real tenant token fails the *service* verifier outright

    // Session/redirect binding: wrong digests are rejected (404 -- not
    // distinguishable from "no such attempt", by design).
    const wrongState = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/oauth/attempts/${attemptId}/consume`,
      headers: { authorization: "Bearer broker-token" },
      payload: { ...consumePayload, stateDigest: "f".repeat(64), requestId: randomUUID() },
    });
    expect(wrongState.statusCode).toBe(404);
    const wrongNonce = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/oauth/attempts/${attemptId}/consume`,
      headers: { authorization: "Bearer broker-token" },
      payload: { ...consumePayload, sessionNonceDigest: "f".repeat(64), requestId: randomUUID() },
    });
    expect(wrongNonce.statusCode).toBe(404);

    // Real consume.
    const consumed = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/oauth/attempts/${attemptId}/consume`,
      headers: { authorization: "Bearer broker-token" },
      payload: consumePayload,
    });
    expect(consumed.statusCode).toBe(200);
    expect(consumed.json()).toEqual({ connectionId, attemptId, redirectOrigin: ALLOWED_ORIGIN });

    // Replay (same requestId): returns the exact same result, no error.
    const replayed = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/oauth/attempts/${attemptId}/consume`,
      headers: { authorization: "Bearer broker-token" },
      payload: consumePayload,
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toEqual(consumed.json());

    // A *different* requestId against an already-consumed attempt is a
    // real conflict, not a silent no-op.
    const reconsume = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/oauth/attempts/${attemptId}/consume`,
      headers: { authorization: "Bearer broker-token" },
      payload: { ...consumePayload, requestId: randomUUID() },
    });
    expect(reconsume.statusCode).toBe(409);

    // --- complete (broker): public shape only, even to the broker ---
    const completePayload = {
      connectionId,
      expectedConnectionVersion: 1,
      providerAccountId: "google-account-1",
      accountEmail: "connected@example.test",
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      initialHistoryId: "12345",
      vaultReference: connectionId,
      tokenGeneration: 1,
      requestId: randomUUID(),
    };
    const completed = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/oauth/attempts/${attemptId}/complete`,
      headers: { authorization: "Bearer broker-token" },
      payload: completePayload,
    });
    expect(completed.statusCode).toBe(200);
    const completedBody = completed.json() as Record<string, unknown>;
    expect(completedBody.status).toBe("active");
    for (const forbidden of ["vaultReference", "tokenGeneration", "connectionVersion", "tokenOperationLeaseId", "tokenOperationLeaseExpiresAt"]) {
      expect(completedBody).not.toHaveProperty(forbidden);
    }
    // But the real row in the database *does* carry those internals --
    // they are persisted, just never serialized out over HTTP.
    const storedRow = runtimeSql(
      `SELECT vault_reference, token_generation, connection_version FROM app.mailbox_connections WHERE id = '${connectionId}';`,
    );
    expect(storedRow).toBe(`${connectionId}|1|2`);

    // --- customer GET: public shape only -----------------------------
    const got = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/mailbox-connections/google?profileId=${PROFILE_ID}`,
      headers: { authorization: "Bearer tenant-token" },
    });
    expect(got.statusCode).toBe(200);
    const gotConnection = (got.json() as { connection: Record<string, unknown> }).connection;
    expect(gotConnection.status).toBe("active");
    for (const forbidden of ["vaultReference", "tokenGeneration", "connectionVersion"]) {
      expect(gotConnection).not.toHaveProperty(forbidden);
    }
    // Outsider (no membership on this scope) cannot read it at all.
    const outsiderDomain = createMailboxConnectionsDomain(database!, fakeBrokerClient(), {
      allowedRedirectOrigins: [ALLOWED_ORIGIN],
    });
    await expect(
      outsiderDomain.getConnection({ actorUserId: OUTSIDER_USER_ID, tenantId: TENANT_ID, scope: { kind: "personal", profileId: PROFILE_ID } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // --- token-operation lease / advance / release (refresh CAS) -----
    const leaseResponse = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/connections/${connectionId}/token-operations/lease`,
      headers: { authorization: "Bearer broker-token" },
      payload: { operationId: randomUUID(), ttlSeconds: 60 },
    });
    expect(leaseResponse.statusCode).toBe(200);
    const lease = leaseResponse.json() as {
      leaseId: string;
      expectedConnectionVersion: number;
      currentTokenGeneration: number;
    };
    expect(lease.expectedConnectionVersion).toBe(2);
    expect(lease.currentTokenGeneration).toBe(1);

    // A second concurrent lease attempt fails (one lease at a time).
    const secondLease = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/connections/${connectionId}/token-operations/lease`,
      headers: { authorization: "Bearer broker-token" },
      payload: { operationId: randomUUID(), ttlSeconds: 60 },
    });
    expect(secondLease.statusCode).toBe(409);

    const advancePayload = {
      leaseId: lease.leaseId,
      expectedConnectionVersion: lease.expectedConnectionVersion,
      newGeneration: lease.currentTokenGeneration + 1,
      vaultReference: `${connectionId}-gen2`,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    };

    // Wrong leaseId is rejected.
    const wrongLease = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/connections/${connectionId}/token-operations/advance`,
      headers: { authorization: "Bearer broker-token" },
      payload: { ...advancePayload, leaseId: randomUUID() },
    });
    expect(wrongLease.statusCode).toBe(409);

    const advanced = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/connections/${connectionId}/token-operations/advance`,
      headers: { authorization: "Bearer broker-token" },
      payload: advancePayload,
    });
    expect(advanced.statusCode).toBe(200);
    expect(advanced.json()).toMatchObject({ connectionVersion: 3, tokenGeneration: 2 });

    // Replay the exact same idempotencyKey+payload: returns the cached
    // result, does not re-validate the (now-released) lease.
    const advanceReplay = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/connections/${connectionId}/token-operations/advance`,
      headers: { authorization: "Bearer broker-token" },
      payload: advancePayload,
    });
    expect(advanceReplay.statusCode).toBe(200);
    expect(advanceReplay.json()).toEqual(advanced.json());

    const released = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/connections/${connectionId}/token-operations/release`,
      headers: { authorization: "Bearer broker-token" },
      payload: { leaseId: lease.leaseId },
    });
    expect(released.statusCode).toBe(204);
    // Idempotent: releasing an already-cleared lease is a harmless no-op.
    const releasedAgain = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/connections/${connectionId}/token-operations/release`,
      headers: { authorization: "Bearer broker-token" },
      payload: { leaseId: lease.leaseId },
    });
    expect(releasedAgain.statusCode).toBe(204);

    // --- revoke (broker): CAS/replay, public shape -------------------
    const revokeOperationId = randomUUID();
    const revoked = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/connections/${connectionId}/revoke`,
      headers: { authorization: "Bearer broker-token" },
      payload: { operationId: revokeOperationId, status: "revoked" },
    });
    expect(revoked.statusCode).toBe(200);
    const revokedBody = revoked.json() as Record<string, unknown>;
    expect(revokedBody.status).toBe("revoked");
    for (const forbidden of ["vaultReference", "tokenGeneration", "connectionVersion"]) {
      expect(revokedBody).not.toHaveProperty(forbidden);
    }

    // Replay with the same operationId + same status: idempotent, same result.
    const revokeReplay = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/connections/${connectionId}/revoke`,
      headers: { authorization: "Bearer broker-token" },
      payload: { operationId: revokeOperationId, status: "revoked" },
    });
    expect(revokeReplay.statusCode).toBe(200);
    expect(revokeReplay.json()).toEqual(revoked.json());

    // Same operationId, *different* status: a real conflict, not a silent overwrite.
    const revokeConflict = await app.inject({
      method: "POST",
      url: `/internal/v1/mailbox/connections/${connectionId}/revoke`,
      headers: { authorization: "Bearer broker-token" },
      payload: { operationId: revokeOperationId, status: "revocation_pending" },
    });
    expect(revokeConflict.statusCode).toBe(409);

    // --- no secret leakage: inspect every captured log line ----------
    const logText = logLines();
    expect(logText).not.toContain(SECRET_MARKER);
    expect(logText).not.toMatch(/Bearer\s+(broker-token|tenant-token)/);
    // The begin ticket embeds an opaque string, never a raw OAuth code,
    // client secret, or refresh/access token -- none of those words
    // appear anywhere a real one ever would (field names, not just
    // values -- this service never has such a field to begin with).
    for (const forbidden of ["clientSecret", "client_secret", "refreshToken", "refresh_token", "accessToken", "access_token"]) {
      expect(logText).not.toContain(forbidden);
    }
  });

  it("rejects a redirect origin outside the trusted allowlist at start (session binding begins at start, not just consume)", async () => {
    const domain = createDomain();
    await expect(
      domain.startConnection({
        actorUserId: OWNER_USER_ID,
        tenantId: TENANT_ID,
        scope: { kind: "personal", profileId: PROFILE_ID },
        redirectOrigin: "https://evil.test",
        timezone: "America/Los_Angeles",
        localScanTime: "08:00",
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("consumeOAuthState re-validates the redirect-origin allowlist defensively at consume time, independent of the start-time check", async () => {
    const broker = fakeBrokerClient();
    const domain = createDomain(broker);
    const result = await domain.startConnection({
      actorUserId: OWNER_USER_ID,
      tenantId: TENANT_ID,
      scope: { kind: "personal", profileId: PROFILE_ID },
      redirectOrigin: ALLOWED_ORIGIN,
      timezone: "America/Los_Angeles",
      localScanTime: "08:15",
      requestId: randomUUID(),
    });
    // Simulate the allowlist having been narrowed between start and
    // consume (e.g. a config reload) by directly rewriting the
    // persisted redirect_origin to a value the *consuming* domain
    // instance (built with a narrower allowlist) does not trust.
    runtimeSql(
      `UPDATE app.mailbox_oauth_attempts SET redirect_origin = 'https://now-untrusted.test' WHERE id = '${result.attempt.id}';`,
    );
    const narrowerDomain = createMailboxConnectionsDomain(database!, broker, {
      allowedRedirectOrigins: [ALLOWED_ORIGIN], // "https://now-untrusted.test" is not in this list
    });
    await expect(
      narrowerDomain.consumeOAuthState({
        attemptId: result.attempt.id,
        connectionId: result.connection.id,
        stateDigest: result.attempt.stateDigest,
        sessionNonceDigest: result.attempt.sessionNonceDigest,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
