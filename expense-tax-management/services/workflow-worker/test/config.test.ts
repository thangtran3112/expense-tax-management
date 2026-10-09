import { describe, expect, it } from "vitest";

import { WorkerConfigError, workerConfigFromEnv } from "../src/config.js";

const ENV = {
  TEMPORAL_HOST: " temporal:7233 ",
  TEMPORAL_NAMESPACE: " expense-tax ",
  AI_WORKER_TASK_QUEUE: " expense-tax-processing ",
  APP_API_BASE_URL: " http://app-api:8100/ ",
  FOUNDRY_BASE_URL: " https://foundry.test/ ",
  MAILBOX_BROKER_BASE_URL: " http://mailbox-broker:8300/ ",
  CLERK_ISSUER_URL: " https://clerk.test/ ",
  CLERK_JWKS_URL: " https://clerk.test/.well-known/jwks.json ",
  CLERK_APP_SERVICE_AUDIENCE: " mch_appAudience ",
  CLERK_APP_MACHINE_SECRET_KEY: " ak_test_app_secret ",
  CLERK_APP_SERVICE_SUBJECT: " mch_app ",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: " mch_foundryAudience ",
  CLERK_FOUNDRY_MACHINE_SECRET_KEY: " ak_test_foundry_secret ",
  CLERK_FOUNDRY_SERVICE_SUBJECT: " mch_foundry ",
  CLERK_MAILBOX_SERVICE_AUDIENCE: " mch_mailboxAudience ",
  CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY: " ak_test_mailbox_secret ",
  CLERK_MAILBOX_WORKER_SUBJECT: " mch_workerMailbox ",
  CLERK_MAILBOX_WORKER_APP_MACHINE_SECRET_KEY: " ak_test_mailbox_app_secret ",
  CLERK_MAILBOX_WORKER_APP_SUBJECT: " mch_workerMailboxApp ",
} as const;

const REQUIRED_KEYS = Object.keys(ENV) as (keyof typeof ENV)[];

