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
 * ruling, see task-3-report.md) adds a third, worker-facing route: a
 * native Temporal Schedule's action args are fixed at creation time, so
 * the daily-schedule's trigger workflow cannot carry a real `scanRunId`
 * (App API mints that only when the schedule fires). This route is the
 * one App-reachable entry point that lets the trigger workflow's own
 * activity mint it, guarded by the worker's own service principal
 * (subject "workflow-worker-mailbox", scope "mailbox:discover" -- the
 * exact subject/scope pair 3D-A Task 5 already provisioned for this
 * worker identity, never the broker's).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AttachmentManifestV1Schema,
  ErrorResponseSchema,
  MailboxCandidateClassificationSchema,
} from "@expense-tax/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { MailboxScansDomain } from "../domain/mailbox-scans.js";
import { serviceGuard } from "../plugins/auth.js";

export interface MailboxInternalRouteOptions {
  readonly mailboxScansDomain: MailboxScansDomain;
  /** Default mirrors the plan's exact machine subject: "mailbox-broker-app". */
  readonly brokerServiceSubject?: string;
  /** Default mirrors 3D-A Task 5's exact worker machine subject: "workflow-worker-mailbox". */
  readonly workerServiceSubject?: string;
}

const errors = { 401: ErrorResponseSchema, 403: ErrorResponseSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema };

const ScanRunIdParamsSchema = z.strictObject({ scanRunId: z.uuid() });

const BrokerBindingResponseSchema = z.strictObject({
  scanRunId: z.uuid(),
  connectionId: z.uuid(),
  expectedConnectionVersion: z.number().int(),
  currentHistoryId: z.string().nullable(),
  currentCursorDigest: z.string(),
  preFenceToken: z.string(),
  nextPageSequence: z.number().int(),
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
}
