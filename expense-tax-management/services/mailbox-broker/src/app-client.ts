/**
 * Phase 3D-A Task 3 — broker's outbound client to App API
 * (`MailboxBrokerConnectionAppClient`, @expense-tax/contracts).
 *
 * Mints a Clerk M2M token with exact subject "mailbox-broker-app" and
 * scope "mailbox:write" against App API's existing service audience
 * (`CLERK_APP_SERVICE_AUDIENCE`, reused). Mirrors the request/error
 * conventions of services/app-api/src/integrations/mailbox-broker-client.ts
 * (this task's mirror-image counterpart) and
 * services/workflow-worker/src/clients/app-api.ts.
 *
 * `completeConnection` and `recordRevocation` call routes App API does
 * not expose yet -- Task 2's brief explicitly omitted a completion route
 * (see task-2-report.md Ruling 3) and no revocation route exists either.
 * Both methods are implemented against their natural path (consistent
 * with the three routes Task 2 *did* build) so this client satisfies the
 * full `MailboxBrokerConnectionAppClient` interface now; they will 404
 * against the real App API until whichever task (3/4) adds those routes.
 * Every method is independently unit-tested here against a fake HTTP
 * server, so that gap is caught by a 404 test today, not discovered
 * silently later.
 */
import type {
  AdvanceTokenGenerationInput,
  AdvanceTokenGenerationResult,
  ConnectedAccount,
  MailboxAttachmentUploadResultV1,
  MailboxBrokerAttachmentUploadV1,
  MailboxBrokerCandidateBindingV1,
  MailboxBrokerConnectionAppClient,
  MailboxBrokerScanBindingV1,
  MailboxBrokerUploadGrantRequestV1,
  MailboxBrokerUploadGrantV1,
  MailboxCandidateMetadataStagingResultV1,
  MailboxCandidateMetadataStagingV1,
  MailboxConnectionV1,
  MailboxIngestionAppClient,
  MailboxMaterializationResultV1,
  MailboxStructuredReceiptCallbackV1,
  TokenOperationLeaseV1,
} from "@expense-tax/contracts";
import { MAX_CANDIDATE_ATTACHMENTS, MailboxErrorCodeV1Schema, MAX_UPLOAD_BYTES } from "@expense-tax/contracts";
import { z } from "zod";

import {
  createMachineTokenProvider,
  MachineTokenError,
  type MachineTokenProviderOptions,
  type TokenProvider,
} from "./auth/machine-token.js";
import type { MachineCredentialConfig } from "./config.js";
import { AttachmentBoundError, pumpBoundedAttachment } from "./ingestion.js";

export type MailboxAppClientErrorCode =
  | "authentication_failed"
  | "authorization_failed"
  | "conflict"
  | "idempotency_conflict"
  | "invalid_request"
  | "invalid_response"
  | "not_found"
  | "rate_limited"
  | "request_failed"
  | "timeout"
  | "unavailable";

export class MailboxAppClientError extends Error {
  readonly code: MailboxAppClientErrorCode;
  readonly status: number | undefined;

  constructor(code: MailboxAppClientErrorCode, status?: number) {
    super(`App API request failed: ${code}`);
    this.name = "MailboxAppClientError";
    this.code = code;
    this.status = status;
  }

  /**
   * True for a *definitive* rejection -- the server is certain the
   * mutation did not and will not commit under the given lease/key
   * (confirmed CONFLICT or IDEMPOTENCY_CONFLICT, per the brief's
   * "VERSION_CONFLICT"/"IDEMPOTENCY_CONFLICT" language; App API's actual
   * advanceTokenGeneration -- Task 2 -- throws a generic CONFLICT for
   * every invalid-lease/version/generation case, not a distinct
   * VERSION_CONFLICT code, so CONFLICT is treated as that definitive
   * rejection here). Anything else (5xx, timeout, invalid_response,
   * network failure) is ambiguous and must be retried, never treated as
   * a rejection.
   */
  isDefinitiveRejection(): boolean {
    return this.code === "conflict" || this.code === "idempotency_conflict";
  }
}

const ConsumeResponseSchema = z.strictObject({
  connectionId: z.uuid(),
  attemptId: z.uuid(),
  redirectOrigin: z.string(),
});

