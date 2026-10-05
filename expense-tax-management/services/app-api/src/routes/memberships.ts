import {
  BusinessMembershipCreateRequestSchema,
  BusinessMembershipListSchema,
  BusinessMembershipParamsSchema,
  BusinessMembershipSchema,
  BusinessMembershipScopeParamsSchema,
  BusinessMembershipUpdateRequestSchema,
  ErrorResponseSchema,
  PersonalMembershipCreateRequestSchema,
  PersonalMembershipListSchema,
  PersonalMembershipParamsSchema,
  PersonalMembershipSchema,
  PersonalMembershipScopeParamsSchema,
  PersonalMembershipUpdateRequestSchema,
  TenantIdParamsSchema,
  TenantInvitationAcceptRequestSchema,
  TenantInvitationCreatedSchema,
  TenantInvitationCreateRequestSchema,
  TenantInvitationSchema,
  TenantMembershipListSchema,
  TenantMembershipParamsSchema,
  TenantMembershipSchema,
  TenantMembershipUpdateRequestSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { IdentityResolver } from "../domain/authenticated-user.js";
import type { MembershipDomain } from "../domain/memberships.js";
import { DomainError } from "../errors.js";
import { authenticatedUserGuard, tenantGuard } from "../plugins/auth.js";

export interface MembershipRouteOptions {
  readonly identityResolver: IdentityResolver;
  readonly membershipDomain: MembershipDomain;
}

function actorUserId(request: FastifyRequest): string {
  if (!request.authenticatedUser) throw DomainError.unauthenticated();
  return request.authenticatedUser.id;
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
  500: ErrorResponseSchema,
};

/**
 * Phase 3D-A Task 4, fix round 3 (Important) -- the minimal read the
 * Office mailbox scope-picker needs: the caller's own Personal profile,
 * if they have one. `profile: null` is a normal, non-error response (the
 * caller has no Personal-profile access in this tenant), not a 404.
 */
const OwnPersonalProfileResponseSchema = z.strictObject({
  profile: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
});

export async function registerMembershipRoutes(
  app: FastifyInstance,
  options: MembershipRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    "/api/v1/tenants/:tenantId/invitations",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TenantIdParamsSchema,
        body: TenantInvitationCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: TenantInvitationCreatedSchema, ...standardErrors },
      },
    },
    async (request, reply) => {
      const created = await options.membershipDomain.createInvitation({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        request: request.body,
        requestId: request.id,
      });
      return reply.code(201).send(created);
    },
  );

  typedApp.post(
    "/api/v1/invitations/accept",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        body: TenantInvitationAcceptRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: TenantInvitationSchema, ...standardErrors },
      },
    },
    async (request) => {
      const result = await options.membershipDomain.acceptInvitation({
        actorUserId: actorUserId(request),
        request: request.body,
        requestId: request.id,
      });
      return result.body;
    },
  );

  typedApp.get(
    "/api/v1/tenants/:tenantId/memberships",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TenantIdParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: TenantMembershipListSchema, ...standardErrors },
      },
    },
    async (request) => ({
      items: [
        ...(await options.membershipDomain.listTenantMemberships(
          actorUserId(request),
          request.params.tenantId,
          request.id,
        )),
      ],
    }),
  );

  typedApp.patch(
    "/api/v1/tenants/:tenantId/memberships/:userId",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TenantMembershipParamsSchema,
        body: TenantMembershipUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: TenantMembershipSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.membershipDomain.updateTenantMembership({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        targetUserId: request.params.userId,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.get(
    "/api/v1/tenants/:tenantId/personal-profiles/mine",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: TenantIdParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: OwnPersonalProfileResponseSchema, ...standardErrors },
      },
    },
    async (request) => ({
      profile: await options.membershipDomain.getOwnPersonalProfile({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
      }),
    }),
  );

  typedApp.get(
    "/api/v1/tenants/:tenantId/personal-profiles/:profileId/memberships",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalMembershipScopeParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: PersonalMembershipListSchema, ...standardErrors },
      },
    },
    async (request) => ({
      items: [
        ...(await options.membershipDomain.listPersonalMemberships({
          actorUserId: actorUserId(request),
          tenantId: request.params.tenantId,
          profileId: request.params.profileId,
          requestId: request.id,
        })),
      ],
    }),
  );

  typedApp.post(
    "/api/v1/tenants/:tenantId/personal-profiles/:profileId/memberships",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalMembershipScopeParamsSchema,
        body: PersonalMembershipCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: PersonalMembershipSchema, ...standardErrors },
      },
    },
    async (request, reply) => {
      const created = await options.membershipDomain.createPersonalMembership({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: request.params.profileId,
        request: request.body,
        requestId: request.id,
      });
      return reply.code(201).send(created);
    },
  );

  typedApp.patch(
    "/api/v1/tenants/:tenantId/personal-profiles/:profileId/memberships/:userId",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: PersonalMembershipParamsSchema,
        body: PersonalMembershipUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: PersonalMembershipSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.membershipDomain.updatePersonalMembership({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        profileId: request.params.profileId,
        targetUserId: request.params.userId,
        request: request.body,
        requestId: request.id,
      }),
  );

  typedApp.get(
    "/api/v1/tenants/:tenantId/businesses/:businessId/memberships",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessMembershipScopeParamsSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: BusinessMembershipListSchema, ...standardErrors },
      },
    },
    async (request) => ({
      items: [
        ...(await options.membershipDomain.listBusinessMemberships({
          actorUserId: actorUserId(request),
          tenantId: request.params.tenantId,
          businessId: request.params.businessId,
          requestId: request.id,
        })),
      ],
    }),
  );

  typedApp.post(
    "/api/v1/tenants/:tenantId/businesses/:businessId/memberships",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessMembershipScopeParamsSchema,
        body: BusinessMembershipCreateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 201: BusinessMembershipSchema, ...standardErrors },
      },
    },
    async (request, reply) => {
      const created = await options.membershipDomain.createBusinessMembership({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        request: request.body,
        requestId: request.id,
      });
      return reply.code(201).send(created);
    },
  );

  typedApp.patch(
    "/api/v1/tenants/:tenantId/businesses/:businessId/memberships/:userId",
    {
      preHandler: authentication(options.identityResolver),
      schema: {
        params: BusinessMembershipParamsSchema,
        body: BusinessMembershipUpdateRequestSchema,
        security: [{ tenantBearer: [] }],
        response: { 200: BusinessMembershipSchema, ...standardErrors },
      },
    },
    async (request) =>
      options.membershipDomain.updateBusinessMembership({
        actorUserId: actorUserId(request),
        tenantId: request.params.tenantId,
        businessId: request.params.businessId,
        targetUserId: request.params.userId,
        request: request.body,
        requestId: request.id,
      }),
  );
}
