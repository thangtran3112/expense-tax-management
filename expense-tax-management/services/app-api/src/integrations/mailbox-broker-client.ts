/**
 * Phase 3D-A Task 2 — App API's outbound client to the mailbox broker.
 *
 * App API is the only caller of the broker's OAuth-start endpoint
 * (startConnection() needs an authorizationUrl before it can create an
 * attempt row). Presents a Clerk M2M token with exact subject
 * "app-api-mailbox" and the broker's configured audience. Mirrors the
 * request/error conventions of
 * services/workflow-worker/src/clients/app-api.ts.
 */
import type { OAuthStartInput, OAuthStartResult } from "@expense-tax/contracts";
import { z } from "zod";

import {
  createMachineTokenProvider,
  MachineTokenError,
  type MachineTokenProviderOptions,
  type TokenProvider,
} from "../auth/machine-token.js";
import type { MachineCredentialConfig } from "../config.js";

export type MailboxBrokerClientErrorCode =
  | "authentication_failed"
  | "authorization_failed"
  | "invalid_request"
  | "invalid_response"
  | "rate_limited"
  | "request_failed"
  | "timeout"
  | "unavailable";

export class MailboxBrokerClientError extends Error {
  readonly code: MailboxBrokerClientErrorCode;
  readonly status: number | undefined;

  constructor(code: MailboxBrokerClientErrorCode, status?: number) {
    super(`Mailbox broker request failed: ${code}`);
    this.name = "MailboxBrokerClientError";
    this.code = code;
    this.status = status;
  }
}

const OAuthStartResponseSchema = z.strictObject({
  authorizationUrl: z.string().trim().min(1),
  stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().trim().min(1),
  /**
   * Fix round 2 (Important) -- the broker's opaque, short-lived begin
   * ticket (`services/mailbox-broker/src/begin-ticket.ts`). App API never
   * decrypts or inspects it; it only forwards it, wrapped into a link to
   * the broker's own `/oauth/google/begin`, to Office.
   */
  beginTicket: z.string().trim().min(1),
});

export interface MailboxBrokerClientConfig {
  readonly baseUrl: string;
  readonly issuerUrl: string;
  readonly jwksUrl: string;
  readonly credentials: MachineCredentialConfig;
}

export interface MailboxBrokerClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly tokenProvider?: TokenProvider;
  readonly machineTokenOptions?: Pick<
    MachineTokenProviderOptions,
    "endpoint" | "keyResolver" | "jwksFetch" | "nowSeconds"
  >;
}

export interface MailboxBrokerClient {
  startOAuth(input: OAuthStartInput): Promise<OAuthStartResult & { readonly beginTicket: string }>;
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

function errorCodeForStatus(status: number): MailboxBrokerClientErrorCode {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "authentication_failed";
    case 403:
      return "authorization_failed";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "unavailable" : "request_failed";
  }
}

export function createMailboxBrokerClient(
  config: MailboxBrokerClientConfig,
  options: MailboxBrokerClientOptions = {},
): MailboxBrokerClient {
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const tokenProvider =
    options.tokenProvider ??
    createMachineTokenProvider(
      {
        issuerUrl: config.issuerUrl,
        jwksUrl: config.jwksUrl,
        credentials: config.credentials,
        scopes: ["mailbox:write"],
      },
      { fetch: fetchImplementation, ...options.machineTokenOptions },
    );

  return {
    async startOAuth(input) {
      const signal = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        const token = await withAbort(tokenProvider(), signal);
        response = await fetchImplementation(
          `${config.baseUrl}/internal/v1/mailbox/oauth/start`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(input),
            redirect: "error",
            signal,
          },
        );
      } catch (error) {
        if (error instanceof MailboxBrokerClientError) throw error;
        if (error instanceof MachineTokenError) {
          throw new MailboxBrokerClientError(
            error.code === "timeout"
              ? "timeout"
              : error.code === "acquisition_failed"
                ? "unavailable"
                : "authentication_failed",
          );
        }
        throw new MailboxBrokerClientError(signal.aborted ? "timeout" : "unavailable");
      }

      if (!response.ok) {
        await discardResponseBody(response, signal);
        throw new MailboxBrokerClientError(
          errorCodeForStatus(response.status),
          response.status,
        );
      }

      try {
        const body = await withAbort(response.json(), signal);
        return OAuthStartResponseSchema.parse(body);
      } catch {
        await discardResponseBody(response, signal);
        throw new MailboxBrokerClientError(
          signal.aborted ? "timeout" : "invalid_response",
          response.status,
        );
      }
    },
  };
}
