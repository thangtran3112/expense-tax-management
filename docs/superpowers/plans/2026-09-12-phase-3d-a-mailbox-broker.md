# Phase 3D-A Mailbox Broker and Connection Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Not started; blocked by Phase 3C. Execute first within Phase 3D from a fresh `feature/*` worktree based on current `origin/dev`.

**Goal:** Build protected Gmail connection lifecycle, a VPS-container mailbox broker in the Expense production Compose, App-owned connection metadata, OAuth state consumption, PostgreSQL token-vault CAS, and Office mailbox administration base.

**Architecture:** App API owns tenant/scope authorization, connection records, OAuth attempt state, reviewer grants, and all persisted customer metadata. Broker owns Google OAuth, provider calls, short-lived credentials, and its own PostgreSQL token-vault database. Temporal and the TypeScript workflow worker are not involved in OAuth or mailbox credential handling.

**Tech Stack:** Node 24 TypeScript Fastify, `googleapis`, Kysely/PostgreSQL (token vault), Node `crypto` (AES-256-GCM), `jose`, Zod, Clerk M2M JWTs, Docker Compose on the existing VPS, Next.js 16 React 19 Office Web, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md`

## Global Constraints

- Phase 3C must be complete before Phase 3D migrations. Phase 3C owns App migration `016`; runtime migration Task 7 Stage A owns `017`; 3D-A owns `018`, 3D-B owns `019`, and 3D-C owns `020`.
- Public provider enum is `"gmail" | "outlook"`; only Gmail adapter exists. App and broker reject `outlook` with typed `PROVIDER_UNSUPPORTED`.
- Gmail scope is exactly `https://www.googleapis.com/auth/gmail.readonly`; no mailbox modification, Pub/Sub, Outlook implementation, live LLM, or static GCP key.
- Mailbox broker is a container in the Expense production Compose on the existing VPS, loopback port, no public ingress except the OAuth callback through the existing Cloudflare Tunnel. It has no GCP identity. Its own PostgreSQL token-vault database/roles are created only by an explicit operator-only bootstrap step, never by normal deploy (same pattern as Temporal DB bootstrap).
- Tokens, authorization codes, PKCE verifiers, client secrets, raw state, mailbox body, MIME, provider error bodies, and sensitive query strings never enter App PostgreSQL, Temporal, browser storage, logs, or VPS files in plaintext. Refresh tokens exist as AES-256-GCM ciphertext (nonce, key ID, generation) only in the broker's token-vault database.
- Exact machine subjects: `app-api-mailbox`, `workflow-worker-mailbox`, `mailbox-broker-app`. The TypeScript workflow worker uses existing App audience with subject `workflow-worker-mailbox` and route scopes `mailbox:discover`, `mailbox:materialize`.
- Remote writes require explicit execution-time confirmation immediately before Clerk provisioning, VPS deploy, or token-vault database/role bootstrap commands. No opaque IDs are invented.
- File ownership: 3D-A creates broker base, worker client/auth base, App mailbox base, Office mailbox page/API base. 3D-B modifies those files only where scan/review integration requires it. 3D-C modifies them only for ingestion status; each later plan creates only its own new modules.
- Every write has permanent uniqueness `(tenant_id, operation_key, idempotency_key, normalized_request_hash)` and replay returns original result; same key with different payload returns typed conflict.

---

## Canonical A Contracts

These names and field meanings are immutable inputs for 3D-B and 3D-C.

