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

export interface MailboxAppApiClient {
  /** Mints (and caches) a Clerk M2M token scoped to the worker's mailbox identity, audience = App API. */
  mintAppToken(): Promise<string>;
  /** Mints (and caches) a Clerk M2M token scoped to the worker's mailbox identity, audience = the mailbox broker. */
  mintBrokerToken(): Promise<string>;
  /** Authenticated request against App API's mailbox routes (base URL from `config.services.appApiBaseUrl`). */
  requestAppApi<T>(input: MailboxApiRequestInput<T>): Promise<T>;
  /** Authenticated request directly against the mailbox broker (base URL from `config.services.mailboxBrokerBaseUrl`). */
  requestBroker<T>(input: MailboxApiRequestInput<T>): Promise<T>;
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

  const appTokenProvider =
    options.appTokenProvider ??
    createMachineTokenProvider(
      {
        issuerUrl: config.clerk.issuerUrl,
        jwksUrl: config.clerk.jwksUrl,
        credentials: config.clerk.mailboxApp,
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
        credentials: config.clerk.mailboxBroker,
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

  return {
    mintAppToken: appTokenProvider,
    mintBrokerToken: brokerTokenProvider,
    requestAppApi(input) {
      return request(config.services.appApiBaseUrl, appTokenProvider, input);
    },
    requestBroker(input) {
      return request(config.services.mailboxBrokerBaseUrl, brokerTokenProvider, input);
    },
  };
}
