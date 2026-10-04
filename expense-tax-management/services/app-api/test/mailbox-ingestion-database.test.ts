/**
 * Migration 020 structural tests (Phase 3D-C Task 1: mailbox ingestion
 * schema + connected provenance prerequisite).
 *
 * An executable import is used so malformed TypeScript causes a module-load
 * error rather than silently satisfying text-search assertions. Live
 * PostgreSQL proofs (FK enforcement, trigger behavior) are Docker-gated
 * integration tests added by later Phase 3D-C tasks, not Task 1 (same
 * precedent as migrations 018/019's own Task 1 structural suites).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as migration020 from "../src/database/migrations/020_mailbox_ingestion.js";

const migrationsDir = fileURLToPath(new URL("../src/database/migrations", import.meta.url));

const migration = readFileSync(
  new URL("../src/database/migrations/020_mailbox_ingestion.ts", import.meta.url),
  "utf8",
);

describe("mailbox ingestion migration 020 – executable import", () => {
  it("exports up and down functions (module is valid TypeScript)", () => {
    expect(typeof migration020.up).toBe("function");
    expect(typeof migration020.down).toBe("function");
  });
});

describe("mailbox ingestion migration 020 – ordering", () => {
  it("sorts after migrations 016, 017, 018, and 019", () => {
    const names = readdirSync(migrationsDir).sort();
    const indexOf016 = names.indexOf("016_expense_enrichment.ts");
    const indexOf017 = names.indexOf("017_temporal_dispatch_routing.ts");
    const indexOf018 = names.indexOf("018_mailbox_connections.ts");
    const indexOf019 = names.indexOf("019_mailbox_discovery.ts");
    const indexOf020 = names.indexOf("020_mailbox_ingestion.ts");

    expect(indexOf016).toBeGreaterThanOrEqual(0);
    expect(indexOf017).toBeGreaterThan(indexOf016);
    expect(indexOf018).toBeGreaterThan(indexOf017);
    expect(indexOf019).toBeGreaterThan(indexOf018);
    expect(indexOf020).toBeGreaterThan(indexOf019);
  });
});

describe("mailbox ingestion migration 020 – app.mailbox_candidates composite unique index prerequisites", () => {
  it("adds (id, tenant_id) before it is used as an FK target (same requirement migration 015 solved for expense_files/inbound_emails)", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX mailbox_candidates_id_tenant_unique[\s\S]*ON app\.mailbox_candidates \(id, tenant_id\)/,
    );
  });

  it("adds (id, connection_id, tenant_id) so the ingestion ledger's candidate FK can also bind connection_id (fix round 1, finding 2)", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX mailbox_candidates_id_connection_tenant_unique[\s\S]*ON app\.mailbox_candidates \(id, connection_id, tenant_id\)/,
    );
  });
});

describe("mailbox ingestion migration 020 – app.expense_sources connected provenance", () => {
  it("adds a nullable mailbox_candidate_id column with a composite tenant FK to app.mailbox_candidates", () => {
    expect(migration).toMatch(
      /ALTER TABLE app\.expense_sources\s*ADD COLUMN mailbox_candidate_id uuid/,
    );
    expect(migration).toMatch(
      /expense_sources_mailbox_candidate_tenant_fk[\s\S]*FOREIGN KEY \(mailbox_candidate_id, tenant_id\)[\s\S]*REFERENCES app\.mailbox_candidates\(id, tenant_id\)/,
    );
  });

  it("extends source_type to manual_upload|forwarded_email|connected_mailbox, requiring exactly one source-identifying column", () => {
    expect(migration).toMatch(
      /expense_sources_type_check[\s\S]*CHECK \(\s*\(source_type = 'manual_upload' AND source_file_id IS NOT NULL\s*AND inbound_email_id IS NULL AND mailbox_candidate_id IS NULL\)\s*OR \(source_type = 'forwarded_email' AND inbound_email_id IS NOT NULL\s*AND mailbox_candidate_id IS NULL\)\s*OR \(source_type = 'connected_mailbox' AND mailbox_candidate_id IS NOT NULL\s*AND inbound_email_id IS NULL\)\s*\)/,
    );
  });

  it("does not edit the historical migration 015 file (drops and recreates the named constraint instead)", () => {
    expect(migration).toMatch(/ALTER TABLE app\.expense_sources\s*DROP CONSTRAINT expense_sources_type_check/);
    const migration015 = readFileSync(
      new URL("../src/database/migrations/015_expense_deduplication.ts", import.meta.url),
      "utf8",
    );
    expect(migration015).not.toContain("connected_mailbox");
  });

  it("enforces unique (tenant_id, mailbox_candidate_id) for rows where it is set, same partial-unique pattern as the file/email columns", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX expense_sources_mailbox_candidate_unique[\s\S]*ON app\.expense_sources \(tenant_id, mailbox_candidate_id\)[\s\S]*WHERE mailbox_candidate_id IS NOT NULL/,
    );
  });

  it("extends the shared scope-validation trigger function with an exact tenant/scope match against app.mailbox_candidates", () => {
    expect(migration).toMatch(
      /IF NEW\.mailbox_candidate_id IS NOT NULL THEN[\s\S]*candidate_personal_profile_id, candidate_business_id[\s\S]*FROM app\.mailbox_candidates[\s\S]*RAISE EXCEPTION 'expense source mailbox candidate scope mismatch'/,
    );
  });
});

describe("mailbox ingestion migration 020 – referenced candidate scope/connection immutability (fix round 1, finding 3)", () => {
  it("adds a column-list trigger on app.mailbox_candidates guarding scope and connection once an expense_sources row references it", () => {
    expect(migration).toMatch(/prevent_mailbox_candidate_referenced_scope_update/);
    expect(migration).toMatch(
      /CREATE TRIGGER mailbox_candidates_referenced_scope_guard_trigger\s*BEFORE UPDATE OF tenant_id, connection_id, candidate_personal_profile_id, candidate_business_id\s*ON app\.mailbox_candidates/,
    );
    expect(migration).toMatch(
      /EXISTS \(SELECT 1 FROM app\.expense_sources WHERE mailbox_candidate_id = OLD\.id\)/,
    );
  });
});

describe("mailbox ingestion migration 020 – app.mailbox_ingestion_operations", () => {
  it("creates the table with composite tenant FKs to connection and candidate", () => {
    expect(migration).toContain("CREATE TABLE app.mailbox_ingestion_operations");
    expect(migration).toMatch(
      /mailbox_ingestion_operations_connection_tenant_fk[\s\S]*FOREIGN KEY \(connection_id, tenant_id\)[\s\S]*REFERENCES app\.mailbox_connections\(id, tenant_id\)/,
    );
    expect(migration).toMatch(
      /mailbox_ingestion_operations_candidate_connection_tenant_fk[\s\S]*FOREIGN KEY \(candidate_id, connection_id, tenant_id\)[\s\S]*REFERENCES app\.mailbox_candidates\(id, connection_id, tenant_id\)/,
    );
  });

  it("binds the candidate to the SAME connection via the three-column FK, not just the same tenant (fix round 1, finding 2)", () => {
    expect(migration).not.toMatch(
      /mailbox_ingestion_operations_candidate_tenant_fk[\s\S]*FOREIGN KEY \(candidate_id, tenant_id\)/,
    );
  });

  it("enforces the documented operation_kind and forward-only status values", () => {
    expect(migration).toMatch(
      /mailbox_ingestion_operations_kind_check[\s\S]*CHECK \(operation_kind IN \(\s*'issue_upload_grant', 'upload_attachment', 'submit_structured_result',\s*'materialize_candidate'\s*\)\)/,
    );
    expect(migration).toMatch(
      /mailbox_ingestion_operations_status_check[\s\S]*CHECK \(status IN \('pending', 'started', 'completed', 'failed'\)\)/,
    );
  });

  it("enforces permanent uniqueness over (tenant_id, operation_key, idempotency_key) only -- normalized_request_hash compared in application code, same triple-only pattern as migration 018/019's ledgers", () => {
    expect(migration).toMatch(
      /mailbox_ingestion_operations_permanent_unique[\s\S]*UNIQUE \(tenant_id, operation_key, idempotency_key\)/,
    );
    expect(migration).not.toMatch(
      /UNIQUE \(tenant_id, operation_key, idempotency_key, normalized_request_hash\)/,
    );
  });

  it("does not revoke UPDATE from the runtime role (rows legitimately progress pending -> started -> completed|failed, unlike the pure-append mailbox_operation_keys ledger)", () => {
    expect(migration).not.toMatch(/REVOKE UPDATE.*mailbox_ingestion_operations/);
  });

  it("guards completed/failed rows as fully immutable, and permits only the documented pending -> started -> completed|failed edges (fix round 1, finding 1)", () => {
    expect(migration).toMatch(/prevent_mailbox_ingestion_operation_invalid_transition/);
    expect(migration).toMatch(/mailbox_ingestion_operations_transition_guard_trigger/);
    expect(migration).toMatch(/OLD\.status IN \('completed', 'failed'\) THEN/);
    expect(migration).toMatch(
      /\(OLD\.status = 'pending' AND NEW\.status = 'started'\)\s*OR \(OLD\.status = 'started' AND NEW\.status IN \('completed', 'failed'\)\)/,
    );
  });

  it("does not leave the old terminal-only (not forward-only) guard in place", () => {
    expect(migration).not.toMatch(/prevent_mailbox_ingestion_operation_terminal_update/);
    expect(migration).not.toMatch(/mailbox_ingestion_operations_terminal_guard_trigger/);
  });

  it("constrains response_json per operation_kind with strict field formats, not just scalar-ness (fix round 2)", () => {
    expect(migration).toMatch(/validate_mailbox_ingestion_operation_response/);
    expect(migration).toMatch(/mailbox_ingestion_operations_response_shape_guard_trigger/);
    expect(migration).toMatch(/jsonb_typeof\(NEW\.response_json\) <> 'object'/);
    expect(migration).toMatch(/allowed_keys := CASE NEW\.operation_kind/);
    for (const key of [
      "candidateId", "connectionId", "uploadGrantId", "fileId", "status", "errorCode",
      "idempotencyKey", "processingJobId", "expenseId", "sourceId", "duplicateMatchId",
    ]) {
      expect(migration).toContain(`'${key}'`);
    }
  });

  it("validates candidate/connection/expense-family ids as lowercase UUIDs, not bare scalars (fix round 2)", () => {
    expect(migration).toMatch(
      /'candidateId', 'connectionId', 'processingJobId', 'expenseId', 'sourceId', 'duplicateMatchId' THEN[\s\S]*\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/,
    );
  });

  it("validates errorCode against the canonical error-code TOKEN PATTERN, not the hardcoded enum (avoids drift from packages/contracts/src/mailbox.ts)", () => {
    expect(migration).toMatch(/WHEN 'errorCode' THEN[\s\S]*\^\[A-Z\]\[A-Z0-9_\]\{1,63\}\$/);
  });

  it("validates status against the exact set for the row's own operation_kind, not the union of both shapes", () => {
    expect(migration).toMatch(/IF NEW\.operation_kind = 'upload_attachment' THEN[\s\S]*'READY', 'REVIEW', 'FAILED'/);
    expect(migration).toMatch(/'queued', 'processed', 'duplicate', 'review', 'failed'/);
  });

  it("validates uploadGrantId/fileId/idempotencyKey as bounded whitespace-free tokens (a multi-line HTML/MIME body can never match)", () => {
    expect(migration).toMatch(
      /'uploadGrantId', 'fileId', 'idempotencyKey' THEN[\s\S]*char_length\(response_value #>> '\{\}'\) > 500[\s\S]*\^\[\\x21-\\x7e\]\+\$/,
    );
  });

  it("splits the 500-char bound from the charset regex for opaque tokens (PostgreSQL's regex engine caps repetition counts at 255, so a single {1,500} pattern would throw at runtime)", () => {
    expect(migration).not.toMatch(/\\x21-\\x7e\]\{1,500\}/);
  });

  it("indexes a reconcile sweep over pending/started materialize_candidate rows", () => {
    expect(migration).toMatch(
      /CREATE INDEX mailbox_ingestion_operations_materialize_pending_index[\s\S]*ON app\.mailbox_ingestion_operations \(tenant_id, status\)[\s\S]*WHERE operation_kind = 'materialize_candidate' AND status IN \('pending', 'started'\)/,
    );
  });

  it("carries no raw MIME/body/HTML/text/OAuth columns", () => {
    const tableMatch = migration.match(/CREATE TABLE app\.mailbox_ingestion_operations \([\s\S]*?\n    \)/);
    expect(tableMatch).not.toBeNull();
    for (const forbidden of ["raw_mime", "body_html", "body_text", "access_token", "refresh_token"]) {
      expect(tableMatch![0]).not.toContain(forbidden);
    }
  });
});

describe("mailbox ingestion migration 020 – role grants", () => {
  it("adds no blanket GRANT ALL", () => {
    expect(migration).not.toMatch(/GRANT ALL/);
  });
});

describe("mailbox ingestion migration 020 – down() is forward-only (binding constraint: migrations never roll back persisted data)", () => {
  it("throws instead of dropping any table or column -- actually invoked, not just asserted from source text", async () => {
    await expect(migration020.down()).rejects.toThrow(/forward-only/i);
  });

  it("carries no DROP TABLE/DROP COLUMN statement in down() (source-text backstop against a future regression re-adding destructive rollback)", () => {
    const downMatch = migration.match(/export async function down\(\)[\s\S]*$/);
    expect(downMatch).not.toBeNull();
    const downBody = downMatch![0];
    expect(downBody).not.toMatch(/dropTable|DROP TABLE|DROP COLUMN/);
  });
});