```ts
export type MailboxProvider = "gmail" | "outlook";
export type MailboxScope =
  | { readonly kind: "personal"; readonly personalProfileId: string }
  | { readonly kind: "business"; readonly businessId: string };
export type MailboxConnectionStatus =
  | "pending" | "active" | "paused" | "reauth_required"
  | "disconnecting" | "revocation_pending" | "revoked";
export type MailboxErrorCodeV1 =
  | "ENTITLEMENT_DISABLED" | "SCOPE_ACCESS_DENIED" | "CONNECTION_NOT_FOUND"
  | "PROVIDER_UNSUPPORTED" | "OAUTH_ATTEMPT_EXPIRED" | "OAUTH_STATE_INVALID"
  | "OAUTH_REPLAY" | "OAUTH_SCOPE_MISMATCH" | "GOOGLE_REAUTH_REQUIRED"
  | "GOOGLE_RATE_LIMITED" | "GOOGLE_UNAVAILABLE" | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT" | "REVOKE_PENDING";

export interface MailboxConnectionV1 {
  readonly schemaVersion: 1; readonly id: string; readonly tenantId: string;
  readonly ownerUserId: string; readonly provider: MailboxProvider;
  readonly providerAccountId: string; readonly accountEmail: string;
  readonly scope: MailboxScope; readonly status: MailboxConnectionStatus;
  readonly grantedScopes: readonly string[]; readonly timezone: string;
  readonly localScanTime: string; readonly scanEnabled: boolean;
  readonly lastScanAt: string | null; readonly nextScheduleAt: string | null;
  readonly createdAt: string; readonly updatedAt: string; readonly revokedAt: string | null;
}

export interface MailboxConnectionRecordV1 extends MailboxConnectionV1 {
  readonly secretResourceName: string;
  readonly tokenGeneration: number;
  readonly connectionVersion: number;
  readonly tokenOperationLeaseId: string | null;
  readonly tokenOperationLeaseExpiresAt: string | null;
  readonly activeScanRunId: string | null;
  readonly activeScanLeaseExpiresAt: string | null;
}

export interface MailboxOAuthAttemptV1 {
  readonly schemaVersion: 1; readonly id: string; readonly connectionId: string;
  readonly tenantId: string; readonly actorUserId: string;
  readonly stateDigest: string; readonly sessionNonceDigest: string;
  readonly redirectOrigin: string; readonly expiresAt: string;
  readonly status: "pending" | "consumed" | "completed" | "expired" | "cancelled";
  readonly createdAt: string; readonly consumedAt: string | null; readonly completedAt: string | null;
}

export interface MailboxReviewerGrantV1 {
  readonly schemaVersion: 1; readonly connectionId: string; readonly tenantId: string;
  readonly userId: string; readonly role: "reviewer" | "manager";
  readonly version: number; readonly revokedAt: string | null;
}

export function mailboxIdempotencyKey(connectionId: string, operation: string, reference: string, version: number): string {
  return `${connectionId}:${operation}:${reference}:${version}`;
}
```

Provider types are defined here, not deferred to later plans:

```ts
export interface OAuthStartInput { connectionId: string; attemptId: string; sessionNonce: string; redirectOrigin: string; }
export interface OAuthStartResult { authorizationUrl: string; stateDigest: string; expiresAt: string; }
export interface OAuthCallbackInput { code: string; state: string; requestOrigin: string; }
export interface ConnectedAccount { providerAccountId: string; email: string; grantedScopes: readonly string[]; initialHistoryId: string; secretResourceName: string; tokenGeneration: number; }
export interface RevokeConnectionInput { connectionId: string; operationId: string; }
export interface MailboxBrokerConnectionAppClient {
  consumeOAuthAttempt(input: { connectionId: string; attemptId: string; stateDigest: string; sessionNonceDigest: string }): Promise<{ status: "consumed"; connectionVersion: number }>;
  completeConnection(input: ConnectedAccount & { connectionId: string; attemptId: string; expectedConnectionVersion: number }): Promise<MailboxConnectionV1>;
  recordRevocation(input: { connectionId: string; operationId: string; status: "revoked" | "revocation_pending" }): Promise<MailboxConnectionV1>;
}
export interface MailboxProviderAdapter {
  createAuthorizationUrl(input: OAuthStartInput): Promise<OAuthStartResult>;
  exchangeAuthorizationCode(input: OAuthCallbackInput): Promise<ConnectedAccount>;
  revoke(input: RevokeConnectionInput): Promise<void>;
}
```

### Task 1: Contracts, Ownership Ledger, and Migration 018 Prerequisite

