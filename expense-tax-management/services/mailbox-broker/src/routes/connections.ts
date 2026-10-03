/**
 * Phase 3D-A Task 4 — broker's internal connection-revocation route.
 *
 * `POST /internal/v1/connections/:connectionId/revoke` -- revokes the
 * Google refresh token and destroys this connection's token-vault rows
 * (`MailboxProviderAdapter.revoke`), then tells App API the connection is
 * revoked (`appClient.recordRevocation`, the App-side route Task 4 also
 * adds). Guarded for the "app-api" caller only, scope "connections:revoke".
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { ServiceGuard } from "../plugins/auth.js";
import type { MailboxBrokerConnectionAppClient, MailboxProviderAdapter } from "../contracts.js";

export interface ConnectionsRouteOptions {
  readonly providerAdapter: MailboxProviderAdapter;
  readonly appClient: MailboxBrokerConnectionAppClient;
  /** Guards the revoke route: caller "app-api", scope "connections:revoke". */
  readonly appApiRevokeGuard: ServiceGuard;
}

const ConnectionIdParamsSchema = z.strictObject({ connectionId: z.uuid() });
const RevokeBodySchema = z.strictObject({ operationId: z.string().trim().min(1) });

export async function registerConnectionRoutes(
  app: FastifyInstance,
  options: ConnectionsRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.post(
    "/internal/v1/connections/:connectionId/revoke",
    {
      preHandler: [options.appApiRevokeGuard],
      schema: { params: ConnectionIdParamsSchema, body: RevokeBodySchema },
    },
    async (request) => {
      await options.providerAdapter.revoke({
        connectionId: request.params.connectionId,
        operationId: request.body.operationId,
      });
      return options.appClient.recordRevocation({
        connectionId: request.params.connectionId,
        operationId: request.body.operationId,
        status: "revoked",
      });
    },
  );
}
