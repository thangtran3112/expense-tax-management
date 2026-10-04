/**
 * Phase 3D-A Task 4 — broker's internal connection-revocation route.
 *
 * `POST /internal/v1/connections/:connectionId/revoke` -- revokes the
 * Google refresh token and destroys this connection's token-vault rows
 * (`MailboxProviderAdapter.revoke`), then tells App API the connection is
 * revoked (`appClient.recordRevocation`, the App-side route Task 4 also
 * adds). Guarded for the "app-api" caller only, scope "connections:revoke".
 *
 * Phase 3D-B Task 4 adds `POST /internal/v1/mailbox/scan-runs/:scanRunId/
 * discover` -- the one page-at-a-time entry point the workflow worker's
 * `discoverPage` client method calls (clients/mailbox-client.ts, Task 3).
 * Guarded for the "worker" caller, scope "mailbox:discover" (the exact
 * subject/scope pair 3D-A Task 5 already provisioned). The discovery
 * fields are optional on `ConnectionsRouteOptions`: omitting them (every
 * existing caller of this function, routes.test.ts included) simply
 * skips registering the route, so no existing test or call site needed
 * to change.
 */
import type { FastifyInstance } from "fastify";
import { MailboxMaterializationResultV1Schema } from "@expense-tax/contracts";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { materializeCandidate, type MaterializeCandidateDependencies } from "../ingestion.js";
import type { ServiceGuard } from "../plugins/auth.js";
import type {
  MailboxBrokerConnectionAppClient,
  MailboxBrokerDiscoveryAppClient,
  MailboxDiscoveryProviderAdapter,
  MailboxProviderAdapter,
} from "../contracts.js";

export interface ConnectionsRouteOptions {
  readonly providerAdapter: MailboxProviderAdapter;
  readonly appClient: MailboxBrokerConnectionAppClient;
  /** Guards the revoke route: caller "app-api", scope "connections:revoke". */
  readonly appApiRevokeGuard: ServiceGuard;
  /** Phase 3D-B Task 4 -- discovery route dependencies. Omit all three to skip registering the route entirely. */
  readonly discoveryProviderAdapter?: MailboxDiscoveryProviderAdapter;
  readonly discoveryAppClient?: MailboxBrokerDiscoveryAppClient;
  /** Guards the discover route: caller "worker", scope "mailbox:discover". */
  readonly workerDiscoverGuard?: ServiceGuard;
  /**
   * Phase 3D-C Task 5 -- materialize route dependencies. Omit both to
   * skip registering the route entirely (same "all-or-nothing" pattern as
   * the discover trio above; production wiring of a real
   * `MaterializeCandidateDependencies` -- a real Gmail client factory --
   * remains deferred/flagged in task-5-report.md, same class of gap Task
   * 2/3 already left for this exact route).
   */
  readonly materializeDependencies?: MaterializeCandidateDependencies;
  /** Guards the materialize route: caller "worker", scope "mailbox:materialize". */
  readonly workerMaterializeGuard?: ServiceGuard;
}

const ConnectionIdParamsSchema = z.strictObject({ connectionId: z.uuid() });
const RevokeBodySchema = z.strictObject({ operationId: z.string().trim().min(1) });
const ScanRunIdParamsSchema = z.strictObject({ scanRunId: z.uuid() });
const DiscoverResponseSchema = z.strictObject({
  scanRunId: z.uuid(),
  pageSequence: z.number().int(),
  candidateCount: z.number().int(),
  retryCount: z.number().int(),
});
const CandidateIdParamsSchema = z.strictObject({ candidateId: z.uuid() });
const MaterializeBodySchema = z.strictObject({ operationId: z.string().trim().min(1) });

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

  const { discoveryProviderAdapter, discoveryAppClient, workerDiscoverGuard } = options;
  if (discoveryProviderAdapter && discoveryAppClient && workerDiscoverGuard) {
    typedApp.post(
      "/internal/v1/mailbox/scan-runs/:scanRunId/discover",
      {
        preHandler: [workerDiscoverGuard],
        schema: { params: ScanRunIdParamsSchema, body: z.strictObject({}), response: { 200: DiscoverResponseSchema } },
      },
      async (request) => {
        // DiscoveryInput.connectionId is part of the generic contract
        // shape but unused by the Gmail implementation: the worker never
        // knows a connectionId (by design -- see clients/mailbox-
        // client.ts's discoverPage doc comment), so the broker resolves
        // it itself via loadScanBinding(scanRunId) inside discover().
        return discoveryProviderAdapter.discover({
          connectionId: "",
          scanRunId: request.params.scanRunId,
        });
      },
    );
  }

  const { materializeDependencies, workerMaterializeGuard } = options;
  if (materializeDependencies && workerMaterializeGuard) {
    typedApp.post(
      "/internal/v1/mailbox/candidates/:candidateId/materialize",
      {
        preHandler: [workerMaterializeGuard],
        schema: {
          params: CandidateIdParamsSchema,
          body: MaterializeBodySchema,
          response: { 200: MailboxMaterializationResultV1Schema },
        },
      },
      async (request) => {
        // MaterializeInput.connectionId is part of the generic contract
        // shape but unused -- same ruling as the discover route above:
        // the broker resolves it itself via loadCandidateBinding, since
        // the worker never knows it either (opaque by design).
        return materializeCandidate(materializeDependencies, {
          connectionId: "",
          candidateId: request.params.candidateId,
          operationId: request.body.operationId,
        });
      },
    );
  }
}
