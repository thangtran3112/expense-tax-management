import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SpendingCategoryListSchema,
  SpendingCategorySchema,
  type AuthenticatedUser,
  type SpendingCategory,
} from "@expense-tax/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import { createAppDatabase } from "../src/database/client.js";
import type { AppDatabase } from "../src/database/types.js";
import { runMigrations } from "../src/database/migrate.js";
import { createSpendingCategoryDomain } from "../src/domain/spending-categories.js";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";

const TEST_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/.well-known/jwks.json",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/.well-known/jwks.json",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
  APP_DATABASE_URL: "postgresql://app-runtime.test/app",
};
const USER_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const CATEGORY_ID = "33333333-3333-4333-8333-333333333333";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";
const CATEGORY: SpendingCategory = {
  id: CATEGORY_ID,
  tenantId: TENANT_ID,
  templateKey: null,
  name: "Supplies",
  description: "Operating supplies",
  color: "#2563EB",
  icon: "package",
  status: "active",
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function principal(subject: string): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject,
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.test",
    roles: [],
    scopes: [],
    tokenId: `${subject}-token`,
    email: `${subject}@example.test`,
    emailVerified: true,
    displayName: subject,
  };
}

// ------------------------------------------------------------------ //
// Live PostgreSQL tests — category archive + suggestion supersession
// ------------------------------------------------------------------ //

