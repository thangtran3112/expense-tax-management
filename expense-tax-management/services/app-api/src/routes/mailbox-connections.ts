/**
 * Phase 3D-A Task 2 — internal broker-facing mailbox connection routes.
 *
 * Exactly the four endpoints the task-2 brief lists: OAuth state consume,
 * and the token-operation lease/advance/release CAS. All four are guarded
 * by the broker's own service principal (subject "mailbox-broker-app",
 * scope "mailbox:write") -- never a tenant token, never the App worker's
 * own service principal.
 *
 * This module only exports its route-registration function; wiring into
 * app-api/src/app.ts (alongside the Office/public routes that depend on
 * the same domain) is Task 4's job.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ErrorResponseSchema,
  MailboxConnectionV1Schema,
  MailboxOAuthAttemptV1Schema,
  MailboxScopeSchema,
  TenantIdParamsSchema,
  type MailboxConnectionRecordV1,
  type MailboxConnectionV1,
} from "@expense-tax/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import { authenticatedUserGuard, serviceGuard, tenantGuard } from "../plugins/auth.js";
import { DomainError } from "../errors.js";
import type { MailboxConnectionsDomain } from "../domain/mailbox-connections.js";

export interface MailboxConnectionsRouteOptions {
  readonly mailboxConnectionsDomain: MailboxConnectionsDomain;
  /**
   * Required for the customer-facing google/start route; the four
   * existing broker-only internal routes (Task 2) don't need it. Optional
   * here only so Task 2's own broker-guard unit test (no tenant routes
   * exercised) keeps working unchanged.
   */
  readonly identityResolver?: IdentityResolver;
  /** Default mirrors the plan's exact machine subject: "mailbox-broker-app". */
  readonly brokerServiceSubject?: string;
  /**
   * Fix round 1 (Critical) -- the broker's PUBLIC base URL. Required to
   * serve the customer-facing start route for real: it wraps the
   * broker's opaque begin ticket (fix round 2) into a link to this
   * origin's own `/oauth/google/begin`, where the broker builds the real
   * Google URL itself and sets its session-nonce cookie before
   * redirecting -- see `config.ts`'s `mailboxBrokerPublicBaseUrl` doc
   * comment for why.
   */
  readonly mailboxBrokerPublicBaseUrl?: string;
}

function actorUserId(request: FastifyRequest): string {
  if (!request.authenticatedUser) throw DomainError.unauthenticated();
  return request.authenticatedUser.id;
}

/** Public connection projection -- strips vault/lease/scan internals. */
function toPublicConnection(record: MailboxConnectionRecordV1): MailboxConnectionV1 {
  const copy: Partial<Record<string, unknown>> = { ...record };
  delete copy.vaultReference;
  delete copy.tokenGeneration;
  delete copy.connectionVersion;
  delete copy.tokenOperationLeaseId;
  delete copy.tokenOperationLeaseExpiresAt;
  delete copy.activeScanRunId;
  delete copy.activeScanLeaseExpiresAt;
  return copy as unknown as MailboxConnectionV1;
}

const errors = { 401: ErrorResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema, 410: ErrorResponseSchema };

const ConnectionIdParamsSchema = z.strictObject({ connectionId: z.uuid() });
const AttemptIdParamsSchema = z.strictObject({ attemptId: z.uuid() });

const ConsumeBodySchema = z.strictObject({
  connectionId: z.uuid(),
  stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sessionNonceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().trim().min(1),
});
const ConsumeResponseSchema = z.strictObject({
  connectionId: z.uuid(),
  attemptId: z.uuid(),
  redirectOrigin: z.string(),
});

const LeaseBodySchema = z.strictObject({
  operationId: z.string().trim().min(1),
  ttlSeconds: z.number().int().positive(),
});
const LeaseResponseSchema = z.strictObject({
  connectionId: z.uuid(),
  leaseId: z.uuid(),
  expiresAt: z.string(),
  expectedConnectionVersion: z.number().int(),
  currentTokenGeneration: z.number().int(),
});

const AdvanceBodySchema = z.strictObject({
  leaseId: z.uuid(),
  expectedConnectionVersion: z.number().int(),
  newGeneration: z.number().int().positive(),
  vaultReference: z.string().trim().min(1).max(500),
  requestId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(255),
});
const AdvanceResponseSchema = z.strictObject({
  connectionVersion: z.number().int(),
  tokenGeneration: z.number().int(),
  vaultReference: z.string(),
});

const ReleaseBodySchema = z.strictObject({ leaseId: z.uuid() });

