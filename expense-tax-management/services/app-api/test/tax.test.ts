import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BusinessTaxProfileSchema,
  TaxCategoryDefinitionListSchema,
  TaxonomyVersionListSchema,
  ExpenseTaxTreatmentSchema,
  type AuthenticatedUser,
  type BusinessTaxProfile,
  type ExpenseTaxTreatment,
  type TaxCategoryDefinition,
  type TaxonomyVersion,
} from "@expense-tax/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import { createAppDatabase } from "../src/database/client.js";
import type { AppDatabase } from "../src/database/types.js";
import { runMigrations } from "../src/database/migrate.js";
import { createTaxDomain } from "../src/domain/tax.js";

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
const BUSINESS_ID = "33333333-3333-4333-8333-333333333333";
const EXPENSE_ID = "44444444-4444-4444-8444-444444444444";
const TAXONOMY_ID = "66666666-6666-4666-8666-666666666666";
const DEFINITION_ID = "77777777-7777-4777-8777-777777777777";
const TAX_PROFILE_ID = "88888888-8888-4888-8888-888888888888";
const TIMESTAMP = "2026-09-08T00:00:00.000Z";

const TAXONOMY: TaxonomyVersion = {
  id: TAXONOMY_ID,
  jurisdictionCode: "US-FEDERAL",
  taxYear: 2025,
  code: "schedule-c-2025",
  name: "2025 Schedule C",
  status: "active",
  sourceUrl: "https://www.irs.gov/forms-pubs/about-schedule-c-form-1040",
  sourceRevision: "2025-final",
  sourceChecksum: "a".repeat(64),
  createdAt: TIMESTAMP,
};
const DEFINITION: TaxCategoryDefinition = {
  id: DEFINITION_ID,
  taxonomyVersionId: TAXONOMY_ID,
  code: "advertising",
  name: "Advertising",
  description: null,
  officialForm: "Schedule C",
  officialLine: "8",
  status: "active",
  sortOrder: 1,
};
const PROFILE: BusinessTaxProfile = {
  id: TAX_PROFILE_ID,
  tenantId: TENANT_ID,
  businessId: BUSINESS_ID,
  taxYear: 2025,
  taxonomyVersionId: TAXONOMY_ID,
  taxForm: "schedule_c",
  accountingMethod: "cash",
  status: "active",
  version: 1,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const TREATMENT: ExpenseTaxTreatment = {
  expenseId: EXPENSE_ID,
  tenantId: TENANT_ID,
  businessId: BUSINESS_ID,
  taxYear: 2025,
  businessTaxProfileId: TAX_PROFILE_ID,
  taxonomyVersionId: TAXONOMY_ID,
  taxCategoryDefinitionId: DEFINITION_ID,
  deductiblePercent: "75.00",
  reviewStatus: "reviewed",
  note: null,
  version: 1,
  createdByUserId: USER_ID,
  updatedByUserId: USER_ID,
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
// Live PostgreSQL tests — tax profile/treatment mutation supersedes pending tax suggestions
// ------------------------------------------------------------------ //

const requested = process.env.PHASE_3C_INTEGRATION === "1";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().replaceAll("-", "").slice(0, 12);
const databaseName = `expense_tax_tx_${runKey}`;

interface ComposeConfig {
  readonly services: Record<
    string,
    { readonly environment?: Record<string, string | null> }
  >;
}

const TX_TENANT_ID   = "7f000000-0000-4000-8000-000000000001";
const TX_USER_ID     = "7f000000-0000-4000-8000-000000000002";
const TX_PROFILE_ID  = "7f000000-0000-4000-8000-000000000003";
const TX_BIZ_ID      = "7f000000-0000-4000-8000-000000000004";
const TX_TAXVER_ID   = "7f000000-0000-4000-8000-000000000005";
const TX_TAXCAT_ID   = "7f000000-0000-4000-8000-000000000006";

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

function adminSqlTx(sqlStatement: string, db = "postgres"): string {
  return dockerPsql(db, "postgres", "postgrespassword", sqlStatement);
}

function runtimeSqlTx(sqlStatement: string): string {
  return dockerPsql(databaseName, "expense_app_runtime", runtimePassword, sqlStatement);
}

describe.skipIf(!requested)(
  "Task 8 — tax profile mutation supersedes pending tax suggestions",
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

      adminSqlTx(`CREATE DATABASE ${databaseName};`);
      adminSqlTx(
        `CREATE SCHEMA app AUTHORIZATION expense_app_migrator;
         CREATE SCHEMA app_migrations AUTHORIZATION expense_app_migrator;
         GRANT USAGE ON SCHEMA app TO expense_app_runtime;`,
        databaseName,
      );
      const migrationDatabaseUrl = `postgresql://expense_app_migrator:${encodeURIComponent(migratorPassword)}@127.0.0.1:5433/${databaseName}`;
      const runtimeDatabaseUrl = `postgresql://expense_app_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/${databaseName}`;
      await runMigrations(migrationDatabaseUrl);
      adminSqlTx(
        `GRANT USAGE ON SCHEMA app TO expense_app_runtime;
         GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO expense_app_runtime;
         GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA app TO expense_app_runtime;`,
        databaseName,
      );
      database = createAppDatabase(runtimeDatabaseUrl);

      runtimeSqlTx(`
        INSERT INTO app.users (id, primary_email, display_name)
        VALUES ('${TX_USER_ID}', 'tx-owner-${runKey}@example.test', 'TX Owner')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.tenants (id, name, slug, status)
        VALUES ('${TX_TENANT_ID}', 'TX Tenant', 'tx-tenant-${runKey}', 'active')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.tenant_memberships (tenant_id, user_id, role, status)
        VALUES ('${TX_TENANT_ID}', '${TX_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.personal_profiles (id, tenant_id, name)
        VALUES ('${TX_PROFILE_ID}', '${TX_TENANT_ID}', 'TX Profile')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.personal_memberships (personal_profile_id, tenant_id, user_id, role, status)
        VALUES ('${TX_PROFILE_ID}', '${TX_TENANT_ID}', '${TX_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.businesses (id, tenant_id, name, industry_code, timezone, base_currency, status)
        VALUES ('${TX_BIZ_ID}', '${TX_TENANT_ID}', 'TX Biz', 'restaurant', 'UTC', 'USD', 'active')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.business_memberships (business_id, tenant_id, user_id, role, status)
        VALUES ('${TX_BIZ_ID}', '${TX_TENANT_ID}', '${TX_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.taxonomy_versions (id, jurisdiction_code, tax_year, code, name, status, source_url, source_revision, source_checksum)
        VALUES ('${TX_TAXVER_ID}', 'US-FEDERAL', 2025, 'tx-v1', 'TX Taxonomy', 'active', 'https://test.local', 'rev1', '${"a".repeat(64)}')
        ON CONFLICT DO NOTHING;
        -- Additional years needed for tests that create profiles with years 2022/2023/2024.
        -- Each business_tax_profile row must reference a (taxonomy_version_id, tax_year) pair
        -- that exists in taxonomy_versions.
        INSERT INTO app.taxonomy_versions (id, jurisdiction_code, tax_year, code, name, status, source_url, source_revision, source_checksum)
        VALUES
          ('7f000000-0000-4000-8000-000000000010', 'US-FEDERAL', 2024, 'tx-v2', 'TX 2024', 'active', 'https://test.local', 'rev1', '${"b".repeat(64)}'),
          ('7f000000-0000-4000-8000-000000000011', 'US-FEDERAL', 2023, 'tx-v3', 'TX 2023', 'active', 'https://test.local', 'rev1', '${"c".repeat(64)}'),
          ('7f000000-0000-4000-8000-000000000012', 'US-FEDERAL', 2022, 'tx-v4', 'TX 2022', 'active', 'https://test.local', 'rev1', '${"d".repeat(64)}')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.tax_category_definitions (id, taxonomy_version_id, code, name, status, sort_order)
        VALUES
          ('${TX_TAXCAT_ID}', '${TX_TAXVER_ID}', 'MEALS', 'Meals', 'active', 1),
          -- Tax categories for additional years (same IDs reused across taxonomies for test simplicity)
          ('7f000000-0000-4000-8000-000000000020', '7f000000-0000-4000-8000-000000000010', 'MEALS24', 'Meals 2024', 'active', 1),
          ('7f000000-0000-4000-8000-000000000021', '7f000000-0000-4000-8000-000000000011', 'MEALS23', 'Meals 2023', 'active', 1),
          ('7f000000-0000-4000-8000-000000000022', '7f000000-0000-4000-8000-000000000012', 'MEALS22', 'Meals 2022', 'active', 1)
        ON CONFLICT DO NOTHING;
      `);
    });

    afterAll(async () => {
      await database?.destroy();
      if (postgresContainerId && databaseName) {
        adminSqlTx(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE);`);
      }
    });

    function seedTaxSuggestion(opts: {
      sugId: string; expId: string; fakeJobId: string;
      profileId: string; profileVersion: number; taxCatId: string;
      status?: string; idemKey: string;
      taxVersionId?: string; taxYear?: number;
    }): void {
      const tvId = opts.taxVersionId ?? TX_TAXVER_ID;
      const tYear = opts.taxYear ?? 2025;
      runtimeSqlTx(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES
          ('${opts.sugId}', '${TX_TENANT_ID}', NULL, '${TX_BIZ_ID}',
           '${opts.expId}', '${opts.fakeJobId}', 'tax_category', NULL, NULL, '${opts.taxCatId}',
           '${opts.profileId}', ${opts.profileVersion}, '${tvId}', ${tYear},
           'historical', 0.8, '${"f".repeat(64)}', '${opts.status ?? "pending"}', 1, 1, '${opts.idemKey}')
        ON CONFLICT DO NOTHING;
      `);
    }

    it("TX-L1: updateProfile supersedes pending tax suggestions whose snapshot no longer matches", async () => {
      const domain = createTaxDomain(database!);

      // Create a tax profile
      const profileId = randomUUID();
      runtimeSqlTx(`
        INSERT INTO app.business_tax_profiles
          (id, tenant_id, business_id, tax_year, taxonomy_version_id, tax_form, accounting_method, status)
        VALUES
          ('${profileId}', '${TX_TENANT_ID}', '${TX_BIZ_ID}', 2025, '${TX_TAXVER_ID}', 'schedule_c', 'cash', 'active')
        ON CONFLICT DO NOTHING;
      `);

      const expId = randomUUID();
      const fakeJobId = randomUUID();
      runtimeSqlTx(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${TX_TENANT_ID}', '${TX_USER_ID}',
          NULL, '${TX_BIZ_ID}', 'Tax Meals', '50.00', 'USD', '2025-06-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES
          ('${fakeJobId}', '${TX_TENANT_ID}', NULL, '${TX_BIZ_ID}',
           'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
           'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;
      `);

      const pendingSugId = randomUUID();
      seedTaxSuggestion({
        sugId: pendingSugId, expId, fakeJobId,
        profileId, profileVersion: 1, taxCatId: TX_TAXCAT_ID,
        idemKey: `tx-l1-sug-${runKey}`,
      });

      // Update the profile version — must supersede pending suggestion referencing old version
      await domain.updateProfile({
        actorUserId: TX_USER_ID,
        tenantId: TX_TENANT_ID,
        businessId: TX_BIZ_ID,
        taxYear: 2025,
        request: { expectedVersion: 1, accountingMethod: "accrual" },
        requestId: `tx-l1-update-${runKey}`,
      });

      const sugStatus = runtimeSqlTx(
        `SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${pendingSugId}';`,
      );
      expect(sugStatus).toBe("superseded");
    });

    it("TX-L2: closeProfile supersedes pending tax suggestions for that profile", async () => {
      const domain = createTaxDomain(database!);

      const profileId = randomUUID();
      runtimeSqlTx(`
        INSERT INTO app.business_tax_profiles
          (id, tenant_id, business_id, tax_year, taxonomy_version_id, tax_form, accounting_method, status)
        VALUES
          ('${profileId}', '${TX_TENANT_ID}', '${TX_BIZ_ID}', 2024, '7f000000-0000-4000-8000-000000000010', 'schedule_c', 'cash', 'active')
        ON CONFLICT DO NOTHING;
      `);

      const expId = randomUUID();
      const fakeJobId = randomUUID();
      runtimeSqlTx(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${TX_TENANT_ID}', '${TX_USER_ID}',
          NULL, '${TX_BIZ_ID}', 'Close Meals', '40.00', 'USD', '2024-06-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES
          ('${fakeJobId}', '${TX_TENANT_ID}', NULL, '${TX_BIZ_ID}',
           'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
           'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;
      `);

      const pendingSugId = randomUUID();
      seedTaxSuggestion({
        sugId: pendingSugId, expId, fakeJobId,
        profileId, profileVersion: 1, taxCatId: TX_TAXCAT_ID,
        idemKey: `tx-l2-sug-${runKey}`,
        taxVersionId: "7f000000-0000-4000-8000-000000000010",
        taxYear: 2024,
      });

      // Close the profile
      await domain.closeProfile({
        actorUserId: TX_USER_ID,
        tenantId: TX_TENANT_ID,
        businessId: TX_BIZ_ID,
        taxYear: 2024,
        expectedVersion: 1,
        requestId: `tx-l2-close-${runKey}`,
      });

      const sugStatus = runtimeSqlTx(
        `SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${pendingSugId}';`,
      );
      expect(sugStatus).toBe("superseded");
    });

    it("TX-L3: upsertTreatment supersedes pending tax suggestions for the same expense", async () => {
      const domain = createTaxDomain(database!);

      const profileId = randomUUID();
      runtimeSqlTx(`
        INSERT INTO app.business_tax_profiles
          (id, tenant_id, business_id, tax_year, taxonomy_version_id, tax_form, accounting_method, status)
        VALUES
          ('${profileId}', '${TX_TENANT_ID}', '${TX_BIZ_ID}', 2023, '7f000000-0000-4000-8000-000000000011', 'schedule_c', 'cash', 'active')
        ON CONFLICT DO NOTHING;
      `);

      const expId = randomUUID();
      const fakeJobId = randomUUID();
      runtimeSqlTx(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${TX_TENANT_ID}', '${TX_USER_ID}',
          NULL, '${TX_BIZ_ID}', 'Treatment Meals', '60.00', 'USD', '2023-06-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES
          ('${fakeJobId}', '${TX_TENANT_ID}', NULL, '${TX_BIZ_ID}',
           'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
           'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;
      `);

      const pendingSugId = randomUUID();
      seedTaxSuggestion({
        sugId: pendingSugId, expId, fakeJobId,
        profileId, profileVersion: 1, taxCatId: TX_TAXCAT_ID,
        idemKey: `tx-l3-sug-${runKey}`,
        taxVersionId: "7f000000-0000-4000-8000-000000000011",
        taxYear: 2023,
      });

      // Upsert a treatment — supersedes pending tax suggestions for the expense
      await domain.upsertTreatment({
        actorUserId: TX_USER_ID,
        tenantId: TX_TENANT_ID,
        businessId: TX_BIZ_ID,
        expenseId: expId,
        request: {
          businessTaxProfileId: profileId,
          taxonomyVersionId: "7f000000-0000-4000-8000-000000000011", // matches 2023 profile
          taxCategoryDefinitionId: "7f000000-0000-4000-8000-000000000021", // category in 2023 taxonomy
          deductiblePercent: "100.00",
          reviewStatus: "reviewed",
        },
        requestId: `tx-l3-upsert-${runKey}`,
      });

      const sugStatus = runtimeSqlTx(
        `SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${pendingSugId}';`,
      );
      expect(sugStatus).toBe("superseded");
    });

    it("TX-L4: accepted/rejected tax suggestions not affected by profile update", async () => {
      const domain = createTaxDomain(database!);

      const profileId = randomUUID();
      runtimeSqlTx(`
        INSERT INTO app.business_tax_profiles
          (id, tenant_id, business_id, tax_year, taxonomy_version_id, tax_form, accounting_method, status)
        VALUES
          ('${profileId}', '${TX_TENANT_ID}', '${TX_BIZ_ID}', 2022, '7f000000-0000-4000-8000-000000000012', 'schedule_c', 'cash', 'active')
        ON CONFLICT DO NOTHING;
      `);

      const expId = randomUUID();
      const fakeJobId = randomUUID();
      runtimeSqlTx(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${TX_TENANT_ID}', '${TX_USER_ID}',
          NULL, '${TX_BIZ_ID}', 'Terminal Tax Meals', '70.00', 'USD', '2022-06-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES
          ('${fakeJobId}', '${TX_TENANT_ID}', NULL, '${TX_BIZ_ID}',
           'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
           'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;
      `);

      const acceptedSugId = randomUUID();
      const rejectedSugId = randomUUID();
      // Seed accepted suggestion
      runtimeSqlTx(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key,
           resolved_by_user_id, resolved_at)
        VALUES
          ('${acceptedSugId}', '${TX_TENANT_ID}', NULL, '${TX_BIZ_ID}',
           '${expId}', '${fakeJobId}', 'tax_category', NULL, NULL, '${TX_TAXCAT_ID}',
           '${profileId}', 1, '${TX_TAXVER_ID}', 2022,
           'historical', 0.8, '${"a".repeat(64)}', 'accepted', 2, 1, 'tx-l4-accepted-${runKey}',
           '${TX_USER_ID}', now()),
          ('${rejectedSugId}', '${TX_TENANT_ID}', NULL, '${TX_BIZ_ID}',
           '${expId}', '${fakeJobId}', 'tax_category', NULL, NULL, '${TX_TAXCAT_ID}',
           '${profileId}', 1, '${TX_TAXVER_ID}', 2022,
           'historical', 0.7, '${"b".repeat(64)}', 'rejected', 2, 1, 'tx-l4-rejected-${runKey}',
           '${TX_USER_ID}', now())
        ON CONFLICT DO NOTHING;
      `);

      // Update profile
      await domain.updateProfile({
        actorUserId: TX_USER_ID,
        tenantId: TX_TENANT_ID,
        businessId: TX_BIZ_ID,
        taxYear: 2022,
        request: { expectedVersion: 1, accountingMethod: "accrual" },
        requestId: `tx-l4-update-${runKey}`,
      });

      const acceptedStatus = runtimeSqlTx(
        `SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${acceptedSugId}';`,
      );
      const rejectedStatus = runtimeSqlTx(
        `SELECT status FROM app.expense_enrichment_suggestions WHERE id = '${rejectedSugId}';`,
      );
      expect(acceptedStatus).toBe("accepted");
      expect(rejectedStatus).toBe("rejected");
    });

    // ---------------------------------------------------------------- //
    // Fix-4: Tax accept with stale expense tax_year → CONFLICT
    // ---------------------------------------------------------------- //

    it("TX-Fix4: accept tax suggestion when expense.tax_year != suggestion.tax_year → CONFLICT", async () => {
      const { resolveSuggestion } = await import("../src/domain/enrichment.js");

      // Use a dedicated second business to avoid collisions with other tests (TX-L1 uses 2025).
      const biz2Id = randomUUID();
      const profileId = randomUUID();
      runtimeSqlTx(`
        -- Second business for isolation
        INSERT INTO app.businesses
          (id, tenant_id, name, industry_code, timezone, base_currency, status)
        VALUES ('${biz2Id}', '${TX_TENANT_ID}', 'TX Fix4 Biz', 'restaurant', 'UTC', 'USD', 'active')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.business_memberships (business_id, tenant_id, user_id, role, status)
        VALUES ('${biz2Id}', '${TX_TENANT_ID}', '${TX_USER_ID}', 'owner', 'active')
        ON CONFLICT DO NOTHING;

        -- Profile for year 2026 (fresh tax year for this biz — no collision)
        INSERT INTO app.taxonomy_versions (id, jurisdiction_code, tax_year, code, name, status, source_url, source_revision, source_checksum)
        VALUES ('7f000000-0000-4000-8000-000000000013', 'US-FEDERAL', 2026, 'tx-v5', 'TX 2026', 'active', 'https://test.local', 'rev1', '${"a".repeat(64)}')
        ON CONFLICT DO NOTHING;
        INSERT INTO app.business_tax_profiles
          (id, tenant_id, business_id, tax_year, taxonomy_version_id, tax_form, accounting_method, status)
        VALUES ('${profileId}', '${TX_TENANT_ID}', '${biz2Id}', 2026, '7f000000-0000-4000-8000-000000000013', 'schedule_c', 'cash', 'active')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.tax_category_definitions (id, taxonomy_version_id, code, name, status, sort_order)
        VALUES ('7f000000-0000-4000-8000-000000000023', '7f000000-0000-4000-8000-000000000013', 'FIX4', 'Fix4 Cat', 'active', 1)
        ON CONFLICT DO NOTHING;
      `);

      // Expense for 2026 (tax_year=2026)
      const expId = randomUUID();
      const fakeJobId = randomUUID();
      runtimeSqlTx(`
        INSERT INTO app.expenses (id, tenant_id, created_by_user_id, personal_profile_id, business_id,
          merchant, amount, currency, incurred_on, source, status)
        VALUES ('${expId}', '${TX_TENANT_ID}', '${TX_USER_ID}',
          NULL, '${biz2Id}', 'Stale Year Meals', '30.00', 'USD', '2026-06-01', 'manual', 'ready')
        ON CONFLICT DO NOTHING;

        INSERT INTO app.processing_jobs
          (id, tenant_id, personal_profile_id, business_id,
           workflow_type, workflow_id, task_queue, status,
           target_aggregate_type, target_aggregate_id, expected_aggregate_version,
           input_params, allowed_result_schema_version, dispatched_at, completed_at)
        VALUES ('${fakeJobId}', '${TX_TENANT_ID}', NULL, '${biz2Id}',
          'ExpenseEnrichmentWorkflow', 'job-${fakeJobId}', 'expense-tax-ai-worker', 'SUCCEEDED',
          'expense', '${expId}', 1, '{}', 'expense-enrichment-v1', now(), now())
        ON CONFLICT DO NOTHING;
      `);

      // Suggestion with tax_year=2025 (stale — expense.tax_year=2026)
      // The suggestion references the profile correctly but the year diverges from expense.
      const sugId = randomUUID();
      runtimeSqlTx(`
        INSERT INTO app.expense_enrichment_suggestions
          (id, tenant_id, personal_profile_id, business_id, expense_id, job_id,
           kind, tag_id, spending_category_id, tax_category_definition_id,
           business_tax_profile_id, business_tax_profile_version, taxonomy_version_id, tax_year,
           source, confidence, evidence_hash, status, version, expense_version, idempotency_key)
        VALUES ('${sugId}', '${TX_TENANT_ID}', NULL, '${biz2Id}',
          '${expId}', '${fakeJobId}', 'tax_category', NULL, NULL, '7f000000-0000-4000-8000-000000000023',
          '${profileId}', 1, '7f000000-0000-4000-8000-000000000013', 2025,
          'historical', 0.8, '${"e".repeat(64)}', 'pending', 1, 1, 'fix4-stale-sug-${runKey}')
        ON CONFLICT DO NOTHING;
      `);

      // Accept must fail: expense.tax_year (2026) != suggestion.tax_year (2025)
      await expect(
        resolveSuggestion(database!, {
          actorUserId: TX_USER_ID,
          tenantId: TX_TENANT_ID,
          profileId: null,
          businessId: biz2Id,
          expenseId: expId,
          suggestionId: sugId,
          request: {
            action: "accepted",
            expectedSuggestionVersion: 1,
            expectedExpenseVersion: 1,
            idempotencyKey: `fix4-stale-${runKey}`,
            taxAcceptance: {
              businessTaxProfileId: profileId,
              deductiblePercent: "100.00",
            },
          },
          requestId: `fix4-stale-req-${runKey}`,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  },
);

describe("App API taxonomy and tax routes", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp() {
    const listTaxonomies = vi.fn(async () => [TAXONOMY]);
    const listTaxCategories = vi.fn(async () => [DEFINITION]);
    const createProfile = vi.fn(async () => PROFILE);
    const getProfile = vi.fn(async () => PROFILE);
    const updateProfile = vi.fn(async () => ({ ...PROFILE, version: 2 }));
    const closeProfile = vi.fn(async () => undefined);
    const getTreatment = vi.fn(async () => TREATMENT);
    const upsertTreatment = vi.fn(async () => TREATMENT);
    const deleteTreatment = vi.fn(async () => undefined);
    const resolve = vi.fn(async (): Promise<AuthenticatedUser> => ({
      id: USER_ID,
      primaryEmail: "owner@example.test",
      displayName: "Owner",
      status: "active",
    }));
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async (token) => principal(token)),
    };
    const app = buildApp({
      config: createAppConfig({ env: TEST_ENV, version: "test" }),
      logger: false,
      authVerifiers: {
        tenant: tenantVerifier,
        service: { verify: vi.fn(async () => { throw new Error("not used"); }) },
      },
      identityDomain: { provision: vi.fn(), resolve },
      taxDomain: {
        listTaxonomies,
        listTaxCategories,
        createProfile,
        getProfile,
        updateProfile,
        closeProfile,
        getTreatment,
        upsertTreatment,
        deleteTreatment,
      },
    });
    apps.add(app);
    return {
      app,
      createProfile,
      getTreatment,
      listTaxCategories,
      listTaxonomies,
      upsertTreatment,
    };
  }

  const auth = { authorization: "Bearer owner" };

  it("lists taxonomy versions and definitions", async () => {
    const { app, listTaxCategories, listTaxonomies } = createTestApp();
    const versions = await app.inject({
      method: "GET",
      url: "/api/v1/taxonomies",
      headers: auth,
    });
    const definitions = await app.inject({
      method: "GET",
      url: `/api/v1/taxonomies/${TAXONOMY_ID}/categories`,
      headers: auth,
    });

    expect(TaxonomyVersionListSchema.parse(versions.json())).toEqual({
      items: [TAXONOMY],
    });
    expect(TaxCategoryDefinitionListSchema.parse(definitions.json())).toEqual({
      items: [DEFINITION],
    });
    expect(listTaxonomies).toHaveBeenCalledOnce();
    expect(listTaxCategories).toHaveBeenCalledWith(TAXONOMY_ID);
  });

  it("creates Schedule C tax profile for explicit business and year", async () => {
    const { app, createProfile } = createTestApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/tax-profiles`,
      headers: auth,
      payload: { taxYear: 2025, accountingMethod: "cash" },
    });

    expect(response.statusCode).toBe(201);
    expect(BusinessTaxProfileSchema.parse(response.json())).toEqual(PROFILE);
    expect(createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER_ID,
        businessId: BUSINESS_ID,
        request: { taxYear: 2025, accountingMethod: "cash" },
      }),
    );
  });

  it("upserts business expense treatment", async () => {
    const { app, upsertTreatment } = createTestApp();
    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/tenants/${TENANT_ID}/businesses/${BUSINESS_ID}/expenses/${EXPENSE_ID}/tax-treatment`,
      headers: auth,
      payload: {
        businessTaxProfileId: TAX_PROFILE_ID,
        taxonomyVersionId: TAXONOMY_ID,
        taxCategoryDefinitionId: DEFINITION_ID,
        deductiblePercent: "75.00",
        reviewStatus: "reviewed",
        note: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(ExpenseTaxTreatmentSchema.parse(response.json())).toEqual(TREATMENT);
    expect(upsertTreatment).toHaveBeenCalledWith(
      expect.objectContaining({ expenseId: EXPENSE_ID, businessId: BUSINESS_ID }),
    );
  });
});
