import { describe, expect, it } from "vitest";

import { createServiceVerifier, requireCaller, requireScopes, ServiceAuthError } from "../src/auth/clerk.js";
import type { InboundAuthConfig } from "../src/config.js";
import { createFakeClerkIssuer } from "../src/test-doubles.js";

const AUDIENCE = "mch_mailboxServiceAudience";
const APP_API_SUBJECT = "app-api-mailbox";
const WORKER_SUBJECT = "workflow-worker-mailbox";

async function setup() {
  const issuer = await createFakeClerkIssuer();
  const config: InboundAuthConfig = {
    issuer: issuer.issuerUrl,
    audience: AUDIENCE,
    jwksUrl: issuer.jwksUrl,
    appApiSubject: APP_API_SUBJECT,
    workerSubject: WORKER_SUBJECT,
  };
  const verifier = createServiceVerifier(config, { keyResolver: issuer.keyResolver });
  return { issuer, config, verifier };
}

describe("auth/clerk.ts createServiceVerifier", () => {
  it("accepts App API's configured subject and reports caller 'app-api'", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({
      subject: APP_API_SUBJECT,
      audience: AUDIENCE,
      scopes: ["oauth:start", "connections:read"],
    });

    const principal = await verifier.verify(token);
    expect(principal.caller).toBe("app-api");
    expect(principal.subject).toBe(APP_API_SUBJECT);
    expect(principal.scopes).toEqual(["oauth:start", "connections:read"]);
  });

  it("accepts the worker's configured subject and reports caller 'worker'", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({
      subject: WORKER_SUBJECT,
      audience: AUDIENCE,
      scopes: ["mailbox:discover", "mailbox:materialize"],
    });

    const principal = await verifier.verify(token);
    expect(principal.caller).toBe("worker");
  });

  it("rejects any subject other than the two configured ones", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({
      subject: "some-other-subject",
      audience: AUDIENCE,
      scopes: [],
    });

    await expect(verifier.verify(token)).rejects.toThrow(ServiceAuthError);
  });

  it("rejects a token signed for a different audience", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({
      subject: APP_API_SUBJECT,
      audience: "mch_someOtherAudience",
      scopes: [],
    });

    await expect(verifier.verify(token)).rejects.toThrow(ServiceAuthError);
  });

  it("rejects an expired token", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({
      subject: APP_API_SUBJECT,
      audience: AUDIENCE,
      scopes: [],
      expiresInSeconds: -3_600,
    });

    await expect(verifier.verify(token)).rejects.toThrow(ServiceAuthError);
  });

  it("rejects a token signed by an untrusted key (never logs the bearer token itself)", async () => {
    const { verifier } = await setup();
    const attacker = await createFakeClerkIssuer();
    const forged = await attacker.mint({
      subject: APP_API_SUBJECT,
      audience: AUDIENCE,
      scopes: [],
    });

    await expect(verifier.verify(forged)).rejects.toThrow(ServiceAuthError);
  });

  it("requireScopes throws when a required scope is missing", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({
      subject: APP_API_SUBJECT,
      audience: AUDIENCE,
      scopes: ["oauth:start"],
    });
    const principal = await verifier.verify(token);

    expect(() => requireScopes(principal, ["oauth:start", "connections:revoke"])).toThrow(
      ServiceAuthError,
    );
    expect(() => requireScopes(principal, ["oauth:start"])).not.toThrow();
  });

  it("requireCaller throws when the caller is not the one expected by the route", async () => {
    const { issuer, verifier } = await setup();
    const token = await issuer.mint({
      subject: WORKER_SUBJECT,
      audience: AUDIENCE,
      scopes: [],
    });
    const principal = await verifier.verify(token);

    expect(() => requireCaller(principal, "app-api")).toThrow(ServiceAuthError);
    expect(() => requireCaller(principal, "worker")).not.toThrow();
  });
});
