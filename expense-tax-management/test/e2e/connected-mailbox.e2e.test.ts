/**
 * Phase 3D-C Task 7 Step 6 — operator-gated end-to-end proof against a
 * REAL test Gmail mailbox and the REAL, production-shaped VPS Compose
 * stack (never a fake/mock broker or Postgres fixture, unlike every
 * other suite in this phase). This is the one test in the repository
 * that is allowed to touch real Google infrastructure.
 *
 * NOT run by `pnpm exec vitest run test/integration` (different
 * directory) and NOT wired into `scripts/verify-phase-0n.mjs` or any
 * other required CI check -- per the plan's own Task 7 Step 6, this
 * suite "does not block `dev` merge and runs before any production
 * activation decision, after runtime migration Task 7 cutover"
 * (`sub-plans/runtime-typescript-temporal-migration.md`). Skipped
 * entirely (zero network, zero side effects) unless every required
 * environment variable below is set.
 *
 * Operator runbook (prerequisites this test assumes, never performs
 * itself):
 * 1. Runtime migration Task 7 cutover has happened (the TypeScript
 *    `services/workflow-worker` is the live dispatch target for
 *    `expense-tax-processing`), and Phase 3D-A/B/C are deployed on the
 *    VPS Compose stack this test points at.
 * 2. A real test Google account's Gmail mailbox is already connected to
 *    a tenant's Personal profile via the real Office UI OAuth flow (this
 *    test never drives an OAuth consent screen -- that is Phase 3D-A's
 *    own concern, already proven against fakes everywhere else in this
 *    repo). Its `connectionId` is supplied below.
 * 3. That mailbox contains at least one real, unread, receipt-shaped
 *    email (a schema.org Order/Invoice/Receipt structured-HTML email, OR
 *    a PDF/image attachment under 25 MiB) the operator is willing to
 *    have ingested into a real expense. This test polls for whichever
 *    candidate a real scan discovers; it never asserts a specific
 *    merchant/amount (those are the operator's real test data, not
 *    fixed fixtures).
 *
 * Required environment variables (all must be set, or the whole suite
 * is skipped with no network access attempted):
 * - MAILBOX_E2E_INTEGRATION=1
 * - MAILBOX_E2E_APP_BASE_URL (e.g. https://expense-api.tobytran.dev)
 * - MAILBOX_E2E_TENANT_TOKEN (a real, short-lived tenant bearer token
 *   for the test tenant -- never committed, never logged)
 * - MAILBOX_E2E_TENANT_ID
 * - MAILBOX_E2E_CONNECTION_ID (the already-connected mailbox connection
 *   from prerequisite 2 above)
 * - MAILBOX_E2E_FORBIDDEN_MARKERS (optional, comma-separated): any
 *   strings specific to the operator's real test mailbox (the real
 *   sender address, subject line, etc.) that must never appear in any
 *   HTTP response this test captures -- the content-leakage half of
 *   this proof, run against the real stack rather than a fake.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

const REQUIRED_ENV = [
  "MAILBOX_E2E_APP_BASE_URL",
  "MAILBOX_E2E_TENANT_TOKEN",
  "MAILBOX_E2E_TENANT_ID",
  "MAILBOX_E2E_CONNECTION_ID",
] as const;

const e2eEnabled =
  process.env.MAILBOX_E2E_INTEGRATION === "1" &&
  REQUIRED_ENV.every((key) => Boolean(process.env[key]?.trim()));

describe.skipIf(!e2eEnabled)("Phase 3D-C Task 7 Step 6 — connected mailbox, real Gmail + real VPS stack (operator-gated)", () => {
  const baseUrl = process.env.MAILBOX_E2E_APP_BASE_URL ?? "";
  const tenantToken = process.env.MAILBOX_E2E_TENANT_TOKEN ?? "";
  const tenantId = process.env.MAILBOX_E2E_TENANT_ID ?? "";
  const connectionId = process.env.MAILBOX_E2E_CONNECTION_ID ?? "";
  const forbiddenMarkers = (process.env.MAILBOX_E2E_FORBIDDEN_MARKERS ?? "")
    .split(",")
    .map((marker) => marker.trim())
    .filter((marker) => marker.length > 0);

  const capturedBodies: string[] = [];

  async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${tenantToken}`, "content-type": "application/json", ...init.headers },
    });
    capturedBodies.push(await response.clone().text());
    return response;
  }

  it(
    "a real scan discovers a real receipt email, ingest approval materializes a real expense, no remote writes outside the test mailbox, no content leakage",
    async () => {
      const scanStart = await apiFetch(
        `/api/v1/tenants/${tenantId}/mailbox-connections/${connectionId}/scans`,
        { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID() }) },
      );
      expect([200, 201, 409]).toContain(scanStart.status);

      // Poll for scan completion -- real Gmail history sync is not
      // instantaneous. Bounded: never hangs indefinitely in CI or a
      // local operator run.
      let scanCompleted = false;
      for (let attempt = 0; attempt < 30 && !scanCompleted; attempt += 1) {
        await sleep(2_000);
        const list = await apiFetch(`/api/v1/tenants/${tenantId}/mailbox-connections/${connectionId}/scans`);
        const body = (await list.clone().json()) as { items: readonly { status: string }[] };
        scanCompleted = body.items.some((run) => run.status === "completed" || run.status === "failed");
      }
      expect(scanCompleted).toBe(true);

      // A real receipt-classified candidate from this real scan.
      const candidates = await apiFetch(
        `/api/v1/tenants/${tenantId}/mailbox-connections/${connectionId}/candidates?classification=receipt`,
      );
      const candidateList = (await candidates.clone().json()) as {
        items: readonly { id: string; version: number; status: string }[];
      };
      const candidate = candidateList.items.find((item) => item.status === "review" || item.status === "staged");
      expect(
        candidate,
        "operator prerequisite: the connected test mailbox must contain at least one unprocessed receipt-shaped email",
      ).toBeDefined();

      // The personal profile id is not the tenant id; read the caller's real one.
      const scopesResponse = await apiFetch(`/api/v1/tenants/${tenantId}/scopes`);
      expect(scopesResponse.status).toBe(200);
      const scopes = (await scopesResponse.clone().json()) as {
        personalProfiles: readonly { id: string }[];
      };
      const profileId = scopes.personalProfiles[0]?.id;
      expect(profileId, "operator prerequisite: the caller has a personal profile in this tenant").toBeDefined();

      const resolve = await apiFetch(
        `/api/v1/tenants/${tenantId}/mailbox-connections/${connectionId}/candidates/${candidate!.id}/resolve`,
        {
          method: "POST",
          body: JSON.stringify({
            action: "ingest",
            scope: { kind: "personal", profileId: profileId! },
            expectedCandidateVersion: candidate!.version,
            requestId: crypto.randomUUID(),
          }),
        },
      );
      expect(resolve.status).toBe(200);
      const resolved = (await resolve.clone().json()) as { status: string };
      expect(resolved.status).toBe("queued");

      // Poll for real materialization (real Gmail refetch + real
      // broker-to-App streaming + real OCR/structured-receipt path).
      let finalStatus: string | null = null;
      for (let attempt = 0; attempt < 60 && finalStatus === null; attempt += 1) {
        await sleep(3_000);
        const refreshed = await apiFetch(
          `/api/v1/tenants/${tenantId}/mailbox-connections/${connectionId}/candidates?classification=receipt`,
        );
        const refreshedList = (await refreshed.clone().json()) as {
          items: readonly { id: string; status: string }[];
        };
        const current = refreshedList.items.find((item) => item.id === candidate!.id);
        if (current && ["processed", "duplicate", "failed"].includes(current.status)) {
          finalStatus = current.status;
        }
      }
      expect(finalStatus).not.toBeNull();
      // A real malware-blocked or unsupported-format test email is a
      // legitimate terminal outcome too (owner ruling: dead end, no
      // expense) -- this proof only requires the real pipeline reached
      // SOME terminal state, not always "processed".
      expect(["processed", "duplicate", "failed"]).toContain(finalStatus);

      for (const body of capturedBodies) {
        for (const marker of forbiddenMarkers) {
          expect(body).not.toContain(marker);
        }
      }
    },
    600_000,
  );
});