**Local testability:** Fully local with fakes (Vitest, in-memory/test PostgreSQL). No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/packages/contracts/src/mailbox.ts`
- Modify: `expense-tax-management/packages/contracts/src/index.ts`
- Create: `expense-tax-management/packages/contracts/test/mailbox.test.ts`
- Create: `expense-tax-management/services/app-api/src/database/migrations/018_mailbox_connections.ts`
- Modify: `expense-tax-management/services/app-api/src/database/types.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-connections-database.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/package.json`
- Create: `expense-tax-management/services/mailbox-broker/tsconfig.json`
- Create: `expense-tax-management/services/mailbox-broker/src/contracts.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/contracts.test.ts`
- Modify: `expense-tax-management/package.json`
- Modify: `expense-tax-management/pnpm-workspace.yaml`

**Interfaces:** Produces all A contracts above, strict Zod schemas, and migration 018. Migration requires Phase 3C migration 016 and runtime migration Task 7 Stage A migration 017 in the test migration fixture; it creates connection/reviewer/attempt rows but no scan/candidate tables.

- [ ] **Step 1: Write failing tests** for public/internal record separation, provider `gmail|outlook`, unsupported Outlook, exact readonly scope, no secret fields in public schema, permanent replay conflict, and migration order `016,017 -> 018`.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/contracts exec vitest run test/mailbox.test.ts && pnpm --filter @expense-tax/app-api test -- test/mailbox-connections-database.test.ts`; expected FAIL because contracts/migration are absent.
- [ ] **Step 3: Implement strict schemas and migration 018.** Add composite tenant/scope FKs, active uniqueness, status checks, OAuth attempt one-time status, connection version, token-generation/lease internals, and no token/code/verifier columns. Connection row stores `vault_reference` (opaque), never a secret value.
- [ ] **Step 4: Run:** `pnpm contracts:generate && pnpm contracts:check && pnpm --filter @expense-tax/app-api typecheck`; expected PASS with generated drift absent.
- [ ] **Step 5: Commit:**
  ```bash
  git add packages/contracts/src/mailbox.ts packages/contracts/src/index.ts packages/contracts/test/mailbox.test.ts services/app-api/src/database/migrations/018_mailbox_connections.ts services/app-api/src/database/types.ts services/app-api/test/mailbox-connections-database.test.ts services/mailbox-broker/package.json services/mailbox-broker/tsconfig.json services/mailbox-broker/src/contracts.ts services/mailbox-broker/test/contracts.test.ts package.json pnpm-workspace.yaml
  git commit -m "feat(mailbox): define connection contracts"
  ```

### Task 2: App Connection/OAuth Domain and Exact State Consume CAS

**Local testability:** Fully local with fakes. No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/services/app-api/src/domain/mailbox-connections.ts`
- Create: `expense-tax-management/services/app-api/src/routes/mailbox-connections.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-connections.test.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-oauth-state.test.ts`

**Interfaces:**
- `startConnection({ actorUserId, tenantId, scope, sessionNonce, redirectOrigin, timezone, localScanTime, requestId }): Promise<{ connection: MailboxConnectionV1; attempt: MailboxOAuthAttemptV1; authorizationUrl: string }>` passes `sessionNonce` to broker and stores only `sha256(sessionNonce)`.
- `consumeOAuthState({ attemptId, connectionId, stateDigest, sessionNonceDigest, requestId }): Promise<{ connectionId: string; attemptId: string; redirectOrigin: string }>` locks pending attempt, constant-time compares both digests, verifies allowlisted origin and expiry, changes status to `consumed`, and returns no state/code/verifier/token.
- `completeConnection({ attemptId, connectionId, secretResourceName, providerAccountId, accountEmail, grantedScopes, initialHistoryId, tokenGeneration, requestId }): Promise<MailboxConnectionRecordV1>` performs activation CAS only from `consumed`; replay returns prior completion result or `OAUTH_REPLAY`.

- [ ] **Step 1: Write failing tests** for entitlement/scope checks, session nonce digest transport, trusted redirect allowlist, state digest mismatch, expired attempt, first consume, second consume, completion-before-consume, completion replay, and wrong connection/tenant.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/app-api test -- test/mailbox-connections.test.ts test/mailbox-oauth-state.test.ts`; expected FAIL.
- [ ] **Step 3: Implement domain and routes.** Public responses use `MailboxConnectionV1`; only internal broker callback may receive `MailboxConnectionRecordV1` fields, and only secret resource name/generation required for completion.
- [ ] **Step 4: Add exact endpoint:** `POST /internal/v1/mailbox/oauth/attempts/:attemptId/consume`; guard broker subject `mailbox-broker-app`, App service audience, scope `mailbox:write`; request body is `{ connectionId, stateDigest, sessionNonceDigest, requestId }`.
- [ ] **Step 5: Run:** `pnpm --filter @expense-tax/app-api test -- test/mailbox-connections.test.ts test/mailbox-oauth-state.test.ts && pnpm --filter @expense-tax/app-api typecheck`; expected PASS.
- [ ] **Step 6: Commit:** `git add services/app-api/src/domain/mailbox-connections.ts services/app-api/src/routes/mailbox-connections.ts services/app-api/test/mailbox-connections.test.ts services/app-api/test/mailbox-oauth-state.test.ts && git commit -m "feat(mailbox): add OAuth consume CAS"`

