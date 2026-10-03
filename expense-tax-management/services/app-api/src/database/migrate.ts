import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Kysely, PostgresDialect } from "kysely";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { Pool } from "pg";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

export function requiredMigrationDatabaseUrl(value: string | undefined): string {
  const migrationDatabaseUrl = value?.trim();
  if (!migrationDatabaseUrl) {
    throw new Error(
      "Missing required environment variable: APP_MIGRATION_DATABASE_URL",
    );
  }

  return migrationDatabaseUrl;
}

/**
 * Create a Kysely database connection using migrator credentials.
 * Exported for use in integration tests that need to call migration
 * functions (e.g. down()) directly without going through the migration
 * tracking system. Callers are responsible for calling destroy() on the
 * returned instance.
 */
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

export async function runMigrations(
  migrationDatabaseUrl: string,
): Promise<void> {
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
      migrationTableSchema: "app_migrations",
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
    requiredMigrationDatabaseUrl(process.env.APP_MIGRATION_DATABASE_URL),
  );
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  void main().catch((error: unknown) => {
    console.error("App database migration failed", error);
    process.exitCode = 1;
  });
}
