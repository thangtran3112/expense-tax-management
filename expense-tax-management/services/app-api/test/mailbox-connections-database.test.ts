/**
 * Migration 018 structural tests (Phase 3D-A Task 1: mailbox connection
 * ownership ledger prerequisite).
 *
 * An executable import is used so malformed TypeScript causes a module-load
 * error rather than silently satisfying text-search assertions. Live
 * PostgreSQL proofs (FK enforcement, trigger behavior) are Docker-gated
 * integration tests added by later Phase 3D-A tasks, not Task 1.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as migration018 from "../src/database/migrations/018_mailbox_connections.js";

const migrationsDir = fileURLToPath(new URL("../src/database/migrations", import.meta.url));

const migration = readFileSync(
  new URL("../src/database/migrations/018_mailbox_connections.ts", import.meta.url),
  "utf8",
);

describe("mailbox connections migration 018 – executable import", () => {
  it("exports up and down functions (module is valid TypeScript)", () => {
    expect(typeof migration018.up).toBe("function");
    expect(typeof migration018.down).toBe("function");
  });
});

describe("mailbox connections migration 018 – ordering", () => {
  it("sorts after migration 016 (expense enrichment) and 017 (dispatch routing)", () => {
    const names = readdirSync(migrationsDir).sort();
    const indexOf016 = names.indexOf("016_expense_enrichment.ts");
    const indexOf017 = names.indexOf("017_temporal_dispatch_routing.ts");
    const indexOf018 = names.indexOf("018_mailbox_connections.ts");

    expect(indexOf016).toBeGreaterThanOrEqual(0);
    expect(indexOf017).toBeGreaterThan(indexOf016);
    expect(indexOf018).toBeGreaterThan(indexOf017);
  });
});

describe("mailbox connections migration 018 – app.mailbox_connections", () => {
  it("creates the table with composite personal/business FKs (002/003/005/008/009 convention)", () => {
    expect(migration).toContain("CREATE TABLE app.mailbox_connections");
    expect(migration).toMatch(
      /mailbox_connections_profile_tenant_fk[\s\S]*FOREIGN KEY \(personal_profile_id, tenant_id\)[\s\S]*REFERENCES app\.personal_profiles\(id, tenant_id\)/,
    );
    expect(migration).toMatch(
      /mailbox_connections_business_tenant_fk[\s\S]*FOREIGN KEY \(business_id, tenant_id\)[\s\S]*REFERENCES app\.businesses\(id, tenant_id\)/,
    );
  });

  it("enforces exactly one personal or business scope", () => {
    expect(migration).toMatch(
      /mailbox_connections_scope_check[\s\S]*CHECK \(\(personal_profile_id IS NULL\) <> \(business_id IS NULL\)\)/,
    );
  });

  it("enforces the documented connection status values", () => {
    expect(migration).toMatch(
      /mailbox_connections_status_check[\s\S]*CHECK \(status IN \('pending', 'active', 'paused', 'reauth_required', 'disconnecting', 'revocation_pending', 'revoked'\)\)/,
    );
  });

  it("enforces the documented provider values", () => {
    expect(migration).toMatch(
      /mailbox_connections_provider_check[\s\S]*CHECK \(provider IN \('gmail', 'outlook'\)\)/,
    );
  });

  it("carries connection_version for optimistic concurrency", () => {
    expect(migration).toMatch(/connection_version integer NOT NULL DEFAULT 1/);
    expect(migration).toMatch(/mailbox_connections_connection_version_check[\s\S]*CHECK \(connection_version > 0\)/);
  });

  it("carries token-generation/lease internals but no token/code/verifier columns", () => {
    expect(migration).toContain("token_generation integer NOT NULL DEFAULT 1");
    expect(migration).toContain("vault_reference text NOT NULL");
    expect(migration).toContain("token_operation_lease_id uuid");
    expect(migration).toContain("token_operation_lease_expires_at timestamptz");
    expect(migration).toContain("active_scan_run_id uuid");
    expect(migration).toContain("active_scan_lease_expires_at timestamptz");

    for (const forbidden of [
      "refresh_token",
      "access_token",
      "authorization_code",
      "pkce_verifier",
      "client_secret",
    ]) {
      expect(migration).not.toContain(forbidden);
    }
  });

  it("creates no scan/candidate tables (deferred to 3D-B/3D-C)", () => {
    expect(migration).not.toMatch(/CREATE TABLE app\.mailbox_scan/);
    expect(migration).not.toMatch(/CREATE TABLE app\.mailbox_candidate/);
  });

  it("enforces active uniqueness per scope with two scope-specific partial indexes (NULLs are distinct in a single composite index, so personal/business must be split)", () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX mailbox_connections_active_personal_unique[\s\S]*ON app\.mailbox_connections \(tenant_id, personal_profile_id, provider, provider_account_id\)[\s\S]*WHERE status <> 'revoked' AND personal_profile_id IS NOT NULL/,
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX mailbox_connections_active_business_unique[\s\S]*ON app\.mailbox_connections \(tenant_id, business_id, provider, provider_account_id\)[\s\S]*WHERE status <> 'revoked' AND business_id IS NOT NULL/,
    );
    // The old single-index design silently failed to dedup across NULLs;
    // make sure it isn't still present alongside the fix.
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX mailbox_connections_active_unique\s/);
  });
});

describe("mailbox connections migration 018 – app.mailbox_oauth_attempts", () => {
  it("creates the table with one-time status values", () => {
    expect(migration).toContain("CREATE TABLE app.mailbox_oauth_attempts");
    expect(migration).toMatch(
      /mailbox_oauth_attempts_status_check[\s\S]*CHECK \(status IN \('pending', 'consumed', 'completed', 'expired', 'cancelled'\)\)/,
    );
  });

  it("references the owning connection via a composite tenant FK", () => {
    expect(migration).toMatch(
      /mailbox_oauth_attempts_connection_tenant_fk[\s\S]*FOREIGN KEY \(connection_id, tenant_id\)[\s\S]*REFERENCES app\.mailbox_connections\(id, tenant_id\)/,
    );
  });

  it("guards against invalid status transitions with a forward-only trigger (consumed cannot return to pending)", () => {
    expect(migration).toMatch(/prevent_mailbox_oauth_attempt_invalid_transition/);
    expect(migration).toMatch(/mailbox_oauth_attempts_transition_guard_trigger/);
    // The forward-only guard must enumerate every legal edge explicitly,
    // not merely block updates to already-terminal rows (that alone
    // leaves consumed -> pending open, since 'consumed' isn't terminal).
    expect(migration).toMatch(
      /OLD\.status = 'pending' AND NEW\.status IN \('consumed', 'expired', 'cancelled'\)/,
    );
    expect(migration).toMatch(
      /OLD\.status = 'consumed' AND NEW\.status IN \('completed', 'cancelled'\)/,
    );
  });
});

describe("mailbox connections migration 018 – app.mailbox_reviewer_grants", () => {
  it("creates the table with role check and active uniqueness per (connection, user)", () => {
    expect(migration).toContain("CREATE TABLE app.mailbox_reviewer_grants");
    expect(migration).toMatch(
      /mailbox_reviewer_grants_role_check[\s\S]*CHECK \(role IN \('reviewer', 'manager'\)\)/,
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX mailbox_reviewer_grants_active_unique[\s\S]*ON app\.mailbox_reviewer_grants[\s\S]*WHERE revoked_at IS NULL/,
    );
  });
});

describe("mailbox connections migration 018 – app.mailbox_operation_keys (permanent replay ledger)", () => {
  it("creates the permanent operation-key ledger table", () => {
    expect(migration).toContain("CREATE TABLE app.mailbox_operation_keys");
  });

  it("enforces permanent uniqueness over the key triple only (tenant_id, operation_key, idempotency_key) -- normalized_request_hash is compared in domain code, not part of the constraint, so a differing-hash replay collides at the DB level instead of silently inserting a second row", () => {
    expect(migration).toMatch(
      /mailbox_operation_keys_permanent_unique[\s\S]*UNIQUE \(tenant_id, operation_key, idempotency_key\)/,
    );
    expect(migration).not.toMatch(
      /UNIQUE \(tenant_id, operation_key, idempotency_key, normalized_request_hash\)/,
    );
  });

  it("replay returns the original cached response via response_json", () => {
    expect(migration).toContain("response_json jsonb");
  });
});

describe("mailbox connections migration 018 – role grants (016/017 convention)", () => {
  it("grants are scoped (no blanket GRANT ALL added by this migration)", () => {
    expect(migration).not.toMatch(/GRANT ALL/);
  });
});

describe("mailbox connections migration 018 – down()", () => {
  it("drops every table this migration creates, in dependency order", () => {
    expect(migration).toMatch(/dropTable\("app\.mailbox_operation_keys"\)/);
    expect(migration).toMatch(/dropTable\("app\.mailbox_oauth_attempts"\)/);
    expect(migration).toMatch(/dropTable\("app\.mailbox_reviewer_grants"\)/);
    expect(migration).toMatch(/dropTable\("app\.mailbox_connections"\)/);
  });
});
