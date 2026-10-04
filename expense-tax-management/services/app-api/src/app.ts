import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import fastifySwagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import {
  createConfiguredAuthVerifiers,
  type AuthKeyResolverFactory,
} from "./auth/verifier.js";
import type { AuthVerifiers } from "./auth/types.js";
import type { AppConfig } from "./config.js";
import { createAppDatabase } from "./database/client.js";
import { createDatabaseClerkIdentityMappingDomain } from "./domain/clerk-identity.js";
import type { AppDatabase } from "./database/types.js";
import {
  createBusinessDomain,
  type BusinessDomain,
} from "./domain/businesses.js";
import {
  createIdentityDomain,
  type IdentityDomain,
} from "./domain/identity.js";
import {
  createSpendingCategoryDomain,
  type SpendingCategoryDomain,
} from "./domain/spending-categories.js";
import { createProjectDomain, type ProjectDomain } from "./domain/projects.js";
import { createExpenseDomain, type ExpenseDomain } from "./domain/expenses.js";
import { createTaxDomain, type TaxDomain } from "./domain/tax.js";
import {
  createMembershipDomain,
  type MembershipDomain,
} from "./domain/memberships.js";
import { createTenantDomain, type TenantDomain } from "./domain/tenants.js";
import { createPlansDomain, type PlansDomain } from "./domain/plans.js";
import {
  createEnrichmentJobsDomain,
  type EnrichmentJobsDomain,
} from "./domain/enrichment-jobs.js";
import {
  createProcessingJobsDomain,
  type ProcessingJobsDomain,
} from "./domain/processing-jobs.js";
import { DomainError, registerErrorHandlers } from "./errors.js";
import { registerAuthPlugin } from "./plugins/auth.js";
import {
  registerDatabasePlugin,
  type DatabaseReadinessProbe,
} from "./plugins/database.js";
import { registerGatewayHardening } from "./plugins/gateway-hardening.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerBusinessRoutes } from "./routes/businesses.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerMembershipRoutes } from "./routes/memberships.js";
import { registerSpendingCategoryRoutes } from "./routes/spending-categories.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerExpenseRoutes } from "./routes/expenses.js";
import { registerTaxRoutes } from "./routes/tax.js";
import { registerTenantRoutes } from "./routes/tenants.js";
import { registerPlanRoutes } from "./routes/plans.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { createDeduplicationDomain, type DeduplicationDomain } from "./domain/deduplication.js";
import { createTagDomain, type TagDomain } from "./domain/tags.js";
import { registerTagRoutes } from "./routes/tags.js";
import { registerEnrichmentRoutes } from "./routes/enrichment.js";
import { registerExportRoutes } from "./routes/exports.js";
import { createExportsDomain, type ExportsDomain } from "./domain/exports.js";
import { registerFileRoutes } from "./routes/files.js";
import { createFilesDomain, type FilesDomain } from "./domain/files.js";
import { registerOcrRoutes } from "./routes/ocr.js";
import { createOcrJobsDomain, type OcrJobsDomain } from "./domain/ocr.js";
import {
  createInboundEmailDomain,
  type InboundEmailDomain,
} from "./domain/inbound-email.js";
import { registerInboundEmailRoutes } from "./routes/inbound-email.js";
import { registerClerkWebhookRoutes, type ClerkWebhookRouteOptions } from "./routes/clerk-webhooks.js";
import { registerAuthCheckRoutes } from "./routes/auth-check.js";
import { registerDuplicateMatchRoutes } from "./routes/duplicate-matches.js";
import { registerMailboxConnectionRoutes } from "./routes/mailbox-connections.js";
import { registerMailboxInternalRoutes } from "./routes/mailbox-internal.js";
import { registerMailboxCandidateRoutes } from "./routes/mailbox-candidates.js";
import {
  createMailboxConnectionsDomain,
  type MailboxConnectionsDomain,
} from "./domain/mailbox-connections.js";
import {
  createMailboxScansDomain,
  type MailboxScansDomain,
} from "./domain/mailbox-scans.js";
import {
  createMailboxCandidatesDomain,
  type MailboxCandidatesDomain,
} from "./domain/mailbox-candidates.js";
import { createMailboxBrokerClient } from "./integrations/mailbox-broker-client.js";
import type { ClerkIdentityMappingDomain } from "./domain/clerk-identity.js";
import {
  createClerkWebhookHandler,
  createDatabaseClerkWebhookRepository,
  type ClerkWebhookHandler,
} from "./integrations/clerk-webhooks.js";
import {
  createLocalVerificationNotifier,
  type VerificationNotifier,
} from "./inbound/notifier.js";
import {
  PatternMalwareScanner,
  type MalwareScanner,
} from "./inbound/security.js";
import {
  createStorageAdapter,
  type StorageAdapter,
} from "./storage/factory.js";
import {
  createTemporalWorkflowStarter,
  type TemporalWorkflowStarter,
} from "./temporal/client.js";
import { createMailboxScanDispatch } from "./temporal/mailbox-schedules.js";
import type { Kysely } from "kysely";

