/**
 * Phase 3D-B Task 2 — internal broker-facing mailbox discovery routes.
 *
 * Exactly the two endpoints the task-2 brief lists: the broker's scan
 * binding read and the fenced candidate-page callback. Both are guarded
 * by the broker's own service principal (subject "mailbox-broker-app",
 * scope "mailbox:write") -- same convention as
 * routes/mailbox-connections.ts's internal routes.
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

export async function registerMailboxInternalRoutes(
  app: FastifyInstance,
  options: MailboxInternalRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const brokerGuard = [
    serviceGuard(options.brokerServiceSubject ?? "mailbox-broker-app", ["mailbox:write"]),
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
}