// Fix round 1 (Critical): no `sessionNonce` field -- Office JavaScript
// cannot securely bind the browser to this OAuth attempt via a cookie it
// sets itself (host-only on the Office origin, never reaches the broker's
// callback origin, and can't be HttpOnly). App API now generates the
// session nonce itself (domain/mailbox-connections.ts's startConnection).
const StartBodySchema = z.strictObject({
  scope: MailboxScopeSchema,
  redirectOrigin: z.string().trim().min(1).max(2048),
  timezone: z.string().trim().min(1).max(100),
  localScanTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  requestId: z.string().trim().min(1),
});
const StartResponseSchema = z.strictObject({
  connection: MailboxConnectionV1Schema,
  attempt: MailboxOAuthAttemptV1Schema,
  /**
   * The broker's PUBLIC `/oauth/google/begin?ticket=...` URL, not the raw
   * Google URL directly -- the field name is unchanged (minimal client
   * churn); only the value's origin and purpose changed. The browser must
   * navigate here first so the broker's own origin can build the real
   * Google URL and set its session-nonce cookie before redirecting.
   */
  authorizationUrl: z.string().trim().min(1),
});

const ConnectionQuerySchema = z
  .object({
    profileId: z.uuid().optional(),
    businessId: z.uuid().optional(),
  })
  .refine((value) => (value.profileId === undefined) !== (value.businessId === undefined), {
    message: "Exactly one of profileId or businessId is required",
  });
const ConnectionResponseSchema = z.strictObject({
  connection: MailboxConnectionV1Schema.nullable(),
});

// Mirrors the exact body shape services/mailbox-broker/src/app-client.ts's
// completeConnection sends. Final-review Minor fix: `expectedConnectionVersion`
// was previously accepted here but never read by domain.completeConnection
// (attemptId's own one-time state machine is the real CAS guard) -- dropped
// end-to-end (contract, broker client, this schema) rather than wiring up
// unused enforcement, per the review's "choose the smaller correct change".
const CompleteBodySchema = z.strictObject({
  connectionId: z.uuid(),
  providerAccountId: z.string().trim().min(1).max(255),
  accountEmail: z.email().max(320),
  grantedScopes: z.array(z.string().trim().min(1).max(255)),
  initialHistoryId: z.string().trim().min(1),
  vaultReference: z.string().trim().min(1).max(500),
  tokenGeneration: z.number().int().positive(),
  requestId: z.string().trim().min(1),
});

const RevokeBodySchema = z.strictObject({
  operationId: z.string().trim().min(1),
  status: z.enum(["revoked", "revocation_pending"]),
});

