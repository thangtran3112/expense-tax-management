import {
  DeduplicationEvidenceV1Schema,
  ExpenseEnrichmentInputResponseV1Schema,
  ExpenseEnrichmentResultV1Schema,
  FileReadUrlResponseSchema,
  JobResultSubmitRequestV1Schema,
  JobStatusUpdateRequestV1Schema,
  OcrJobInputV1Schema,
  ProcessingJobSchema,
  VersionSchema,
  type DeduplicationEvidenceV1,
  type ExpenseEnrichmentInputResponseV1,
  type FileReadUrlResponse,
  type JobResultSubmitRequestV1,
  type JobStatusUpdateRequestV1,
  type OcrJobInputV1,
  type ProcessingJob,
} from "@expense-tax/contracts";
import { z } from "zod";

import type { WorkerConfig } from "../config.js";
import {
  createMachineTokenProvider,
  MachineTokenError,
  type TokenProvider,
} from "../auth/machine-token.js";

export type AppApiClientErrorCode =
  | "authentication_failed"
  | "authorization_failed"
  | "conflict"
  | "invalid_request"
  | "invalid_response"
  | "not_found"
  | "precondition_failed"
  | "rate_limited"
  | "request_failed"
  | "timeout"
  | "unavailable";

export class AppApiClientError extends Error {
  readonly code: AppApiClientErrorCode;
  readonly status: number | undefined;

  constructor(code: AppApiClientErrorCode, status?: number) {
    super(`App API request failed: ${code}`);
    this.name = "AppApiClientError";
    this.code = code;
    this.status = status;
  }
}

const IdSchema = z.uuid();
const MaterializeInputResponseSchema = z.strictObject({ candidateId: z.uuid() });
const DeduplicationResponseSchema = z.strictObject({
  decision: z.enum(["no_match", "review"]),
  matchIds: z.array(z.uuid()),
});
export type DeduplicationResponse = z.infer<
  typeof DeduplicationResponseSchema
>;

const EnrichmentResultSubmitRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  expectedJobVersion: VersionSchema,
  idempotencyKey: z.string().trim().min(1).max(255),
  result: ExpenseEnrichmentResultV1Schema,
});
export type EnrichmentResultSubmitRequest = z.infer<
  typeof EnrichmentResultSubmitRequestSchema
>;

interface AppTokenProviders {
  readonly jobs: TokenProvider;
  readonly enrichmentInput: TokenProvider;
  readonly enrichmentResult: TokenProvider;
}

export interface AppApiClientOptions {
  readonly allowedFileOrigins?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly tokenProviders?: AppTokenProviders;
}

async function withAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function discardResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  await withAbort(response.body.cancel(), signal).catch(() => undefined);
}

function errorCodeForStatus(status: number): AppApiClientErrorCode {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "authentication_failed";
    case 403:
      return "authorization_failed";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 412:
      return "precondition_failed";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "unavailable" : "request_failed";
  }
}

export interface AppApiClient {
  updateStatus(
    jobId: string,
    request: JobStatusUpdateRequestV1,
  ): Promise<ProcessingJob>;
  submitResult(
    jobId: string,
    request: JobResultSubmitRequestV1,
  ): Promise<ProcessingJob>;
  recordDeduplicationEvidence(
    jobId: string,
    evidence: DeduplicationEvidenceV1,
  ): Promise<DeduplicationResponse>;
  getOcrInput(jobId: string): Promise<OcrJobInputV1>;
  /** Phase 3D-C Task 5 gap closure -- read-only candidateId resolver, never mutates the job. */
  getMaterializeInput(jobId: string): Promise<{ readonly candidateId: string }>;
  issueFileReadUrl(fileId: string): Promise<FileReadUrlResponse>;
  downloadFile(fileId: string): Promise<Uint8Array>;
  getEnrichmentInput(
    jobId: string,
  ): Promise<ExpenseEnrichmentInputResponseV1>;
  submitEnrichmentResult(
    jobId: string,
    request: EnrichmentResultSubmitRequest,
  ): Promise<ProcessingJob>;
}