describe("workerConfigFromEnv", () => {
  it("parses and normalizes worker configuration", () => {
    expect(workerConfigFromEnv(ENV)).toEqual({
      temporal: {
        address: "temporal:7233",
        namespace: "expense-tax",
        taskQueue: "expense-tax-processing",
      },
      services: {
        appApiBaseUrl: "http://app-api:8100",
        foundryBaseUrl: "https://foundry.test",
        mailboxBrokerBaseUrl: "http://mailbox-broker:8300",
      },
      clerk: {
        issuerUrl: "https://clerk.test",
        jwksUrl: "https://clerk.test/.well-known/jwks.json",
        app: {
          audience: "mch_appAudience",
          machineSecretKey: "ak_test_app_secret",
          subject: "mch_app",
        },
        foundry: {
          audience: "mch_foundryAudience",
          machineSecretKey: "ak_test_foundry_secret",
          subject: "mch_foundry",
        },
        mailboxApp: {
          audience: "mch_appAudience",
          machineSecretKey: "ak_test_mailbox_app_secret",
          subject: "mch_workerMailboxApp",
        },
        mailboxBroker: {
          audience: "mch_mailboxAudience",
          machineSecretKey: "ak_test_mailbox_secret",
          subject: "mch_workerMailbox",
        },
      },
    });
  });

  it("fix round 5: mailboxApp and mailboxBroker pick distinct machine pairs by audience", () => {
    const config = workerConfigFromEnv(ENV);

    // mailboxApp: App-audience machine (CLERK_MAILBOX_WORKER_APP_*), never
    // the broker-audience machine's secret/subject.
    expect(config.clerk.mailboxApp).toEqual({
      audience: "mch_appAudience",
      machineSecretKey: "ak_test_mailbox_app_secret",
      subject: "mch_workerMailboxApp",
    });
    // mailboxBroker: broker-audience machine (CLERK_MAILBOX_WORKER_*),
    // never the App-audience machine's secret/subject.
    expect(config.clerk.mailboxBroker).toEqual({
      audience: "mch_mailboxAudience",
      machineSecretKey: "ak_test_mailbox_secret",
      subject: "mch_workerMailbox",
    });
    expect(config.clerk.mailboxApp?.subject).not.toBe(config.clerk.mailboxBroker?.subject);
    expect(config.clerk.mailboxApp?.machineSecretKey).not.toBe(
      config.clerk.mailboxBroker?.machineSecretKey,
    );
  });

  it("accepts Clerk-generated machine secret keys", () => {
    const config = workerConfigFromEnv({
      ...ENV,
      CLERK_APP_MACHINE_SECRET_KEY: "ak_devAppMachine",
      CLERK_FOUNDRY_MACHINE_SECRET_KEY: "ak_devFoundryMachine",
    });

    expect(config.clerk.app.machineSecretKey).toBe("ak_devAppMachine");
    expect(config.clerk.foundry.machineSecretKey).toBe("ak_devFoundryMachine");
  });

  it.each(REQUIRED_KEYS)("rejects missing %s", (key) => {
    const env: Record<string, string | undefined> = { ...ENV };
    delete env[key];

    expect(() => workerConfigFromEnv(env)).toThrow(key);
  });

  it.each([
    ["TEMPORAL_HOST", "temporal"],
    ["TEMPORAL_HOST", "temporal:0"],
    ["TEMPORAL_HOST", "temporal:65536"],
    ["TEMPORAL_NAMESPACE", "default"],
    ["AI_WORKER_TASK_QUEUE", "expense-tax-ai-worker"],
  ] as const)("rejects invalid %s", (key, value) => {
    expect(() => workerConfigFromEnv({ ...ENV, [key]: value })).toThrow(key);
  });

  it.each([
    ["APP_API_BASE_URL", "file:///tmp/app"],
    ["APP_API_BASE_URL", "http://user:secret@app-api:8100"],
    ["FOUNDRY_BASE_URL", "data:text/plain,foundry"],
    ["FOUNDRY_BASE_URL", "https://foundry.test/api"],
    ["CLERK_ISSUER_URL", "http://clerk.test"],
    ["CLERK_ISSUER_URL", "https://user:secret@clerk.test"],
    ["CLERK_JWKS_URL", "http://clerk.test/.well-known/jwks.json"],
  ] as const)("rejects unsafe %s", (key, value) => {
    expect(() => workerConfigFromEnv({ ...ENV, [key]: value })).toThrow(key);
  });

  it("Phase 3D-A Task 5: parses cleanly with every mailbox var omitted (ordinary dev->main deploy)", () => {
    const env: Record<string, string | undefined> = { ...ENV };
    delete env.MAILBOX_BROKER_BASE_URL;
    delete env.CLERK_MAILBOX_SERVICE_AUDIENCE;
    delete env.CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY;
    delete env.CLERK_MAILBOX_WORKER_SUBJECT;
    delete env.CLERK_MAILBOX_WORKER_APP_MACHINE_SECRET_KEY;
    delete env.CLERK_MAILBOX_WORKER_APP_SUBJECT;

    const config = workerConfigFromEnv(env);

    expect(config.services.mailboxBrokerBaseUrl).toBeUndefined();
    expect(config.clerk.mailboxApp).toBeUndefined();
    expect(config.clerk.mailboxBroker).toBeUndefined();
  });

  it.each([
    "MAILBOX_BROKER_BASE_URL",
    "CLERK_MAILBOX_SERVICE_AUDIENCE",
    "CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY",
    "CLERK_MAILBOX_WORKER_SUBJECT",
    "CLERK_MAILBOX_WORKER_APP_MACHINE_SECRET_KEY",
    "CLERK_MAILBOX_WORKER_APP_SUBJECT",
  ])(
    "Phase 3D-A Task 5: rejects a partially-set mailbox configuration missing only %s",
    (missingKey) => {
      const env: Record<string, string | undefined> = { ...ENV };
      delete env[missingKey];

      expect(() => workerConfigFromEnv(env)).toThrow(/must all be set together or all omitted/);
      let thrown: unknown;
      try {
        workerConfigFromEnv(env);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WorkerConfigError);
      expect((thrown as WorkerConfigError).variables).toEqual([missingKey]);
    },
  );

  it.each([
    ["CLERK_APP_SERVICE_AUDIENCE", "app-audience"],
    ["CLERK_APP_MACHINE_SECRET_KEY", "not-yet-issued"],
    ["CLERK_APP_MACHINE_SECRET_KEY", "ak_test_not-configured"],
    ["CLERK_APP_SERVICE_SUBJECT", "app-subject"],
    ["CLERK_FOUNDRY_SERVICE_AUDIENCE", "foundry-audience"],
    ["CLERK_FOUNDRY_MACHINE_SECRET_KEY", "secret"],
    ["CLERK_FOUNDRY_SERVICE_SUBJECT", "foundry-subject"],
    ["CLERK_MAILBOX_SERVICE_AUDIENCE", "mailbox-audience"],
    ["CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY", "not-yet-issued"],
    ["CLERK_MAILBOX_WORKER_SUBJECT", "workflow-worker-mailbox"],
    ["CLERK_MAILBOX_WORKER_SUBJECT", "Workflow-Worker-Mailbox"],
    ["CLERK_MAILBOX_WORKER_APP_MACHINE_SECRET_KEY", "not-yet-issued"],
    ["CLERK_MAILBOX_WORKER_APP_SUBJECT", "workflow-worker-mailbox-app"],
  ] as const)("rejects invalid machine credential %s", (key, value) => {
    expect(() => workerConfigFromEnv({ ...ENV, [key]: value })).toThrow(key);
  });
});