const requested = process.env.PHASE_3C_INTEGRATION === "1";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_sc_${runKey}`;

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

const SC_TENANT_ID  = "9c000000-0000-4000-8000-000000000001";
const SC_USER_ID    = "9c000000-0000-4000-8000-000000000002";
const SC_PROFILE_ID = "9c000000-0000-4000-8000-000000000003";

let postgresContainerId = "";
let runtimePassword = "";
let migratorPassword = "";
let database: Kysely<AppDatabase> | undefined;

function dockerPsql(dbName: string, username: string, password: string, sqlStatement: string): string {
  const result = spawnSync(
    "docker",
    ["exec", "-e", `PGPASSWORD=${password}`, postgresContainerId,
     "psql", "-X", "-v", "ON_ERROR_STOP=1",
     "--host", "127.0.0.1", "--username", username, "--dbname", dbName,
     "--tuples-only", "--no-align", "--pset", "footer=off", "--command", sqlStatement],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function adminSqlSc(sqlStatement: string, db = "postgres"): string {
  return dockerPsql(db, "postgres", "postgrespassword", sqlStatement);
}

function runtimeSqlSc(sqlStatement: string): string {
  return dockerPsql(databaseName, "expense_app_runtime", runtimePassword, sqlStatement);
}

describe.skipIf(!requested)(
  "Task 8 — spending-category archive supersedes pending suggestions",
  () => {
    beforeAll(async () => {
      const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
      if (!dockerAvailable) throw new Error("Phase 3C PostgreSQL prerequisites unavailable");

      let postgresRunning = false;
      try {
        postgresRunning = execFileSync(composeScript, ["ps", "-q", "postgres"], {
          cwd: repoRoot, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim().length > 0;
      } catch { postgresRunning = false; }
      if (!postgresRunning) throw new Error("Phase 3C PostgreSQL prerequisites unavailable");

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
        throw new Error("Phase 3C PostgreSQL prerequisites unavailable");
      }

      adminSqlSc(`CREATE DATABASE ${databaseName};`);
      adminSqlSc(
        `CREATE SCHEMA app AUTHORIZATION expense_app_migrator;
         CREATE SCHEMA app_migrations AUTHORIZATION expense_app_migrator;
         GRANT USAGE ON SCHEMA app TO expense_app_runtime;`,
        databaseName,
      );
      const migrationDatabaseUrl = `postgresql://expense_app_migrator:${encodeURIComponent(migratorPassword)}@127.0.0.1:5433/${databaseName}`;
      const runtimeDatabaseUrl = `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/${databaseName}`;
      await runMigrations(migrationDatabaseUrl);
      adminSqlSc(
        `GRANT USAGE ON SCHEMA app TO expense_app_runtime;
         GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO expense_app_runtime;
         GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app TO expense_app_runtime;`,
        databaseName,
      );
      database = createAppDatabase(runtimeDatabaseUrl);

      runtimeSqlSc(`
        INSERT INTO app.users (id, primary_email, display_name)
        VALUES ('${SC_USER_ID}', 'sc-owner-${runKey}@example.test', 'SC Owner')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.tenants (id, name, slug, status)
        VALUES ('${SC_TENANT_ID}', 'SC Tenant', 'sc-tenant-${runKey}', 'active')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('${SC_TENANT_ID}', '${SC_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.personal_profiles (id, tenant_id, name)
        VALUES ('${SC_PROFILE_ID}', '${SC_TENANT_ID}', 'SC Profile')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status)
        VALUES ('${SC_PROFILE_ID}', '${SC_TENANT_ID}', '${SC_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;
      `);
    });

    afterAll(async () => {
      await database?.destroy();
      if (postgresContainerId && databaseName) {
        adminSqlSc(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
      }
    });

    it("SC-L1: archiving a spending_category supersedes pending matching suggestions", async () => {
      const domain = createSpendingCategoryDomain(database!);
      const cat = await domain.create({
        actorUserId: SC_USER_ID,
        tenantId: SC_TENANT_ID,
        request: { name: "To Archive Cat", color: "#AAAAAA", icon: "tag" },
        requestId: `sc-l1-create-${runKey}`,
      });

      // Seed an expense + pending suggestion referencing this category
      const expId = randomUUID();
      const fakeJobId = randomUUID();
      const sugId = randomUUID();
      runtimeSqlSc(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${SC_TENANT_ID}', '${SC_USER_ID}',
          '${SC_PROFILE_ID}', NULL, 'Cat Shop', '10.00', 'USD', '2026-09-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES
          ('${fakeJobId}', '${SC_TENANT_ID}', '${SC_PROFILE_ID}', NULL,
           'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
           'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;

        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES
          ('${sugId}', '${SC_TENANT_ID}', '${SC_PROFILE_ID}', NULL,
           '${expId}', '${fakeJobId}', 'spending_category', NULL, '${cat.id}', NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.9, '${"a".repeat(64)}', 'pending', 1, 1, 'sc-l1-sug-${runKey}')
        ON CONFLICT DO NOTHING;
      `);

      // Archive the category
      await domain.archive({
        actorUserId: SC_USER_ID,
        tenantId: SC_TENANT_ID,
        categoryId: cat.id,
        request: { expectedVersion: cat.version },
        requestId: `sc-l1-archive-${runKey}`,
      });

      // Pending suggestion must be superseded
      const sugStatus = runtimeSqlSc(
        `SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${sugId}';`,
      );
      expect(sugStatus).toBe("superseded");
    });

    it("SC-L2: accepted/rejected suggestions not affected by category archive", async () => {
      const domain = createSpendingCategoryDomain(database!);
      const cat = await domain.create({
        actorUserId: SC_USER_ID,
        tenantId: SC_TENANT_ID,
        request: { name: "Terminal Cat", color: "#BBBBBB", icon: "folder" },
        requestId: `sc-l2-create-${runKey}`,
      });

      const expId = randomUUID();
      const fakeJobId = randomUUID();
      const acceptedSugId = randomUUID();
      const rejectedSugId = randomUUID();
      runtimeSqlSc(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${SC_TENANT_ID}', '${SC_USER_ID}',
          '${SC_PROFILE_ID}', NULL, 'Terminal Cat Shop', '15.00', 'USD', '2026-09-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES
          ('${fakeJobId}', '${SC_TENANT_ID}', '${SC_PROFILE_ID}', NULL,
           'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
           'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;

        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key,
           resolved_by_user_id, resolved_at)
        VALUES
          ('${acceptedSugId}', '${SC_TENANT_ID}', '${SC_PROFILE_ID}', NULL,
           '${expId}', '${fakeJobId}', 'spending_category', NULL, '${cat.id}', NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.9, '${"b".repeat(64)}', 'accepted', 2, 1, 'sc-l2-accepted-${runKey}',
           '${SC_USER_ID}', now()),
          ('${rejectedSugId}', '${SC_TENANT_ID}', '${SC_PROFILE_ID}', NULL,
           '${expId}', '${fakeJobId}', 'spending_category', NULL, '${cat.id}', NULL,
           NULL, NULL, NULL, NULL,
           'historical', 0.7, '${"c".repeat(64)}', 'rejected', 2, 1, 'sc-l2-rejected-${runKey}',
           '${SC_USER_ID}', now())
        ON CONFLICT DO NOTHING;
      `);

      // Archive the category
      await domain.archive({
        actorUserId: SC_USER_ID,
        tenantId: SC_TENANT_ID,
        categoryId: cat.id,
        request: { expectedVersion: cat.version },
        requestId: `sc-l2-archive-${runKey}`,
      });

      // Accepted/rejected must remain unchanged
      const acceptedStatus = runtimeSqlSc(
        `SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${acceptedSugId}';`,
      );
      const rejectedStatus = runtimeSqlSc(
        `SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${rejectedSugId}';`,
      );
      expect(acceptedStatus).toBe("accepted");
      expect(rejectedStatus).toBe("rejected");
    });
  },
);

