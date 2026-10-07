import { createAppApiClient, type TenantScopes } from "@expense-tax/contracts";

import type { QueueItem } from "./queue";
import type { CaptureSession } from "./session";
import { getAppAuthorization, type ClerkGetToken } from "./clerk";

/**
 * Web session wiring design (2026-10-06) -- the Settings scope picker's
 * authorized choices: the caller's own personal profile (0 or 1) and
 * every active business they have a membership on.
 */
export async function fetchTenantScopes(
  session: CaptureSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
): Promise<TenantScopes> {
  const authorization = await getAppAuthorization(getToken, organizationId);
  const client = createAppApiClient(session.apiBaseUrl);
  const result = await client.GET("/api/v1/tenants/{tenantId}/scopes", {
    params: { path: { tenantId: session.tenantId } },
    headers: authorization,
  });
  if (!result.data) throw new Error("Could not load profiles");
  return result.data;
}

export async function uploadQueuedReceipt(
  session: CaptureSession,
  item: QueueItem,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  const authorization = await getAppAuthorization(getToken, organizationId);
  const client = createAppApiClient(session.apiBaseUrl);
  const body = {
    originalFilename: item.filename,
    contentType: item.contentType as
      | "image/jpeg"
      | "image/png"
      | "image/webp"
      | "application/pdf",
    expectedSizeBytes: item.file.size,
  };
  const idempotencyKey = `capture:${item.id}:file`;

  const created =
    session.scope.kind === "personal"
      ? await client.POST(
          "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/upload-sessions",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                profileId: session.scope.profileId,
              },
              header: { "idempotency-key": idempotencyKey },
            },
            headers: authorization,
            body,
          },
        )
      : await client.POST(
          "/api/v1/tenants/{tenantId}/businesses/{businessId}/files/upload-sessions",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                businessId: session.scope.businessId,
              },
              header: { "idempotency-key": idempotencyKey },
            },
            headers: authorization,
            body,
          },
        );
  if (created.error || !created.data) {
    throw new Error("Could not create upload session");
  }
  const target = created.data.uploadTarget;
  const put = await fetch(target.url, {
    method: "PUT",
    headers: target.requiredHeaders,
    body: item.file,
  });
  if (!put.ok) throw new Error(`Direct upload failed (${put.status})`);

  const confirm =
    session.scope.kind === "personal"
      ? await client.POST(
          "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/upload-sessions/{sessionId}/confirm",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                profileId: session.scope.profileId,
                sessionId: created.data.uploadSession.id,
              },
            },
            headers: authorization,
          },
        )
      : await client.POST(
          "/api/v1/tenants/{tenantId}/businesses/{businessId}/files/upload-sessions/{sessionId}/confirm",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                businessId: session.scope.businessId,
                sessionId: created.data.uploadSession.id,
              },
            },
            headers: authorization,
          },
        );
  if (confirm.error || !confirm.data) throw new Error("Could not confirm upload");

  const ocrIdempotencyKey = `capture:${item.id}:ocr`;
  const ocr =
    session.scope.kind === "personal"
      ? await client.POST(
          "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/{fileId}/ocr-jobs",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                profileId: session.scope.profileId,
                fileId: confirm.data.id,
              },
              header: { "idempotency-key": ocrIdempotencyKey },
            },
            headers: authorization,
            body: { modeKey: item.modeKey },
          },
        )
      : await client.POST(
          "/api/v1/tenants/{tenantId}/businesses/{businessId}/files/{fileId}/ocr-jobs",
          {
            params: {
              path: {
                tenantId: session.tenantId,
                businessId: session.scope.businessId,
                fileId: confirm.data.id,
              },
              header: { "idempotency-key": ocrIdempotencyKey },
            },
            headers: authorization,
            body: { modeKey: item.modeKey },
          },
        );
  if (ocr.error || !ocr.data) throw new Error("Could not start OCR");
  return { fileId: confirm.data.id, jobId: ocr.data.id };
}
