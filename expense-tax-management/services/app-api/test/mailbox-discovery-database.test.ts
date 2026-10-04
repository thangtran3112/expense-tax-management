/**
 * Migration 019 structural tests (Phase 3D-B Task 1: mailbox scan/candidate
 * discovery schema prerequisite).
 *
 * An executable import is used so malformed TypeScript causes a module-load
 * error rather than silently satisfying text-search assertions. Live
 * PostgreSQL proofs (FK enforcement, trigger behavior) are Docker-gated
 * integration tests added by later Phase 3D-B tasks, not Task 1 (same
 * precedent as migration 018's Task 1 structural suite).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as migration019 from "../src/database/migrations/019_mailbox_discovery.js";

const migrationsDir = fileURLToPath(new URL("../src/database/migrations", import.meta.url));

const migration = readFileSync(
  new URL("../src/database/migrations/019_mailbox_discovery.ts", import.meta.url),
  "utf8",
);

describe("mailbox discovery migration 019 – executable import", () => {
  it("exports up and down functions (module is valid TypeScript)", () => {
    expect(typeof migration019.up).toBe("function");
    expect(typeof migration019.down).toBe("function");
  });
});

describe("mailbox discovery migration 019 – ordering", () => {
  it("sorts after migrations 016, 017, and 018", () => {
    const names = readdirSync(migrationsDir).sort();
    const indexOf016 = names.indexOf("016_expense_enrichment.ts");
    const indexOf017 = names.indexOf("017_temporal_dispatch_routing.ts");
    const indexOf018 = names.indexOf("018_mailbox_connections.ts");
    const indexOf019 = names.indexOf("019_mailbox_discovery.ts");

    expect(indexOf016).toBeGreaterThanOrEqual(0);
    expect(indexOf017).toBeGreaterThan(indexOf016);
    expect(indexOf018).toBeGreaterThan(indexOf017);
    expect(indexOf019).toBeGreaterThan(indexOf018);
  });
});

describe("mailbox discovery migration 019 – cursor fence columns on app.mailbox_connections", () => {
  it("adds history/cursor/pre-fence/page-sequence columns via ALTER TABLE", () => {
    expect(migration).toMatch(/ALTER TABLE app\.mailbox_connections[\s\S]*ADD COLUMN current_history_id text/);
    expect(migration).toContain("ADD COLUMN current_cursor_digest text");
    expect(migration).toContain("ADD COLUMN pre_fence_token text");
    expect(migration).toContain("ADD COLUMN next_page_sequence integer NOT NULL DEFAULT 1");
  });
});

describe("mailbox discovery migration 019 – app.mailbox_scan_runs", () => {
  it("creates the table referencing the owning connection via composite tenant FK", () => {
    expect(migration).toContain("CREATE TABLE app.mailbox_scan_runs");
    expect(migration).toMatch(
      /mailbox_scan_runs_connection_tenant_fk[\s\S]*FOREIGN KEY \(connection_id, tenant_id\)[\s\S]*REFERENCES app\.mailbox_connections\(id, tenant_id\)/,
    );
  });

  it("enforces the documented status values", () => {
    expect(migration).toMatch(
      /mailbox_scan_runs_status_check[\s\S]*CHECK \(status IN \('pending', 'running', 'completed', 'partial', 'failed', 'skipped'\)\)/,
    );
  });

  it("enforces permanent uniqueness over (connection_id, idempotency_key) only -- the normalized_request_hash is compared in application code, not part of the constraint, so a differing-hash replay collides at the DB level", () => {
    expect(migration).toMatch(
      /mailbox_scan_runs_permanent_unique[\s\S]*UNIQUE \(connection_id, idempotency_key\)/,
    );
    expect(migration).not.toMatch(
      /UNIQUE \(connection_id, idempotency_key, normalized_request_hash\)/,
    );
  });

  it("carries no provider message/thread ID column (Temporal-crossing contracts never see it; it is App-candidate-row-only)", () => {
    const tableMatch = migration.match(/CREATE TABLE app\.mailbox_scan_runs \([\s\S]*?\n    \)/);
    expect(tableMatch).not.toBeNull();
    expect(tableMatch![0]).not.toMatch(/provider_message_id|provider_thread_id/);
  });
});

describe("mailbox discovery migration 019 – app.mailbox_candidates", () => {
  it("creates the table with composite scan-run and connection tenant FKs", () => {
    expect(migration).toContain("CREATE TABLE app.mailbox_candidates");
    expect(migration).toMatch(
      /mailbox_candidates_scan_run_tenant_fk[\s\S]*FOREIGN KEY \(scan_run_id, tenant_id\)[\s\S]*REFERENCES app\.mailbox_scan_runs\(id, tenant_id\)/,
    );
    expect(migration).toMatch(
      /mailbox_candidates_connection_tenant_fk[\s\S]*FOREIGN KEY \(connection_id, tenant_id\)[\s\S]*REFERENCES app\.mailbox_connections\(id, tenant_id\)/,
    );
  });

  it("stores the provider message ID only here (App candidate row), with provider_thread_id nullable", () => {
    expect(migration).toContain("provider_message_id text NOT NULL");
    expect(migration).toContain("provider_thread_id text");
  });

  it("enforces exactly one assigned Personal/business scope, or neither (unassigned/review state)", () => {
    expect(migration).toMatch(
      /mailbox_candidates_scope_check[\s\S]*CHECK \(\s*\(candidate_personal_profile_id IS NULL AND candidate_business_id IS NULL\)\s*OR \(candidate_personal_profile_id IS NULL\) <> \(candidate_business_id IS NULL\)\s*\)/,
    );
  });

  it("enforces the documented classification and status values", () => {
    expect(migration).toMatch(
      /mailbox_candidates_classification_check[\s\S]*CHECK \(classification IN \('receipt', 'ambiguous', 'not_receipt'\)\)/,
    );
    expect(migration).toMatch(
      /mailbox_candidates_status_check[\s\S]*CHECK \(status IN \('staged', 'review', 'queued', 'processed', 'duplicate', 'skipped', 'failed'\)\)/,
    );
  });

  it("bounds the attachment manifest to an array of at most 5 entries (spec: 'at most 5 accepted attachments')", () => {
    expect(migration).toMatch(
      /mailbox_candidates_attachment_manifest_check[\s\S]*jsonb_typeof\(attachment_manifest\) = 'array'[\s\S]*jsonb_array_length\(attachment_manifest\) <= 5/,
    );
  });

  it("enforces unique (connection_id, provider_message_id) -- one candidate row per discovered message", () => {
    expect(migration).toMatch(
      /mailbox_candidates_message_unique[\s\S]*UNIQUE \(connection_id, provider_message_id\)/,
    );
  });

  it("enforces permanent uniqueness over (connection_id, idempotency_key) only -- same triple-only/hash-compared-separately pattern as mailbox_scan_runs and migration 018's operation-key ledger", () => {
    expect(migration).toMatch(
      /mailbox_candidates_permanent_unique[\s\S]*UNIQUE \(connection_id, idempotency_key\)/,
    );
    expect(migration).not.toMatch(
      /UNIQUE \(connection_id, idempotency_key, normalized_request_hash\)/,
    );
  });

  it("guards terminal candidates (processed/duplicate/skipped) as fully immutable, including same-status updates", () => {
    expect(migration).toMatch(/prevent_mailbox_candidate_terminal_update/);
    expect(migration).toMatch(/mailbox_candidates_terminal_guard_trigger/);
    expect(migration).toMatch(
      /OLD\.status IN \('processed', 'duplicate', 'skipped'\) AND OLD IS DISTINCT FROM NEW/,
    );
  });

  it("allows exactly one failed-candidate exception: failed -> review (Phase 3D-B Task 5's retry action), nothing else", () => {
    expect(migration).toMatch(
      /OLD\.status = 'failed' AND OLD IS DISTINCT FROM NEW AND NEW\.status != 'review'/,
    );
  });

  it("carries no raw MIME/body/HTML/text/OAuth columns (spec: 'Raw MIME, body HTML/text, inline images, and OAuth values are never stored here')", () => {
    for (const forbidden of [
      "raw_mime",
      "body_html",
      "body_text",
      "access_token",
      "refresh_token",
      "authorization_code",
    ]) {
      expect(migration).not.toContain(forbidden);
    }
  });
});

describe("mailbox discovery migration 019 – app.mailbox_scan_page_outcomes (durable page outcomes/retries)", () => {
  it("creates the table with a permanent unique key per (scan_run_id, page_sequence)", () => {
    expect(migration).toContain("CREATE TABLE app.mailbox_scan_page_outcomes");
    expect(migration).toMatch(
      /mailbox_scan_page_outcomes_permanent_unique[\s\S]*UNIQUE \(scan_run_id, page_sequence\)/,
    );
  });

  it("carries durable retry_count and status for recovery without depending on Gmail retaining old history", () => {
    expect(migration).toContain("retry_count integer NOT NULL DEFAULT 0");
    expect(migration).toMatch(
      /mailbox_scan_page_outcomes_status_check[\s\S]*CHECK \(status IN \('pending', 'completed', 'failed'\)\)/,
    );
  });
});

describe("mailbox discovery migration 019 – role grants", () => {
  it("adds no blanket GRANT ALL", () => {
    expect(migration).not.toMatch(/GRANT ALL/);
  });
});

describe("mailbox discovery migration 019 – down() is forward-only (binding constraint: migrations never roll back persisted data)", () => {
  it("throws instead of dropping any table or column -- actually invoked, not just asserted from source text", async () => {
    await expect(migration019.down()).rejects.toThrow(/forward-only/i);
  });

  it("carries no DROP TABLE/DROP COLUMN statement in down() (source-text backstop against a future regression re-adding destructive rollback)", () => {
    const downMatch = migration.match(/export async function down\(\)[\s\S]*$/);
    expect(downMatch).not.toBeNull();
    const downBody = downMatch![0];
    expect(downBody).not.toMatch(/dropTable|DROP TABLE|DROP COLUMN/);
  });
});

describe("mailbox discovery migration 019 – scope-targeted review queue indexes", () => {
  it("adds one partial index per nullable scope column (same split-by-scope reasoning as migration 018's active-uniqueness indexes)", () => {
    expect(migration).toMatch(
      /CREATE INDEX mailbox_candidates_personal_scope_index[\s\S]*ON app\.mailbox_candidates \(tenant_id, candidate_personal_profile_id, status\)[\s\S]*WHERE candidate_personal_profile_id IS NOT NULL/,
    );
    expect(migration).toMatch(
      /CREATE INDEX mailbox_candidates_business_scope_index[\s\S]*ON app\.mailbox_candidates \(tenant_id, candidate_business_id, status\)[\s\S]*WHERE candidate_business_id IS NOT NULL/,
    );
  });
});
