/**
 * Phase 3D-C Task 3 -- the three broker-facing routes
 * MailboxIngestionAppClient calls directly (issueUploadGrant/
 * uploadAttachment/submitStructuredResult). Guarded by the broker's own
 * service principal, scope "mailbox:write" -- reusing the existing scope
 * rather than minting a new one (Task 2 Ruling 3, carried forward here).
 *
 * The attachment-upload route accepts a raw "application/octet-stream"
 * body (never a declared/trusted content type -- the real type is sniffed
 * from magic bytes by domain/files.ts's writeMailboxAttachment, same
 * "never trust a caller-claimed MIME type" precedent as the broker's own
 * streamAttachment). candidateId/attachmentIndex travel as path params;
 * uploadGrantId/expectedCandidateVersion/idempotencyKey as query params,
 * since the body itself is the opaque byte stream.
 *
 * Fix round 1 (review Important #1) -- the content-type parser below is
 * registered with NO `parseAs` option, which per Fastify's own docs means
 * it receives the raw request stream and Fastify does not buffer or
 * size-check it at all; `done(null, payload)` hands that same stream
 * straight through as `request.body`, so the handler passes it to
 * `receiveAttachment` exactly as received -- zero bytes are buffered in
 * this process before domain/storage/bounded-stream.ts's own
 * MAX_UPLOAD_BYTES enforcement (which hashes incrementally while reading)
 * ever runs. Breaking out of (or throwing from) the `for await` loop that
 * consumes an AsyncIterable over a Node Readable stream -- which is
 * exactly what a bound violation does -- triggers the stream's own
 * automatic destroy() via the async-iterator-return protocol, so an
 * oversize upload's connection is torn down rather than drained to
 * completion.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ErrorResponseSchema } from "@expense-tax/contracts";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import type { MailboxIngestionDomain } from "../domain/mailbox-ingestion.js";
import { serviceGuard } from "../plugins/auth.js";

export interface MailboxIngestionRouteOptions {
  readonly mailboxIngestionDomain: MailboxIngestionDomain;
  /** Default mirrors the plan's exact machine subject: "mailbox-broker-app". */
  readonly brokerServiceSubject?: string;
}

const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
  409: ErrorResponseSchema,
  410: ErrorResponseSchema,
  412: ErrorResponseSchema,
  413: ErrorResponseSchema,
};

const CandidateIdParamsSchema = z.strictObject({ candidateId: z.uuid() });
const AttachmentParamsSchema = z.strictObject({
  candidateId: z.uuid(),
  attachmentIndex: z.coerce.number().int().min(0),
});

const UploadGrantRequestBodySchema = z.strictObject({
  expectedCandidateVersion: z.number().int(),
  operationId: z.string().trim().min(1).max(500),
});

const UploadGrantResponseSchema = z.strictObject({
  candidateId: z.uuid(),
  connectionId: z.uuid(),
  uploadGrantId: z.uuid(),
  expiresAt: z.string(),
  maxBytes: z.literal(26214400),
  maxAttachments: z.literal(5),
});

const AttachmentQuerySchema = z.strictObject({
  uploadGrantId: z.uuid(),
  expectedCandidateVersion: z.coerce.number().int(),
  idempotencyKey: z.string().trim().min(1).max(500),
});

const AttachmentResponseSchema = z.strictObject({
  candidateId: z.uuid(),
  attachmentIndex: z.number().int(),
  fileId: z.uuid(),
  status: z.enum(["READY", "REVIEW", "FAILED"]),
  errorCode: z.string().nullable(),
  idempotencyKey: z.string(),
});

const StructuredResultBodySchema = z.strictObject({
  result: z.strictObject({
    schemaVersion: z.literal(1),
    candidateId: z.uuid(),
    connectionId: z.uuid(),
    candidateVersion: z.number().int(),
    merchant: z.string().trim().min(1).max(200),
    amount: z.string(),
    currency: z.string(),
    incurredOn: z.string(),
    orderNumber: z.string().nullable(),
    notes: z.string().nullable(),
    evidence: z.array(z.string()),
    idempotencyKey: z.string().trim().min(1).max(500),
  }),
  idempotencyKey: z.string().trim().min(1).max(500),
});

const MaterializationResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  candidateId: z.uuid(),
  status: z.enum(["queued", "processed", "duplicate", "review", "failed"]),
  processingJobId: z.uuid().nullable(),
  expenseId: z.uuid().nullable(),
  sourceId: z.uuid().nullable(),
  duplicateMatchId: z.uuid().nullable(),
  idempotencyKey: z.string(),
});

export async function registerMailboxIngestionRoutes(
  app: FastifyInstance,
  options: MailboxIngestionRouteOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();
  const brokerGuard = [
    serviceGuard(options.brokerServiceSubject ?? "mailbox-broker-app", ["mailbox:write"]),
  ];

  // No `parseAs` -- raw-stream mode. `payload` is the request's own
  // Readable stream (an AsyncIterable<Buffer>); handing it straight
  // through via `done(null, payload)` means `request.body` IS that
  // stream, never a fully-buffered Buffer.
  typedApp.addContentTypeParser(
    "application/octet-stream",
    (_request: FastifyRequest, payload: NodeJS.ReadableStream, done) => {
      done(null, payload);
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/candidates/:candidateId/upload-grant",
    {
      preHandler: brokerGuard,
      schema: {
        hide: true,
        params: CandidateIdParamsSchema,
        body: UploadGrantRequestBodySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: UploadGrantResponseSchema, ...errors },
      },
    },
    async (request) => {
      return options.mailboxIngestionDomain.issueUploadGrant({
        candidateId: request.params.candidateId,
        expectedCandidateVersion: request.body.expectedCandidateVersion,
        operationId: request.body.operationId,
      });
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/candidates/:candidateId/attachments/:attachmentIndex",
    {
      preHandler: brokerGuard,
      schema: {
        hide: true,
        params: AttachmentParamsSchema,
        querystring: AttachmentQuerySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: AttachmentResponseSchema, ...errors },
      },
    },
    async (request) => {
      // The raw-stream content-type parser above hands this straight
      // through as the live request stream -- never buffered here or
      // anywhere upstream of domain/storage/bounded-stream.ts's own
      // incremental, size-capped hashing.
      const source = request.body as AsyncIterable<Buffer>;
      return options.mailboxIngestionDomain.receiveAttachment(
        {
          candidateId: request.params.candidateId,
          attachmentIndex: request.params.attachmentIndex,
          uploadGrantId: request.query.uploadGrantId,
          expectedCandidateVersion: request.query.expectedCandidateVersion,
          idempotencyKey: request.query.idempotencyKey,
        },
        source,
      );
    },
  );

  typedApp.post(
    "/internal/v1/mailbox/candidates/:candidateId/structured-result",
    {
      preHandler: brokerGuard,
      schema: {
        hide: true,
        params: CandidateIdParamsSchema,
        body: StructuredResultBodySchema,
        security: [{ serviceBearer: [] }],
        response: { 200: MaterializationResponseSchema, ...errors },
      },
    },
    async (request) => {
      return options.mailboxIngestionDomain.submitStructuredReceipt({
        result: {
          ...request.body.result,
          candidateId: request.params.candidateId,
        },
        idempotencyKey: request.body.idempotencyKey,
      });
    },
  );
}