describe("App API spending category routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const list = vi.fn(async () => [CATEGORY]);
    const create = vi.fn(async () => CATEGORY);
    const update = vi.fn(async () => ({ ...CATEGORY, name: "Materials", version: 2 }));
    const archive = vi.fn(async () => ({
      ...CATEGORY,
      status: "archived" as const,
      version: 2,
    }));
    const resolve = vi.fn(async (): Promise<AuthenticatedUser> => ({
      id: USER_ID,
      primaryEmail: "owner@example.test",
      displayName: "Owner",
      status: "active",
    }));
    const tenantVerifier: TokenVerifier = { verify: vi.fn(async (token) => principal(token)) };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: tenantVerifier,
        service: { verify: vi.fn(async () => { throw new Error("not used"); }) },
      },
      identityDomain: { provision: vi.fn(), resolve },
      spendingCategoryDomain: { archive, create, list, update },
    });
    apps.add(app);
    return { app, archive, create, list, update };
  }

  const auth = { authorization: "Bearer owner" };

  it("lists tenant-scoped categories", async () => {
    const { app, list } = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/tenants/${TENANT_ID}/spending-categories`,
      headers: auth,
    });

    expect(SpendingCategoryListSchema.parse(response.json())).toEqual({ items: [CATEGORY] });
    expect(list).toHaveBeenCalledWith(USER_ID, TENANT_ID);
  });

  it("creates a custom tenant category", async () => {
    const { app, create } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/spending-categories`,
      headers: auth,
      payload: {
        name: " Supplies ",
        description: "Operating supplies",
        color: "#2563EB",
        icon: "package",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(SpendingCategorySchema.parse(response.json())).toEqual(CATEGORY);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: USER_ID, tenantId: TENANT_ID }),
    );
  });

  it("updates and archives with expected versions", async () => {
    const { app, archive, update } = createTestApp();
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/tenants/${TENANT_ID}/spending-categories/${CATEGORY_ID}`,
      headers: auth,
      payload: { expectedVersion: 1, name: "Materials" },
    });
    const archived = await app.inject({
      method: "DELETE",
      url: `/api/v1/tenants/${TENANT_ID}/spending-categories/${CATEGORY_ID}`,
      headers: auth,
      payload: { expectedVersion: 1 },
    });

    expect(updated.statusCode).toBe(200);
    expect(archived.statusCode).toBe(200);
    expect(update).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledOnce();
  });
});
