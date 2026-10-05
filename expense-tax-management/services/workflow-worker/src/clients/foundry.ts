import {
  AiQuotaReservationCreateRequestSchema,
  AiQuotaReservationSchema,
  EffectiveRouteQuerySchema,
  EffectiveRouteResponseSchema,
  ProviderCallOutcomeRequestSchema,
  ProviderCallStartedRequestSchema,
  type AiQuotaReservation,
  type AiQuotaReservationCreateRequest,
  type EffectiveRouteQuery,
  type EffectiveRouteResponse,
  type ProviderCallOutcomeRequest,
  type ProviderCallStartedRequest,
} from "@expense-tax/contracts";
import { z } from "zod";

import {
  createMachineTokenProvider,
  MachineTokenError,
  type TokenProvider,
} from "../auth/machine-token.js";
import type { WorkerConfig } from "../config.js";

export type FoundryClientErrorCode =
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

export class FoundryClientError extends Error {
  readonly code: FoundryClientErrorCode;
  readonly status: number | undefined;

  constructor(code: FoundryClientErrorCode, status?: number) {
    super(`Foundry request failed: ${code}`);
    this.name = "FoundryClientError";
    this.code = code;
    this.status = status;
  }
}

interface FoundryTokenProviders {
  readonly routes: TokenProvider;
  readonly reservations: TokenProvider;
}

export interface FoundryClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly tokenProviders?: FoundryTokenProviders;
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

function errorCodeForStatus(status: number): FoundryClientErrorCode {
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

export interface FoundryClient {
  getEffectiveRoute(query: EffectiveRouteQuery): Promise<EffectiveRouteResponse>;
  reserve(request: AiQuotaReservationCreateRequest): Promise<AiQuotaReservation>;
  markCallStarted(
    reservationId: string,
    request?: ProviderCallStartedRequest,
  ): Promise<AiQuotaReservation>;
  recordOutcome(
    reservationId: string,
    attemptNumber: number,
    request: ProviderCallOutcomeRequest,
  ): Promise<AiQuotaReservation>;
  release(reservationId: string): Promise<AiQuotaReservation>;
}

export function createFoundryClient(
  config: WorkerConfig,
  options: FoundryClientOptions = {},
): FoundryClient {
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const tokenProviders =
    options.tokenProviders ??
    {
      routes: createMachineTokenProvider(
        {
          issuerUrl: config.clerk.issuerUrl,
          jwksUrl: config.clerk.jwksUrl,
          credentials: config.clerk.foundry,
          scopes: ["routes:read"],
        },
        { fetch: fetchImplementation },
      ),
      reservations: createMachineTokenProvider(
        {
          issuerUrl: config.clerk.issuerUrl,
          jwksUrl: config.clerk.jwksUrl,
          credentials: config.clerk.foundry,
          scopes: ["reservations:write"],
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
        `${config.services.foundryBaseUrl}${input.path}`,
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
      if (error instanceof FoundryClientError) throw error;
      if (error instanceof MachineTokenError) {
        throw new FoundryClientError(
          error.code === "timeout"
            ? "timeout"
            : error.code === "acquisition_failed"
              ? "unavailable"
              : "authentication_failed",
        );
      }
      throw new FoundryClientError(signal.aborted ? "timeout" : "unavailable");
    }

    if (!response.ok) {
      await discardResponseBody(response, signal);
      throw new FoundryClientError(
        errorCodeForStatus(response.status),
        response.status,
      );
    }

    try {
      const body = await withAbort(response.json(), signal);
      return input.responseSchema.parse(body);
    } catch {
      await discardResponseBody(response, signal);
      throw new FoundryClientError(
        signal.aborted ? "timeout" : "invalid_response",
        response.status,
      );
    }
  }

  return {
    getEffectiveRoute(query) {
      const parsed = EffectiveRouteQuerySchema.parse(query);
      const search = new URLSearchParams({
        operation: parsed.operation,
        modeKey: parsed.modeKey,
      });
      return requestJson({
        path: `/internal/v1/effective-route?${search.toString()}`,
        method: "GET",
        token: tokenProviders.routes,
        responseSchema: EffectiveRouteResponseSchema,
      });
    },
    reserve(request) {
      const body = AiQuotaReservationCreateRequestSchema.parse(request);
      return requestJson({
        path: "/internal/v1/ai-quota-reservations",
        method: "POST",
        token: tokenProviders.reservations,
        responseSchema: AiQuotaReservationSchema,
        body,
      });
    },
    markCallStarted(reservationId, request = {}) {
      const id = z.uuid().parse(reservationId);
      const body = ProviderCallStartedRequestSchema.parse(request);
      return requestJson({
        path: `/internal/v1/ai-quota-reservations/${id}/call-started`,
        method: "POST",
        token: tokenProviders.reservations,
        responseSchema: AiQuotaReservationSchema,
        body,
      });
    },
    recordOutcome(reservationId, attemptNumber, request) {
      const id = z.uuid().parse(reservationId);
      const attempt = z.int().positive().parse(attemptNumber);
      const body = ProviderCallOutcomeRequestSchema.parse(request);
      return requestJson({
        path: `/internal/v1/ai-quota-reservations/${id}/attempts/${attempt}/outcome`,
        method: "POST",
        token: tokenProviders.reservations,
        responseSchema: AiQuotaReservationSchema,
        body,
      });
    },
    release(reservationId) {
      const id = z.uuid().parse(reservationId);
      return requestJson({
        path: `/internal/v1/ai-quota-reservations/${id}/release`,
        method: "POST",
        token: tokenProviders.reservations,
        responseSchema: AiQuotaReservationSchema,
      });
    },
  };
}
