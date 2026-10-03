import { describe, expect, it } from "vitest";
import { createAppConfig } from "../src/config.js";

const ENV = {
  AUTH_PROVIDER: "clerk",
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/jwks",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/jwks",
  APP_DATABASE_URL: "postgresql://app.test/app",
  TEMPORAL_HOST: "127.0.0.1:7233",
  TEMPORAL_NAMESPACE: "default",
  STORAGE_BACKEND: "local",
  LOCAL_STORAGE_DIR: "/tmp/app-test",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  STORAGE_URL_SIGNING_KEY: "test-signing-key",
  INBOUND_EMAIL_BASE_ADDRESS: "receipts@test",
  INBOUND_WEBHOOK_SIGNING_KEY: "test-webhook-key",
  INBOUND_ROUTING_TOKEN_SECRET: "test-routing-secret",
  INBOUND_CHALLENGE_DIR: "/tmp/challenges",
  CLERK_ISSUER_URL: " https://clerk.test/ ",
  CLERK_JWKS_URL: " https://clerk.test/.well-known/jwks.json ",
  CLERK_TENANT_AUDIENCE: " tenant-audience ",
  CLERK_PLATFORM_AUDIENCE: " platform-audience ",
  CLERK_APP_SERVICE_AUDIENCE: " app-service-audience ",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: " foundry-service-audience ",
  CLERK_APP_SERVICE_SUBJECT: " ai-worker-app-machine ",
  CLERK_FOUNDRY_SERVICE_SUBJECT: " ai-worker-foundry-machine ",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: " pk_test_fake ",
  CLERK_SECRET_KEY: " sk_test_fake ",
  CLERK_WEBHOOK_SIGNING_SECRET: " whsec_test_fake ",
};

const LEGACY_ENV = { ...ENV, AUTH_PROVIDER: "legacy" };
for (const key of [
  "CLERK_ISSUER_URL",
  "CLERK_JWKS_URL",
  "CLERK_TENANT_AUDIENCE",
  "CLERK_PLATFORM_AUDIENCE",
  "CLERK_APP_SERVICE_AUDIENCE",
  "CLERK_FOUNDRY_SERVICE_AUDIENCE",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_WEBHOOK_SIGNING_SECRET",
] as const) {
  delete LEGACY_ENV[key];
}

