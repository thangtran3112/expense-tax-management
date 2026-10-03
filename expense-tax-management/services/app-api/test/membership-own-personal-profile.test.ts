/**
 * Phase 3D-A Task 4, fix round 3 — domain/memberships.ts:
 * getOwnPersonalProfile.
 *
 * Real-PostgreSQL coverage (PHASE_3D_A_T4FR3_INTEGRATION=1), same
 * ephemeral-database pattern as mailbox-connections.test.ts.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAppDatabase } from "../src/database/client.js";
import type { AppDatabase } from "../src/database/types.js";
import { runMigrations } from "../src/database/migrate.js";
import { createMembershipDomain, type MembershipDomain } from "../src/domain/memberships.js";

const requested = process.env.PHASE_3D_A_T4FR3_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_t4fr3_${runKey}`;

interface ComposeConfig {
  readonly services: Record<string, { readonly environment?: Record<string, string | null> }>;
}

// Tenant A: OWNER_USER has an active personal_membership on its one
// personal profile; MEMBER_USER has only a tenant_membership (business-
// only member, never granted personal access).
const TENANT_A = "7b000000-0000-4000-8000-000000000001";
const OWNER_USER = "7b000000-0000-4000-8000-000000000002";
const MEMBER_USER = "7b000000-0000-4000-8000-000000000003";
const PROFILE_A = "7b000000-0000-4000-8000-000000000004";

// Tenant B: a completely different tenant/profile/owner, to prove
// cross-tenant isolation (OWNER_USER's own profile is in tenant A; this
// must never leak when queried against tenant B).
const TENANT_B = "7b000000-0000-4000-8000-000000000005";
const PROFILE_B = "7b000000-0000-4000-8000-000000000006";
const OWNER_USER_B = "7b000000-0000-4000-8000-000000000007";

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

describe.skipIf(!requested)("domain/memberships.ts — getOwnPersonalProfile (live PostgreSQL)", () => {
  let membershipDomain: MembershipDomain;

  beforeAll(async () => {
    const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
    if (!dockerAvailable) throw new Error("Fix round 3 PostgreSQL prerequisites unavailable");

    let postgresRunning = false;
    try {
      postgresRunning =
        execFileSync(composeScript, ["ps", "-q", "postgres"], {
          cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim().length > 0;
    } catch {
      postgresRunning = false;
    }
    if (!postgresRunning) throw new Error("Fix round 3 PostgreSQL prerequisites unavailable");

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
      throw new Error("Fix round 3 PostgreSQL prerequisites unavailable");
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
    membershipDomain = createMembershipDomain(database, { error: () => undefined });

    runtimeSql(`
      INSERT INTO app.users (id, primary_email, display_name) VALUES
        ('${OWNER_USER}', 't4fr3-owner@example.test', 'T4FR3 Owner'),
        ('${MEMBER_USER}', 't4fr3-member@example.test', 'T4FR3 Member'),
        ('${OWNER_USER_B}', 't4fr3-ownerb@example.test', 'T4FR3 Owner B')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.tenants (id, name, slug, status) VALUES
        ('${TENANT_A}', 'T4FR3 Tenant A', 't4fr3-tenant-a-${runKey}', 'active'),
        ('${TENANT_B}', 'T4FR3 Tenant B', 't4fr3-tenant-b-${runKey}', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status) VALUES
        ('${TENANT_A}', '${OWNER_USER}', 'owner', 'active'),
        ('${TENANT_A}', '${MEMBER_USER}', 'member', 'active'),
        ('${TENANT_B}', '${OWNER_USER_B}', 'owner', 'active')
      ON CONFLICT DO NOTHING;

      INSERT INTO app.personal_profiles (id, tenant_id, name) VALUES
        ('${PROFILE_A}', '${TENANT_A}', 'T4FR3 Profile A'),
        ('${PROFILE_B}', '${TENANT_B}', 'T4FR3 Profile B')
      ON CONFLICT DO NOTHING;

      -- MEMBER_USER deliberately gets NO personal_memberships row: a
      -- tenant_membership (business-only member) never implies personal
      -- access on its own.
      INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status) VALUES
        ('${PROFILE_A}', '${TENANT_A}', '${OWNER_USER}', 'owner', 'active'),
        ('${PROFILE_B}', '${TENANT_B}', '${OWNER_USER_B}', 'owner', 'active')
      ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await database?.destroy();
    if (postgresContainerId && databaseName) {
      adminSql(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
    }
  });

  it("returns the caller's own Personal profile when they have active personal-membership access", async () => {
    const result = await membershipDomain.getOwnPersonalProfile({
      actorUserId: OWNER_USER,
      tenantId: TENANT_A,
    });
    expect(result).toEqual({ id: PROFILE_A, name: "T4FR3 Profile A" });
  });

  it("returns null for a member with tenant role but no Personal profile access", async () => {
    const result = await membershipDomain.getOwnPersonalProfile({
      actorUserId: MEMBER_USER,
      tenantId: TENANT_A,
    });
    expect(result).toBeNull();
  });

  it("never returns another tenant's (or another member's) Personal profile -- cross-tenant isolation", async () => {
    // OWNER_USER has no membership at all in TENANT_B -- must not see
    // PROFILE_B even though OWNER_USER has a real profile elsewhere.
    const result = await membershipDomain.getOwnPersonalProfile({
      actorUserId: OWNER_USER,
      tenantId: TENANT_B,
    });
    expect(result).toBeNull();
  });

  it("rejects a caller with no tenant membership at all", async () => {
    const result = await membershipDomain.getOwnPersonalProfile({
      actorUserId: randomUUID(),
      tenantId: TENANT_A,
    });
    expect(result).toBeNull();
  });
});
