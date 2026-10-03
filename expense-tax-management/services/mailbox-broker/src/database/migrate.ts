import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Kysely, PostgresDialect } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { Pool } from "pg";

/**
 * Not in Task 3's explicit file-list, but required to apply migrations
 * 001/002 against a real test database (and, later, the broker's own
 * production bootstrap) -- same role app-api/src/database/migrate.ts and
 * foundry-service/src/database/migrate.ts already play for their own
 * services. 1:1 port of app-api's version.
 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export function requiredMigrationDatabaseUrl(value: string | undefined): string {
  const migrationDatabaseUrl = value?.trim();
  if (!migrationDatabaseUrl) {
    throw new Error(
      "Missing required environment variable: MAILBOX_BROKER_MIGRATION_DATABASE_URL",
    );
  }
  return migrationDatabaseUrl;
}

export function createMigratorDatabase(migrationDatabaseUrl: string): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: migrationDatabaseUrl,
        max: 1,
        connectionTimeoutMillis: 5_000,
      }),
    }),
  });
}

export async function runMigrations(migrationDatabaseUrl: string): Promise<void> {
  const database = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: migrationDatabaseUrl,
        max: 1,
        connectionTimeoutMillis: 5_000,
      }),
    }),
  });

  try {
    const migrator = new Migrator({
      db: database,
      migrationTableSchema: "token_vault_migrations",
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: MIGRATIONS_FOLDER,
      }),
    });
    const { error, results } = await migrator.migrateToLatest();

    for (const result of results ?? []) {
      console.info(
        `migration "${result.migrationName}" ${result.direction.toLowerCase()} status: ${result.status}`,
      );
    }

    if (error) {
      throw error;
    }
  } finally {
    await database.destroy();
  }
}

async function main(): Promise<void> {
  await runMigrations(
    requiredMigrationDatabaseUrl(process.env.MAILBOX_BROKER_MIGRATION_DATABASE_URL),
  );
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error("Mailbox broker database migration failed", error);
    process.exitCode = 1;
  });
}
