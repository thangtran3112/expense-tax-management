/**
 * Phase 3D-B Task 5 — customer-facing candidate review-queue routes.
 *
 * Both routes are tenant-authenticated (same `tenantGuard` +
 * `authenticatedUserGuard` convention as every other Office-facing
 * mailbox route in routes/mailbox-connections.ts). Authorization beyond
 * the bearer token (owner/reviewer-grant/scope-membership,
 * target-scope membership for `ingest`) is domain/mailbox-candidates.ts's
 * job, not this file's.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ErrorResponseSchema,
  MailboxCandidateClassificationSchema,
  MailboxCandidateV1Schema,
  MailboxScopeSchema,
} from "@expense-tax/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";
import { DomainError } from "../errors.js";
import type { MailboxCandidatesDomain } from "../domain/mailbox-candidates.js";

export interface MailboxCandidatesRouteOptions {
  readonly mailboxCandidatesDomain: MailboxCandidatesDomain;
  readonly identityResolver: IdentityResolver;
}

function actorUserId(request: FastifyRequest): string {
  if (!request.authenticatedUser) throw DomainError.unauthenticated();
  return request.authenticatedUser.id;
}

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
};

const ConnectionParamsSchema = z.strictObject({ tenantId: z.uuid(), connectionId: z.uuid() });
const CandidateParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  connectionId: z.uuid(),
  candidateId: z.uuid(),
});

const ListQuerySchema = z.object({
  classification: MailboxCandidateClassificationSchema.optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
const ListResponseSchema = z.strictObject({
  items: z.array(MailboxCandidateV1Schema),
  nextCursor: z.string().nullable(),
});

const ResolveBodySchema = z.strictObject({
  action: z.enum(["ingest", "skip", "not_receipt", "retry"]),
  scope: MailboxScopeSchema.optional(),
  expectedCandidateVersion: z.number().int(),
  requestId: z.string().trim().min(1),
});

export async function registerMailboxCandidateRoutes(
  app: FastifyInstance,
  options: MailboxCandidatesRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const customerGuard = [tenantGuard, authenticatedUserGuard(options.identityResolver)];

  typedApp.get(
    "/api/v1/tenants/:tenantId/mailbox-connections/:connectionId/candidates",
    {
      preHandler: customerGuard,
      schema: {
        params: ConnectionParamsSchema,
        querystring: ListQuerySchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ListResponseSchema, ...errors },
      },
    },
    async (request) => {
      const result = await options.mailboxCandidatesDomain.listCandidates({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        connectionId: request.params.connectionId,
        ...(request.query.classification === undefined ? {} : { classification: request.query.classification }),
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
      });
      return { items: [...result.items], nextCursor: result.nextCursor };
    },
  );

  typedApp.post(
    "/api/v1/tenants/:tenantId/mailbox-connections/:connectionId/candidates/:candidateId/resolve",
    {
      preHandler: customerGuard,
      schema: {
        params: CandidateParamsSchema,
        body: ResolveBodySchema,
        security: [{ tenantBearer: [] }],
        response: { 200: MailboxCandidateV1Schema, ...errors },
      },
    },
    async (request) => {
      return options.mailboxCandidatesDomain.resolveCandidate({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        connectionId: request.params.connectionId,
        candidateId: request.params.candidateId,
        action: request.body.action,
        ...(request.body.scope === undefined ? {} : { scope: request.body.scope }),
        expectedCandidateVersion: request.body.expectedCandidateVersion,
        requestId: request.body.requestId,
      });
    },
  );
}
