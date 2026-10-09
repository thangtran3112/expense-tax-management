/**
 * Phase 3D-A Task 3 — base mailbox worker client.
 *
 * "Base" deliberately: this task provides the authenticated-request
 * plumbing only (Clerk M2M token minting for both the worker's mailbox-
 * scoped App API calls and its direct broker calls, plus a generic
 * authenticated-request helper mirroring clients/app-api.ts's
 * conventions) -- no `discover`/`materialize` business methods, since no
 * App API or broker route for either exists yet (those are 3D-B/C's
 * job, which build concrete calls on top of this client rather than
 * inventing routes here).
 *
 * Two distinct token providers, per the brief's credential-naming note:
 * `config.clerk.mailboxApp` (audience `CLERK_APP_SERVICE_AUDIENCE`,
 * reused -- the same App target `clients/app-api.ts` already calls, but
 * under the mailbox-scoped identity) for calls into App API's mailbox
 * routes, and `config.clerk.mailboxBroker` (audience
 * `CLERK_MAILBOX_SERVICE_AUDIENCE`, new) for calls directly to the
 * broker.
 */
import {
  MailboxMaterializationResultV1Schema,
  ProcessingJobSchema,
  type DiscoveryPageV1,
  type JobResultSubmitRequestV1,
  type JobStatusUpdateRequestV1,
  type MailboxMaterializationResultV1,
  type ProcessingJob,
} from "@expense-tax/contracts";
import { z } from "zod";

import type { WorkerConfig } from "../config.js";
import {
  createMachineTokenProvider,
  MachineTokenError,
  type TokenProvider,
} from "../auth/machine-token.js";

export type MailboxClientErrorCode =
  | "authentication_failed"
  | "authorization_failed"
  | "conflict"
  | "invalid_request"
  | "invalid_response"
  | "not_found"
  | "rate_limited"
  | "request_failed"
  | "timeout"
  | "unavailable";

export class MailboxClientError extends Error {
  readonly code: MailboxClientErrorCode;
  readonly status: number | undefined;

  constructor(code: MailboxClientErrorCode, status?: number) {
    super(`Mailbox client request failed: ${code}`);
    this.name = "MailboxClientError";
    this.code = code;
    this.status = status;
  }
}

export interface MailboxAppApiClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly appTokenProvider?: TokenProvider;
  readonly brokerTokenProvider?: TokenProvider;
}

export interface MailboxApiRequestInput<T> {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly responseSchema: z.ZodType<T>;
  readonly body?: unknown;
}

/**
 * Phase 3D-B Task 3. `DiscoveryPageV1` is a plain interface in
 * `@expense-tax/contracts` (Temporal-boundary payloads are deliberately
 * not Zod-validated there -- Task 1 Ruling 2 precedent), but
 * `MailboxApiRequestInput.responseSchema` needs a real runtime schema;
 * this one is local to the client that actually makes the HTTP call.
 */
const DiscoveryPageV1Schema = z.object({
  scanRunId: z.string(),
  pageSequence: z.number(),
  candidateCount: z.number(),
  retryCount: z.number(),
});

export interface StartScheduledScanResult {
  readonly status: "started" | "skipped_overlap";
  readonly scanRunId: string;
}

const StartScheduledScanResultSchema = z.object({
  status: z.enum(["started", "skipped_overlap"]),
  scanRunId: z.string(),
});

export interface FinalizeScanResult {
  readonly scanRunId: string;
  readonly status: string;
  readonly leaseReleased: boolean;
}

const FinalizeScanResultSchema = z.object({
  scanRunId: z.string(),
  status: z.string(),
  leaseReleased: z.boolean(),
});

/**
 * Phase 3D-C Task 5 fix round 1 (review Important #1) -- same local-
 * schema convention as DiscoveryPageV1Schema above.
 */
const MaterializeInputResultSchema = z.object({ candidateId: z.string() });

