import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFoundryDatabase } from "../../services/foundry-service/src/database/client.js";
import type { FoundryDatabase } from "../../services/foundry-service/src/database/types.js";
import { createQuotasDomain } from "../../services/foundry-service/src/domain/quotas.js";
import { createRoutesDomain } from "../../services/foundry-service/src/domain/routes.js";
import { DomainError } from "../../services/foundry-service/src/errors.js";
import type { Kysely } from "kysely";

const integrationEnabled = process.env.PHASE_0C_INTEGRATION === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const composeScript = path.join(repoRoot, "scripts", "compose.sh");
const runKey = randomUUID().slice(0, 8);

const FAKE_MODEL_ID = "eeeeeeee-0001-4000-8000-000000000003";

let postgresContainerId = "";
let runtimePassword = "";
let database: Kysely<FoundryDatabase>;

function runSql(sql: string) {
  return spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${runtimePassword}`,
      postgresContainerId,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      "127.0.0.1",
      "--username",
      "expense_foundry_runtime",
      "--dbname",
      "expense_tax_db",
      "--tuples-only",
      "--no-align",
      "--pset",
      "footer=off",
      "--command",
      sql,
    ],
    { encoding: "utf8" },
  );
}

function executeSql(sql: string): string {
  const result = runSql(sql);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

const createdTenantIds: string[] = [];

describe.skipIf(!integrationEnabled)("Phase 0C Foundry effective route", () => {
  beforeAll(() => {
    const config = JSON.parse(
      execFileSync(composeScript, ["config", "--format", "json"], {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as {
      readonly services: Record<
        string,
        { readonly environment?: Record<string, string | null> }
      >;
    };
    postgresContainerId = execFileSync(composeScript, ["ps", "-q", "postgres"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
    }).trim();
    runtimePassword =
      config.services.postgres?.environment?.FOUNDRY_RUNTIME_DB_PASSWORD ?? "";
    if (!postgresContainerId || !runtimePassword) {
      throw new Error("Phase 0C Foundry prerequisites are missing");
    }
    database = createFoundryDatabase(
      `postgresql://expense_foundry_runtime:${encodeURIComponent(runtimePassword)}@127.0.0.1:5433/expense_tax_db`,
    );
  });

  afterAll(async () => {
    if (postgresContainerId && runtimePassword) {
      for (const tenantId of createdTenantIds) {
        executeSql(
          `DELETE FROM foundry.ai_quota_reservations WHERE tenant_id = '${tenantId}';`,
        );
        executeSql(
          `DELETE FROM foundry.provider_call_logs WHERE reservation_id IN (SELECT id FROM foundry.ai_quota_reservations WHERE tenant_id = '${tenantId}');`,
        );
        executeSql(
          `DELETE FROM foundry.tenant_ai_quotas WHERE tenant_id = '${tenantId}';`,
        );
      }
    }
    await database?.destroy();
  });

  const EXPECTED_ROUTES = [
    { modeKey: "ocr_mode_fast", providerModelId: "gpt-5.4-mini" },
    { modeKey: "ocr_mode_balanced", providerModelId: "gpt-5.4-mini" },
    { modeKey: "ocr_mode_accurate", providerModelId: "gpt-5.4" },
  ] as const;

  it("resolves each seeded OCR mode to its current OpenAI route without secrets", async () => {
    const domain = createRoutesDomain(database);
    for (const { modeKey, providerModelId } of EXPECTED_ROUTES) {
      const route = await domain.resolveEffectiveRoute({
        operation: "RECEIPT_OCR",
        modeKey,
      });
      expect(route.providerKind).toBe("openai");
      expect(route.providerModelId).toBe(providerModelId);
      expect(route.routeVersionNumber).toBe(2);
      expect(route).not.toHaveProperty("secretReference");
      expect(route).not.toHaveProperty("secretValue");
    }
  });

  it("keeps the fake model row active and selectable by id after the OpenAI migration", async () => {
    const row = await database
      .selectFrom("foundry.ai_models")
      .select(["status"])
      .where("id", "=", FAKE_MODEL_ID)
      .executeTakeFirst();
    expect(row?.status).toBe("active");
  });

  it("returns NOT_FOUND uniformly for unknown modes, operations, and retired routes", async () => {
    const domain = createRoutesDomain(database);
    await expect(
      domain.resolveEffectiveRoute({ operation: "RECEIPT_OCR", modeKey: "nope" }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "NOT_FOUND" });
    // AI_SEARCH has no ocr_mode_* rows: operation mismatch is also NOT_FOUND.
    await expect(
      domain.resolveEffectiveRoute({ operation: "AI_SEARCH", modeKey: "ocr_mode_fast" }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "NOT_FOUND" });
  });

  it("runs a full RECEIPT_OCR reservation lifecycle against the fake model", async () => {
    const tenantId = randomUUID();
    createdTenantIds.push(tenantId);
    const domain = createQuotasDomain(database);

    const reservation = await domain.reserve({
      request: {
        tenantId,
        operation: "RECEIPT_OCR",
        aiModelId: FAKE_MODEL_ID,
        idempotencyKey: `0c-${runKey}-ocr-reserve`,
      },
      requestId: `0c-${runKey}-ocr-reserve`,
    });
    expect(reservation.status).toBe("RESERVED");

    const started = await domain.recordCallAttempt({
      reservationId: reservation.id,
      request: {},
      requestId: `0c-${runKey}-ocr-started`,
    });
    expect(started.reservation.status).toBe("CALL_STARTED");

    const settled = await domain.recordProviderOutcome({
      reservationId: reservation.id,
      attemptNumber: 1,
      request: { outcome: "accepted" },
      requestId: `0c-${runKey}-ocr-accepted`,
    });
    expect(settled.status).toBe("CONSUMED");
  });

  it("blocks reservations under an exhausted RECEIPT_OCR aggregate policy", async () => {
    const tenantId = randomUUID();
    createdTenantIds.push(tenantId);
    const domain = createQuotasDomain(database);
    await domain.createTenantAiQuota({
      request: {
        tenantId,
        operation: "RECEIPT_OCR",
        aiModelId: null,
        periodType: "monthly",
        maxJobs: 0,
      },
      actorPlatformSubject: "test",
      requestId: `0c-${runKey}-ocr-policy`,
    });

    await expect(
      domain.reserve({
        request: {
          tenantId,
          operation: "RECEIPT_OCR",
          aiModelId: FAKE_MODEL_ID,
          idempotencyKey: `0c-${runKey}-ocr-blocked`,
        },
        requestId: `0c-${runKey}-ocr-blocked`,
      }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "CONFLICT" });
  });
});
