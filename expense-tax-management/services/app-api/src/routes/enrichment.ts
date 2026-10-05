/**
 * Task 8 — Enrichment suggestion and rerun routes.
 *
 * Suggestion list and resolution — personal scope:
 *   GET  /api/v1/tenants/:tenantId/personal-profiles/:profileId/expenses/:expenseId/suggestions
 *   POST /api/v1/tenants/:tenantId/personal-profiles/:profileId/expenses/:expenseId/suggestions/:suggestionId/resolve
 *   POST /api/v1/tenants/:tenantId/personal-profiles/:profileId/expenses/:expenseId/enrichment-runs
 *
 * Suggestion list and resolution — business scope:
 *   GET  /api/v1/tenants/:tenantId/businesses/:businessId/expenses/:expenseId/suggestions
 *   POST /api/v1/tenants/:tenantId/businesses/:businessId/expenses/:expenseId/suggestions/:suggestionId/resolve
 *   POST /api/v1/tenants/:tenantId/businesses/:businessId/expenses/:expenseId/enrichment-runs
 *
 * Tag CRUD and expense-tag association routes live in routes/tags.ts.
 */

import {
  ErrorResponseSchema,
  EnrichmentSuggestionListSchema,
  SuggestionResolveRequestSchema,
  SuggestionResolveResponseSchema,
  SuggestionRerunRequestSchema,
  TenantIdParamsSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { TagDomain } from "../domain/tags.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface EnrichmentRouteOptions {
  readonly identityResolver: IdentityResolver;
  /** The TagDomain exposes listSuggestions, resolveSuggestion, rerunEnrichment. */
  readonly tagDomain: TagDomain;
}

const authentication = (identityResolver: IdentityResolver) => [
  tenantGuard,
  authenticatedUserGuard(identityResolver),
];

const standardErrors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  412: ErrorResponseSchema,
  500: ErrorResponseSchema,
};

function actorUserId(request: FastifyRequest): string {
  if (!request.authenticatedUser) throw DomainError.unauthenticated();
  return request.authenticatedUser.id;
}

// Scope param schemas — kept local so enrichment.ts is self-contained.
const PersonalExpenseParamsSchema = TenantIdParamsSchema.extend({
  profileId: z.string().uuid(),
  expenseId: z.string().uuid(),
});
const PersonalExpenseSuggestionParamsSchema = PersonalExpenseParamsSchema.extend({
  suggestionId: z.string().uuid(),
});
const BusinessExpenseParamsSchema = TenantIdParamsSchema.extend({
  businessId: z.string().uuid(),
  expenseId: z.string().uuid(),
});
const BusinessExpenseSuggestionParamsSchema = BusinessExpenseParamsSchema.extend({
  suggestionId: z.string().uuid(),
});

/** Helper: cast validated resolve body to the domain input type. */
type ResolveBody = {
  action: "accepted" | "rejected";
  expectedSuggestionVersion: number;
  expectedExpenseVersion: number;
  idempotencyKey: string;
  taxAcceptance?: { businessTaxProfileId: string; deductiblePercent: string };
};

export async function registerEnrichmentRoutes(
  app: FastifyInstance,
  options: EnrichmentRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // ----------------------------------------------------------------
  // Personal scope
  // ----------------------------------------------------------------

  const personalBase = "/api/v1/tenants/:tenantId/personal-profiles/:profileId/expenses/:expenseId";
  const personalSuggestions = `${personalBase}/suggestions`;
  const personalSuggestionResolve = `${personalSuggestions}/:suggestionId/resolve`;
  const personalEnrichmentRuns = `${personalBase}/enrichment-runs`;

  typedApp.get(
    personalSuggestions,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalExpenseParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: EnrichmentSuggestionListSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.listSuggestions({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: request.params.profileId,
        businessId: null,
        expenseId: request.params.expenseId,
      }),
  );

  typedApp.post(
    personalSuggestionResolve,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalExpenseSuggestionParamsSchema,
        body: SuggestionResolveRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: SuggestionResolveResponseSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.resolveSuggestion({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: request.params.profileId,
        businessId: null,
        expenseId: request.params.expenseId,
        suggestionId: request.params.suggestionId,
        request: request.body as ResolveBody,
        requestId: request.id,
      }),
  );

  typedApp.post(
    personalEnrichmentRuns,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalExpenseParamsSchema,
        body: SuggestionRerunRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 204: z.null(), ...standardErrors },
      },
    },
    async (request, reply) => {
      await options.tagDomain.rerunEnrichment({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: request.params.profileId,
        businessId: null,
        expenseId: request.params.expenseId,
        kinds: request.body.kinds,
        requestId: request.id,
      });
      return reply.code(204).send(null);
    },
  );

  // ----------------------------------------------------------------
  // Business scope
  // ----------------------------------------------------------------

  const businessBase = "/api/v1/tenants/:tenantId/businesses/:businessId/expenses/:expenseId";
  const businessSuggestions = `${businessBase}/suggestions`;
  const businessSuggestionResolve = `${businessSuggestions}/:suggestionId/resolve`;
  const businessEnrichmentRuns = `${businessBase}/enrichment-runs`;

  typedApp.get(
    businessSuggestions,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessExpenseParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: EnrichmentSuggestionListSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.listSuggestions({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: null,
        businessId: request.params.businessId,
        expenseId: request.params.expenseId,
      }),
  );

  typedApp.post(
    businessSuggestionResolve,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessExpenseSuggestionParamsSchema,
        body: SuggestionResolveRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: SuggestionResolveResponseSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.resolveSuggestion({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: null,
        businessId: request.params.businessId,
        expenseId: request.params.expenseId,
        suggestionId: request.params.suggestionId,
        request: request.body as ResolveBody,
        requestId: request.id,
      }),
  );

  typedApp.post(
    businessEnrichmentRuns,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessExpenseParamsSchema,
        body: SuggestionRerunRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 204: z.null(), ...standardErrors },
      },
    },
    async (request, reply) => {
      await options.tagDomain.rerunEnrichment({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: null,
        businessId: request.params.businessId,
        expenseId: request.params.expenseId,
        kinds: request.body.kinds,
        requestId: request.id,
      });
      return reply.code(204).send(null);
    },
  );
}