describe("App API Clerk configuration", () => {
  it("does not require Clerk values in legacy mode", () => {
    const config = createAppConfig({ env: LEGACY_ENV });

    expect(config.authProvider).toBe("legacy");
    expect(config.clerk).toBeUndefined();
  });

  it("parses and trims Clerk URLs, audiences, and optional secrets", () => {
    const config = createAppConfig({ env: ENV });

    expect(config.authProvider).toBe("clerk");
    expect(config.clerk).toEqual({
      issuerUrl: "https://clerk.test/",
      jwksUrl: "https://clerk.test/.well-known/jwks.json",
      tenantAudience: "tenant-audience",
      platformAudience: "platform-audience",
      appServiceAudience: "app-service-audience",
      foundryServiceAudience: "foundry-service-audience",
      appServiceSubject: "ai-worker-app-machine",
      foundryServiceSubject: "ai-worker-foundry-machine",
      enrichmentInputScope: "jobs:enrichment-input",
      enrichmentResultScope: "jobs:enrichment-result",
      publishableKey: "pk_test_fake",
      secretKey: "sk_test_fake",
      webhookSigningSecret: "whsec_test_fake",
    });
  });

  it.each([
    "CLERK_ISSUER_URL",
    "CLERK_JWKS_URL",
    "CLERK_TENANT_AUDIENCE",
    "CLERK_PLATFORM_AUDIENCE",
    "CLERK_APP_SERVICE_AUDIENCE",
    "CLERK_FOUNDRY_SERVICE_AUDIENCE",
    "CLERK_APP_SERVICE_SUBJECT",
    "CLERK_FOUNDRY_SERVICE_SUBJECT",
  ])("fails with the named variable when %s is missing", (key) => {
    const env = { ...ENV };
    delete env[key as keyof typeof env];

    expect(() => createAppConfig({ env })).toThrow(
      `Missing required environment variable: ${key}`,
    );
  });

  it.each([
    "http://clerk.test/jwks",
    "file:///tmp/jwks.json",
    "data:application/json,{}",
  ])("rejects non-HTTPS Clerk JWKS URLs: %s", (jwksUrl) => {
    const env = { ...ENV, CLERK_JWKS_URL: jwksUrl };

    expect(() => createAppConfig({ env })).toThrow(
      "Invalid URL in environment variable: CLERK_JWKS_URL",
    );
  });

  it.each([
    "http://clerk.test",
    "file:///tmp/issuer",
    "data:text/plain,issuer",
  ])("rejects non-HTTPS Clerk issuer URLs: %s", (issuerUrl) => {
    const env = { ...ENV, CLERK_ISSUER_URL: issuerUrl };

    expect(() => createAppConfig({ env })).toThrow(
      "Invalid URL in environment variable: CLERK_ISSUER_URL",
    );
  });

  it("does not use ambient Clerk values with an explicit env object", () => {
    const previousValues = Object.fromEntries(
      [
        "CLERK_ISSUER_URL",
        "CLERK_JWKS_URL",
        "CLERK_TENANT_AUDIENCE",
        "CLERK_PLATFORM_AUDIENCE",
    "CLERK_APP_SERVICE_AUDIENCE",
    "CLERK_FOUNDRY_SERVICE_AUDIENCE",
      ].map((key) => [key, process.env[key]]),
    );
    process.env.CLERK_ISSUER_URL = "https://ambient-clerk.test";
    process.env.CLERK_JWKS_URL = "https://ambient-clerk.test/jwks";
    process.env.CLERK_TENANT_AUDIENCE = "ambient-tenant";
    process.env.CLERK_PLATFORM_AUDIENCE = "ambient-platform";
    process.env.CLERK_APP_SERVICE_AUDIENCE = "ambient-app-service";
    process.env.CLERK_FOUNDRY_SERVICE_AUDIENCE = "ambient-foundry-service";
    const env = { ...ENV };
    delete env.CLERK_ISSUER_URL;
    delete env.CLERK_JWKS_URL;
    delete env.CLERK_TENANT_AUDIENCE;
    delete env.CLERK_PLATFORM_AUDIENCE;
    delete env.CLERK_APP_SERVICE_AUDIENCE;
    delete env.CLERK_FOUNDRY_SERVICE_AUDIENCE;

    try {
      expect(() => createAppConfig({ env })).toThrow(
        "Missing required environment variable: CLERK_ISSUER_URL",
      );
    } finally {
      for (const [key, value] of Object.entries(previousValues)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("allows optional server-only secrets to be absent", () => {
    const env = { ...ENV };
    delete env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete env.CLERK_SECRET_KEY;
    delete env.CLERK_WEBHOOK_SIGNING_SECRET;

    expect(createAppConfig({ env }).clerk).toMatchObject({
      publishableKey: undefined,
      secretKey: undefined,
      webhookSigningSecret: undefined,
    });
  });
});

// -------------------------------------------------------------------- //
// Fix round 1 (Important) -- mailbox feature flag: fails startup closed
// when explicitly enabled but incompletely configured; never affects any
// deployment that leaves MAILBOX_FEATURE_ENABLED unset.
// -------------------------------------------------------------------- //

const MAILBOX_ENV = {
  ...ENV,
  MAILBOX_BROKER_BASE_URL: "http://mailbox-broker:8300",
  MAILBOX_BROKER_PUBLIC_BASE_URL: "https://expense-mailbox.test",
  CLERK_MAILBOX_SERVICE_AUDIENCE: "mailbox-service-audience",
  CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY: "ak_test_fake",
  CLERK_MAILBOX_APP_API_SUBJECT: "app-api-mailbox",
  MAILBOX_ALLOWED_REDIRECT_ORIGINS: "https://expense-office.test",
};

describe("App API mailbox feature flag", () => {
  it("defaults to disabled and requires none of the broker fields", () => {
    expect(createAppConfig({ env: ENV }).mailboxEnabled).toBe(false);
  });

  it.each(["true", "True", "TRUE"])(
    "enables the feature for MAILBOX_FEATURE_ENABLED=%s when fully configured",
    (value) => {
      const config = createAppConfig({
        env: { ...MAILBOX_ENV, MAILBOX_FEATURE_ENABLED: value },
      });
      expect(config.mailboxEnabled).toBe(true);
    },
  );

  it.each(["false", "1", "yes", ""])(
    "treats MAILBOX_FEATURE_ENABLED=%s as disabled",
    (value) => {
      const config = createAppConfig({
        env: { ...ENV, MAILBOX_FEATURE_ENABLED: value },
      });
      expect(config.mailboxEnabled).toBe(false);
    },
  );

  it.each([
    ["MAILBOX_BROKER_BASE_URL", "MAILBOX_BROKER_BASE_URL"],
    ["MAILBOX_BROKER_PUBLIC_BASE_URL", "MAILBOX_BROKER_PUBLIC_BASE_URL"],
    ["CLERK_MAILBOX_SERVICE_AUDIENCE", "CLERK_MAILBOX_SERVICE_AUDIENCE"],
    ["CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY", "CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY"],
    ["CLERK_MAILBOX_APP_API_SUBJECT", "CLERK_MAILBOX_APP_API_SUBJECT"],
    ["MAILBOX_ALLOWED_REDIRECT_ORIGINS", "MAILBOX_ALLOWED_REDIRECT_ORIGINS"],
  ])("fails startup naming the missing variable when %s is absent while enabled", (_label, key) => {
    const env = { ...MAILBOX_ENV, MAILBOX_FEATURE_ENABLED: "true" };
    delete env[key as keyof typeof env];

    expect(() => createAppConfig({ env })).toThrow(
      /Mailbox feature is enabled .* missing required configuration:.*/,
    );
    expect(() => createAppConfig({ env })).toThrow(new RegExp(key));
  });

  it("never leaks a secret value in the fail-closed error message", () => {
    const env = { ...MAILBOX_ENV, MAILBOX_FEATURE_ENABLED: "true" };
    delete (env as Record<string, string | undefined>).CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY;

    try {
      createAppConfig({ env });
      throw new Error("expected createAppConfig to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("ak_test_fake");
    }
  });

  it("fails startup when enabled under legacy auth (no Clerk config at all)", () => {
    const env = { ...LEGACY_ENV, ...MAILBOX_ENV, MAILBOX_FEATURE_ENABLED: "true", AUTH_PROVIDER: "legacy" };
    expect(() => createAppConfig({ env })).toThrow(/AUTH_PROVIDER is not "clerk"/);
  });

  it("succeeds and is fully usable when enabled and completely configured", () => {
    const config = createAppConfig({
      env: { ...MAILBOX_ENV, MAILBOX_FEATURE_ENABLED: "true" },
    });
    expect(config.mailboxEnabled).toBe(true);
    expect(config.clerk?.mailboxBrokerBaseUrl).toBe("http://mailbox-broker:8300");
    expect(config.clerk?.mailboxBrokerPublicBaseUrl).toBe("https://expense-mailbox.test");
    expect(config.mailboxAllowedRedirectOrigins).toEqual(["https://expense-office.test"]);
  });
});