const SENSITIVE_FIELD_NAMES = [
  "authorization",
  "cookie",
  "cookies",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "bearerToken",
  "apiKey",
  "clientSecret",
  "secret",
  "secrets",
  "key",
  "keys",
  "privateKey",
  "secretKey",
  "signingKey",
  "encryptionKey",
  "databaseUrl",
  "databaseURL",
  "database_url",
  "databaseUri",
  "databaseURI",
  "database_uri",
  "connectionString",
  "connection_string",
  "access_token",
  "refresh_token",
  "id_token",
  "bearer_token",
  "api_key",
  "client_secret",
  "private_key",
  "secret_key",
  "signing_key",
  "encryption_key",
  "urlSigningKey",
  "url_signing_key",
  "webhookSigningKey",
  "routingTokenSecret",
];

const SENSITIVE_LOG_PATHS = [
  ...SENSITIVE_FIELD_NAMES,
  ...SENSITIVE_FIELD_NAMES.map((fieldName) => "*." + fieldName),
  "headers.authorization",
  "headers.cookie",
  "headers.cookies",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.cookies",
  "request.headers.authorization",
  "request.headers.cookie",
  "request.headers.cookies",
];

type LoggerOption = Exclude<FastifyServerOptions["logger"], undefined>;

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly logger?: FastifyServerOptions["logger"];
  readonly authVerifiers?: AuthVerifiers;
  readonly authKeyResolverFactory?: AuthKeyResolverFactory;
  readonly database?: Kysely<AppDatabase>;
  readonly readinessProbe?: DatabaseReadinessProbe;
  readonly identityDomain?: IdentityDomain;
  readonly tenantDomain?: TenantDomain;
  readonly membershipDomain?: MembershipDomain;
  readonly businessDomain?: BusinessDomain;
  readonly spendingCategoryDomain?: SpendingCategoryDomain;
  readonly projectDomain?: ProjectDomain;
  readonly expenseDomain?: ExpenseDomain;
  readonly taxDomain?: TaxDomain;
  readonly plansDomain?: PlansDomain;
  readonly temporalStarter?: TemporalWorkflowStarter;
  readonly processingJobsDomain?: ProcessingJobsDomain;
  readonly enrichmentJobsDomain?: EnrichmentJobsDomain;
  readonly deduplicationDomain?: DeduplicationDomain;
  readonly storageAdapter?: StorageAdapter;
  readonly filesDomain?: FilesDomain;
  readonly exportsDomain?: ExportsDomain;
  readonly ocrJobsDomain?: OcrJobsDomain;
  readonly inboundEmailDomain?: InboundEmailDomain;
  readonly verificationNotifier?: VerificationNotifier;
  readonly malwareScanner?: MalwareScanner;
  readonly clerkWebhookHandler?: ClerkWebhookHandler;
  readonly clerkWebhookVerifySignature?: ClerkWebhookRouteOptions["verifySignature"];
  readonly clerkIdentityDomain?: ClerkIdentityMappingDomain;
  readonly tagDomain?: TagDomain;
  readonly mailboxConnectionsDomain?: MailboxConnectionsDomain;
  readonly mailboxScansDomain?: MailboxScansDomain;
  readonly mailboxCandidatesDomain?: MailboxCandidatesDomain;
}

/**
 * Fix round 1 (Important) -- used only when `config.mailboxEnabled` is
 * explicitly false (the deliberate, documented default), never as a
 * fallback for incomplete-but-enabled config: `createAppConfig` already
 * fails startup in that case (`validateMailboxConfiguration`), so this
 * function is reached only by genuine, intentional "feature is off"
 * deployments. Every method returns a typed, documented
 * `DomainError.featureDisabled()` (404, code `FEATURE_DISABLED`) instead
 * of a generic/ambiguous error, so a caller can tell "this isn't broken,
 * it's turned off" from "something crashed". Routes stay registered
 * either way, so the customer-facing route is always present in the
 * generated OpenAPI spec/TS client.
 */
