/**
 * Migration 017 structural tests (Task 7 Stage A: transactional Temporal
 * dispatch routing fence).
 *
 * An executable import is used so malformed TypeScript causes a module-load
 * error rather than silently satisfying text-search assertions. Live
 * PostgreSQL singleton/grant/fence proofs live in the Docker-gated
 * integration test (test/integration/app-domain-task7-dispatch-routing.test.ts).
 */
import * as migration017 from "../src/database/migrations/017_temporal_dispatch_routing.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../src/database/migrations/017_temporal_dispatch_routing.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("temporal dispatch routing migration 017 – executable import", () => {
  it("exports up and down functions (module is valid TypeScript)", () => {
    expect(typeof migration017.up).toBe("function");
    expect(typeof migration017.down).toBe("function");
  });
});

describe("temporal dispatch routing migration 017 – schema structure", () => {
  it("creates app.temporal_dispatch_routing", () => {
    expect(migration).toContain("CREATE TABLE app.temporal_dispatch_routing");
  });

  it("enforces a singleton row via boolean primary key + check", () => {
    const tableMatch = migration.match(
      /CREATE TABLE app\.temporal_dispatch_routing\s*\([^;]+\)/,
    );
    expect(tableMatch).not.toBeNull();
    const table = tableMatch![0];
    expect(table).toMatch(/singleton\s+boolean\s+PRIMARY KEY/);
    expect(table).toMatch(/CHECK\s*\(\s*singleton\s*\)/);
  });

  it("enforces generation >= 1", () => {
    expect(migration).toMatch(
      /temporal_dispatch_routing_generation_check[\s\S]*generation\s*>=\s*1/,
    );
  });

  it("has temporal_namespace, task_queue, and updated_at columns", () => {
    const tableMatch = migration.match(
      /CREATE TABLE app\.temporal_dispatch_routing\s*\([^;]+\)/,
    );
    const table = tableMatch![0];
    expect(table).toContain("temporal_namespace");
    expect(table).toContain("task_queue");
    expect(table).toMatch(/updated_at\s+timestamptz\s+NOT NULL/);
  });

  it("seeds generation 1 = legacy Python routing (namespace default, queue expense-tax-ai-worker)", () => {
    expect(migration).toMatch(
      /INSERT INTO app\.temporal_dispatch_routing[\s\S]*generation[\s\S]*VALUES/,
    );
    expect(migration).toContain("'default'");
    expect(migration).toContain("'expense-tax-ai-worker'");
  });

  it("adds dispatch_generation and dispatch_namespace to app.processing_jobs, defaulted to generation 1 / legacy namespace (backfill via column default)", () => {
    expect(migration).toMatch(
      /ALTER TABLE app\.processing_jobs[\s\S]*ADD COLUMN dispatch_generation integer NOT NULL DEFAULT 1/,
    );
    expect(migration).toMatch(
      /ALTER TABLE app\.processing_jobs[\s\S]*ADD COLUMN dispatch_namespace text NOT NULL DEFAULT 'default'/,
    );
  });

  it("restricts the runtime role to SELECT only on the routing table", () => {
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON app\.temporal_dispatch_routing FROM expense_app_runtime/,
    );
    expect(migration).toMatch(
      /GRANT SELECT ON app\.temporal_dispatch_routing TO expense_app_runtime/,
    );
  });

  it("down() drops the processing_jobs columns and the routing table", () => {
    expect(migration).toMatch(
      /DROP COLUMN IF EXISTS dispatch_generation/,
    );
    expect(migration).toMatch(
      /DROP COLUMN IF EXISTS dispatch_namespace/,
    );
    expect(migration).toMatch(
      /dropTable\("app\.temporal_dispatch_routing"\)/,
    );
  });
});
