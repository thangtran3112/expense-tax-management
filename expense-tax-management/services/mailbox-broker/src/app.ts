/**
 * Phase 3D-A Task 4 — mailbox broker Fastify app.
 *
 * Deliberately takes a fully-built `appClient`/`providerAdapter` rather
 * than constructing them from raw config: doing so keeps this module
 * (and every test that builds an app from it) free of any real Google
 * client-credential or token-vault-database dependency -- those are
 * resolved once, in `server.ts`, for the real running process.
 */
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";

import type { BrokerConfig } from "./config.js";
import { registerErrorHandlers } from "./errors.js";
import { createServiceGuardFactory } from "./plugins/auth.js";
import type { CreateServiceVerifierOptions } from "./auth/clerk.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import type { MaterializeCandidateDependencies } from "./ingestion.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import type {
  MailboxBrokerConnectionAppClient,
  MailboxBrokerDiscoveryAppClient,
  MailboxDiscoveryProviderAdapter,
  MailboxProviderAdapter,
} from "./contracts.js";
import type { GoogleAuthorizationUrlBuilder } from "./google-authorization-url.js";
import { SENSITIVE_LOG_PATHS } from "./logging.js";

type LoggerOption = Exclude<FastifyServerOptions["logger"], undefined>;

export interface BuildAppOptions {
  readonly config: BrokerConfig;
  readonly logger?: FastifyServerOptions["logger"];
  readonly appClient: MailboxBrokerConnectionAppClient;
  readonly providerAdapter: MailboxProviderAdapter;
  readonly allowedRedirectOrigins: readonly string[];
  readonly sessionNonceCookieName?: string;
  readonly expectedCallbackHost?: string;
  /**
   * Fix round 2 (Important) -- builds the Google authorization URL from
   * trusted server config at `/oauth/google/begin` time; never a
   * client-supplied URL. Required (not defaulted) so every test and the
   * real `server.ts` must supply one explicitly -- there is no safe
   * default that doesn't need real Google client credentials.
   */
  readonly buildGoogleAuthorizationUrl: GoogleAuthorizationUrlBuilder;
  readonly beginTicketTtlSeconds?: number;
  /** Test-only: substitutes the real remote JWKS fetch (see test-doubles.ts's `createFakeClerkIssuer`). */
  readonly inboundKeyResolver?: CreateServiceVerifierOptions["keyResolver"];
  /**
   * Phase 3D-B Task 4 -- discovery route dependencies. Optional: omitting
   * both (every existing caller of `buildApp`, routes.test.ts included)
   * simply skips registering the discover route, so no existing test or
   * call site needed to change (`registerConnectionRoutes`'s own three
   * discovery fields follow the same optional convention).
   */
  readonly discoveryAppClient?: MailboxBrokerDiscoveryAppClient;
  readonly discoveryProviderAdapter?: MailboxDiscoveryProviderAdapter;
  /**
   * Phase 3D-C Task 5 -- materialize route dependencies. Optional, same
   * "omit to skip registering the route" convention as the discovery pair
   * above; no existing test or call site needs to change.
   */
  readonly materializeDependencies?: MaterializeCandidateDependencies;
}

/**
 * Strips the query string from the logged request URL -- `req.url` is
 * logged verbatim by Fastify's default request serializer, and pino's
 * `redact` option cannot selectively redact a substring inside a composite
 * string value (only whole field values). The OAuth callback's query
 * string carries the Google authorization `code` and the encrypted
 * `state`; neither may ever reach a log line.
 */
function requestSerializer(request: FastifyRequest): Record<string, unknown> {
  const [pathOnly] = request.url.split("?");
  return {
    method: request.method,
    url: pathOnly,
    hostname: request.hostname,
    remoteAddress: request.ip,
  };
}

function loggerWithRedaction(logger: BuildAppOptions["logger"]): LoggerOption {
  if (logger === false) {
    return false;
  }
  const base = logger === true || logger === undefined ? {} : logger;
  return {
    ...base,
    redact: SENSITIVE_LOG_PATHS,
    serializers: { req: requestSerializer },
  };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: loggerWithRedaction(options.logger),
    bodyLimit: 1024 * 1024,
    // A worker /discover call is idle on the socket while the broker walks a
    // Gmail page (paced by Gmail's per-minute quota, up to minutes); Node
    // destroys a socket idle longer than this. Keep above the worker's
    // MAILBOX_DISCOVER_TIMEOUT_MS.
    connectionTimeout: 300_000,
    keepAliveTimeout: 5_000,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);

  const createGuard = createServiceGuardFactory(
    options.config.inboundAuth,
    options.inboundKeyResolver ? { keyResolver: options.inboundKeyResolver } : {},
  );

  app.register(registerOAuthRoutes, {
    providerAdapter: options.providerAdapter,
    appClient: options.appClient,
    vaultKeys: options.config.vault,
    allowedRedirectOrigins: options.allowedRedirectOrigins,
    ...(options.sessionNonceCookieName ? { sessionNonceCookieName: options.sessionNonceCookieName } : {}),
    ...(options.expectedCallbackHost ? { expectedCallbackHost: options.expectedCallbackHost } : {}),
    buildGoogleAuthorizationUrl: options.buildGoogleAuthorizationUrl,
    ...(options.beginTicketTtlSeconds !== undefined
      ? { beginTicketTtlSeconds: options.beginTicketTtlSeconds }
      : {}),
    appApiStartGuard: createGuard("app-api", ["oauth:start"]),
  });

  app.register(registerConnectionRoutes, {
    providerAdapter: options.providerAdapter,
    appClient: options.appClient,
    appApiRevokeGuard: createGuard("app-api", ["connections:revoke"]),
    ...(options.discoveryProviderAdapter ? { discoveryProviderAdapter: options.discoveryProviderAdapter } : {}),
    ...(options.discoveryAppClient ? { discoveryAppClient: options.discoveryAppClient } : {}),
    ...(options.discoveryProviderAdapter && options.discoveryAppClient
      ? { workerDiscoverGuard: createGuard("worker", ["mailbox:discover"]) }
      : {}),
    ...(options.materializeDependencies
      ? {
          materializeDependencies: options.materializeDependencies,
          workerMaterializeGuard: createGuard("worker", ["mailbox:materialize"]),
        }
      : {}),
  });

  // Phase 3D-A Task 5: liveness only (no token-vault-database probe),
  // matching app-api's/foundry-service's own `/health/live` (their
  // DB-backed `/health/ready` has no broker equivalent yet) -- needed so
  // deploy/production/health-check.sh has a loopback endpoint to poll
  // once this service joins the production Compose.
  app.get("/health/live", async () => ({
    status: "ok" as const,
    service: options.config.service,
    version: options.config.version,
  }));

  return app;
}