### Task 3: Broker Token Vault, OAuth CAS, Clerk Identity, and Base Worker Client

**Local testability:** Mostly local with fakes (test PostgreSQL for the vault, fake Clerk JWKS). The Gmail adapter's token-refresh event handling needs a human-provisioned Google OAuth client/test account to exercise end-to-end against real Google; stub it with a fake `googleapis` client for this task's tests and mark true Google-credential verification as **operator-gated** (Task 6).

**Files:**
- Create: `expense-tax-management/services/mailbox-broker/src/config.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/logging.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/database/client.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/database/migrations/001_token_vault.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/token-vault.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/oauth-state.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/google-mailbox.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/app-client.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/auth/clerk.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/test-doubles.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/oauth-state.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/token-vault.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/auth.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/app-client.test.ts`
- Create: `expense-tax-management/services/workflow-worker/src/clients/mailbox-client.ts`
- Create: `expense-tax-management/services/workflow-worker/test/mailbox-client.test.ts`

**Interfaces:** `createOAuthState`, `consumeOAuthState`, `createConnectionVaultRow`, `addTokenGenerationCAS`, `destroyTokenGeneration`, `revokeTokenGenerations`, `createGmailMailboxProvider`, and `MailboxBrokerConnectionAppClient` are created here. The token vault uses its own dedicated PostgreSQL database with a runtime role (read/write vault rows only) separate from its migration role (DDL only); both are provisioned by the operator-only bootstrap in Task 5, never by normal deploy. `MailboxBrokerConnectionAppClient` signs broker-to-App connection/OAuth callbacks with existing App service audience, subject `mailbox-broker-app`, and scope `mailbox:write`. 3D-B extends broker App access with discovery staging; 3D-C extends it with upload/materialization. Separate TypeScript `MailboxAppApiClient` in `services/workflow-worker` uses existing App audience, subject `workflow-worker-mailbox`, and scopes `mailbox:discover`, `mailbox:materialize` only for opaque orchestration.

- [ ] **Step 1: Write failing tests** for AES-256-GCM tamper/expiry, PKCE S256, state one-time behavior, nonce transport, token-vault losing-writer cleanup (compare-and-set on generation), revoke race, logger redaction, exact Clerk issuer/audience/subject/scope, and worker token config.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/mailbox-broker exec vitest run test/oauth-state.test.ts test/token-vault.test.ts test/auth.test.ts && pnpm --filter @expense-tax/workflow-worker exec vitest run test/mailbox-client.test.ts`; expected FAIL.
- [ ] **Step 3: Implement state.** Payload carries `keyId`, `connectionId`, `attemptId`, `sessionNonce`, `pkceVerifier`, issue/expiry, and redirect origin. Callback decrypts, validates allowlist/session/expiry, computes `sha256(state)` and `sha256(sessionNonce)`, then calls App consume CAS before exchanging code. Invalid/replayed state redirects to fixed failure page with no details; no provider exchange occurs.
- [ ] **Step 4: Implement Gmail adapter.** Use `googleapis`, offline access, exact readonly scope, in-memory access token, token-event token-vault CAS (AES-256-GCM encrypt, new generation, verify, then disable prior generation), and provider enum rejection for Outlook.
- [ ] **Step 5: Implement `MailboxBrokerConnectionAppClient`.** Implement only OAuth-attempt consume, connection completion, and revocation-state callbacks. Never create scan, candidate, upload, or structured-result routes in A. Add tests for App audience, `mailbox-broker-app` subject, and `mailbox:write` scope.
- [ ] **Step 6: Run:** `pnpm --filter @expense-tax/mailbox-broker test && pnpm --filter @expense-tax/mailbox-broker typecheck && pnpm --filter @expense-tax/workflow-worker exec vitest run test/mailbox-client.test.ts`; expected PASS.
- [ ] **Step 7: Commit:** `git add services/mailbox-broker/src services/mailbox-broker/test services/workflow-worker/src/clients/mailbox-client.ts services/workflow-worker/test/mailbox-client.test.ts && git commit -m "feat(mailbox): secure OAuth and broker clients"`

### Task 4: Fastify Broker/App Routes and Office Mailbox Base

**Local testability:** Fully local with fakes. No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/services/mailbox-broker/src/app.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/routes/oauth.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/routes/connections.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/server.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/routes.test.ts`
- Modify: `expense-tax-management/services/app-api/src/app.ts`
- Modify: `expense-tax-management/services/app-api/src/config.ts`
- Modify: `expense-tax-management/frontend/office-web/src/lib/api.ts`
- Create: `expense-tax-management/frontend/office-web/src/lib/mailbox.ts`
- Create: `expense-tax-management/frontend/office-web/src/lib/mailbox.test.ts`
- Create: `expense-tax-management/frontend/office-web/src/app/(office)/mailbox/page.tsx`
- Modify: `expense-tax-management/frontend/office-web/src/components/office-shell.tsx`
- Modify: `expense-tax-management/frontend/office-web/src/lib/page-data.ts`

