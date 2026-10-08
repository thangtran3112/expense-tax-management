import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  SMOKE_CONFIRMATION,
  assertLocalDatabaseHost,
  assertLocalDockerEndpoint,
  assertRoutingNotAtTarget,
  buildSmokePlan,
  isExecutionConfirmed,
  missingClerkCredentials,
  servicesToStart,
} from "./local-worker-smoke.mjs";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "local-worker-smoke.mjs",
);
const scriptSource = readFileSync(scriptPath, "utf8");

describe("local worker smoke safety guards", () => {
  it("refuses to run without the explicit local-only confirmation", () => {
    assert.equal(isExecutionConfirmed([], {}), false);
    assert.equal(
      isExecutionConfirmed(["--execute"], { LOCAL_WORKER_SMOKE_CONFIRM: "wrong" }),
      false,
    );
    assert.equal(
      isExecutionConfirmed(["--execute"], {
        LOCAL_WORKER_SMOKE_CONFIRM: SMOKE_CONFIRMATION,
      }),
      true,
    );
  });

  it("requires both the flag and the matching confirmation value together", () => {
    assert.equal(
      isExecutionConfirmed([], { LOCAL_WORKER_SMOKE_CONFIRM: SMOKE_CONFIRMATION }),
      false,
    );
  });

  it("reports missing Development Clerk credentials by name only, never by value", () => {
    assert.deepEqual(missingClerkCredentials({}), [
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
    assert.deepEqual(missing, [
      "CLERK_ISSUER_URL",
      "CLERK_JWKS_URL",
      "CLERK_APP_MACHINE_SECRET_KEY",
      "CLERK_FOUNDRY_MACHINE_SECRET_KEY",
    ]);
  });

  it("accepts real-looking Development Clerk credentials", () => {
    assert.deepEqual(
      missingClerkCredentials({
        CLERK_ISSUER_URL: "https://clerk.tobytran.dev",
        CLERK_JWKS_URL: "https://clerk.tobytran.dev/.well-known/jwks.json",
        CLERK_APP_MACHINE_SECRET_KEY: "ak_live_realvalue",
        CLERK_FOUNDRY_MACHINE_SECRET_KEY: "ak_live_realvalue2",
      }),
      [],
    );
  });

  it("accepts a bare hostname matching the local Compose postgres service", () => {
    assert.doesNotThrow(() =>
      assertLocalDatabaseHost("postgres", "APP_MIGRATION_DATABASE_URL"),
    );
  });

  it("refuses any non-local hostname (never takes a connection string with a password)", () => {
    assert.throws(
      () => assertLocalDatabaseHost("prod-db.example.com", "APP_MIGRATION_DATABASE_URL"),
      (error) =>
        error instanceof Error &&
        error.message.includes("prod-db.example.com") &&
        error.message.includes("APP_MIGRATION_DATABASE_URL"),
    );
  });

  it("only starts services that are not already running", () => {
    assert.deepEqual(
      servicesToStart(["postgres"], ["postgres", "temporal", "app-api"]),
      ["temporal", "app-api"],
    );
    assert.deepEqual(servicesToStart([], ["postgres"]), ["postgres"]);
    assert.deepEqual(
      servicesToStart(["postgres", "temporal"], ["postgres", "temporal"]),
      [],
    );
  });

  it("accepts a local unix-socket Docker context with no DOCKER_HOST override", () => {
    assert.doesNotThrow(() =>
      assertLocalDockerEndpoint(
        {},
        () => "unix:///Users/me/.colima/default/docker.sock",
      ),
    );
  });

  it("refuses when DOCKER_HOST points at a remote endpoint", () => {
    assert.throws(
      () =>
        assertLocalDockerEndpoint(
          { DOCKER_HOST: "tcp://remote-docker.example.com:2376" },
          () => "unix:///var/run/docker.sock",
        ),
      /DOCKER_HOST/,
    );
  });

  it("refuses even a unix:// DOCKER_HOST (it may proxy to a remote daemon)", () => {
    assert.throws(
      () =>
        assertLocalDockerEndpoint(
          { DOCKER_HOST: "unix:///tmp/x" },
          () => "unix:///var/run/docker.sock",
        ),
      /DOCKER_HOST/,
    );
  });

  it("refuses when the current Docker context endpoint is not a local unix socket", () => {
    assert.throws(
      () => assertLocalDockerEndpoint({}, () => "tcp://remote-docker.example.com:2376"),
      /not a local unix socket/,
    );
  });

  it("confirms routing is below the TypeScript target before advancing", () => {
    assert.doesNotThrow(() =>
      assertRoutingNotAtTarget({
        generation: 1,
        namespace: "default",
        taskQueue: "expense-tax-ai-worker",
      }),
    );
  });

  it("refuses to run when a prior smoke already advanced dispatch routing", () => {
    assert.throws(
      () =>
        assertRoutingNotAtTarget({
          generation: 2,
          namespace: "expense-tax",
          taskQueue: "expense-tax-processing",
        }),
      /compose\.sh down -v/,
    );
  });

  it("orders the smoke plan: guards, compose up, advance, job, teardown", () => {
    assert.deepEqual(buildSmokePlan(), [
      "guard:execution-confirmed",
      "guard:docker-endpoint-local",
      "guard:compose-config-valid",
      "guard:migration-database-host-local",
      "guard:runtime-database-host-local",
      "guard:clerk-credentials-present",
      "compose:start-services",
      "database:run-app-api-migrations",
      "temporal:bootstrap-expense-tax-namespace",
      "dispatch-routing:assert-not-at-target",
      "dispatch-routing:advance-to-target",
      "job:create-job",
      "job:await-typescript-worker-callback",
      "teardown:stop-started-services",
    ]);
  });

  it("never asks Compose to resolve and print real credential values (config --format json)", () => {
    assert.ok(!/"--format"/.test(scriptSource));
    assert.ok(!/composeConfig/.test(scriptSource));
  });

  it("only ever invokes compose config for syntax validation (--quiet)", () => {
    assert.match(scriptSource, /"config",\s*"--quiet"/);
  });
});