const LeaseResponseSchema = z.strictObject({
  connectionId: z.uuid(),
  leaseId: z.uuid(),
  expiresAt: z.string(),
  expectedConnectionVersion: z.number().int(),
  currentTokenGeneration: z.number().int(),
});

const AdvanceResponseSchema = z.strictObject({
  connectionVersion: z.number().int(),
  tokenGeneration: z.number().int(),
  vaultReference: z.string(),
});

// completeConnection/recordRevocation response shapes mirror
// MailboxConnectionV1's own wire shape (public fields only).
const ConnectionResponseSchema = z.looseObject({
  schemaVersion: z.literal(1),
  id: z.uuid(),
  status: z.string(),
});

// Phase 3D-B Task 2 -- mirrors services/app-api/src/routes/mailbox-internal.ts's
// exact response shapes.
const ScanBindingResponseSchema = z.strictObject({
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

// Phase 3D-B Task 4 Step 3a -- mirrors routes/mailbox-internal.ts's
// candidate broker-binding response shape exactly.
const CandidateBrokerBindingResponseSchema = z.strictObject({
  candidateId: z.uuid(),
  connectionId: z.uuid(),
  expectedCandidateVersion: z.number().int(),
  providerMessageId: z.string(),
  providerThreadId: z.string().nullable(),
});

// Phase 3D-C Task 2 -- mirrors the (future App-side) ingestion routes'
// exact response shapes, per the canonical MailboxIngestionAppClient
// contract (@expense-tax/contracts/mailbox-ingestion.ts).
const UploadGrantResponseSchema = z.strictObject({
  candidateId: z.uuid(),
  connectionId: z.uuid(),
  uploadGrantId: z.string().trim().min(1),
  expiresAt: z.string(),
  // MAX_UPLOAD_BYTES is a computed expression (`25 * 1024 * 1024`), so TS
  // widens its const binding to `number`; cast back to the exact literal
  // MailboxBrokerUploadGrantV1.maxBytes requires (MAX_CANDIDATE_ATTACHMENTS
  // needs no cast -- it's declared as a literal token).
  maxBytes: z.literal(MAX_UPLOAD_BYTES as 26214400),
  maxAttachments: z.literal(MAX_CANDIDATE_ATTACHMENTS),
});

const AttachmentUploadResponseSchema = z.strictObject({
  candidateId: z.uuid(),
  attachmentIndex: z.number().int(),
  fileId: z.string().trim().min(1),
  status: z.enum(["READY", "REVIEW", "FAILED"]),
  errorCode: MailboxErrorCodeV1Schema.nullable(),
  idempotencyKey: z.string().trim().min(1),
});

const MaterializationResultResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  candidateId: z.uuid(),
  status: z.enum(["queued", "processed", "duplicate", "review", "failed"]),
  processingJobId: z.uuid().nullable(),
  expenseId: z.uuid().nullable(),
  sourceId: z.uuid().nullable(),
  duplicateMatchId: z.uuid().nullable(),
  idempotencyKey: z.string().trim().min(1),
});

const CandidatePagesResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scanRunId: z.uuid(),
  pageSequence: z.number().int(),
  candidateIds: z.array(z.uuid()),
  counts: z.strictObject({
    discovered: z.number().int(),
    staged: z.number().int(),
    review: z.number().int(),
    failed: z.number().int(),
  }),
});

export interface MailboxAppClientConfig {
  readonly baseUrl: string;
  readonly issuerUrl: string;
  readonly jwksUrl: string;
  readonly credentials: MachineCredentialConfig;
}

export interface MailboxAppClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly tokenProvider?: TokenProvider;
  readonly machineTokenOptions?: Pick<
    MachineTokenProviderOptions,
    "endpoint" | "keyResolver" | "jwksFetch" | "nowSeconds"
  >;
}

// Phase 3D-B Task 4 Step 3a (fix round 1, review Important #4) -- the
// plan's exact wording: the broker-binding route is "authenticated as
// mailbox-broker-app with mailbox:materialize". MailboxBrokerMaterializeAppClient
// is canonicalized in @expense-tax/contracts (./mailbox-discovery.ts) as of
// Phase 3D-C Task 1, so Phase 3D-C's MailboxIngestionAppClient can extend
// it directly; imported above rather than declared locally.

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