function createDisabledMailboxConnectionsDomain(): MailboxConnectionsDomain {
  const disabled = async (): Promise<never> => {
    throw DomainError.featureDisabled();
  };
  return {
    startConnection: disabled,
    getConnection: disabled,
    consumeOAuthState: disabled,
    completeConnection: disabled,
    acquireTokenOperationLease: disabled,
    advanceTokenGeneration: disabled,
    releaseTokenOperationLease: disabled,
    recordRevocation: disabled,
  };
}

/** Same "explicitly disabled, not misconfigured" convention as
 * createDisabledMailboxConnectionsDomain, applied to the Task 2 scan
 * domain. */
function createDisabledMailboxScansDomain(): MailboxScansDomain {
  const disabled = async (): Promise<never> => {
    throw DomainError.featureDisabled();
  };
  return {
    startManualScan: disabled,
    startScheduledScan: disabled,
    listScanRuns: disabled,
    loadScanBinding: disabled,
    loadCandidateBinding: disabled,
    recordCandidateMetadata: disabled,
    finalizeScanRun: disabled,
  };
}

/** Same "explicitly disabled, not misconfigured" convention as
 * createDisabledMailboxConnectionsDomain, applied to Task 5's candidate
 * review domain. */
function createDisabledMailboxCandidatesDomain(): MailboxCandidatesDomain {
  const disabled = async (): Promise<never> => {
    throw DomainError.featureDisabled();
  };
  return {
    listCandidates: disabled,
    resolveCandidate: disabled,
  };
}

