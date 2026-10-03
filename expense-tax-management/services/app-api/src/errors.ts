import type { FastifyError, FastifyInstance } from "fastify";

export type DomainErrorCode =
  | "CONFLICT"
  | "FORBIDDEN"
  | "GONE"
  | "IDEMPOTENCY_CONFLICT"
  | "NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "UNAUTHENTICATED"
  | "VALIDATION_ERROR";

export class DomainError extends Error {
  private constructor(
    readonly code: DomainErrorCode,
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 410 | 412,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }

  static unauthenticated(): DomainError {
    return new DomainError("UNAUTHENTICATED", 401, "Authentication required");
  }

  static forbidden(): DomainError {
    return new DomainError("FORBIDDEN", 403, "Access denied");
  }

  static notFound(): DomainError {
    return new DomainError("NOT_FOUND", 404, "Resource not found");
  }

  static conflict(): DomainError {
    return new DomainError(
      "CONFLICT",
      409,
      "Request conflicts with current state",
    );
  }

  static validation(): DomainError {
    return new DomainError("VALIDATION_ERROR", 400, "Request validation failed");
  }

  static gone(message = "Resource is no longer available"): DomainError {
    return new DomainError("GONE", 410, message);
  }

  static preconditionFailed(): DomainError {
    return new DomainError(
      "PRECONDITION_FAILED",
      412,
      "Request precondition failed",
    );
  }

  static idempotencyConflict(): DomainError {
    return new DomainError(
      "IDEMPOTENCY_CONFLICT",
      409,
      "Request conflicts with a prior operation using this idempotency key",
    );
  }
}

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}

function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
    },
  };
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(errorEnvelope("NOT_FOUND", "Route not found", request.id));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof DomainError) {
      request.log.info(
        {
          code: error.code,
          requestId: request.id,
          statusCode: error.statusCode,
        },
        "domain request rejected",
      );
      reply
        .code(error.statusCode)
        .send(errorEnvelope(error.code, error.message, request.id));
      return;
    }

    const statusCode =
      error.validation || error.statusCode === 400
        ? 400
        : error.statusCode && error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 500;
    const isInternalError = statusCode >= 500;

    request.log.error(
      { err: error, requestId: request.id, statusCode },
      "request failed",
    );

    reply.code(statusCode).send(
      errorEnvelope(
        isInternalError
          ? "INTERNAL_ERROR"
          : error.validation
            ? "VALIDATION_ERROR"
            : "REQUEST_ERROR",
        isInternalError
          ? "Internal server error"
          : error.validation
            ? "Request validation failed"
            : "Request failed",
        request.id,
      ),
    );
  });
}