export interface MailboxAppApiClient {
  /** Mints (and caches) a Clerk M2M token scoped to the worker's mailbox identity, audience = App API. */
  mintAppToken(): Promise<string>;
  /** Mints (and caches) a Clerk M2M token scoped to the worker's mailbox identity, audience = the mailbox broker. */
  mintBrokerToken(): Promise<string>;
  /** Authenticated request against App API's mailbox routes (base URL from `config.services.appApiBaseUrl`). */
  requestAppApi<T>(input: MailboxApiRequestInput<T>): Promise<T>;
  /** Authenticated request directly against the mailbox broker (base URL from `config.services.mailboxBrokerBaseUrl`). */
  requestBroker<T>(input: MailboxApiRequestInput<T>): Promise<T>;
  /**
   * Phase 3D-B Task 3 handoff note: named convenience method built on top
   * of `requestBroker`, rather than a pre-existing `.runDiscovery()` this
   * client never had. Sends only `scanRunId` -- the broker resolves
   * connectionId/fence state itself via its own `loadScanBinding` call to
   * App API, never from the worker.
   */
  discoverPage(scanRunId: string): Promise<DiscoveryPageV1>;
  /**
   * Phase 3D-B Task 3. Mints (or replays) the scan run for a Temporal-
   * Schedule-triggered scan. `tenantId` rides the Schedule's own fixed
   * trigger-workflow args (see app-api/src/temporal/mailbox-schedules.ts)
   * so this call never needs its own connectionId -> tenantId lookup.
   */
  startScheduledScan(input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly requestId: string;
  }): Promise<StartScheduledScanResult>;
  /**
   * Phase 3D-B Task 3 fix round 1. Opaque terminal callback -- no content,
   * just a bare succeeded/failed outcome -- `MailboxScanWorkflow` calls on
   * success, non-retryable failure, and cancellation.
   */
  finalizeScan(input: {
    readonly scanRunId: string;
    readonly outcome: "succeeded" | "failed";
  }): Promise<FinalizeScanResult>;
  /**
   * Phase 3D-C Task 5. The worker's one opaque-by-candidateId call into
   * the broker's materialize route -- same "named convenience method over
   * requestBroker" shape as discoverPage, same mailbox:materialize scope
   * this client's broker token provider already requests.
   */
  materializeCandidate(input: {
    readonly candidateId: string;
    readonly operationId: string;
  }): Promise<MailboxMaterializationResultV1>;
  /**
   * Phase 3D-C Task 5 fix round 1 (review Important #1) -- the three
   * calls MailboxMaterializeWorkflow's combined activity makes against
   * App, all under this client's mailbox-scoped `workflow-worker-
   * mailbox` identity (never the generic worker identity
   * clients/app-api.ts uses) and App's mailbox-scoped routes
   * (routes/mailbox-internal.ts), never routes/jobs.ts's generic ones.
   */
  mailboxJobMaterializeInput(jobId: string): Promise<{ readonly candidateId: string }>;
  mailboxJobStatus(jobId: string, request: JobStatusUpdateRequestV1): Promise<ProcessingJob>;
  mailboxJobResult(jobId: string, request: JobResultSubmitRequestV1): Promise<ProcessingJob>;
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
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

async function discardResponseBody(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.body) return;
  await withAbort(response.body.cancel(), signal).catch(() => undefined);
}

function errorCodeForStatus(status: number): MailboxClientErrorCode {
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
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "unavailable" : "request_failed";
  }
}

