/**
 * Phase 3D-A Task 4 — error-handler registration, mirroring app-api/
 * foundry-service's own `errors.ts` envelope shape (`{error:{code,message,
 * requestId}}`). Broker-specific: maps the known error classes Task 3
 * already defines (`ServiceAuthError`, `OAuthStateInvalidError`,
 * `MailboxAppClientError`) to the right HTTP status instead of a generic
 * 500, so a real auth/state/upstream rejection is never mislabeled as an
 * internal error.
 */
import type { FastifyError, FastifyInstance } from "fastify";

import { ServiceAuthError } from "./auth/clerk.js";
import { MailboxAppClientError } from "./app-client.js";
import { OAuthStateInvalidError } from "./oauth-state.js";
import { BeginTicketInvalidError } from "./begin-ticket.js";
import { GmailApiError } from "./discovery.js";

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}

function errorEnvelope(code: string, message: string, requestId: string): ErrorEnvelope {
  return { error: { code, message, requestId } };
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(errorEnvelope("NOT_FOUND", "Route not found", request.id));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ServiceAuthError) {
      reply.code(401).send(errorEnvelope("SERVICE_UNAUTHENTICATED", error.message, request.id));
      return;
    }

    if (error instanceof OAuthStateInvalidError) {
      reply.code(400).send(errorEnvelope("OAUTH_STATE_INVALID", error.message, request.id));
      return;
    }

    if (error instanceof BeginTicketInvalidError) {
      reply.code(400).send(errorEnvelope("BEGIN_TICKET_INVALID", error.message, request.id));
      return;
    }

    if (error instanceof MailboxAppClientError) {
      const statusCode = error.status && error.status >= 400 && error.status < 500 ? error.status : 502;
      reply.code(statusCode).send(errorEnvelope("APP_API_REQUEST_FAILED", error.message, request.id));
      return;
    }

    if (error instanceof GmailApiError) {
      const statusCode =
        error.code === "reauth_required" ? 409 : error.code === "rate_limited" ? 429 : 503;
      reply
        .code(statusCode)
        .send(errorEnvelope(`GOOGLE_${error.code.toUpperCase()}`, error.message, request.id));
      return;
    }

    const statusCode =
      error.validation || error.statusCode === 400
        ? 400
        : error.statusCode && error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 500;
    const isInternalError = statusCode >= 500;

    request.log.error({ err: error, requestId: request.id, statusCode }, "request failed");

    reply.code(statusCode).send(
      errorEnvelope(
        isInternalError ? "INTERNAL_ERROR" : error.validation ? "VALIDATION_ERROR" : "REQUEST_ERROR",
        isInternalError ? "Internal server error" : error.validation ? "Request validation failed" : "Request failed",
        request.id,
      ),
    );
  });
}