const ErrorBodySchema = z.object({
  error: z.object({ code: z.string().optional() }).optional(),
});

function errorCodeForStatus(status: number, bodyCode: string | undefined): MailboxAppClientErrorCode {
  if (status === 409 && bodyCode === "IDEMPOTENCY_CONFLICT") return "idempotency_conflict";
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

/**
 * Phase 3D-C Task 2 -- backs `pumpBoundedAttachment`'s push-based
 * `StreamTarget` with a platform `TransformStream`, whose writer's
 * `write()` genuinely respects the readable side's consumption
 * (backpressure), so a slow App API response naturally slows the
 * broker's own read from `source` -- no custom buffering/queueing code
 * needed (ladder step 4: native platform feature).
 */
function createHttpUploadTarget(): {
  readonly readable: ReadableStream<Uint8Array>;
  readonly write: (chunk: Buffer) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly close: () => Promise<void>;
} {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  return {
    readable,
    write: (chunk) => writer.write(chunk),
    // Fix round 1 (review Important #1) -- `readable.cancel()` is the
    // one operation proven (by direct experiment) to unblock a pending
    // `writer.write()` in every reachable state, including when no
    // consumer ever attached a reader at all; it also settles promptly
    // even if the stream is already locked (rejecting fast with "stream
    // is locked" rather than hanging), so it is safe to await.
    // `writer.abort()` is attempted too for good hygiene, but NOT
    // awaited: if an external consumer locked a reader and then simply
    // stops reading without ever releasing it, `abort()` itself can
    // hang indefinitely, and cleanup must never block on that.
    abort: () => {
      void writer.abort(new Error("attachment stream aborted")).catch(() => undefined);
      return readable.cancel(new Error("attachment stream aborted")).then(
        () => undefined,
        () => undefined,
      );
    },
    // Closing signals EOF to the readable side (the fetch body) -- a
    // consumer's read() would otherwise hang forever waiting for more
    // data or a close that never comes.
    close: () => writer.close(),
  };
}

export function createMailboxAppClient(
  config: MailboxAppClientConfig,
  options: MailboxAppClientOptions = {},
): MailboxBrokerConnectionAppClient & MailboxIngestionAppClient {
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const tokenProvider =
    options.tokenProvider ??
    createMachineTokenProvider(
      {
        issuerUrl: config.issuerUrl,
        jwksUrl: config.jwksUrl,
        credentials: config.credentials,
        // Fix round 1 (review Important #4) -- "mailbox:materialize"
        // added alongside "mailbox:write": same principal
        // (mailbox-broker-app), same single token, multiple scopes --
        // same precedent as workflow-worker's own mailbox token
        // providers (clients/mailbox-client.ts: ["mailbox:discover",
        // "mailbox:materialize"] together).
        scopes: ["mailbox:write", "mailbox:materialize"],
      },
      { fetch: fetchImplementation, ...options.machineTokenOptions },
    );

  async function requestJson<T>(input: {
    readonly path: string;
    readonly method: "POST";
    readonly responseSchema: z.ZodType<T>;
    readonly body?: unknown;
    readonly allowEmptyBody?: boolean;
  }): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      const token = await withAbort(tokenProvider(), signal);
      response = await fetchImplementation(`${config.baseUrl}${input.path}`, {
        method: input.method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input.body ?? {}),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (error instanceof MailboxAppClientError) throw error;
      if (error instanceof MachineTokenError) {
        throw new MailboxAppClientError(
          error.code === "timeout"
            ? "timeout"
            : error.code === "acquisition_failed"
              ? "unavailable"
              : "authentication_failed",
        );
      }
      throw new MailboxAppClientError(signal.aborted ? "timeout" : "unavailable");
    }

    if (!response.ok) {
      let bodyCode: string | undefined;
      try {
        const body = await withAbort(response.json(), signal);
        bodyCode = ErrorBodySchema.parse(body).error?.code;
      } catch {
        bodyCode = undefined;
      } finally {
        await discardResponseBody(response, signal);
      }
      throw new MailboxAppClientError(
        errorCodeForStatus(response.status, bodyCode),
        response.status,
      );
    }

    if (input.allowEmptyBody && response.status === 204) {
      await discardResponseBody(response, signal);
      return undefined as T;
    }

    try {
      const body = await withAbort(response.json(), signal);
      return input.responseSchema.parse(body);
    } catch {
      await discardResponseBody(response, signal);
      throw new MailboxAppClientError(
        signal.aborted ? "timeout" : "invalid_response",
        response.status,
      );
    }
  }

  return {
    async consumeOAuthAttempt(input) {
      const result = await requestJson({
        path: `/internal/v1/mailbox/oauth/attempts/${input.attemptId}/consume`,
        method: "POST",
        responseSchema: ConsumeResponseSchema,
        body: {
          connectionId: input.connectionId,
          stateDigest: input.stateDigest,
          sessionNonceDigest: input.sessionNonceDigest,
          requestId: input.attemptId,
        },
      });
      void result;
      // Task 2's real endpoint returns {connectionId, attemptId,
      // redirectOrigin} -- no connectionVersion (task-2-report.md Ruling
      // 4: the plan's illustrative consumeOAuthAttempt/connectionVersion
      // contract diverges from the brief Task 2 actually implemented,
      // consumeOAuthState, which never returns one). This method's own
      // signature is fixed by @expense-tax/contracts'
      // MailboxBrokerConnectionAppClient (the plan's canonical shape), so
      // `connectionVersion` here is a documented placeholder, not a real
      // value -- oauth-state.ts (this task) never reads it from this
      // method's result; it acquires a fresh connection version from
      // `acquireTokenOperationLease`'s own `expectedConnectionVersion`
      // whenever a later CAS actually needs one.
      return { status: "consumed", connectionVersion: 0 };
    },

    async completeConnection(input): Promise<MailboxConnectionV1> {
      const connectedAccount: ConnectedAccount = {
        providerAccountId: input.providerAccountId,
        email: input.email,
        grantedScopes: input.grantedScopes,
        initialHistoryId: input.initialHistoryId,
        vaultReference: input.vaultReference,
        tokenGeneration: input.tokenGeneration,
      };
      const result = await requestJson({
        path: `/internal/v1/mailbox/oauth/attempts/${input.attemptId}/complete`,
        method: "POST",
        responseSchema: ConnectionResponseSchema,
        body: {
          connectionId: input.connectionId,
          providerAccountId: connectedAccount.providerAccountId,
          accountEmail: connectedAccount.email,
          grantedScopes: connectedAccount.grantedScopes,
          initialHistoryId: connectedAccount.initialHistoryId,
          vaultReference: connectedAccount.vaultReference,
          tokenGeneration: connectedAccount.tokenGeneration,
          requestId: input.attemptId,
        },
      });
      return result as unknown as MailboxConnectionV1;
    },

    async acquireTokenOperationLease(input): Promise<TokenOperationLeaseV1> {
      return requestJson({
        path: `/internal/v1/mailbox/connections/${input.connectionId}/token-operations/lease`,
        method: "POST",
        responseSchema: LeaseResponseSchema,
        body: { operationId: input.operationId, ttlSeconds: input.ttlSeconds },
      });
    },

    async advanceTokenGeneration(input: AdvanceTokenGenerationInput): Promise<AdvanceTokenGenerationResult> {
      return requestJson({
        path: `/internal/v1/mailbox/connections/${input.connectionId}/token-operations/advance`,
        method: "POST",
        responseSchema: AdvanceResponseSchema,
        body: {
          leaseId: input.leaseId,
          expectedConnectionVersion: input.expectedConnectionVersion,
          newGeneration: input.newGeneration,
          vaultReference: input.vaultReference,
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
        },
      });
    },

    async releaseTokenOperationLease(input): Promise<void> {
      await requestJson({
        path: `/internal/v1/mailbox/connections/${input.connectionId}/token-operations/release`,
        method: "POST",
        responseSchema: z.undefined(),
        body: { leaseId: input.leaseId },
        allowEmptyBody: true,
      });
    },

    async recordRevocation(input): Promise<MailboxConnectionV1> {
      const result = await requestJson({
        path: `/internal/v1/mailbox/connections/${input.connectionId}/revoke`,
        method: "POST",
        responseSchema: ConnectionResponseSchema,
        body: { operationId: input.operationId, status: input.status },
      });
      return result as unknown as MailboxConnectionV1;
    },

    async loadScanBinding(scanRunId): Promise<MailboxBrokerScanBindingV1> {
      return requestJson({
        path: `/internal/v1/mailbox/scan-runs/${scanRunId}/broker-binding`,
        method: "POST",
        responseSchema: ScanBindingResponseSchema,
        body: {},
      });
    },

    async loadCandidateBinding(candidateId): Promise<MailboxBrokerCandidateBindingV1> {
      return requestJson({
        path: `/internal/v1/mailbox/candidates/${candidateId}/broker-binding`,
        method: "POST",
        responseSchema: CandidateBrokerBindingResponseSchema,
        body: {},
      });
    },

    async stageCandidateMetadata(
      input: MailboxCandidateMetadataStagingV1,
    ): Promise<MailboxCandidateMetadataStagingResultV1> {
      return requestJson({
        path: `/internal/v1/mailbox/scan-runs/${input.scanRunId}/candidate-pages`,
        method: "POST",
        responseSchema: CandidatePagesResponseSchema,
        body: {
          connectionId: input.connectionId,
          expectedConnectionVersion: input.expectedConnectionVersion,
          cursorBeforeDigest: input.cursorBeforeDigest,
          preFenceToken: input.preFenceToken,
          pageSequence: input.pageSequence,
          nextHistoryId: input.nextHistoryId,
          nextPreFenceHistoryId: input.nextPreFenceHistoryId,
          nextHistoryPageToken: input.nextHistoryPageToken,
          messages: input.messages,
          idempotencyKey: input.idempotencyKey,
        },
      });
    },

    // Phase 3D-C Task 2 -- MailboxIngestionAppClient. Scope reuse ruling:
    // these three routes are guarded under the broker's existing
    // "mailbox:write" scope (already minted above), not a new scope --
    // no new Clerk scope is provisioned anywhere in this phase's tasks,
    // and nothing here needs a narrower grant than the write scope the
    // discovery-staging routes already use.
    async issueUploadGrant(input: MailboxBrokerUploadGrantRequestV1): Promise<MailboxBrokerUploadGrantV1> {
      return requestJson({
        path: `/internal/v1/mailbox/candidates/${input.candidateId}/upload-grant`,
        method: "POST",
        responseSchema: UploadGrantResponseSchema,
        body: {
          expectedCandidateVersion: input.expectedCandidateVersion,
          operationId: input.operationId,
        },
      });
    },

    async uploadAttachment(
      input: MailboxBrokerAttachmentUploadV1,
      source: AsyncIterable<Buffer>,
    ): Promise<MailboxAttachmentUploadResultV1> {
      // Checked synchronously, before any I/O: pumpBoundedAttachment's
      // own check happens inside an async function, so by the time its
      // rejection could be observed here, fetchImplementation would
      // already have been called -- this mirrors that same bound (incl.
      // fix round 1's negative/non-integer rejection) so a known-bad
      // attachmentIndex never reaches the network at all.
      if (
        !Number.isInteger(input.attachmentIndex) ||
        input.attachmentIndex < 0 ||
        input.attachmentIndex >= MAX_CANDIDATE_ATTACHMENTS
      ) {
        throw new AttachmentBoundError(
          "ATTACHMENT_BOUND_EXCEEDED",
          `attachment index ${input.attachmentIndex} is not a valid 0-based index below the ${MAX_CANDIDATE_ATTACHMENTS}-attachment cap`,
        );
      }

      const target = createHttpUploadTarget();
      let closed = false;

      // pumpBoundedAttachment enforces the five-attachment/25-MiB bounds
      // and sniffs the real file type as bytes are streamed into
      // target.readable, which is passed directly as the fetch body.
      // Fix round 1 (review Important #1): a bare `.then`/`.catch` is
      // attached immediately so an abandoned pump (see the race below)
      // never surfaces as a Node "unhandled rejection" even though this
      // method may stop awaiting it.
      const pumpPromise = pumpBoundedAttachment({ attachmentIndex: input.attachmentIndex }, source, target).then(
        async (result) => {
          closed = true;
          await target.close();
          return result;
        },
      );
      pumpPromise.catch(() => undefined);

      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const token = await withAbort(tokenProvider(), signal);
        const fetchPromise = fetchImplementation(
          `${config.baseUrl}/internal/v1/mailbox/candidates/${input.candidateId}/attachments/${input.attachmentIndex}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/octet-stream",
              "x-mailbox-upload-grant-id": input.uploadGrantId,
              "x-mailbox-expected-candidate-version": String(input.expectedCandidateVersion),
              "x-mailbox-idempotency-key": input.idempotencyKey,
            },
            body: target.readable,
            duplex: "half",
            redirect: "error",
            signal,
          } as RequestInit,
        );
        fetchPromise.catch(() => undefined);

        // Fix round 1 (review Important #1) -- race, don't
        // unconditionally wait for both: a response that never consumes
        // target.readable (or a token/fetch failure before the pump
        // even starts) would otherwise leave pumpPromise's pending
        // write blocked forever, hanging this call. Whichever settles
        // first decides the outcome; the other side is abandoned/
        // aborted rather than waited on.
        type RaceOutcome =
          | { readonly kind: "pump"; readonly ok: true }
          | { readonly kind: "pump"; readonly ok: false; readonly error: unknown }
          | { readonly kind: "fetch"; readonly ok: true; readonly response: Response }
          | { readonly kind: "fetch"; readonly ok: false; readonly error: unknown };

        const first = await Promise.race<RaceOutcome>([
          pumpPromise.then(
            (): RaceOutcome => ({ kind: "pump", ok: true }),
            (error: unknown): RaceOutcome => ({ kind: "pump", ok: false, error }),
          ),
          fetchPromise.then(
            (response): RaceOutcome => ({ kind: "fetch", ok: true, response }),
            (error: unknown): RaceOutcome => ({ kind: "fetch", ok: false, error }),
          ),
        ]);

        let response: Response;
        if (first.kind === "pump") {
          if (!first.ok) throw first.error;
          // Pump finished (closed the target) before fetch responded --
          // fetch is now unblocked and should settle promptly.
          try {
            response = await fetchPromise;
          } catch {
            throw new MailboxAppClientError(signal.aborted ? "timeout" : "unavailable");
          }
        } else {
          // Fetch already produced a definitive result (success or
          // failure) -- never wait on a pump that may never get a
          // reader to unblock it.
          if (!closed) void target.abort();
          if (!first.ok) throw new MailboxAppClientError(signal.aborted ? "timeout" : "unavailable");
          response = first.response;
        }

        if (!response.ok) {
          let bodyCode: string | undefined;
          try {
            const body = await withAbort(response.json(), signal);
            bodyCode = ErrorBodySchema.parse(body).error?.code;
          } catch {
            bodyCode = undefined;
          } finally {
            await discardResponseBody(response, signal);
          }
          throw new MailboxAppClientError(errorCodeForStatus(response.status, bodyCode), response.status);
        }

        try {
          const body = await withAbort(response.json(), signal);
          return AttachmentUploadResponseSchema.parse(body);
        } catch {
          await discardResponseBody(response, signal);
          throw new MailboxAppClientError(signal.aborted ? "timeout" : "invalid_response", response.status);
        }
      } finally {
        // Fix round 1 (review Important #1) -- every exit path (token
        // failure, fetch failure, a non-consuming response, or a
        // successful parse) ends up here; abort/cancel the stream
        // unless the pump already closed it normally.
        if (!closed) void target.abort();
      }
    },

    async submitStructuredResult(
      input: MailboxStructuredReceiptCallbackV1,
    ): Promise<MailboxMaterializationResultV1> {
      return requestJson({
        path: `/internal/v1/mailbox/candidates/${input.result.candidateId}/structured-result`,
        method: "POST",
        responseSchema: MaterializationResultResponseSchema,
        body: {
          result: input.result,
          idempotencyKey: input.idempotencyKey,
        },
      });
    },
  };
}
