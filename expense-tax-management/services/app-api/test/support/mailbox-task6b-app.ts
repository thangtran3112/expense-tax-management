/**
 * Phase 3D-B Task 6 — shared Fastify-app builder for the phase-level
 * verification suite (test/integration/app-domain-3d-b-mailbox.test.ts).
 *
 * Same reasoning as 3D-A Task 6's services/app-api/test/support/
 * mailbox-task6-app.ts (lives inside services/app-api/test/ so its
 * "fastify"/"fastify-type-provider-zod" bare-specifier imports resolve
 * against this package's own node_modules). Registers the real route
 * modules 3D-B built (customer-facing scan start/list via
 * registerMailboxConnectionRoutes's optional mailboxScansDomain branch,
 * the broker/worker-facing internal routes, and the customer-facing
 * candidate review routes) against real (injected) domain instances
 * backed by real PostgreSQL -- never a vi.fn() stub.
 *
 * Fake `TokenVerifier`s only recognize fixed bearer-token literals, same
 * convention as every other mailbox test suite in this repo; no real JWT
 * signing is needed to prove subject/scope/token-type enforcement.
 */
import { Writable } from "node:stream";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";

import type { AuthPrincipal, TokenVerifier } from "../../src/auth/types.js";
import type { IdentityResolver } from "../../src/domain/authenticated-user.js";
import type {
  AcquireTokenOperationLeaseInput,
  CompleteConnectionInput,
  ConsumeOAuthStateInput,
  ConsumeOAuthStateResult,
  GetConnectionInput,
  MailboxConnectionsDomain,
  RecordRevocationInput,
  ReleaseTokenOperationLeaseInput,
  StartConnectionInput,
  StartConnectionResult,
} from "../../src/domain/mailbox-connections.js";
import type { MailboxCandidatesDomain } from "../../src/domain/mailbox-candidates.js";
import type { MailboxScansDomain } from "../../src/domain/mailbox-scans.js";
import type {
  AdvanceTokenGenerationInput,
  AdvanceTokenGenerationResult,
  MailboxConnectionV1,
  MailboxConnectionRecordV1,
  TokenOperationLeaseV1,
} from "@expense-tax/contracts";
import { registerErrorHandlers } from "../../src/errors.js";
import { registerAuthPlugin } from "../../src/plugins/auth.js";
import { registerMailboxConnectionRoutes } from "../../src/routes/mailbox-connections.js";
import { registerMailboxInternalRoutes } from "../../src/routes/mailbox-internal.js";
import { registerMailboxCandidateRoutes } from "../../src/routes/mailbox-candidates.js";

export const BROKER_SUBJECT = "mailbox-broker-app";
export const WORKER_SUBJECT = "workflow-worker-mailbox";

export function servicePrincipal(subject: string, scopes: readonly string[]): AuthPrincipal {
  return {
    tokenType: "service",
    subject,
    clientId: subject,
    audience: "expense-app-internal",
    issuer: "https://services.t6b.test",
    roles: [],
    scopes,
    tokenId: `${subject}-token-id`,
    email: null,
    emailVerified: null,
    displayName: null,
  };
}

/**
 * Task 6 never exercises the OAuth connection-lifecycle routes (3D-A
 * Task 6 already owns that proof) -- only the "scans" sub-routes
 * registerMailboxConnectionRoutes adds when `mailboxScansDomain` is
 * supplied. Every other method is unused by this suite.
 */
function notImplementedMailboxConnectionsDomain(): MailboxConnectionsDomain {
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented: Task 6 does not exercise connection-lifecycle routes");
  };
  return {
    startConnection: notImplemented as (input: StartConnectionInput) => Promise<StartConnectionResult>,
    getConnection: notImplemented as (input: GetConnectionInput) => Promise<MailboxConnectionV1 | null>,
    consumeOAuthState: notImplemented as (input: ConsumeOAuthStateInput) => Promise<ConsumeOAuthStateResult>,
    completeConnection: notImplemented as (input: CompleteConnectionInput) => Promise<MailboxConnectionRecordV1>,
    acquireTokenOperationLease: notImplemented as (
      input: AcquireTokenOperationLeaseInput,
    ) => Promise<TokenOperationLeaseV1>,
    advanceTokenGeneration: notImplemented as (
      input: AdvanceTokenGenerationInput,
    ) => Promise<AdvanceTokenGenerationResult>,
    releaseTokenOperationLease: notImplemented as (input: ReleaseTokenOperationLeaseInput) => Promise<void>,
    recordRevocation: notImplemented as (input: RecordRevocationInput) => Promise<MailboxConnectionV1>,
  };
}

export interface BuildTask6BAppOptions {
  readonly mailboxScansDomain: MailboxScansDomain;
  readonly mailboxCandidatesDomain: MailboxCandidatesDomain;
  readonly identityResolver: IdentityResolver;
  /**
   * Keyed by bearer-token literal, so a single app instance can exercise
   * review authorization across several distinct tenant actors (owner /
   * reviewer-grant / outsider) without rebuilding the app per actor --
   * `identityResolver.resolve(issuer, subject)` keys on each principal's
   * own distinct `subject`.
   */
  readonly tenantPrincipalsByToken: Readonly<Record<string, AuthPrincipal>>;
}

/**
 * Bearer-token literals this suite's fake verifiers recognize:
 * - any key of `tenantPrincipalsByToken` -> that exact tenant principal.
 * - "broker-token" -> BROKER_SUBJECT with ["mailbox:write", "mailbox:materialize"].
 * - "worker-token" -> WORKER_SUBJECT with ["mailbox:discover"].
 * - "wrong-worker-token" -> a different subject (rejected by workerGuard).
 * - "missing-scope-worker-token" -> WORKER_SUBJECT with no scopes.
 */
export function buildTask6BTestApp(options: BuildTask6BAppOptions) {
  const serviceVerifier: TokenVerifier = {
    verify: async (token) => {
      if (token === "broker-token") return servicePrincipal(BROKER_SUBJECT, ["mailbox:write", "mailbox:materialize"]);
      if (token === "worker-token") return servicePrincipal(WORKER_SUBJECT, ["mailbox:discover"]);
      if (token === "wrong-worker-token") return servicePrincipal("some-other-service", ["mailbox:discover"]);
      if (token === "missing-scope-worker-token") return servicePrincipal(WORKER_SUBJECT, []);
      throw new Error("tenant token rejected by service verifier");
    },
  };
  const tenantVerifier: TokenVerifier = {
    verify: async (token) => {
      const principal = options.tenantPrincipalsByToken[token];
      if (principal) return principal;
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
    mailboxConnectionsDomain: notImplementedMailboxConnectionsDomain(),
    mailboxScansDomain: options.mailboxScansDomain,
    identityResolver: options.identityResolver,
  });
  app.register(registerMailboxInternalRoutes, { mailboxScansDomain: options.mailboxScansDomain });
  app.register(registerMailboxCandidateRoutes, {
    mailboxCandidatesDomain: options.mailboxCandidatesDomain,
    identityResolver: options.identityResolver,
  });

  return {
    app: app.withTypeProvider<ZodTypeProvider>(),
    logLines: () => logChunks.join("\n"),
  };
}