export function createMailboxAppApiClient(
  config: WorkerConfig,
  options: MailboxAppApiClientOptions = {},
): MailboxAppApiClient {
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  // Phase 3D-A Task 5 (controller ruling): mailbox config is optional on
  // WorkerConfig (ordinary dev->main deploys carry none at all). This
  // client is only ever constructed by a caller that actually wants a
  // mailbox client, so a missing credential here is a real
  // misconfiguration -- fail fast with a clear error instead of minting a
  // token request with `undefined` credentials.
  const { mailboxApp, mailboxBroker } = config.clerk;
  const { mailboxBrokerBaseUrl } = config.services;
  if (!mailboxApp || !mailboxBroker || !mailboxBrokerBaseUrl) {
    throw new Error(
      "createMailboxAppApiClient requires mailbox configuration (MAILBOX_BROKER_BASE_URL, CLERK_MAILBOX_SERVICE_AUDIENCE, CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY, CLERK_MAILBOX_WORKER_SUBJECT) to be set",
    );
  }

  const appTokenProvider =
    options.appTokenProvider ??
    createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: mailboxApp,
        scopes: ["mailbox:discover", "mailbox:materialize"],
      },
      { fetch: fetchImplementation },
    );
  const brokerTokenProvider =
    options.brokerTokenProvider ??
    createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: mailboxBroker,
        scopes: ["mailbox:discover", "mailbox:materialize"],
      },
      { fetch: fetchImplementation },
    );

  async function request<T>(
    baseUrl: string,
    token: TokenProvider,
    input: MailboxApiRequestInput<T>,
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      const bearer = await withAbort(token(), signal);
      response = await fetchImplementation(`${baseUrl}${input.path}`, {
        method: input.method,
        headers:
          input.body === undefined
            ? { authorization: `Bearer ${bearer}` }
            : { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (error instanceof MailboxClientError) throw error;
      if (error instanceof MachineTokenError) {
        throw new MailboxClientError(
          error.code === "timeout"
            ? "timeout"
            : error.code === "acquisition_failed"
              ? "unavailable"
              : "authentication_failed",
        );
      }
      throw new MailboxClientError(signal.aborted ? "timeout" : "unavailable");
    }

    if (!response.ok) {
      await discardResponseBody(response, signal);
      throw new MailboxClientError(errorCodeForStatus(response.status), response.status);
    }

    try {
      const body = await withAbort(response.json(), signal);
      return input.responseSchema.parse(body);
    } catch {
      await discardResponseBody(response, signal);
      throw new MailboxClientError(
        signal.aborted ? "timeout" : "invalid_response",
        response.status,
      );
    }
  }

  const client: MailboxAppApiClient = {
    mintAppToken: appTokenProvider,
    mintBrokerToken: brokerTokenProvider,
    requestAppApi(input) {
      return request(config.services.appApiBaseUrl, appTokenProvider, input);
    },
    requestBroker(input) {
      return request(mailboxBrokerBaseUrl, brokerTokenProvider, input);
    },
    discoverPage(scanRunId) {
      // The broker route requires `body: z.strictObject({})` -- an absent
      // body (no content-type, no body sent at all) fails that schema
      // with a 400. An empty object satisfies it; this route never takes
      // real input (the broker resolves everything itself).
      return client.requestBroker({
        path: `/internal/v1/mailbox/scan-runs/${scanRunId}/discover`,
        method: "POST",
        responseSchema: DiscoveryPageV1Schema,
        body: {},
      });
    },
    startScheduledScan({ tenantId, connectionId, requestId }) {
      return client.requestAppApi({
        path: `/internal/v1/mailbox/connections/${connectionId}/scheduled-scans`,
        method: "POST",
        responseSchema: StartScheduledScanResultSchema,
        body: { tenantId, requestId },
      });
    },
    finalizeScan({ scanRunId, outcome }) {
      return client.requestAppApi({
        path: `/internal/v1/mailbox/scan-runs/${scanRunId}/finalize`,
        method: "POST",
        responseSchema: FinalizeScanResultSchema,
        body: { outcome },
      });
    },
    materializeCandidate({ candidateId, operationId }) {
      return client.requestBroker({
        path: `/internal/v1/mailbox/candidates/${candidateId}/materialize`,
        method: "POST",
        responseSchema: MailboxMaterializationResultV1Schema,
        body: { operationId },
      });
    },
    mailboxJobMaterializeInput(jobId) {
      return client.requestAppApi({
        path: `/internal/v1/mailbox/jobs/${jobId}/materialize-input`,
        method: "GET",
        responseSchema: MaterializeInputResultSchema,
      });
    },
    mailboxJobStatus(jobId, request) {
      return client.requestAppApi({
        path: `/internal/v1/mailbox/jobs/${jobId}/status`,
        method: "POST",
        responseSchema: ProcessingJobSchema,
        body: request,
      });
    },
    mailboxJobResult(jobId, request) {
      return client.requestAppApi({
        path: `/internal/v1/mailbox/jobs/${jobId}/result`,
        method: "POST",
        responseSchema: ProcessingJobSchema,
        body: request,
      });
    },
  };
  return client;
}
