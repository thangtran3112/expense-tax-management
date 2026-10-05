/**
 * Phase 3D-A Task 6 — shared Fastify-app builder for the top-level
 * verification suite (test/integration/app-domain-3d-a-mailbox.test.ts).
 *
 * Lives inside services/app-api/test/ (not the repo-root test/integration
 * directory) so its "fastify"/"fastify-type-provider-zod" bare-specifier
 * imports resolve against this package's own node_modules -- the repo
 * root has no direct dependency on either package, and Node resolves a
 * bare specifier relative to the *file* importing it, not the file that
 * ultimately calls into this module.
 */
import { Writable } from "node:stream";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";

import type { AuthPrincipal, TokenVerifier } from "../../src/auth/types.js";
import type { IdentityResolver } from "../../src/domain/authenticated-user.js";
import type { MailboxConnectionsDomain } from "../../src/domain/mailbox-connections.js";
import { registerErrorHandlers } from "../../src/errors.js";
import { registerAuthPlugin } from "../../src/plugins/auth.js";
import { registerMailboxConnectionRoutes } from "../../src/routes/mailbox-connections.js";

export const SERVICE_AUDIENCE = "expense-app-internal";
export const BROKER_SUBJECT = "mailbox-broker-app";

export function servicePrincipal(subject: string, scopes: readonly string[]): AuthPrincipal {
  return {
    tokenType: "service",
    subject,
    clientId: subject,
    audience: SERVICE_AUDIENCE,
    issuer: "https://services.t6.test",
    roles: [],
    scopes,
    tokenId: `${subject}-token-id`,
    email: null,
    emailVerified: null,
    displayName: null,
  };
}

export interface BuildTask6AppOptions {
  readonly mailboxConnectionsDomain: MailboxConnectionsDomain;
  readonly identityResolver: IdentityResolver;
  readonly tenantPrincipal: AuthPrincipal;
  readonly mailboxBrokerPublicBaseUrl?: string;
}

/**
 * Builds a minimal (non-`buildApp`) Fastify instance registering exactly
 * the real auth plugin + real mailbox routes against a real (injected)
 * `mailboxConnectionsDomain` -- same pattern as
 * services/app-api/test/mailbox-connections.test.ts's "broker-only auth
 * guard" block, but with a real domain backing real PostgreSQL instead
 * of `vi.fn()` stubs, and with request logs captured to a string so
 * callers can assert no secret ever appears in them.
 *
 * Fake `TokenVerifier`s only recognize the fixed bearer-token literals
 * "broker-token" / "wrong-subject-token" / "app-worker-token" /
 * "missing-scope-token" / "tenant-token" -- the same convention Task 2's
 * own suite established; no real JWT signing is needed to prove subject/
 * scope/token-type enforcement.
 */
export function buildTask6TestApp(options: BuildTask6AppOptions) {
  const serviceVerifier: TokenVerifier = {
    verify: async (token) => {
      if (token === "broker-token") return servicePrincipal(BROKER_SUBJECT, ["mailbox:write"]);
      if (token === "wrong-subject-token") return servicePrincipal("some-other-service", ["mailbox:write"]);
      if (token === "app-worker-token") {
        return servicePrincipal("ai-worker-app-machine", ["mailbox:write", "jobs:write"]);
      }
      if (token === "missing-scope-token") return servicePrincipal(BROKER_SUBJECT, []);
      throw new Error("tenant token rejected by service verifier");
    },
  };
  const tenantVerifier: TokenVerifier = {
    verify: async (token) => {
      if (token === "tenant-token") return options.tenantPrincipal;
      throw new Error("service token rejected by tenant verifier");
    },
  };

  const logChunks: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logChunks.push(chunk.toString("utf8"));
      callback();
    },
  });

  const app = Fastify({ logger: { level: "info", stream: logStream } });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);
  registerAuthPlugin(app, { authVerifiers: { tenant: tenantVerifier, service: serviceVerifier } });
  app.register(registerMailboxConnectionRoutes, {
    mailboxConnectionsDomain: options.mailboxConnectionsDomain,
    identityResolver: options.identityResolver,
    mailboxBrokerPublicBaseUrl: options.mailboxBrokerPublicBaseUrl ?? "https://expense-mailbox.t6.test",
  });

  return {
    app: app.withTypeProvider<ZodTypeProvider>(),
    logLines: () => logChunks.join("\n"),
  };
}
