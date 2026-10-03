import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { brokerConfigFromEnv } from "../src/config.js";

function validEnv(): Record<string, string> {
  const key1 = randomBytes(32).toString("base64");
  return {
    MAILBOX_BROKER_DATABASE_URL: "postgresql://runtime@127.0.0.1:5433/mailbox_vault",
    MAILBOX_SERVICE_TOKEN_ISSUER: "https://clerk.test",
    MAILBOX_SERVICE_TOKEN_AUDIENCE: "mch_mailboxServiceAudience",
    MAILBOX_SERVICE_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
    CLERK_MAILBOX_APP_API_SUBJECT: "app-api-mailbox",
    CLERK_MAILBOX_WORKER_SUBJECT: "workflow-worker-mailbox",
    CLERK_ISSUER_URL: "https://clerk.test",
    CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
    APP_API_BASE_URL: "http://app-api:8100",
    CLERK_APP_SERVICE_AUDIENCE: "mch_appServiceAudience",
    CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY: "ak_test_broker_secret",
    CLERK_MAILBOX_BROKER_SUBJECT: "mailbox-broker-app",
    MAILBOX_VAULT_KEYS: JSON.stringify([{ keyId: "key-1", key: key1 }]),
    MAILBOX_VAULT_ACTIVE_KEY_ID: "key-1",
  };
}

describe("brokerConfigFromEnv", () => {
  it("parses a complete valid environment", () => {
    const env = validEnv();
    const config = brokerConfigFromEnv({ env });

    expect(config.service).toBe("mailbox-broker");
    expect(config.port).toBe(8300);
    expect(config.databaseUrl).toBe(env.MAILBOX_BROKER_DATABASE_URL);
    expect(config.inboundAuth).toEqual({
      issuer: "https://clerk.test",
      audience: "mch_mailboxServiceAudience",
      jwksUrl: "https://clerk.test/.well-known/jwks.json",
      appApiSubject: "app-api-mailbox",
      workerSubject: "workflow-worker-mailbox",
    });
    expect(config.outboundApp.credentials).toEqual({
      audience: "mch_appServiceAudience",
      machineSecretKey: "ak_test_broker_secret",
      subject: "mailbox-broker-app",
    });
    expect(config.vault.activeKeyId).toBe("key-1");
    expect(config.vault.keys.get("key-1")).toHaveLength(32);
  });

  it("accepts a Compose-internal http:// App API base URL", () => {
    const config = brokerConfigFromEnv({ env: validEnv() });
    expect(config.outboundApp.baseUrl).toBe("http://app-api:8100");
  });

  it("rejects a non-HTTPS Clerk issuer URL", () => {
    expect(() =>
      brokerConfigFromEnv({ env: { ...validEnv(), CLERK_ISSUER_URL: "http://clerk.test" } }),
    ).toThrow("CLERK_ISSUER_URL");
  });

  it.each([
    "MAILBOX_BROKER_DATABASE_URL",
    "MAILBOX_SERVICE_TOKEN_ISSUER",
    "MAILBOX_SERVICE_TOKEN_AUDIENCE",
    "MAILBOX_SERVICE_JWKS_URL",
    "CLERK_MAILBOX_APP_API_SUBJECT",
    "CLERK_MAILBOX_WORKER_SUBJECT",
    "CLERK_ISSUER_URL",
    "CLERK_JWKS_URL",
    "APP_API_BASE_URL",
    "CLERK_APP_SERVICE_AUDIENCE",
    "CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY",
    "CLERK_MAILBOX_BROKER_SUBJECT",
    "MAILBOX_VAULT_KEYS",
    "MAILBOX_VAULT_ACTIVE_KEY_ID",
  ])("rejects a missing %s", (key) => {
    const env = validEnv();
    delete (env as Record<string, string | undefined>)[key];
    expect(() => brokerConfigFromEnv({ env })).toThrow(key);
  });

  it("rejects a key that does not decode to exactly 32 bytes", () => {
    const env = validEnv();
    env.MAILBOX_VAULT_KEYS = JSON.stringify([{ keyId: "key-1", key: Buffer.alloc(16).toString("base64") }]);
    expect(() => brokerConfigFromEnv({ env })).toThrow("32 bytes");
  });

  it("rejects MAILBOX_VAULT_ACTIVE_KEY_ID not present in MAILBOX_VAULT_KEYS", () => {
    const env = validEnv();
    env.MAILBOX_VAULT_ACTIVE_KEY_ID = "missing-key";
    expect(() => brokerConfigFromEnv({ env })).toThrow("MAILBOX_VAULT_ACTIVE_KEY_ID");
  });

  it("rejects malformed JSON in MAILBOX_VAULT_KEYS", () => {
    const env = validEnv();
    env.MAILBOX_VAULT_KEYS = "not-json";
    expect(() => brokerConfigFromEnv({ env })).toThrow("MAILBOX_VAULT_KEYS");
  });

  it("supports a dual-key window (two entries in MAILBOX_VAULT_KEYS)", () => {
    const env = validEnv();
    const key2 = randomBytes(32).toString("base64");
    env.MAILBOX_VAULT_KEYS = JSON.stringify([
      { keyId: "key-1", key: JSON.parse(env.MAILBOX_VAULT_KEYS)[0].key },
      { keyId: "key-2", key: key2 },
    ]);
    const config = brokerConfigFromEnv({ env });
    expect(config.vault.keys.size).toBe(2);
  });
});
