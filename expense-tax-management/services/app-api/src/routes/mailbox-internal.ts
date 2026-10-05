/**
 * Phase 3D-B Task 2 — internal broker-facing mailbox discovery routes.
 *
 * Exactly the two endpoints the task-2 brief lists: the broker's scan
 * binding read and the fenced candidate-page callback. Both are guarded
 * by the broker's own service principal (subject "mailbox-broker-app",
 * scope "mailbox:write") -- same convention as
 * routes/mailbox-connections.ts's internal routes.
 *
 * Phase 3D-B Task 3 (beyond the task-3 brief's literal file list --
 * ruling, see task-3-report.md) adds two worker-facing routes, both
 * guarded by the worker's own service principal (subject
 * "workflow-worker-mailbox", scope "mailbox:discover" -- the exact
 * subject/scope pair 3D-A Task 5 already provisioned for this worker
 * identity, never the broker's):
 * - scheduled-scans: a native Temporal Schedule's action args are fixed
 *   at creation time, so the daily-schedule's trigger workflow cannot
 *   carry a real `scanRunId` (App API mints that only when the schedule
 *   fires). This is the one App-reachable entry point that lets the
 *   trigger workflow's own activity mint it.
 * - finalize (Task 3 fix round 1): the terminal callback
 *   `MailboxScanWorkflow` calls on success, non-retryable failure, and
 *   cancellation -- marks the scan run completed/failed and releases the
 *   connection's scan lease, only if this run still holds it.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AttachmentManifestV1Schema,
  ErrorResponseSchema,
  JobResultSubmitRequestV1Schema,
  JobStatusUpdateRequestV1Schema,
  MailboxCandidateClassificationSchema,
  ProcessingJobParamsSchema,
  ProcessingJobSchema,
} from "@expense-tax/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { MailboxScansDomain } from "../domain/mailbox-scans.js";
import type { ProcessingJobsDomain } from "../domain/processing-jobs.js";
import { DomainError } from "../errors.js";
import { serviceGuard } from "../plugins/auth.js";

export interface MailboxInternalRouteOptions {
  readonly mailboxScansDomain: MailboxScansDomain;
  /**
   * Phase 3D-C Task 5 fix round 1 (review Important #1) -- the worker's
   * materialize-input/status/result callbacks below need the SAME
   * generic job domain every other job type's routes (routes/jobs.ts)
   * already uses; no mailbox-specific domain logic, only a mailbox-
   * scoped identity guard in front of it.
   */
  readonly processingJobsDomain: ProcessingJobsDomain;
  /** Default mirrors the plan's exact machine subject: "mailbox-broker-app". */
  readonly brokerServiceSubject?: string;
  /** Default mirrors 3D-A Task 5's exact worker machine subject: "workflow-worker-mailbox". */
  readonly workerServiceSubject?: string;
}

function actorServicePrincipal(request: FastifyRequest): string {
  const clientId = request.authPrincipal?.clientId;
  if (!clientId) throw DomainError.forbidden();
  return clientId;
}

const errors = { 401: ErrorResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema };

const ScanRunIdParamsSchema = z.strictObject({ scanRunId: z.uuid() });
const CandidateIdParamsSchema = z.strictObject({ candidateId: z.uuid() });

const CandidateBrokerBindingResponseSchema = z.strictObject({
  candidateId: z.uuid(),
  connectionId: z.uuid(),
  expectedCandidateVersion: z.number().int(),
  providerMessageId: z.string(),
  providerThreadId: z.string().nullable(),
});

const BrokerBindingResponseSchema = z.strictObject({
  scanRunId: z.uuid(),
  connectionId: z.uuid(),
  expectedConnectionVersion: z.number().int(),
  currentHistoryId: z.string().nullable(),
  currentCursorDigest: z.string(),
  preFenceToken: z.string(),
  nextPageSequence: z.number().int(),
  preFenceHistoryId: z.string().nullable(),
  historyPageToken: z.string().nullable(),
});

const StagingMessageSchema = z.strictObject({
  receivedAt: z.string(),
  senderAddress: z.string(),
  senderDomain: z.string(),
  subject: z.string(),
  contentHash: z.string(),
  attachmentManifest: z.array(AttachmentManifestV1Schema).max(5),
  classification: MailboxCandidateClassificationSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  providerMessageId: z.string().trim().min(1),
  providerThreadId: z.string().trim().min(1).nullable(),
});

const CandidatePagesBodySchema = z.strictObject({
  connectionId: z.uuid(),
  expectedConnectionVersion: z.number().int(),
  cursorBeforeDigest: z.string(),
  preFenceToken: z.string(),
  pageSequence: z.number().int().positive(),
  nextHistoryId: z.string().nullable(),
  nextPreFenceHistoryId: z.string().nullable(),
  nextHistoryPageToken: z.string().nullable(),
  messages: z.array(StagingMessageSchema),
  idempotencyKey: z.string().trim().min(1).max(500),
});

const CandidatePagesResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scanRunId: z.uuid(),
  pageSequence: z.number().int(),
  candidateIds: z.array(z.uuid()),
  counts: z.strictObject({
    discovered: z.number().int().nonnegative(),
    staged: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});

const ConnectionIdParamsSchema = z.strictObject({ connectionId: z.uuid() });

const ScheduledScanBodySchema = z.strictObject({
  /**
   * The trigger workflow's own fixed Schedule args carry `tenantId`
   * alongside `connectionId` (see mailbox-schedules.ts) specifically so
   * this worker-facing route can call `startScheduledScan` without
   * needing its own connectionId -> tenantId lookup -- domain/mailbox-
   * scans.ts (Task 2, under concurrent re-review) is untouched.
   */
  tenantId: z.uuid(),
  requestId: z.string().trim().min(1).max(500),
});

const ScheduledScanResponseSchema = z.strictObject({
  status: z.enum(["started", "skipped_overlap"]),
  scanRunId: z.uuid(),
});

const FinalizeScanBodySchema = z.strictObject({
  outcome: z.enum(["succeeded", "failed"]),
});

const FinalizeScanResponseSchema = z.strictObject({
  scanRunId: z.uuid(),
  status: z.string(),
  leaseReleased: z.boolean(),
});

/**
 * Phase 3D-C Task 5 fix round 1 (review Important #1) -- the worker's
 * MailboxMaterializeWorkflow combined activity calls these three routes
 * instead of routes/jobs.ts's generic `ai-worker`-guarded ones, using the
 * SAME mailbox-scoped identity (subject "workflow-worker-mailbox") every
 * other worker-facing route in this file already requires -- but scope
 * "mailbox:materialize" (distinct from scheduled-scans/finalize's own
 * "mailbox:discover" above, mirroring the broker-binding route's own
 * scope split a few lines up), the exact scope
 * clients/mailbox-client.ts's appTokenProvider already requests. No new
 * domain logic: each route is a thin, mailbox-guarded alias over
 * ProcessingJobsDomain's existing getJob/recordStatusUpdate/submitResult
 * -- the same generic job row every job type shares.
 */
const MaterializeInputResponseSchema = z.strictObject({ candidateId: z.uuid() });
/** Adds the two status codes recordStatusUpdate/submitResult can also
 * throw (DomainError.validation()/preconditionFailed()) -- never widens
 * this file's own shared `errors` map, used by every other route here. */
const jobCallbackErrors = { ...errors, 400: ErrorResponseSchema, 412: ErrorResponseSchema };

