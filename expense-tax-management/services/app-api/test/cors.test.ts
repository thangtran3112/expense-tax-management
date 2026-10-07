/**
 * Web session wiring design (2026-10-06) -- App API CORS allowlist.
 * Registered before registerGatewayHardening (see src/app.ts): an allowed
 * origin's OPTIONS preflight must short-circuit before the rate limiter
 * and before Fastify's own 404-for-unregistered-method handling.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { AuthPrincipal, TokenVerifier } from "../src/auth/types.js";
import { createAppConfig } from "../src/config.js";

const ALLOWED_ORIGIN = "https://expense-capture.test";
const OTHER_ALLOWED_ORIGIN = "https://expense-office.test";
const DISALLOWED_ORIGIN = "https://evil.test";

const BASE_ENV = {
  APP_TENANT_TOKEN_ISSUER: "https://identity.test",
  APP_TENANT_TOKEN_AUDIENCE: "expense-app",
  APP_TENANT_JWKS_URL: "https://identity.test/jwks",
  APP_SERVICE_TOKEN_ISSUER: "https://services.test",
  APP_SERVICE_TOKEN_AUDIENCE: "expense-app-internal",
  APP_SERVICE_JWKS_URL: "https://services.test/jwks",
  CLERK_ISSUER_URL: "https://clerk.test",
  CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
  CLERK_TENANT_AUDIENCE: "tenant-audience",
  CLERK_PLATFORM_AUDIENCE: "platform-audience",
  CLERK_APP_SERVICE_AUDIENCE: "app-service-audience",
  CLERK_FOUNDRY_SERVICE_AUDIENCE: "foundry-service-audience",
  CLERK_APP_SERVICE_SUBJECT: "ai-worker-app-machine",
  CLERK_FOUNDRY_SERVICE_SUBJECT: "ai-worker-foundry-machine",
  APP_DATABASE_URL: "postgresql://unused.test/app",
  TEMPORAL_HOST: "127.0.0.1:7233",
  TEMPORAL_NAMESPACE: "default",
  STORAGE_BACKEND: "local",
  LOCAL_STORAGE_DIR: "/tmp/cors-test",
  STORAGE_LOCAL_BASE_URL: "http://127.0.0.1:8100",
  STORAGE_URL_SIGNING_KEY: "test-storage-key",
  INBOUND_EMAIL_BASE_ADDRESS: "receipts@inbound.test",
  INBOUND_WEBHOOK_SIGNING_KEY: "test-webhook-key",
  INBOUND_ROUTING_TOKEN_SECRET: "test-routing-key",
  INBOUND_CHALLENGE_DIR: "/tmp/cors-test-challenges",
};

function principal(): AuthPrincipal {
  return {
    tokenType: "tenant",
    subject: "tenant-subject",
    clientId: null,
    audience: "expense-app",
    issuer: "https://identity.test",
    roles: [],
    scopes: [],
    tokenId: "token-id",
    email: "person@example.test",
    emailVerified: true,
    displayName: "Person",
  };
}

describe("App API CORS allowlist", () => {
  const apps = new Set<ReturnType<typeof buildApp>>();

  afterEach(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    apps.clear();
  });

  function createTestApp(corsAllowedOrigins?: string) {
    const env = {
      ...BASE_ENV,
      ...(corsAllowedOrigins !== undefined
        ? { APP_CORS_ALLOWED_ORIGINS: corsAllowedOrigins }
        : {}),
    };
    const tenantVerifier: TokenVerifier = {
      verify: vi.fn(async () => principal()),
    };
    const serviceVerifier: TokenVerifier = {
      verify: vi.fn(async () => {
        throw new Error("service token not accepted");
      }),
    };
    const app = buildApp({
      config: createAppConfig({ env, version: "test" }),
      logger: false,
      authVerifiers: { tenant: tenantVerifier, service: serviceVerifier },
      identityDomain: { provision: vi.fn(), resolve: vi.fn(async () => null) },
    });
    apps.add(app);
    return app;
  }

  it("sets Access-Control-Allow-Origin and Vary for an allowed origin on a normal GET", async () => {
    const app = createTestApp(`${ALLOWED_ORIGIN},${OTHER_ALLOWED_ORIGIN}`);
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(response.headers.vary).toBe("Origin");
  });

  it("answers an OPTIONS preflight with 204 and the full CORS header set", async () => {
    const app = createTestApp(`${ALLOWED_ORIGIN},${OTHER_ALLOWED_ORIGIN}`);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/v1/tenants",
      headers: {
        origin: ALLOWED_ORIGIN,
        "access-control-request-method": "GET",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(response.headers["access-control-allow-methods"]).toBe(
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    expect(response.headers["access-control-allow-headers"]).toBe(
      "authorization, content-type, idempotency-key, if-match",
    );
    expect(response.headers["access-control-max-age"]).toBe("600");
  });

  it("gives no CORS headers to a disallowed origin", async () => {
    const app = createTestApp(`${ALLOWED_ORIGIN},${OTHER_ALLOWED_ORIGIN}`);
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: DISALLOWED_ORIGIN },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
  });

  it("disables CORS entirely when the allowlist is unset", async () => {
    const app = createTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("disables CORS entirely when the allowlist is an empty string", async () => {
    const app = createTestApp("");
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never rate-limits an allowed origin's OPTIONS preflight (the api-class limit is 120/min)", async () => {
    const app = createTestApp(ALLOWED_ORIGIN);
    for (let index = 0; index < 150; index += 1) {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/api/v1/tenants",
        headers: {
          origin: ALLOWED_ORIGIN,
          "access-control-request-method": "GET",
        },
      });
      expect(response.statusCode).toBe(204);
    }
  });
});
