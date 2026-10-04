import { describe, expect, it } from "vitest";

import {
  SMOKE_CONFIRMATION,
  assertLocalDatabaseUrl,
  buildSmokePlan,
  isExecutionConfirmed,
  missingClerkCredentials,
  servicesToStart,
} from "./local-worker-smoke.mjs";

describe("local worker smoke safety guards", () => {
  it("refuses to run without the explicit local-only confirmation", () => {
    expect(isExecutionConfirmed([], {})).toBe(false);
    expect(
      isExecutionConfirmed(["--execute"], { LOCAL_WORKER_SMOKE_CONFIRM: "wrong" }),
    ).toBe(false);
    expect(
      isExecutionConfirmed(["--execute"], {
        LOCAL_WORKER_SMOKE_CONFIRM: SMOKE_CONFIRMATION,
      }),
    ).toBe(true);
  });

  it("requires both the flag and the matching confirmation value together", () => {
    expect(
      isExecutionConfirmed([], { LOCAL_WORKER_SMOKE_CONFIRM: SMOKE_CONFIRMATION }),
    ).toBe(false);
  });

  it("reports missing Development Clerk credentials by name only, never by value", () => {
    const missing = missingClerkCredentials({});
    expect(missing).toEqual([
      "CLERK_ISSUER_URL",
      "CLERK_JWKS_URL",
      "CLERK_APP_MACHINE_SECRET_KEY",
      "CLERK_FOUNDRY_MACHINE_SECRET_KEY",
    ]);
  });

  it("treats the documented not-configured placeholders as missing", () => {
    const missing = missingClerkCredentials({
      CLERK_ISSUER_URL: "https://clerk.not-configured.invalid",
      CLERK_JWKS_URL: "https://clerk.not-configured.invalid/.well-known/jwks.json",
      CLERK_APP_MACHINE_SECRET_KEY: "not-yet-issued",
      CLERK_FOUNDRY_MACHINE_SECRET_KEY: "ak_test_not-configured",
    });
    expect(missing).toEqual([
      "CLERK_ISSUER_URL",
      "CLERK_JWKS_URL",
      "CLERK_APP_MACHINE_SECRET_KEY",
      "CLERK_FOUNDRY_MACHINE_SECRET_KEY",
    ]);
  });

  it("accepts real-looking Development Clerk credentials", () => {
    expect(
      missingClerkCredentials({
        CLERK_ISSUER_URL: "https://clerk.tobytran.dev",
        CLERK_JWKS_URL: "https://clerk.tobytran.dev/.well-known/jwks.json",
        CLERK_APP_MACHINE_SECRET_KEY: "ak_live_realvalue",
        CLERK_FOUNDRY_MACHINE_SECRET_KEY: "ak_live_realvalue2",
      }),
    ).toEqual([]);
  });

  it("accepts a database URL whose host is the local Compose postgres service", () => {
    expect(() =>
      assertLocalDatabaseUrl(
        "postgresql://expense_app_migrator:secret@postgres:5432/expense_tax_db",
        "APP_MIGRATION_DATABASE_URL",
      ),
    ).not.toThrow();
  });

  it("refuses a database URL pointed at any non-local host, without echoing the password", () => {
    let thrown;
    try {
      assertLocalDatabaseUrl(
        "postgresql://expense_app_migrator:top-secret@prod-db.example.com:5432/expense_tax_db",
        "APP_MIGRATION_DATABASE_URL",
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("prod-db.example.com");
    expect(thrown.message).not.toContain("top-secret");
  });

  it("rejects an unparsable database URL", () => {
    expect(() => assertLocalDatabaseUrl("not-a-url", "APP_DATABASE_URL")).toThrow(
      /not a valid database URL/,
    );
  });

  it("only starts services that are not already running", () => {
    expect(servicesToStart(["postgres"], ["postgres", "temporal", "app-api"])).toEqual([
      "temporal",
      "app-api",
    ]);
    expect(servicesToStart([], ["postgres"])).toEqual(["postgres"]);
    expect(servicesToStart(["postgres", "temporal"], ["postgres", "temporal"])).toEqual([]);
  });

  it("orders the smoke plan: guards, generation 1, advance, generation 2, teardown", () => {
    expect(buildSmokePlan()).toEqual([
      "guard:execution-confirmed",
      "guard:clerk-credentials-present",
      "guard:local-database-target",
      "compose:start-generation-1-services",
      "database:run-app-api-migrations",
      "temporal:bootstrap-expense-tax-namespace",
      "job:create-generation-1",
      "job:await-python-worker-callback",
      "dispatch-routing:status-generation-1",
      "dispatch-routing:advance-to-generation-2",
      "compose:start-workflow-worker",
      "job:create-generation-2",
      "job:await-typescript-worker-callback",
      "teardown:stop-started-services",
    ]);
  });
});