function loggerWithRedaction(logger: BuildAppOptions["logger"]): LoggerOption {
  if (logger === false) {
    return false;
  }

  if (logger === true || logger === undefined) {
    return { redact: SENSITIVE_LOG_PATHS };
  }

  return {
    ...logger,
    redact: SENSITIVE_LOG_PATHS,
  };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: loggerWithRedaction(options.logger),
    bodyLimit: 1024 * 1024,
    connectionTimeout: 15_000,
    keepAliveTimeout: 5_000,
  });
  const database = options.database ?? createAppDatabase(options.config.databaseUrl);
  const clerkIdentityDomain =
    options.clerkIdentityDomain ?? createDatabaseClerkIdentityMappingDomain(database);
  const identityDomain = options.identityDomain ?? createIdentityDomain(database);
  const tenantDomain = options.tenantDomain ?? createTenantDomain(database);
  const membershipDomain =
    options.membershipDomain ?? createMembershipDomain(database, app.log);
  const businessDomain = options.businessDomain ?? createBusinessDomain(database);
  const spendingCategoryDomain =
    options.spendingCategoryDomain ?? createSpendingCategoryDomain(database);
  const projectDomain = options.projectDomain ?? createProjectDomain(database);
  const expenseDomain = options.expenseDomain ?? createExpenseDomain(database);
  const taxDomain = options.taxDomain ?? createTaxDomain(database);
  const plansDomain = options.plansDomain ?? createPlansDomain(database);
  const temporalStarter =
    options.temporalStarter ?? createTemporalWorkflowStarter(options.config.temporal);
  const processingJobsDomain =
    options.processingJobsDomain ??
    createProcessingJobsDomain(database, temporalStarter);
  const enrichmentJobsDomain =
    options.enrichmentJobsDomain ?? createEnrichmentJobsDomain(database);
  const deduplicationDomain =
    options.deduplicationDomain ?? createDeduplicationDomain(database);
  const tagDomain = options.tagDomain ?? createTagDomain(database);
  const storageAdapter =
    options.storageAdapter ??
    createStorageAdapter({
      backend: options.config.storage.backend,
      localDir: options.config.storage.localDir,
      baseUrl: options.config.storage.baseUrl,
      urlSigningKey: options.config.storage.urlSigningKey,
    });
  const filesDomain =
    options.filesDomain ?? createFilesDomain(database, storageAdapter);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Expense Tax App API",
        version: options.config.version,
      },
      components: {
        securitySchemes: {
          tenantBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Tenant account bearer token",
          },
          serviceBearer: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Internal service bearer token",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  registerErrorHandlers(app);
  registerGatewayHardening(app);
  registerAuthPlugin(app, {
    authVerifiers:
      options.authVerifiers ??
      createConfiguredAuthVerifiers(
        options.config,
        options.authKeyResolverFactory,
      ),
    clerkIdentityDomain,
  });
  registerDatabasePlugin(app, {
    database,
    destroyOnClose: options.database === undefined,
    ...(options.readinessProbe
      ? { readinessProbe: options.readinessProbe }
      : {}),
  });
  app.register(registerHealthRoutes, {
    config: options.config,
    readinessProbe: app.databaseReadinessProbe,
  });
  if (options.config.clerk !== undefined) {
    app.register(registerAuthCheckRoutes, {
      workerServiceSubject: options.config.clerk.appServiceSubject,
    });
  }
  app.register(registerIdentityRoutes, { identityDomain });
  app.register(registerTenantRoutes, {
    identityResolver: identityDomain,
    tenantDomain,
  });
  app.register(registerMembershipRoutes, {
    identityResolver: identityDomain,
    membershipDomain,
  });
  app.register(registerBusinessRoutes, {
    identityResolver: identityDomain,
    businessDomain,
  });
  app.register(registerSpendingCategoryRoutes, {
    identityResolver: identityDomain,
    spendingCategoryDomain,
  });
  app.register(registerProjectRoutes, {
    identityResolver: identityDomain,
    projectDomain,
  });
  app.register(registerExpenseRoutes, {
    identityResolver: identityDomain,
    expenseDomain,
  });
  app.register(registerTaxRoutes, {
    identityResolver: identityDomain,
    taxDomain,
  });
  app.register(registerPlanRoutes, {
    identityResolver: identityDomain,
    plansDomain,
    ...(options.config.clerk?.foundryServiceSubject
      ? { foundryServiceSubject: options.config.clerk.foundryServiceSubject }
      : {}),
  });
  app.register(registerJobRoutes, {
    processingJobsDomain,
    enrichmentJobsDomain,
    deduplicationDomain,
    ...(options.config.clerk?.appServiceSubject
      ? { workerServiceSubject: options.config.clerk.appServiceSubject }
      : {}),
    ...(options.config.clerk?.enrichmentInputScope
      ? { enrichmentInputScope: options.config.clerk.enrichmentInputScope }
      : {}),
    ...(options.config.clerk?.enrichmentResultScope
      ? { enrichmentResultScope: options.config.clerk.enrichmentResultScope }
      : {}),
  });
  app.register(registerTagRoutes, {
    identityResolver: identityDomain,
    tagDomain,
  });
  app.register(registerEnrichmentRoutes, {
    identityResolver: identityDomain,
    tagDomain,
  });
  app.register(registerDuplicateMatchRoutes, {
    identityResolver: identityDomain,
    deduplicationDomain: (deduplicationDomain.resolveMatch
      ? deduplicationDomain
      : createDeduplicationDomain(database)) as Parameters<typeof registerDuplicateMatchRoutes>[1]["deduplicationDomain"],
  });
  // Fix round 1: real construction only when the feature is explicitly
  // enabled (`createAppConfig` already fails startup if enabled but
  // incompletely configured, so every field below is guaranteed present
  // whenever `mailboxEnabled` is true); `options.mailboxConnectionsDomain`
  // always wins, for tests.
  const mailboxBrokerClient =
    options.config.mailboxEnabled &&
    options.config.clerk?.mailboxBrokerBaseUrl !== undefined &&
    options.config.clerk.mailboxServiceAudience !== undefined &&
    options.config.clerk.mailboxAppApiMachineSecretKey !== undefined &&
    options.config.clerk.mailboxAppApiSubject !== undefined
      ? createMailboxBrokerClient({
          baseUrl: options.config.clerk.mailboxBrokerBaseUrl,
          issuerUrl: options.config.clerk.issuerUrl,
          jwksUrl: options.config.clerk.jwksUrl,
          credentials: {
            audience: options.config.clerk.mailboxServiceAudience,
            machineSecretKey: options.config.clerk.mailboxAppApiMachineSecretKey,
            subject: options.config.clerk.mailboxAppApiSubject,
          },
        })
      : undefined;
  const mailboxConnectionsDomain =
    options.mailboxConnectionsDomain ??
    (mailboxBrokerClient && options.config.mailboxAllowedRedirectOrigins
      ? createMailboxConnectionsDomain(database, mailboxBrokerClient, {
          allowedRedirectOrigins: options.config.mailboxAllowedRedirectOrigins,
        })
      : createDisabledMailboxConnectionsDomain());
  const mailboxScansDomain =
    options.mailboxScansDomain ??
    (options.config.mailboxEnabled
      ? createMailboxScanDispatch(
          createMailboxScansDomain(database, { plansDomain }),
          temporalStarter,
        )
      : createDisabledMailboxScansDomain());
  // Phase 3D-B Task 5 -- no broker client needed (candidate review is a
  // pure App-owned transition), so this only depends on `mailboxEnabled`.
  const mailboxCandidatesDomain =
    options.mailboxCandidatesDomain ??
    (options.config.mailboxEnabled
      ? createMailboxCandidatesDomain(database)
      : createDisabledMailboxCandidatesDomain());
  // Always registered (same pattern as every other route group in this
  // file) so the customer-facing route is always present in the generated
  // OpenAPI spec/TS client; when the feature is disabled, every call fails
  // closed with a typed FEATURE_DISABLED (404) via
  // createDisabledMailboxConnectionsDomain/createDisabledMailboxScansDomain
  // above, not a generic error.
  app.register(registerMailboxConnectionRoutes, {
    mailboxConnectionsDomain,
    mailboxScansDomain,
    identityResolver: identityDomain,
    ...(options.config.clerk?.mailboxBrokerServiceSubject
      ? { brokerServiceSubject: options.config.clerk.mailboxBrokerServiceSubject }
      : {}),
    ...(options.config.clerk?.mailboxBrokerPublicBaseUrl
      ? { mailboxBrokerPublicBaseUrl: options.config.clerk.mailboxBrokerPublicBaseUrl }
      : {}),
  });
  app.register(registerMailboxInternalRoutes, {
    mailboxScansDomain,
    ...(options.config.clerk?.mailboxBrokerServiceSubject
      ? { brokerServiceSubject: options.config.clerk.mailboxBrokerServiceSubject }
      : {}),
    ...(options.config.clerk?.mailboxWorkerServiceSubject
      ? { workerServiceSubject: options.config.clerk.mailboxWorkerServiceSubject }
      : {}),
  });
  app.register(registerMailboxCandidateRoutes, {
    mailboxCandidatesDomain,
    identityResolver: identityDomain,
  });
  const exportsDomain =
    options.exportsDomain ??
    createExportsDomain(database, storageAdapter, {
      appVersion: options.config.version,
    });
  app.register(registerExportRoutes, {
    identityResolver: identityDomain,
    exportsDomain,
  });
  app.register(registerFileRoutes, {
    identityResolver: identityDomain,
    filesDomain,
    contentSigningKey: options.config.storage.urlSigningKey,
    ...(options.config.clerk?.appServiceSubject
      ? { workerServiceSubject: options.config.clerk.appServiceSubject }
      : {}),
  });
  const ocrJobsDomain =
    options.ocrJobsDomain ??
    createOcrJobsDomain(database, { plansDomain, filesDomain });
  app.register(registerOcrRoutes, {
    identityResolver: identityDomain,
    ocrJobsDomain,
    ...(options.config.clerk?.appServiceSubject
      ? { workerServiceSubject: options.config.clerk.appServiceSubject }
      : {}),
  });
  const inboundEmailDomain =
    options.inboundEmailDomain ??
    createInboundEmailDomain(database, {
      filesDomain,
      ocrJobsDomain,
      plansDomain,
      notifier:
        options.verificationNotifier ??
        createLocalVerificationNotifier(options.config.inboundEmail.challengeDir),
      malwareScanner: options.malwareScanner ?? PatternMalwareScanner,
      config: {
        baseAddress: options.config.inboundEmail.baseAddress,
        routingTokenSecret: options.config.inboundEmail.routingTokenSecret,
      },
    });
  app.register(registerInboundEmailRoutes, {
    identityResolver: identityDomain,
    inboundEmailDomain,
    webhookSigningKey: options.config.inboundEmail.webhookSigningKey,
  });
  app.register(registerClerkWebhookRoutes, {
    signingSecret: options.config.clerk?.webhookSigningSecret,
    ...(options.clerkWebhookVerifySignature !== undefined
      ? { verifySignature: options.clerkWebhookVerifySignature }
      : {}),
    handler:
      options.clerkWebhookHandler ??
      createClerkWebhookHandler(createDatabaseClerkWebhookRepository(database)),
  });

  if (options.temporalStarter === undefined) {
    app.addHook("onClose", async () => {
      await temporalStarter.close();
    });
  }

  return app;
}