- [ ] **Step 1: Write failing tests** for broker callback query redaction, method/host policy, state consume call ordering, exact M2M auth, Office session nonce creation/transport, no localStorage sensitive values, and connection status rendering.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/mailbox-broker exec vitest run test/routes.test.ts && pnpm --filter @expense-tax/office-web test -- src/lib/mailbox.test.ts`; expected FAIL.
- [ ] **Step 3: Implement routes.** Public `GET /oauth/google/callback`; internal `POST /internal/v1/oauth/google/start`, `POST /internal/v1/connections/:connectionId/revoke`, and App completion callback. Broker calls App consume endpoint before Google code exchange.
- [ ] **Step 4: Implement Office base.** `POST /api/v1/tenants/:tenantId/mailbox-connections/google/start` receives fresh browser session nonce and trusted redirect origin; page owns connect/account/status/schedule/reviewer base. B modifies this page for scan/review; C modifies it for ingestion status.
- [ ] **Step 5: Run:** `pnpm contracts:generate && pnpm contracts:check && pnpm --filter @expense-tax/mailbox-broker test && pnpm --filter @expense-tax/office-web test`; expected PASS and no generated drift.
- [ ] **Step 6: Commit:**
  ```bash
  git add services/mailbox-broker services/app-api/src/app.ts services/app-api/src/config.ts frontend/office-web/src/lib/api.ts frontend/office-web/src/lib/mailbox.ts frontend/office-web/src/lib/mailbox.test.ts "frontend/office-web/src/app/(office)/mailbox/page.tsx" frontend/office-web/src/components/office-shell.tsx frontend/office-web/src/lib/page-data.ts packages/contracts/generated
  git commit -m "feat(mailbox): add broker routes and Office base"
  ```

### Task 5: VPS Compose Integration, Operator Vault Bootstrap, and Exact Three-Principal Provisioning

**Local testability:** Container build and Compose config are locally testable (Docker, no production access). The vault database/role bootstrap script and Clerk machine identity provisioning are **operator-only, human-action-gated**: they mutate shared production infrastructure and require explicit execution-time confirmation before running against the real VPS/Postgres cluster or Clerk.

**Files:**
- Create: `expense-tax-management/services/mailbox-broker/Dockerfile`
- Create: `expense-tax-management/services/mailbox-broker/.dockerignore`
- Modify: `deploy/production/docker-compose.yml`
- Create: `infrastructure/postgres/bootstrap-mailbox-vault-db.sh`
- Create: `expense-tax-management/services/mailbox-broker/README.md`
- Create: `expense-tax-management/services/mailbox-broker/test/compose-config.test.ts`
- Modify: `expense-tax-management/.github/workflows/expense-tax-deploy.yml`

- [ ] **Step 1: Write static tests** for no GCP identity/key in the broker container config, loopback-only port binding, no public route except `/oauth/google/callback` through the Tunnel, container resource ceiling present, and three exact Clerk subjects/scopes including `workflow-worker-mailbox` App audience.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/mailbox-broker exec vitest run test/compose-config.test.ts`; expected FAIL.
- [ ] **Step 3: Implement Dockerfile and Compose service.** Add `mailbox-broker` to `deploy/production/docker-compose.yml` as a plan step: loopback port, environment from the existing Expense bundle, container CPU/memory ceiling (0.5 vCPU / 512 MB default), no GCP service-account mount. This image joins the existing immutable main-only deploy matrix (`.github/workflows/expense-tax-deploy.yml`); it is not deployed by `dev` merges.
- [ ] **Step 4: Implement operator-only vault bootstrap script.** `infrastructure/postgres/bootstrap-mailbox-vault-db.sh` creates the dedicated token-vault database plus separate runtime (DML-only) and migration (DDL-only) roles, mirroring `bootstrap-temporal-db.sh`. The normal deploy path never runs this script.
- [ ] **Step 5: Request explicit confirmation before remote commands.** Show the vault bootstrap script, Clerk machine-identity provisioning commands, and the Compose/deploy diff; execute only after confirmation. These touch shared production Postgres and Clerk and are not reversible by a revert commit alone.
- [ ] **Step 6: Verify:** `pnpm --filter @expense-tax/mailbox-broker test && docker build -f services/mailbox-broker/Dockerfile services/mailbox-broker`; expected PASS and no unapproved paid product.
- [ ] **Step 7: Commit:** `git add services/mailbox-broker/Dockerfile services/mailbox-broker/.dockerignore services/mailbox-broker/README.md services/mailbox-broker/test/compose-config.test.ts deploy/production/docker-compose.yml infrastructure/postgres/bootstrap-mailbox-vault-db.sh .github/workflows/expense-tax-deploy.yml && git commit -m "infra(mailbox): add broker container to VPS Compose"`