export async function registerMailboxConnectionRoutes(
  app: FastifyInstance,
  options: MailboxConnectionsRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const brokerGuard = [
    serviceGuard(options.brokerServiceSubject ?? "mailbox-broker-app", ["mailbox:write"]),
  ];

  typedApp.post(
    "/internal/v1/mailbox/oauth/attempts/:attemptId/consume",
    {
      preHandler: brokerGuard,
      schema: {
        hide: true,
        params: AttemptIdParamsSchema,
        body: ConsumeBodySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: ConsumeResponseSchema, ...errors },
      },
    },
    async (request) => {
      const result = await options.mailboxConnectionsDomain.consumeOAuthState({
        attemptId: request.params.attemptId,
        connectionId: request.body.connectionId,
        stateDigest: request.body.stateDigest,
        sessionNonceDigest: request.body.sessionNonceDigest,
        requestId: request.body.requestId,
      });
      return result;
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/connections/:connectionId/token-operations/lease",
    {
      preHandler: brokerGuard,
      schema: {
        hide: true,
        params: ConnectionIdParamsSchema,
        body: LeaseBodySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: LeaseResponseSchema, ...errors },
      },
    },
    async (request) => {
      const result = await options.mailboxConnectionsDomain.acquireTokenOperationLease({
        connectionId: request.params.connectionId,
        operationId: request.body.operationId,
        ttlSeconds: request.body.ttlSeconds,
      });
      return result;
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/connections/:connectionId/token-operations/advance",
    {
      preHandler: brokerGuard,
      schema: {
        hide: true,
        params: ConnectionIdParamsSchema,
        body: AdvanceBodySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: AdvanceResponseSchema, ...errors },
      },
    },
    async (request) => {
      const result = await options.mailboxConnectionsDomain.advanceTokenGeneration({
        connectionId: request.params.connectionId,
        leaseId: request.body.leaseId,
        expectedConnectionVersion: request.body.expectedConnectionVersion,
        newGeneration: request.body.newGeneration,
        vaultReference: request.body.vaultReference,
        requestId: request.body.requestId,
        idempotencyKey: request.body.idempotencyKey,
      });
      return result;
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/connections/:connectionId/token-operations/release",
    {
      preHandler: brokerGuard,
      schema: {
        hide: true,
        params: ConnectionIdParamsSchema,
        body: ReleaseBodySchema,
        security: [{ serviceBearer: [] }],
        response: { 204: z.void(), ...errors },
      },
    },
    async (request, reply) => {
      await options.mailboxConnectionsDomain.releaseTokenOperationLease({
        connectionId: request.params.connectionId,
        leaseId: request.body.leaseId,
      });
      return reply.code(204).send();
    },
  );

  // ----------------------------------------------------------------
  // Customer-facing: start a Gmail connection attempt.
  // ----------------------------------------------------------------
  if (options.identityResolver) {
    const customerGuard = [tenantGuard, authenticatedUserGuard(options.identityResolver)];

    typedApp.post(
      "/api/v1/tenants/:tenantId/mailbox-connections/google/start",
      {
        preHandler: customerGuard,
        schema: {
          params: TenantIdParamsSchema,
          body: StartBodySchema,
          security: [{ tenantBearer: [] }],
          response: { 201: StartResponseSchema, ...errors },
        },
      },
      async (request, reply) => {
        const result = await options.mailboxConnectionsDomain.startConnection({
          actorUserId: actorUserId(request),
          tenantId: request.params.tenantId,
          scope: request.body.scope,
          redirectOrigin: request.body.redirectOrigin,
          timezone: request.body.timezone,
          localScanTime: request.body.localScanTime,
          requestId: request.body.requestId,
        });
        if (!options.mailboxBrokerPublicBaseUrl) {
          throw new Error("mailboxBrokerPublicBaseUrl is not configured");
        }
        // Fix round 2: only the broker's own opaque, short-lived begin
        // ticket travels here -- never the raw Google authorizationUrl or
        // the session nonce. The begin route builds the real Google URL
        // itself from trusted config.
        const beginUrl = new URL("/oauth/google/begin", options.mailboxBrokerPublicBaseUrl);
        beginUrl.searchParams.set("ticket", result.beginTicket);
        return reply.code(201).send({
          connection: result.connection,
          attempt: result.attempt,
          authorizationUrl: beginUrl.toString(),
        });
      },
    );

    typedApp.get(
      "/api/v1/tenants/:tenantId/mailbox-connections/google",
      {
        preHandler: customerGuard,
        schema: {
          params: TenantIdParamsSchema,
          querystring: ConnectionQuerySchema,
          security: [{ tenantBearer: [] }],
          response: { 200: ConnectionResponseSchema, ...errors },
        },
      },
      async (request) => {
        const scope =
          request.query.profileId !== undefined
            ? ({ kind: "personal" as const, profileId: request.query.profileId })
            : ({ kind: "business" as const, businessId: request.query.businessId as string });
        const connection = await options.mailboxConnectionsDomain.getConnection({
          actorUserId: actorUserId(request),
          tenantId: request.params.tenantId,
          scope,
        });
        return { connection };
      },
    );
  }

  // ----------------------------------------------------------------
  // Internal: broker-only completion callback and revocation recorder.
  // Closes the gap flagged by Task 2 Ruling 3 / Task 3 Ruling 4 --
  // services/mailbox-broker/src/app-client.ts already calls exactly these
  // two paths/bodies; no broker-side change needed.
  // ----------------------------------------------------------------
  typedApp.post(
    "/internal/v1/mailbox/oauth/attempts/:attemptId/complete",
    {
      preHandler: brokerGuard,
      schema: {
        hide: true,
        params: AttemptIdParamsSchema,
        body: CompleteBodySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: MailboxConnectionV1Schema, ...errors },
      },
    },
    async (request) => {
      const record = await options.mailboxConnectionsDomain.completeConnection({
        attemptId: request.params.attemptId,
        connectionId: request.body.connectionId,
        providerAccountId: request.body.providerAccountId,
        accountEmail: request.body.accountEmail,
        grantedScopes: request.body.grantedScopes,
        initialHistoryId: request.body.initialHistoryId,
        vaultReference: request.body.vaultReference,
        tokenGeneration: request.body.tokenGeneration,
        requestId: request.body.requestId,
      });
      return toPublicConnection(record);
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/connections/:connectionId/revoke",
    {
      preHandler: brokerGuard,
      schema: {
        hide: true,
        params: ConnectionIdParamsSchema,
        body: RevokeBodySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: MailboxConnectionV1Schema, ...errors },
      },
    },
    async (request) => {
      return options.mailboxConnectionsDomain.recordRevocation({
        connectionId: request.params.connectionId,
        operationId: request.body.operationId,
        status: request.body.status,
      });
    },
  );
}
