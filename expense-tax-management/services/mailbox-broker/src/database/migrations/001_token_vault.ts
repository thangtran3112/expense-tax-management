import { type Kysely, sql } from "kysely";

/**
 * Phase 3D-A Task 3 — token vault schema.
 *
 * One row per (connection_id, generation). AAD for every encrypt/decrypt
 * call is `${connectionId}:${keyId}:${generation}` (enforced in
 * application code, src/token-vault.ts), binding ciphertext to its own
 * row so it can never be decrypted -- or silently substituted -- into
 * another connection/key/generation's slot.
 *
 * UNIQUE (key_id, nonce) makes a generated-nonce collision under the
 * same key impossible to persist (not merely unlikely): the encrypt
 * operation retries with a freshly generated nonce on conflict.
 *
 * This is the broker's own dedicated database -- never App API's
 * PostgreSQL -- so there is no multi-tenant `app` schema prefix here;
 * tables live in `public`.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE token_vault (
      connection_id uuid NOT NULL,
      generation integer NOT NULL,
      key_id text NOT NULL,
      nonce bytea NOT NULL,
      ciphertext bytea NOT NULL,
      auth_tag bytea NOT NULL,
      disabled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (connection_id, generation),
      CONSTRAINT token_vault_generation_check CHECK (generation > 0),
      CONSTRAINT token_vault_key_id_check CHECK (char_length(trim(key_id)) BETWEEN 1 AND 100),
      CONSTRAINT token_vault_nonce_length_check CHECK (octet_length(nonce) = 12),
      CONSTRAINT token_vault_auth_tag_length_check CHECK (octet_length(auth_tag) = 16),
      CONSTRAINT token_vault_key_nonce_unique UNIQUE (key_id, nonce)
    )
  `.execute(database);

  await sql`
    CREATE INDEX token_vault_connection_active_index
      ON token_vault (connection_id)
      WHERE disabled_at IS NULL
  `.execute(database);

  await sql`
    CREATE INDEX token_vault_key_id_active_index
      ON token_vault (key_id)
      WHERE disabled_at IS NULL
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await database.schema.dropTable("token_vault").ifExists().execute();
}