### Task 6: A Verification and B Handoff

**Local testability:** Fully local with fakes, except the integration test which needs a real test PostgreSQL instance (no production access, no Google credentials).

**Files:**
- Create: `expense-tax-management/test/integration/app-domain-3d-a-mailbox.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/security-regression.test.ts`

- [ ] **Step 1: Test** migration prerequisite 016,017 then 018, public/internal schema separation, OAuth consume CAS/replay, trusted redirect/session binding, refresh/revoke CAS, exact identities, and no token/state leakage.
- [ ] **Step 2: Run:** `pnpm test && pnpm lint && pnpm typecheck && pnpm build && pnpm contracts:generate && pnpm contracts:check && pnpm --filter @expense-tax/mailbox-broker test && pnpm --filter @expense-tax/office-web test && pnpm --filter @expense-tax/workflow-worker test && pnpm test:integration -- test/integration/app-domain-3d-a-mailbox.test.ts && git diff --check`; expected PASS with generated drift absent.
- [ ] **Step 3: Handoff exact interfaces.** B consumes `MailboxConnectionV1` for public UI, `MailboxConnectionRecordV1` only inside App domain, canonical base `MailboxProviderAdapter`, `MailboxBrokerConnectionAppClient`, and TypeScript `MailboxAppApiClient` (in `services/workflow-worker`) for opaque orchestration. B owns every discovery/scan/candidate contract and extends the base as `MailboxDiscoveryProviderAdapter`. C owns every upload/materialization contract and extends B. A implements neither. B/C must not put cursor/history or content values in Temporal. B/C production activation is blocked on runtime migration Task 7 cutover because 3D workflows run only on the TypeScript worker; 3D-A source may still merge to `dev` once Phase 3C is in.

### Task List and Local-Testability Classification Summary

| Task | Local with fakes? | Needs real Google OAuth / production / human action |
|---|---|---|
| 1. Contracts, migration 018 | Yes, fully | No |
| 2. App connection/OAuth domain | Yes, fully | No |
| 3. Broker token vault, OAuth CAS, Clerk identity, worker client | Mostly (fake Google client, test Postgres) | Operator-gated: real Google OAuth client/test account for end-to-end token-refresh verification |
| 4. Fastify routes, Office base | Yes, fully | No |
| 5. VPS Compose integration, vault bootstrap, Clerk provisioning | Container build/config: yes | Operator-gated: vault DB/role bootstrap and Clerk machine-identity provisioning against real infrastructure |
| 6. A verification and B handoff | Yes (integration test needs local test Postgres) | No |
