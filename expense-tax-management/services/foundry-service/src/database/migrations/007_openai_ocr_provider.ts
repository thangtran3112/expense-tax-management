import { type Kysely, sql } from "kysely";

const SECRET_ID = "eeeeeeee-0002-4000-8000-000000000001";
const CONNECTION_ID = "eeeeeeee-0002-4000-8000-000000000002";
const MINI_MODEL_ID = "eeeeeeee-0002-4000-8000-000000000003";
const FULL_MODEL_ID = "eeeeeeee-0002-4000-8000-000000000004";

const MODES = [
  {
    modeId: "eeeeeeee-0001-4000-8000-000000000004",
    routeId: "eeeeeeee-0002-4000-8000-000000000005",
    modelId: MINI_MODEL_ID,
    description: "Fast receipt OCR",
    previous: "Fast fake OCR mode (dev/test only)",
  },
  {
    modeId: "eeeeeeee-0001-4000-8000-000000000005",
    routeId: "eeeeeeee-0002-4000-8000-000000000006",
    modelId: MINI_MODEL_ID,
    description: "Balanced receipt OCR",
    previous: "Balanced fake OCR mode (dev/test only)",
  },
  {
    modeId: "eeeeeeee-0001-4000-8000-000000000006",
    routeId: "eeeeeeee-0002-4000-8000-000000000007",
    modelId: FULL_MODEL_ID,
    description: "Accurate receipt OCR (most capable model)",
    previous: "Accurate fake OCR mode (dev/test only)",
  },
] as const;

export async function up(database: Kysely<unknown>): Promise<void> {
  // The vault value is deliberately NOT a credential: OpenAI keys live in
  // Firestore family-config and reach only workflow-worker. The row exists
  // because connections require a secret reference.
  await sql`
    INSERT INTO foundry.provider_secrets (id, value)
    VALUES (${sql.lit(SECRET_ID)}, 'family-config:shared/llm (no credential stored here)')
    ON CONFLICT (id) DO NOTHING
  `.execute(database);
  await sql`
    INSERT INTO foundry.provider_connections (id, key, provider_kind, display_name, secret_reference, status)
    VALUES (${sql.lit(CONNECTION_ID)}, 'openai', 'openai', 'OpenAI', ${sql.lit(SECRET_ID)}, 'active')
    ON CONFLICT (id) DO NOTHING
  `.execute(database);
  await sql`
    INSERT INTO foundry.ai_models (id, provider_connection_id, provider_model_id, metered_model_key, status)
    VALUES
      (${sql.lit(MINI_MODEL_ID)}, ${sql.lit(CONNECTION_ID)}, 'gpt-5.4-mini', 'openai-gpt-5.4-mini', 'active'),
      (${sql.lit(FULL_MODEL_ID)}, ${sql.lit(CONNECTION_ID)}, 'gpt-5.4', 'openai-gpt-5.4', 'active')
    ON CONFLICT (id) DO NOTHING
  `.execute(database);
  for (const mode of MODES) {
    await sql`UPDATE foundry.ai_modes SET description = ${mode.description} WHERE id = ${sql.lit(mode.modeId)}`.execute(database);
    await sql`
      UPDATE foundry.ai_mode_route_versions SET is_current = false
      WHERE ai_mode_id = ${sql.lit(mode.modeId)} AND is_current
    `.execute(database);
    await sql`
      INSERT INTO foundry.ai_mode_route_versions (id, ai_mode_id, version_number, ai_model_id, is_current)
      SELECT ${sql.lit(mode.routeId)}, ${sql.lit(mode.modeId)}, COALESCE(MAX(version_number), 0) + 1, ${sql.lit(mode.modelId)}, true
      FROM foundry.ai_mode_route_versions WHERE ai_mode_id = ${sql.lit(mode.modeId)}
      ON CONFLICT (id) DO NOTHING
    `.execute(database);
  }
}

export async function down(database: Kysely<unknown>): Promise<void> {
  for (const mode of MODES) {
    await sql`DELETE FROM foundry.ai_mode_route_versions WHERE id = ${sql.lit(mode.routeId)}`.execute(database);
    await sql`
      UPDATE foundry.ai_mode_route_versions SET is_current = true
      WHERE ai_mode_id = ${sql.lit(mode.modeId)} AND version_number = 1
    `.execute(database);
    await sql`UPDATE foundry.ai_modes SET description = ${mode.previous} WHERE id = ${sql.lit(mode.modeId)}`.execute(database);
  }
  await sql`DELETE FROM foundry.ai_models WHERE id IN (${sql.lit(MINI_MODEL_ID)}, ${sql.lit(FULL_MODEL_ID)})`.execute(database);
  await sql`DELETE FROM foundry.provider_connections WHERE id = ${sql.lit(CONNECTION_ID)}`.execute(database);
  await sql`DELETE FROM foundry.provider_secrets WHERE id = ${sql.lit(SECRET_ID)}`.execute(database);
}
