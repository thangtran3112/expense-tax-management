import {
  DispatchPendingJobsResponseSchema,
  ErrorResponseSchema,
  FOUNDATION_ECHO_WORKFLOW_TYPE,
  JobResultSubmitRequestV1Schema,
  JobStatusUpdateRequestV1Schema,
  ProcessingJobParamsSchema,
  ProcessingJobSchema,
} from "@expense-tax/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { EnrichmentJobsDomain } from "../domain/enrichment-jobs.js";
import { EnrichmentResultSubmitRequestSchema } from "../domain/enrichment-jobs.js";
import type { ProcessingJobsDomain } from "../domain/processing-jobs.js";
import type { DeduplicationDomain } from "../domain/deduplication.js";
import { DomainError } from "../errors.js";
import { serviceGuard } from "../plugins/auth.js";
import { registerDeduplicationRoutes } from "./deduplication.js";

export interface JobRouteOptions {
  readonly processingJobsDomain: ProcessingJobsDomain;
  /** Required: enrichment routes are always registered. Production misconfiguration
   *  is prevented at app startup rather than silently omitting routes. */
  readonly enrichmentJobsDomain: EnrichmentJobsDomain;
  readonly deduplicationDomain?: DeduplicationDomain;
  readonly workerServiceSubject?: string;
  /** Scope required on the enrichment-input route. */
  readonly enrichmentInputScope?: string;
  /** Scope required on the enrichment-result route. */
  readonly enrichmentResultScope?: string;
}

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  412: ErrorResponseSchema,
  500: ErrorResponseSchema,
};

const FoundationEchoRequestSchema = z.strictObject({
  tenantId: z.uuid(),
  personalProfileId: z.uuid().optional(),
  businessId: z.uuid().optional(),
});

const MailboxMaterializeInputResponseSchema = z.strictObject({
  candidateId: z.uuid(),
});

function actorServicePrincipal(request: FastifyRequest): string {
  const clientId = request.authPrincipal?.clientId;
  if (!clientId) throw DomainError.forbidden();
  return clientId;
}

