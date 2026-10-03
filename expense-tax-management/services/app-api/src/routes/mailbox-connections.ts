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
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ErrorResponseSchema } from "@expense-tax/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { serviceGuard } from "../plugins/auth.js";
import type { MailboxConnectionsDomain } from "../domain/mailbox-connections.js";

export interface MailboxConnectionsRouteOptions {
  readonly mailboxConnectionsDomain: MailboxConnectionsDomain;
  /** Default mirrors the plan's exact machine subject: "mailbox-broker-app". */
  readonly brokerServiceSubject?: string;
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
}
