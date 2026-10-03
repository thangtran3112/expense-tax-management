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

const StartBodySchema = z.strictObject({
  scope: MailboxScopeSchema,
  sessionNonce: z.string().trim().min(16).max(512),
  redirectOrigin: z.string().trim().min(1).max(2048),
  timezone: z.string().trim().min(1).max(100),
  localScanTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  requestId: z.string().trim().min(1),
});
const StartResponseSchema = z.strictObject({
  connection: MailboxConnectionV1Schema,
  attempt: MailboxOAuthAttemptV1Schema,
  authorizationUrl: z.string().trim().min(1),
});

// Mirrors the exact body shape services/mailbox-broker/src/app-client.ts's
// completeConnection sends -- expectedConnectionVersion is accepted (so the
// broker's already-built, Task 3-tested request shape needs no change) but
// not yet enforced as a CAS precondition by domain.completeConnection.
const CompleteBodySchema = z.strictObject({
  connectionId: z.uuid(),
  expectedConnectionVersion: z.number().int(),
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
          sessionNonce: request.body.sessionNonce,
          redirectOrigin: request.body.redirectOrigin,
          timezone: request.body.timezone,
          localScanTime: request.body.localScanTime,
          requestId: request.body.requestId,
        });
        return reply.code(201).send(result);
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