export async function registerJobRoutes(
  app: FastifyInstance,
  options: JobRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const adminGuard = [serviceGuard("platform-admin", ["jobs:manage"])];
  const workerGuard = [
    serviceGuard(options.workerServiceSubject ?? "ai-worker", ["jobs:write"]),
  ];

  typedApp.post(
    "/internal/v1/jobs/foundation-echo",
    {
      preHandler: adminGuard,
      schema: {
        body: FoundationEchoRequestSchema,
        security: [{ serviceBearer: [] }],
        response: { 201: ProcessingJobSchema, ...errors },
      },
    },
    async (request, reply) => {
      const scope =
        request.body.personalProfileId !== undefined
          ? { personalProfileId: request.body.personalProfileId }
          : request.body.businessId !== undefined
            ? { businessId: request.body.businessId }
            : undefined;
      if (!scope) throw DomainError.validation();

      return reply.code(201).send(
        await options.processingJobsDomain.createJob({
          tenantId: request.body.tenantId,
          scope,
          workflowType: FOUNDATION_ECHO_WORKFLOW_TYPE,
          allowedResultSchemaVersion: "foundation-echo-v1",
          actorServicePrincipal: actorServicePrincipal(request),
          requestId: request.id,
        }),
      );
    },
  );

  typedApp.post(
    "/internal/v1/jobs/dispatch",
    {
      preHandler: adminGuard,
      schema: {
        security: [{ serviceBearer: [] }],
        response: { 200: DispatchPendingJobsResponseSchema, ...errors },
      },
    },
    async () => options.processingJobsDomain.dispatchPendingJobs({}),
  );

  typedApp.get(
    "/internal/v1/jobs/:jobId",
    {
      preHandler: adminGuard,
      schema: {
        params: ProcessingJobParamsSchema,
        security: [{ serviceBearer: [] }],
        response: { 200: ProcessingJobSchema, ...errors },
      },
    },
    async (request) => options.processingJobsDomain.getJob(request.params.jobId),
  );

  typedApp.post(
    "/internal/v1/jobs/:jobId/status",
    {
      preHandler: workerGuard,
      schema: {
        params: ProcessingJobParamsSchema,
        body: JobStatusUpdateRequestV1Schema,
        security: [{ serviceBearer: [] }],
        response: { 200: ProcessingJobSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await options.processingJobsDomain.recordStatusUpdate({
        jobId: request.params.jobId,
        request: request.body,
        actorServicePrincipal: actorServicePrincipal(request),
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  typedApp.post(
    "/internal/v1/jobs/:jobId/result",
    {
      preHandler: workerGuard,
      schema: {
        params: ProcessingJobParamsSchema,
        body: JobResultSubmitRequestV1Schema,
        security: [{ serviceBearer: [] }],
        response: { 200: ProcessingJobSchema, ...errors },
      },
    },
    async (request, reply) => {
      const result = await options.processingJobsDomain.submitResult({
        jobId: request.params.jobId,
        request: request.body,
        actorServicePrincipal: actorServicePrincipal(request),
        requestId: request.id,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  /**
   * Phase 3D-C Task 5 gap closure -- read-only candidateId resolver for
   * MailboxMaterializeWorkflow's combined activity. Deliberately NOT a
   * new ProcessingJobsDomain method: reuses the existing `getJob` (already
   * exposed, admin-guarded, at GET /internal/v1/jobs/:jobId) under the
   * ordinary worker guard instead, same "small, local addition over a new
   * cross-cutting domain method" choice as every other single-purpose
   * job-input route here (ocr-input, enrichment-input). Never mutates the
   * job -- safe for Temporal to retry this activity step any number of
   * times without a version-conflict risk.
   */
  typedApp.get(
    "/internal/v1/jobs/:jobId/materialize-input",
    {
      preHandler: workerGuard,
      schema: {
        params: ProcessingJobParamsSchema,
        security: [{ serviceBearer: [] }],
        response: { 200: MailboxMaterializeInputResponseSchema, ...errors },
      },
    },
    async (request) => {
      const job = await options.processingJobsDomain.getJob(request.params.jobId);
      const candidateId = (job.inputParams as Record<string, unknown> | null)?.["mailboxCandidateId"];
      if (typeof candidateId !== "string") throw DomainError.validation();
      return { candidateId };
    },
  );

  // ---- enrichment input/result routes --------------------------------
  // Require exact configured worker M2M subject and route-specific scopes.
  // Independent guards per route: input scope != result scope.
  // enrichmentJobsDomain is required in JobRouteOptions; routes always registered.
  {
    const enrichmentSubject = options.workerServiceSubject ?? "ai-worker-app-machine";
    const inputScope = options.enrichmentInputScope ?? "jobs:enrichment-input";
    const resultScope = options.enrichmentResultScope ?? "jobs:enrichment-result";

    const enrichmentInputGuard = [
      serviceGuard(enrichmentSubject, [inputScope]),
    ];
    const enrichmentResultGuard = [
      serviceGuard(enrichmentSubject, [resultScope]),
    ];

    /**
     * Enrichment input response schema — strict typed envelope.
     * Uses z.union with distinct object shapes (no cross-field refinements)
     * so Fastify/ZodTypeProvider can register the route without crashing.
     *
     * eligibleTaxSnapshot uses the exact field structure of EligibleTaxSnapshotSchema
     * without the top-level .refine() (which would crash registration). Domain returns
     * values already validated against the full canonical schema.
     * history fields mirror EnrichmentHistorySchema structure, same approach.
     */
    const EligibleTaxSnapshotTransportSchema = z.strictObject({
      businessTaxProfileId: z.string().uuid(),
      businessTaxProfileVersion: z.number().int().positive(),
      taxonomyVersionId: z.string().uuid(),
      taxYear: z.number().int().min(2000).max(2100),
      activeTaxCategoryIds: z.array(z.string().uuid()).max(100),
    });
    const CandidateTagKeyTransport = z.strictObject({
      key: z.string().min(1).max(100),
      count: z.number().int().positive(),
    });
    const CandidateIdTransport = z.strictObject({
      id: z.string().uuid(),
      count: z.number().int().positive(),
    });
    const EnrichmentHistoryTransport = z.strictObject({
      exampleCount: z.number().int().min(0).max(50),
      candidateTagKeys: z.array(CandidateTagKeyTransport).max(20),
      candidateSpendingCategoryIds: z.array(CandidateIdTransport).max(10),
      candidateTaxCategoryIds: z.array(CandidateIdTransport).max(10),
    });
    const EnrichmentInputResponseSchema = z.union([
      z.strictObject({
        outcome: z.literal("evaluate"),
        input: z.strictObject({
          schemaVersion: z.literal(1),
          jobId: z.string().uuid(),
          expenseId: z.string().uuid(),
          expenseVersion: z.number().int().positive(),
          normalizedMerchant: z.string().min(1).max(100).nullable(),
          incurredOn: z.string(),
          spendingCategoryId: z.string().uuid().nullable(),
          rulesVersion: z.number().int().positive(),
          eligibleTagKeys: z.array(z.string().min(1).max(100)).max(100),
          eligibleSpendingCategoryIds: z.array(z.string().uuid()).max(100),
          eligibleTaxSnapshot: EligibleTaxSnapshotTransportSchema.nullable(),
          history: EnrichmentHistoryTransport,
        }),
      }),
      z.strictObject({ outcome: z.literal("stale") }),
      z.strictObject({ outcome: z.literal("skipped") }),
    ]);

    typedApp.get(
      "/internal/v1/jobs/:jobId/enrichment-input",
      {
        preHandler: enrichmentInputGuard,
        schema: {
          params: ProcessingJobParamsSchema,
          security: [{ serviceBearer: [] }],
          response: { 200: EnrichmentInputResponseSchema, ...errors },
        },
      },
      async (request) => {
        const clientId = request.authPrincipal?.clientId ?? request.authPrincipal?.subject;
        if (!clientId) throw DomainError.forbidden();
        return options.enrichmentJobsDomain.getEnrichmentInput({
          jobId: request.params.jobId,
          actorServicePrincipal: clientId,
          requestId: request.id,
        });
      },
    );

    typedApp.post(
      "/internal/v1/jobs/:jobId/enrichment-result",
      {
        preHandler: enrichmentResultGuard,
        schema: {
          params: ProcessingJobParamsSchema,
          body: EnrichmentResultSubmitRequestSchema,
          security: [{ serviceBearer: [] }],
          response: { 200: ProcessingJobSchema, ...errors },
        },
      },
      async (request, reply) => {
        const clientId = request.authPrincipal?.clientId ?? request.authPrincipal?.subject;
        if (!clientId) throw DomainError.forbidden();
        const result = await options.enrichmentJobsDomain.submitEnrichmentResult({
          jobId: request.params.jobId,
          idempotencyKey: request.body.idempotencyKey,
          expectedJobVersion: request.body.expectedJobVersion,
          result: request.body.result,
          actorServicePrincipal: clientId,
          requestId: request.id,
        });
        return reply.code(result.statusCode).send(result.body);
      },
    );
  }

  if (options.deduplicationDomain) {
    await registerDeduplicationRoutes(app, {
      deduplicationDomain: options.deduplicationDomain,
      ...(options.workerServiceSubject
        ? { workerServiceSubject: options.workerServiceSubject }
        : {}),
    });
  }
}
