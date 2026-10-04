import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ErrorResponseSchema,
  HealthResponseSchema,
  HealthStatusSchema,
  JobReferenceV1Schema,
  ServiceNameSchema,
  type ErrorResponse,
  type HealthResponse,
  type HealthStatus,
  type JobReferenceV1,
  type ServiceName,
} from "../src/index.js";

const jobReferenceFixture: unknown = JSON.parse(
  readFileSync(
    new URL("../fixtures/job-reference-v1.json", import.meta.url),
    "utf8",
  ),
);

describe("system contracts", () => {
  it("accepts only supported service names and health statuses", () => {
    expect(ServiceNameSchema.parse("app-api")).toBe("app-api");
    expect(ServiceNameSchema.parse("foundry-service")).toBe("foundry-service");
    expect(HealthStatusSchema.parse("ok")).toBe("ok");
    expect(HealthStatusSchema.parse("degraded")).toBe("degraded");
    expect(ServiceNameSchema.safeParse("expense-service").success).toBe(false);
    expect(HealthStatusSchema.safeParse("healthy").success).toBe(false);
  });

  it("validates a strict health response", () => {
    expect(
      HealthResponseSchema.parse({
        status: "ok",
        service: "app-api",
        version: "0.1.0",
      }),
    ).toEqual({
      status: "ok",
      service: "app-api",
      version: "0.1.0",
    });
    expect(
      HealthResponseSchema.safeParse({
        status: "ok",
        service: "app-api",
        version: "0.1.0",
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("error contract", () => {
  it("validates a strict error envelope", () => {
    expect(
      ErrorResponseSchema.parse({
        error: {
          code: "not_found",
          message: "Resource not found",
          requestId: "request-123",
        },
      }),
    ).toEqual({
      error: {
        code: "not_found",
        message: "Resource not found",
        requestId: "request-123",
      },
    });
    expect(
      ErrorResponseSchema.safeParse({
        error: {
          code: "not_found",
          message: "Resource not found",
          requestId: "request-123",
          details: {},
        },
      }).success,
    ).toBe(false);
  });
});

describe("job reference contract", () => {
  it("accepts the canonical v1 fixture", () => {
    expect(JobReferenceV1Schema.parse(jobReferenceFixture)).toEqual(
      jobReferenceFixture,
    );
  });

  it("rejects extra keys, malformed UUIDs, and empty workflow identifiers", () => {
    expect(
      JobReferenceV1Schema.safeParse({
        ...(jobReferenceFixture as Record<string, unknown>),
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      JobReferenceV1Schema.safeParse({
        ...(jobReferenceFixture as Record<string, unknown>),
        jobId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      JobReferenceV1Schema.safeParse({
        ...(jobReferenceFixture as Record<string, unknown>),
        workflowType: "",
      }).success,
    ).toBe(false);
    expect(
      JobReferenceV1Schema.safeParse({
        ...(jobReferenceFixture as Record<string, unknown>),
        workflowId: "",
      }).success,
    ).toBe(false);
  });
});

describe("inferred types", () => {
  it("match the transport primitives", () => {
    expectTypeOf<ServiceName>().toEqualTypeOf<
      "app-api" | "foundry-service"
    >();
    expectTypeOf<HealthStatus>().toEqualTypeOf<"ok" | "degraded">();
    expectTypeOf<HealthResponse>().toEqualTypeOf<{
      status: "ok" | "degraded";
      service: "app-api" | "foundry-service";
      version: string;
    }>();
    expectTypeOf<ErrorResponse>().toEqualTypeOf<{
      error: {
        code: string;
        message: string;
        requestId: string;
      };
    }>();
    expectTypeOf<JobReferenceV1>().toEqualTypeOf<{
      schemaVersion: 1;
      jobId: string;
      workflowType:
        | "FoundationEchoWorkflow"
        | "OcrReceiptWorkflow"
        | "ForwardedReceiptWorkflow"
        | "ExpenseEnrichmentWorkflow"
        | "MailboxScanWorkflow";
      workflowId: string;
    }>();
  });
});
