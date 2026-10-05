/**
 * Task 8 — Tag CRUD and expense-tag association routes only.
 *
 * Tenant-level tag CRUD:
 *   GET    /api/v1/tenants/:tenantId/tags
 *   POST   /api/v1/tenants/:tenantId/tags
 *   PATCH  /api/v1/tenants/:tenantId/tags/:tagId
 *   DELETE /api/v1/tenants/:tenantId/tags/:tagId     (archive)
 *   POST   /api/v1/tenants/:tenantId/tags/:tagId/unarchive
 *   POST   /api/v1/tenants/:tenantId/tags/:tagId/merge
 *
 * Expense-tag association — personal scope:
 *   GET    /api/v1/tenants/:tenantId/personal-profiles/:profileId/expenses/:expenseId/tags
 *   PUT    /api/v1/tenants/:tenantId/personal-profiles/:profileId/expenses/:expenseId/tags/:tagId
 *   DELETE /api/v1/tenants/:tenantId/personal-profiles/:profileId/expenses/:expenseId/tags/:tagId
 *
 * Expense-tag association — business scope:
 *   GET    /api/v1/tenants/:tenantId/businesses/:businessId/expenses/:expenseId/tags
 *   PUT    /api/v1/tenants/:tenantId/businesses/:businessId/expenses/:expenseId/tags/:tagId
 *   DELETE /api/v1/tenants/:tenantId/businesses/:businessId/expenses/:expenseId/tags/:tagId
 *
 * Suggestion list/resolve and enrichment-runs live in routes/enrichment.ts.
 */

import {
  ErrorResponseSchema,
  TagSchema,
  TagListSchema,
  TagCreateRequestSchema,
  TagUpdateRequestSchema,
  TagArchiveRequestSchema,
  TagUnarchiveRequestSchema,
  TagMergeRequestSchema,
  ExpenseTagSchema,
  ExpenseTagListSchema,
  ExpenseTagRemoveRequestSchema,
  TenantIdParamsSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { TagDomain } from "../domain/tags.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface TagRouteOptions {
  readonly identityResolver: IdentityResolver;
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

// Param schemas
const TagIdParamsSchema = TenantIdParamsSchema.extend({ tagId: z.string().uuid() });
const PersonalExpenseParamsSchema = TenantIdParamsSchema.extend({
  profileId: z.string().uuid(),
  expenseId: z.string().uuid(),
});
const PersonalExpenseTagParamsSchema = PersonalExpenseParamsSchema.extend({ tagId: z.string().uuid() });
const BusinessExpenseParamsSchema = TenantIdParamsSchema.extend({
  businessId: z.string().uuid(),
  expenseId: z.string().uuid(),
});
const BusinessExpenseTagParamsSchema = BusinessExpenseParamsSchema.extend({ tagId: z.string().uuid() });

export async function registerTagRoutes(
  app: FastifyInstance,
  options: TagRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  // ----------------------------------------------------------------
  // Tenant-level tag CRUD
  // ----------------------------------------------------------------

  const tagCollection = "/api/v1/tenants/:tenantId/tags";
  const tagItem = `${tagCollection}/:tagId`;

  typedApp.get(
    tagCollection,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TenantIdParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: TagListSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.listTags({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
      }),
  );

  typedApp.post(
    tagCollection,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TenantIdParamsSchema,
        body: TagCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: TagSchema, ...standardErrors },
      },
    },
    async (request, reply) => {
      const tag = await options.tagDomain.createTag({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        request: request.body,
        requestId: request.id,
      });
      return reply.code(201).send(tag);
    },
  );

  typedApp.patch(
    tagItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TagIdParamsSchema,
        body: TagUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: TagSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.updateTag({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        tagId: request.params.tagId,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.delete(
    tagItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TagIdParamsSchema,
        body: TagArchiveRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: TagSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.archiveTag({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        tagId: request.params.tagId,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.post(
    `${tagItem}/unarchive`,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TagIdParamsSchema,
        body: TagUnarchiveRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: TagSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.unarchiveTag({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        tagId: request.params.tagId,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.post(
    `${tagItem}/merge`,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TagIdParamsSchema,
        body: TagMergeRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 204: z.null(), ...standardErrors },
      },
    },
    async (request, reply) => {
      await options.tagDomain.mergeTags({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        sourceTagId: request.body.sourceTagId,
        targetTagId: request.body.targetTagId,
        expectedSourceVersion: request.body.expectedSourceVersion,
        expectedTargetVersion: request.body.expectedTargetVersion,
        requestId: request.id,
      });
      return reply.code(204).send(null);
    },
  );

  // ----------------------------------------------------------------
  // Expense-tag associations — personal scope
  // ----------------------------------------------------------------

  const personalTagCollection = "/api/v1/tenants/:tenantId/personal-profiles/:profileId/expenses/:expenseId/tags";
  const personalTagItem = `${personalTagCollection}/:tagId`;

  typedApp.get(
    personalTagCollection,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalExpenseParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseTagListSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.listExpenseTags({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: request.params.profileId,
        businessId: null,
        expenseId: request.params.expenseId,
      }),
  );

  typedApp.put(
    personalTagItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalExpenseTagParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseTagSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.applyExpenseTag({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: request.params.profileId,
        businessId: null,
        expenseId: request.params.expenseId,
        tagId: request.params.tagId,
        requestId: request.id,
      }),
  );

  typedApp.delete(
    personalTagItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalExpenseTagParamsSchema,
        body: ExpenseTagRemoveRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 204: z.null(), ...standardErrors },
      },
    },
    async (request, reply) => {
      await options.tagDomain.removeExpenseTag({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: request.params.profileId,
        businessId: null,
        expenseId: request.params.expenseId,
        tagId: request.params.tagId,
        expectedVersion: request.body.expectedVersion,
        requestId: request.id,
      });
      return reply.code(204).send(null);
    },
  );

  // ----------------------------------------------------------------
  // Expense-tag associations — business scope
  // ----------------------------------------------------------------

  const businessTagCollection = "/api/v1/tenants/:tenantId/businesses/:businessId/expenses/:expenseId/tags";
  const businessTagItem = `${businessTagCollection}/:tagId`;

  typedApp.get(
    businessTagCollection,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessExpenseParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseTagListSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.listExpenseTags({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: null,
        businessId: request.params.businessId,
        expenseId: request.params.expenseId,
      }),
  );

  typedApp.put(
    businessTagItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessExpenseTagParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: ExpenseTagSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.tagDomain.applyExpenseTag({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: null,
        businessId: request.params.businessId,
        expenseId: request.params.expenseId,
        tagId: request.params.tagId,
        requestId: request.id,
      }),
  );

  typedApp.delete(
    businessTagItem,
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessExpenseTagParamsSchema,
        body: ExpenseTagRemoveRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 204: z.null(), ...standardErrors },
      },
    },
    async (request, reply) => {
      await options.tagDomain.removeExpenseTag({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: null,
        businessId: request.params.businessId,
        expenseId: request.params.expenseId,
        tagId: request.params.tagId,
        expectedVersion: request.body.expectedVersion,
        requestId: request.id,
      });
      return reply.code(204).send(null);
    },
  );
}