export function createAppApiClient(
  config: WorkerConfig,
  options: AppApiClientOptions = {},
): AppApiClient {
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const appApiOrigin = new URL(config.services.appApiBaseUrl).origin;
  const allowedFileOrigins = new Set([
    appApiOrigin,
    ...(options.allowedFileOrigins ?? []).map((value) => {
      try {
        const url = new URL(value);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        ) {
          throw new Error("invalid origin");
        }
        return url.origin;
      } catch {
        throw new AppApiClientError("invalid_request");
      }
    }),
  ]);
  const tokenProviders =
    options.tokenProviders ??
    {
      jobs: createMachineTokenProvider(
        {
          issuerUrl: config.clerk.issuerUrl,
          jwksUrl: config.clerk.jwksUrl,
          credentials: config.clerk.app,
          scopes: ["jobs:write", "files:read"],
        },
        { fetch: fetchImplementation },
      ),
      enrichmentInput: createMachineTokenProvider(
        {
          issuerUrl: config.clerk.issuerUrl,
          jwksUrl: config.clerk.jwksUrl,
          credentials: config.clerk.app,
          scopes: ["jobs:enrichment-input"],
        },
        { fetch: fetchImplementation },
      ),
      enrichmentResult: createMachineTokenProvider(
        {
          issuerUrl: config.clerk.issuerUrl,
          jwksUrl: config.clerk.jwksUrl,
          credentials: config.clerk.app,
          scopes: ["jobs:enrichment-result"],
        },
        { fetch: fetchImplementation },
      ),
    };

  async function requestJson<T>(input: {
    readonly path: string;
    readonly method: "GET" | "POST";
    readonly token: TokenProvider;
    readonly responseSchema: z.ZodType<T>;
    readonly body?: unknown;
  }): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      const token = await withAbort(input.token(), signal);
      response = await fetchImplementation(
        `${config.services.appApiBaseUrl}${input.path}`,
        {
          method: input.method,
          headers:
            input.body === undefined
              ? { authorization: `Bearer ${token}` }
              : {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                },
          ...(input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) }),
          redirect: "error",
          signal,
        },
      );
    } catch (error) {
      if (error instanceof AppApiClientError) throw error;
      if (error instanceof MachineTokenError) {
        throw new AppApiClientError(
          error.code === "timeout"
            ? "timeout"
            : error.code === "acquisition_failed"
              ? "unavailable"
              : "authentication_failed",
        );
      }
      throw new AppApiClientError(signal.aborted ? "timeout" : "unavailable");
    }

    if (!response.ok) {
      await discardResponseBody(response, signal);
      throw new AppApiClientError(errorCodeForStatus(response.status), response.status);
    }

    try {
      const body = await withAbort(response.json(), signal);
      return input.responseSchema.parse(body);
    } catch {
      await discardResponseBody(response, signal);
      throw new AppApiClientError(
        signal.aborted ? "timeout" : "invalid_response",
        response.status,
      );
    }
  }

  function issueFileReadUrl(fileId: string): Promise<FileReadUrlResponse> {
    const parsedFileId = IdSchema.parse(fileId);
    return requestJson({
      path: `/internal/v1/files/${parsedFileId}/read-url`,
      method: "POST",
      token: tokenProviders.jobs,
      responseSchema: FileReadUrlResponseSchema,
    });
  }

  return {
    updateStatus(jobId, request) {
      const parsedJobId = IdSchema.parse(jobId);
      const body = JobStatusUpdateRequestV1Schema.parse(request);
      return requestJson({
        path: `/internal/v1/jobs/${parsedJobId}/status`,
        method: "POST",
        token: tokenProviders.jobs,
        responseSchema: ProcessingJobSchema,
        body,
      });
    },
    submitResult(jobId, request) {
      const parsedJobId = IdSchema.parse(jobId);
      const body = JobResultSubmitRequestV1Schema.parse(request);
      return requestJson({
        path: `/internal/v1/jobs/${parsedJobId}/result`,
        method: "POST",
        token: tokenProviders.jobs,
        responseSchema: ProcessingJobSchema,
        body,
      });
    },
    recordDeduplicationEvidence(jobId, evidence) {
      const parsedJobId = IdSchema.parse(jobId);
      const body = DeduplicationEvidenceV1Schema.parse(evidence);
      if (body.jobId !== parsedJobId) {
        throw new AppApiClientError("invalid_request");
      }
      return requestJson({
        path: `/internal/v1/jobs/${parsedJobId}/deduplication`,
        method: "POST",
        token: tokenProviders.jobs,
        responseSchema: DeduplicationResponseSchema,
        body,
      });
    },
    getOcrInput(jobId) {
      const parsedJobId = IdSchema.parse(jobId);
      return requestJson({
        path: `/internal/v1/jobs/${parsedJobId}/ocr-input`,
        method: "GET",
        token: tokenProviders.jobs,
        responseSchema: OcrJobInputV1Schema,
      });
    },
    getMaterializeInput(jobId) {
      const parsedJobId = IdSchema.parse(jobId);
      return requestJson({
        path: `/internal/v1/jobs/${parsedJobId}/materialize-input`,
        method: "GET",
        token: tokenProviders.jobs,
        responseSchema: MaterializeInputResponseSchema,
      });
    },
    issueFileReadUrl,
    async downloadFile(fileId) {
      const { url } = await issueFileReadUrl(fileId);
      let downloadUrl: URL;
      try {
        downloadUrl = new URL(url);
        const internalOrigin = new URL(config.services.appApiBaseUrl);
        if (
          downloadUrl.origin !== appApiOrigin &&
          downloadUrl.protocol === "http:" &&
          downloadUrl.hostname === "127.0.0.1" &&
          downloadUrl.port !== "" &&
          downloadUrl.port === internalOrigin.port &&
          !downloadUrl.username &&
          !downloadUrl.password &&
          !downloadUrl.hash &&
          downloadUrl.pathname === `/api/v1/file-content/${fileId}` &&
          /^\d+$/u.test(downloadUrl.searchParams.get("expires") ?? "") &&
          /^[a-f0-9]{64}$/u.test(downloadUrl.searchParams.get("signature") ?? "")
        ) {
          // The signature binds method, file ID, and expiry, not the public origin.
          downloadUrl = new URL(`${downloadUrl.pathname}${downloadUrl.search}`, appApiOrigin);
        }
        if (
          downloadUrl.username ||
          downloadUrl.password ||
          !allowedFileOrigins.has(downloadUrl.origin) ||
          (downloadUrl.protocol !== "https:" &&
            downloadUrl.origin !== appApiOrigin)
        ) {
          throw new Error("unsafe file URL");
        }
      } catch {
        throw new AppApiClientError("invalid_response");
      }

      const signal = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await fetchImplementation(downloadUrl, {
          method: "GET",
          redirect: "error",
          signal,
        });
      } catch {
        throw new AppApiClientError(signal.aborted ? "timeout" : "unavailable");
      }
      if (!response.ok) {
        await discardResponseBody(response, signal);
        throw new AppApiClientError(
          errorCodeForStatus(response.status),
          response.status,
        );
      }
      try {
        const body = await withAbort(response.arrayBuffer(), signal);
        return new Uint8Array(body);
      } catch {
        await discardResponseBody(response, signal);
        throw new AppApiClientError(
          signal.aborted ? "timeout" : "invalid_response",
          response.status,
        );
      }
    },
    getEnrichmentInput(jobId) {
      const parsedJobId = IdSchema.parse(jobId);
      return requestJson({
        path: `/internal/v1/jobs/${parsedJobId}/enrichment-input`,
        method: "GET",
        token: tokenProviders.enrichmentInput,
        responseSchema: ExpenseEnrichmentInputResponseV1Schema,
      });
    },
    submitEnrichmentResult(jobId, request) {
      const parsedJobId = IdSchema.parse(jobId);
      const body = EnrichmentResultSubmitRequestSchema.parse(request);
      return requestJson({
        path: `/internal/v1/jobs/${parsedJobId}/enrichment-result`,
        method: "POST",
        token: tokenProviders.enrichmentResult,
        responseSchema: ProcessingJobSchema,
        body,
      });
    },
  };
}