export async function registerMailboxInternalRoutes(
  app: FastifyInstance,
  options: MailboxInternalRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const brokerGuard = [
    serviceGuard(options.brokerServiceSubject ?? "mailbox-broker-app", ["mailbox:write"]),
  ];
  const workerGuard = [
    serviceGuard(options.workerServiceSubject ?? "workflow-worker-mailbox", ["mailbox:discover"]),
  ];
  /**
   * Phase 3D-B Task 4 Step 3a -- distinct scope ("mailbox:materialize",
   * the brief's exact wording) from the page-callback routes' "mailbox:
   * write", even though both guards accept the same broker subject: this
   * route hands back provider message/thread IDs (never exposed by the
   * scan-binding/candidate-page routes), so it is authorized separately.
   */
  const brokerMaterializeGuard = [
    serviceGuard(options.brokerServiceSubject ?? "mailbox-broker-app", ["mailbox:materialize"]),
  ];
  const workerMaterializeGuard = [
    serviceGuard(options.workerServiceSubject ?? "workflow-worker-mailbox", ["mailbox:materialize"]),
  ];

  typedApp.post(
    "/internal/v1/mailbox/scan-runs/:scanRunId/broker-binding",
    {
      preHandler: brokerGuard,
      schema: {
        hide: true,
        params: ScanRunIdParamsSchema,
        body: z.strictObject({}),
        security: [{ serviceBearer: [] }],
        response: { 200: BrokerBindingResponseSchema, ...errors },
      },
    },
    async (request) => {
      return options.mailboxScansDomain.loadScanBinding(request.params.scanRunId);
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/candidates/:candidateId/broker-binding",
    {
      preHandler: brokerMaterializeGuard,
      schema: {
        hide: true,
        params: CandidateIdParamsSchema,
        body: z.strictObject({}),
        security: [{ serviceBearer: [] }],
        response: { 200: CandidateBrokerBindingResponseSchema, ...errors },
      },
    },
    async (request) => {
      return options.mailboxScansDomain.loadCandidateBinding(request.params.candidateId);
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/scan-runs/:scanRunId/candidate-pages",
    {
      preHandler: brokerGuard,
      schema: {
        hide: true,
        params: ScanRunIdParamsSchema,
        body: CandidatePagesBodySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: CandidatePagesResponseSchema, ...errors },
      },
    },
    async (request) => {
      const result = await options.mailboxScansDomain.recordCandidateMetadata({
        schemaVersion: 1,
        scanRunId: request.params.scanRunId,
        connectionId: request.body.connectionId,
        expectedConnectionVersion: request.body.expectedConnectionVersion,
        cursorBeforeDigest: request.body.cursorBeforeDigest,
        preFenceToken: request.body.preFenceToken,
        pageSequence: request.body.pageSequence,
        nextHistoryId: request.body.nextHistoryId,
        nextPreFenceHistoryId: request.body.nextPreFenceHistoryId,
        nextHistoryPageToken: request.body.nextHistoryPageToken,
        messages: request.body.messages,
        idempotencyKey: request.body.idempotencyKey,
      });
      return { ...result, candidateIds: [...result.candidateIds] };
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/connections/:connectionId/scheduled-scans",
    {
      preHandler: workerGuard,
      schema: {
        hide: true,
        params: ConnectionIdParamsSchema,
        body: ScheduledScanBodySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: ScheduledScanResponseSchema, ...errors },
      },
    },
    async (request) => {
      const result = await options.mailboxScansDomain.startScheduledScan({
        tenantId: request.body.tenantId,
        connectionId: request.params.connectionId,
        requestId: request.body.requestId,
      });
      return { status: result.status, scanRunId: result.scanRun.id };
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/scan-runs/:scanRunId/finalize",
    {
      preHandler: workerGuard,
      schema: {
        hide: true,
        params: ScanRunIdParamsSchema,
        body: FinalizeScanBodySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: FinalizeScanResponseSchema, ...errors },
      },
    },
    async (request) => {
      const result = await options.mailboxScansDomain.finalizeScanRun({
        scanRunId: request.params.scanRunId,
        outcome: request.body.outcome,
      });
      return {
        scanRunId: result.scanRun.id,
        status: result.scanRun.status,
        leaseReleased: result.leaseReleased,
      };
    },
  );

  typedApp.get(
    "/internal/v1/mailbox/jobs/:jobId/materialize-input",
    {
      preHandler: workerMaterializeGuard,
      schema: {
        hide: true,
        params: ProcessingJobParamsSchema,
        security: [{ serviceBearer: [] }],
        response: { 200: MaterializeInputResponseSchema, ...jobCallbackErrors },
      },
    },
    async (request) => {
      // Phase 3D-C Task 5 fix round 2 (review Important #1): restricts
      // this worker-identity route to EXACTLY the MailboxMaterializeWorkflow
      // job it was created for -- see ProcessingJobsDomain's own doc
      // comment on this flag for the full threat model.
      const job = await options.processingJobsDomain.getJob(request.params.jobId, {
        requireMailboxMaterializeWorkflow: true,
      });
      const candidateId = (job.inputParams as Record<string, unknown> | null)?.["mailboxCandidateId"];
      if (typeof candidateId !== "string") throw DomainError.validation();
      return { candidateId };
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/jobs/:jobId/status",
    {
      preHandler: workerMaterializeGuard,
      schema: {
        hide: true,
        params: ProcessingJobParamsSchema,
        body: JobStatusUpdateRequestV1Schema,
        security: [{ serviceBearer: [] }],
        response: { 200: ProcessingJobSchema, ...jobCallbackErrors },
      },
    },
    async (request, reply) => {
      const result = await options.processingJobsDomain.recordStatusUpdate({
        jobId: request.params.jobId,
        request: request.body,
        actorServicePrincipal: actorServicePrincipal(request),
        requestId: request.id,
        requireMailboxMaterializeWorkflow: true,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/jobs/:jobId/result",
    {
      preHandler: workerMaterializeGuard,
      schema: {
        hide: true,
        params: ProcessingJobParamsSchema,
        body: JobResultSubmitRequestV1Schema,
        security: [{ serviceBearer: [] }],
        response: { 200: ProcessingJobSchema, ...jobCallbackErrors },
      },
    },
    async (request, reply) => {
      const result = await options.processingJobsDomain.submitResult({
        jobId: request.params.jobId,
        request: request.body,
        actorServicePrincipal: actorServicePrincipal(request),
        requestId: request.id,
        requireMailboxMaterializeWorkflow: true,
      });
      return reply.code(result.statusCode).send(result.body);
    },
  );
}
