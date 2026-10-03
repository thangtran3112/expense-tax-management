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
`MailboxScope` is not a new shape: it is the existing canonical `Scope`/`ScopeSchema`
from `expense-tax-management/packages/contracts/src/enrichment.ts` (`{ kind: "personal", profileId }`
or `{ kind: "business", businessId }`), imported and aliased, not redeclared. Do not
invent a second public scope schema; `enrichment.ts` states "do not create another
public scope schema elsewhere" for exactly this reason.

This block illustrates `packages/contracts/src/mailbox.ts`, a file *inside* the
`@expense-tax/contracts` package itself; it must import its sibling module by
relative path (`./enrichment.js`), the same way `enrichment.ts` imports
`./expenses.js`/`./tax-treatments.js` — never `@expense-tax/contracts` self-referentially.
Downstream consumers outside this package (`mailbox-broker`, `workflow-worker`,
`office-web`) import `MailboxScope` from `@expense-tax/contracts` as usual.

```ts
import type { Scope } from "./enrichment.js";

export type MailboxProvider = "gmail" | "outlook";
export type MailboxScope = Scope;
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
  readonly vaultReference: string;
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
export interface ConnectedAccount { providerAccountId: string; email: string; grantedScopes: readonly string[]; initialHistoryId: string; vaultReference: string; tokenGeneration: number; }
export interface RevokeConnectionInput { connectionId: string; operationId: string; }
export interface TokenOperationLeaseV1 { readonly connectionId: string; readonly leaseId: string; readonly expiresAt: string; readonly expectedConnectionVersion: number; readonly currentTokenGeneration: number; }
export interface AdvanceTokenGenerationInput {
  readonly connectionId: string; readonly leaseId: string; readonly expectedConnectionVersion: number;
  readonly newGeneration: number; readonly vaultReference: string; readonly requestId: string; readonly idempotencyKey: string;
}
export interface AdvanceTokenGenerationResult { readonly connectionVersion: number; readonly tokenGeneration: number; readonly vaultReference: string; }
export interface MailboxBrokerConnectionAppClient {
  consumeOAuthAttempt(input: { connectionId: string; attemptId: string; stateDigest: string; sessionNonceDigest: string }): Promise<{ status: "consumed"; connectionVersion: number }>;
  completeConnection(input: ConnectedAccount & { connectionId: string; attemptId: string; expectedConnectionVersion: number }): Promise<MailboxConnectionV1>;
  acquireTokenOperationLease(input: { connectionId: string; operationId: string; ttlSeconds: number }): Promise<TokenOperationLeaseV1>;
  advanceTokenGeneration(input: AdvanceTokenGenerationInput): Promise<AdvanceTokenGenerationResult>;
  releaseTokenOperationLease(input: { connectionId: string; leaseId: string }): Promise<void>;
  recordRevocation(input: { connectionId: string; operationId: string; status: "revoked" | "revocation_pending" }): Promise<MailboxConnectionV1>;
}
export interface MailboxProviderAdapter {
  createAuthorizationUrl(input: OAuthStartInput): Promise<OAuthStartResult>;
  exchangeAuthorizationCode(input: OAuthCallbackInput): Promise<ConnectedAccount>;
  revoke(input: RevokeConnectionInput): Promise<void>;
}
```

`acquireTokenOperationLease`/`advanceTokenGeneration`/`releaseTokenOperationLease` exist
because App API — not just the broker's vault — tracks an active `tokenGeneration` on
`MailboxConnectionRecordV1` (it must know, without ever seeing a token, which vault
generation is currently authoritative, so a losing concurrent refresh/rotation can be
detected and only its own newly created generation destroyed). The vault-reference
design does not remove this dependency: `vaultReference`/`tokenGeneration` are opaque
to App, but App still owns the **pointer** (which generation is active) as connection
metadata, and that pointer must move exactly once per rotation, under lease, never by
two concurrent broker operations at once. The lease (bound to
`expectedConnectionVersion` and carrying the connection's `currentTokenGeneration` at
acquisition time) is the race-prevention primitive; `advanceTokenGeneration` is the CAS
that actually moves the pointer and only accepts `newGeneration === currentTokenGeneration + 1`
under the exact `leaseId` that acquired it.

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

**Interfaces:** Produces all A contracts above, strict Zod schemas, and migration 018. `packages/contracts/src/mailbox.ts` imports `ScopeSchema`/`Scope` from `./enrichment.js` and re-exports `MailboxScope = Scope`; it does not declare a second scope union. Migration requires Phase 3C migration 016 and runtime migration Task 7 Stage A migration 017 in the test migration fixture; it creates connection/reviewer/attempt rows but no scan/candidate tables. Connection row uses the existing `personal_profile_id`/`business_id` column convention (see migrations 002/003/005/008/009), consistent with the public `profileId`/`businessId` contract field names.

- [ ] **Step 1: Write failing tests** for public/internal record separation, provider `gmail|outlook`, unsupported Outlook, exact readonly scope, no secret fields in public schema, permanent replay conflict, migration order `016,017 -> 018`, and that `MailboxScope` round-trips through the imported canonical `ScopeSchema` (assert no second scope schema/duplicate union exists in `mailbox.ts`).
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/contracts exec vitest run test/mailbox.test.ts && pnpm --filter @expense-tax/app-api test -- test/mailbox-connections-database.test.ts`; expected FAIL because contracts/migration are absent.
- [ ] **Step 3: Implement strict schemas and migration 018.** Add composite tenant/scope FKs on `personal_profile_id`/`business_id` (mirroring migrations 002/003/005/008/009), active uniqueness, status checks, OAuth attempt one-time status, connection version, token-generation/lease internals, and no token/code/verifier columns. Connection row stores `vault_reference` (opaque), never a secret value.
- [ ] **Step 4: Run:** `pnpm contracts:generate && pnpm contracts:check && pnpm --filter @expense-tax/app-api typecheck`; expected PASS with generated drift absent.
- [ ] **Step 5: Commit:**
  ```bash
  git add packages/contracts/src/mailbox.ts packages/contracts/src/index.ts packages/contracts/test/mailbox.test.ts services/app-api/src/database/migrations/018_mailbox_connections.ts services/app-api/src/database/types.ts services/app-api/test/mailbox-connections-database.test.ts services/mailbox-broker/package.json services/mailbox-broker/tsconfig.json services/mailbox-broker/src/contracts.ts services/mailbox-broker/test/contracts.test.ts package.json pnpm-workspace.yaml
  git commit -m "feat(mailbox): define connection contracts"
  ```

### Task 2: App Connection/OAuth Domain and Exact State Consume CAS

**Local testability:** Fully local with fakes (fake broker HTTP client, fake Clerk JWKS). No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/services/app-api/src/domain/mailbox-connections.ts`
- Create: `expense-tax-management/services/app-api/src/routes/mailbox-connections.ts`
- Create: `expense-tax-management/services/app-api/src/auth/machine-token.ts` (ported from `services/workflow-worker/src/auth/machine-token.ts`; App API has no existing outbound M2M client)
- Create: `expense-tax-management/services/app-api/src/integrations/mailbox-broker-client.ts`
- Modify: `expense-tax-management/services/app-api/src/config.ts`. Two distinct additions:
  (a) App API's own **outbound** credential to call the broker: `MAILBOX_BROKER_BASE_URL` (hardcoded Compose literal `http://mailbox-broker:8300`, not a secret-bundle var — same treatment as the existing `APP_API_BASE_URL: http://app-api:8100` literal already in `ai-worker`'s block, resolved by Docker's internal DNS, not `${VAR:?...}`), `CLERK_MAILBOX_SERVICE_AUDIENCE` (broker's audience — new, shared with the worker's own outbound-to-broker credential in Task 3), `CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY` (App API's own distinct secret — **not** `CLERK_APP_MACHINE_SECRET_KEY`: Compose passes one shared `--env-file` to every service, so reusing an existing caller's var name would silently hand the new caller the old caller's secret), `CLERK_MAILBOX_APP_API_SUBJECT` (value `app-api-mailbox` — this exact var is also read by the broker's own inbound verifier config in Task 3, since "the subject App presents" and "the subject broker expects from App" are the same configured fact, mirroring how `CLERK_APP_SERVICE_SUBJECT` already serves both App API's verifier config and `ai-worker`'s presenter config today).
  (b) The **expected-subject** config for the two new inbound mailbox routes — `mailboxBrokerServiceSubject` (env `CLERK_MAILBOX_BROKER_SUBJECT`, the same shared var the broker's own outbound-to-App credential in Task 3 presents; default-falls-back-to-literal `mailbox-broker-app` at the call site) and `mailboxWorkerServiceSubject` (env `CLERK_MAILBOX_WORKER_SUBJECT`, the same shared var workflow-worker's own outbound credentials present; default `workflow-worker-mailbox`) — mirroring the existing `appServiceSubject`/`foundryServiceSubject` → `options.workerServiceSubject ?? "ai-worker"` pattern already used by `serviceGuard` call sites in this same service (e.g. `routes/jobs.ts:65`, `routes/ocr.ts:74`, `routes/deduplication.ts:48`, `routes/files.ts:85`) and wired from config into route options in `app.ts:347-403`.
- Create: `expense-tax-management/services/app-api/test/mailbox-connections.test.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-oauth-state.test.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-broker-client.test.ts`
- Create: `expense-tax-management/services/app-api/test/mailbox-token-generation.test.ts`

**Interfaces:**
- `startConnection({ actorUserId, tenantId, scope, sessionNonce, redirectOrigin, timezone, localScanTime, requestId }): Promise<{ connection: MailboxConnectionV1; attempt: MailboxOAuthAttemptV1; authorizationUrl: string }>` calls `MailboxBrokerClient.startOAuth(...)` (new outbound client, subject `app-api-mailbox`, broker audience) to obtain `authorizationUrl`, passes `sessionNonce` to broker, and stores only `sha256(sessionNonce)`.
- `consumeOAuthState({ attemptId, connectionId, stateDigest, sessionNonceDigest, requestId }): Promise<{ connectionId: string; attemptId: string; redirectOrigin: string }>` locks pending attempt, constant-time compares both digests, verifies allowlisted origin and expiry, changes status to `consumed`, and returns no state/code/verifier/token.
- `completeConnection({ attemptId, connectionId, vaultReference, providerAccountId, accountEmail, grantedScopes, initialHistoryId, tokenGeneration, requestId }): Promise<MailboxConnectionRecordV1>` performs activation CAS only from `consumed`; replay returns prior completion result or `OAUTH_REPLAY`. This is generation 1's activation path; it does not handle later rotations.
- `acquireTokenOperationLease(input: { connectionId: string; operationId: string; ttlSeconds: number }): Promise<TokenOperationLeaseV1>` takes an exclusive, expiring lease on the connection's token-generation pointer (`SELECT ... FOR UPDATE` within a transaction, or a CAS on a nullable `tokenOperationLeaseId`/`tokenOperationLeaseExpiresAt` pair); fails with `VERSION_CONFLICT` if an unexpired lease already exists. Returns the connection's `currentTokenGeneration` at acquisition time so the broker's `newGeneration` request is always `currentTokenGeneration + 1`, never a value the broker guesses independently.
- `advanceTokenGeneration(input: AdvanceTokenGenerationInput): Promise<AdvanceTokenGenerationResult>` requires the exact `leaseId` from `acquireTokenOperationLease`, exact `expectedConnectionVersion`, and `newGeneration === currentTokenGeneration + 1`; atomically sets `tokenGeneration = newGeneration`, `vaultReference = input.vaultReference`, bumps `connectionVersion`, and clears the lease. Permanent idempotency key `(connectionId, "advance-generation", String(newGeneration), connectionVersion)`: identical replay returns the prior result; same key with a different `vaultReference` returns `IDEMPOTENCY_CONFLICT`. Out-of-order or stale generation/version returns `VERSION_CONFLICT` and does not move the pointer.
- `releaseTokenOperationLease(input: { connectionId: string; leaseId: string }): Promise<void>` clears the lease without advancing the generation (used when the broker's own new vault generation write fails after acquiring the lease, so the lease does not block future operations until its TTL alone expires). **Explicitly idempotent:** if the connection's current `tokenOperationLeaseId` does not equal `input.leaseId` — because a successful `advanceTokenGeneration` already cleared it, because a prior `releaseTokenOperationLease` call already cleared it, or because it never matched — this is a no-op success, never an error. This lets the broker call release defensively after an ambiguous-outcome `advanceTokenGeneration` call without knowing whether the advance actually committed.
- `routes/mailbox-connections.ts` exports its route-registration function only; it is unit-tested directly against a minimal Fastify instance in this task and wired into `app-api/src/app.ts` in Task 4, alongside the broker/Office routes it depends on.

- [ ] **Step 1: Write failing tests** for entitlement/scope checks, session nonce digest transport, trusted redirect allowlist, state digest mismatch, expired attempt, first consume, second consume, completion-before-consume, completion replay, wrong connection/tenant, `MailboxBrokerClient` acquiring/attaching a machine token with exact audience/subject `app-api-mailbox`, and (in `test/mailbox-token-generation.test.ts`) lease acquisition exclusivity (second concurrent acquire on the same connection is rejected until release or TTL expiry), lease-TTL expiry allowing a new acquire, `advanceTokenGeneration` accepting only `currentTokenGeneration + 1`, rejecting a stale `expectedConnectionVersion` or wrong `leaseId`, idempotent replay of an identical advance, `IDEMPOTENCY_CONFLICT` on same key/different `vaultReference`, `releaseTokenOperationLease` without advancing, a successful `advanceTokenGeneration` leaving nothing for a subsequent `releaseTokenOperationLease` call with the same `leaseId` to do (no-op success, not an error — the lease was already cleared by the advance), and calling `releaseTokenOperationLease` twice in a row with the same `leaseId` (second call is also a no-op success).
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/app-api test -- test/mailbox-connections.test.ts test/mailbox-oauth-state.test.ts test/mailbox-broker-client.test.ts test/mailbox-token-generation.test.ts`; expected FAIL.
- [ ] **Step 3: Implement domain and routes.** Public responses use `MailboxConnectionV1`; only internal broker callback may receive `MailboxConnectionRecordV1` fields, and only vault reference/generation required for completion.
- [ ] **Step 4: Add exact endpoints:**
  - `POST /internal/v1/mailbox/oauth/attempts/:attemptId/consume`; guard broker subject `mailbox-broker-app`, App service audience, scope `mailbox:write`; request body is `{ connectionId, stateDigest, sessionNonceDigest, requestId }`.
  - `POST /internal/v1/mailbox/connections/:connectionId/token-operations/lease` (acquire); same guard; body `{ operationId, ttlSeconds }`.
  - `POST /internal/v1/mailbox/connections/:connectionId/token-operations/advance` (CAS advance); same guard; body `{ leaseId, expectedConnectionVersion, newGeneration, vaultReference, requestId, idempotencyKey }`.
  - `POST /internal/v1/mailbox/connections/:connectionId/token-operations/release`; same guard; body `{ leaseId }`.
  Add a negative-auth test asserting every one of these routes rejects a wrong subject, a token for the existing `ai-worker`/`workflow-worker` App-worker audience/subject, and a tenant token (same pattern as `test/auth.test.ts`'s "rejects a tenant token on the service guard").
- [ ] **Step 5: Run:** `pnpm --filter @expense-tax/app-api test -- test/mailbox-connections.test.ts test/mailbox-oauth-state.test.ts test/mailbox-broker-client.test.ts test/mailbox-token-generation.test.ts && pnpm --filter @expense-tax/app-api typecheck`; expected PASS.
- [ ] **Step 6: Commit:** `git add services/app-api/src/domain/mailbox-connections.ts services/app-api/src/routes/mailbox-connections.ts services/app-api/src/auth/machine-token.ts services/app-api/src/integrations/mailbox-broker-client.ts services/app-api/src/config.ts services/app-api/test/mailbox-connections.test.ts services/app-api/test/mailbox-oauth-state.test.ts services/app-api/test/mailbox-broker-client.test.ts services/app-api/test/mailbox-token-generation.test.ts && git commit -m "feat(mailbox): add OAuth consume CAS"`

### Task 3: Broker Token Vault, OAuth CAS, Clerk Identity, and Base Worker Client

**Local testability:** Mostly local with fakes (test PostgreSQL for the vault, fake Clerk JWKS). The Gmail adapter's token-refresh event handling needs a human-provisioned Google OAuth client/test account to exercise end-to-end against real Google; stub it with a fake `googleapis` client for this task's tests and mark true Google-credential verification as **operator-gated** (Task 6).

**Files:**
- Create: `expense-tax-management/services/mailbox-broker/src/config.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/logging.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/database/client.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/database/migrations/001_token_vault.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/token-vault.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/key-rotation.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/key-rotation-cli.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/key-rotation-cli.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/oauth-state.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/google-mailbox.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/app-client.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/auth/clerk.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/test-doubles.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/oauth-state.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/token-vault.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/key-rotation.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/auth.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/app-client.test.ts`
- Modify: `expense-tax-management/services/workflow-worker/src/config.ts` (add **two** new `MachineCredentialConfig` blocks, `clerk.mailboxApp` and `clerk.mailboxBroker` — see the credential-naming note under Interfaces below for exactly why two, not one — both reading subject `CLERK_MAILBOX_WORKER_SUBJECT` and secret `CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY`, differing only in audience: `clerk.mailboxApp` reuses `CLERK_APP_SERVICE_AUDIENCE`, `clerk.mailboxBroker` uses the new `CLERK_MAILBOX_SERVICE_AUDIENCE`)
- Create: `expense-tax-management/services/workflow-worker/src/clients/mailbox-client.ts`
- Create: `expense-tax-management/services/workflow-worker/test/mailbox-client.test.ts`
- Modify: `expense-tax-management/services/workflow-worker/test/config.test.ts`

**Interfaces:** `createOAuthState`, `consumeOAuthState`, `createConnectionVaultRow`, `addTokenGenerationCAS`, `destroyTokenGeneration`, `revokeTokenGenerations`, `createGmailMailboxProvider`, and `MailboxBrokerConnectionAppClient` are created here.

Token vault schema (`src/token-vault.ts` + migration `001_token_vault.ts`): one row per `(connection_id, generation)` with columns `connection_id`, `generation` (int, starts at 1), `key_id` (text, identifies which AES key encrypted this row), `nonce` (12 random bytes / 96 bits, `bytea`), `ciphertext` (`bytea`), `auth_tag` (`bytea`, GCM tag), `disabled_at` (nullable), `created_at`. Unique constraint `(key_id, nonce)` across the whole table — a generated nonce collision under the same key is rejected at the database and the encrypt operation retries with a freshly generated nonce (collision probability is negligible at 96 bits, but the constraint makes reuse impossible rather than merely unlikely). AAD for every encrypt/decrypt call is the UTF-8 bytes of `${connectionId}:${keyId}:${generation}`, so ciphertext from one connection/key/generation cannot be decrypted, or silently substituted, into another's row. `addTokenGenerationCAS` always uses the current active `key_id` from `src/config.ts`'s loaded key map (see below) to encrypt; `destroyTokenGeneration`/`revokeTokenGenerations` only ever disable/delete, never decrypt-and-reencrypt in place.

**Key rotation — concrete protocol.** Broker config loads a map of `key_id -> key
material` from the Expense Secret Manager bundle (deployment-time env:
`MAILBOX_VAULT_KEYS` as a JSON array of `{keyId, key}`, plus
`MAILBOX_VAULT_ACTIVE_KEY_ID` naming the current active entry). Decrypt selects the
key by each row's own stored `key_id`, so any key still present in the loaded map
can decrypt its own rows — this is the **dual-key decrypt window**: both the
retiring and the new key stay in `MAILBOX_VAULT_KEYS` simultaneously until every
row is migrated off the retiring key.

Rotation is a four-step operator-run, broker-executed workflow, not an automatic
background job (there is no scheduler in 3D-A):

1. **Operator adds the new key to the deployment bundle.** Add a new `{keyId, key}`
   entry to `MAILBOX_VAULT_KEYS` and set `MAILBOX_VAULT_ACTIVE_KEY_ID` to the new
   `keyId`; redeploy the broker container so new writes use the new key. The
   retiring key stays in `MAILBOX_VAULT_KEYS` (dual-key window is now open).
2. **Operator runs the re-encryption job.** `src/key-rotation-cli.ts` is a small
   CLI entry point built into the broker image, invoked exactly like the existing
   `app-api-migrate` one-shot pattern (`command: ["node", "dist/database/migrate.js"]`
   in `docker-compose.yml`): `docker exec <mailbox-broker-container> node
   dist/key-rotation-cli.js --retiring-key-id=<old> --new-key-id=<new>
   [--connection-id=<uuid>]` (omit `--connection-id` to rotate every connection).
   For each active (non-disabled) row still encrypted under `--retiring-key-id`,
   `rotateVaultKey` in `src/key-rotation.ts`:
   a. decrypts the row with the retiring key;
   b. calls App's `acquireTokenOperationLease` for that connection (same lease
      primitive refresh-token rotation uses — see below — so a concurrent Gmail
      refresh-token rotation and a key rotation on the same connection can never
      race each other);
   c. encrypts under `--new-key-id` as a new generation (12-byte random nonce, AAD
      `${connectionId}:${newKeyId}:${newGeneration}`), inserts the new vault row;
   d. calls App's `advanceTokenGeneration` with the new generation/`vaultReference`
      under the acquired lease;
   e. on success, disables (does not delete) the prior vault-row generation.
      `advanceTokenGeneration` (step d) already cleared the lease atomically as
      part of its own CAS — the job does **not** call `releaseTokenOperationLease`
      again on this path. On any failure in steps (a)-(c) (before `advanceTokenGeneration`
      is even called), it calls `releaseTokenOperationLease` without advancing,
      leaving the prior generation untouched and the connection usable under the
      old key. If step (d) itself returns an ambiguous outcome (e.g. a network
      timeout where the job cannot tell whether App committed the advance before
      the response was lost), the job calls `releaseTokenOperationLease` as a
      defensive cleanup; this is always safe because release is idempotent (see
      below) — it is a no-op if the advance already succeeded and cleared the
      lease, and a real release if it did not.
   The job is idempotent and resumable: re-running it only processes rows still
   encrypted under `--retiring-key-id`; rows already migrated are skipped.
3. **Operator verifies zero remaining references.** `node dist/key-rotation-cli.js
   --verify-retired=<old>` (or the equivalent `SELECT count(*) FROM token_vault
   WHERE key_id = $1 AND disabled_at IS NULL`) must return zero before step 4.
4. **Operator removes the retiring key from the deployment bundle.** Delete its
   entry from `MAILBOX_VAULT_KEYS` and redeploy; this closes the dual-key window.
   Never remove a key from the bundle before step 3 confirms zero references —
   doing so would make any still-referencing row permanently undecryptable.

Every step above is explicitly **operator-gated**: steps 1, 2, and 4 mutate the
production Secret Manager bundle, the vault database, or both, and require
explicit execution-time confirmation before running, exactly like the vault
database/role bootstrap in Task 5. Step 2's CLI run is the only step this task's
automated tests can exercise locally (against a test vault database with fake
keys); steps 1 and 4 (editing the real deployment bundle) are not something an
automated test can perform.

The token vault uses its own dedicated PostgreSQL database with a runtime role (read/write vault rows only) separate from its migration role (DDL only); both are provisioned by the operator-only bootstrap in Task 5, never by normal deploy.

**Credential naming note.** Production Compose runs `docker compose --env-file <one shared bundle file>` (`deploy/production/deploy.sh:119`), so every `${VAR}` reference across *every* service in `docker-compose.yml` resolves to the exact same bundle value — reusing an existing caller's env-var name for a different caller would silently give the new caller the old caller's secret/subject, not a distinct "broker-specific value". Every new var below is therefore either (a) a genuinely new, globally-unique name for a per-identity secret, or (b) an *intentionally shared* name used identically by both sides of one relationship — mirroring the existing precedent where `CLERK_APP_SERVICE_SUBJECT` is read both by App API's own verifier-side config and by `ai-worker`'s presenter-side config, because it is the same configured fact ("the worker's subject is X") viewed from two sides:

- `CLERK_MAILBOX_APP_API_SUBJECT` (value `app-api-mailbox`) — shared by App API's own outbound-to-broker credential (Task 2) and the broker's inbound-expected-from-App-API subject (below).
- `CLERK_MAILBOX_WORKER_SUBJECT` (value `workflow-worker-mailbox`) — shared by the workflow worker's outbound credentials (to App API's mailbox routes *and* to the broker — one Clerk machine identity, two request-time audiences) and the broker's/App's inbound-expected-from-worker subject.
- `CLERK_MAILBOX_BROKER_SUBJECT` (value `mailbox-broker-app`) — shared by the broker's own outbound-to-App credential and App API's inbound-expected-from-broker subject.
- `CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY`, `CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY`, `CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY` — three distinct new secrets, one per identity above; never reuse `CLERK_APP_MACHINE_SECRET_KEY` (that is `ai-worker`/`workflow-worker`'s *general* secret, a different identity than `workflow-worker-mailbox`).
- `CLERK_APP_SERVICE_AUDIENCE` — reused as-is (unchanged): it names the App API target, which is legitimately the same for every caller of App API, mailbox-related or not.
- `CLERK_MAILBOX_SERVICE_AUDIENCE` — new: names the broker as a target, read by every outbound caller of the broker (App API, workflow worker).

Broker's own inbound auth (`src/auth/clerk.ts` + `src/config.ts`): verifies tokens against its own audience (env `MAILBOX_SERVICE_TOKEN_AUDIENCE`/`MAILBOX_SERVICE_TOKEN_ISSUER`/`MAILBOX_SERVICE_JWKS_URL` — unprefixed, mirroring App API's own `APP_SERVICE_TOKEN_*` verifier-config shape exactly, not the `CLERK_`-prefixed outbound-credential vars) and accepts exactly two configurable expected subjects, read from the two shared vars above — `CLERK_MAILBOX_APP_API_SUBJECT` (scopes `oauth:start`/`connections:read`/`connections:revoke`) and `CLERK_MAILBOX_WORKER_SUBJECT` (scopes `mailbox:discover`/`mailbox:materialize`) — mirroring the existing configurable-subject-with-default pattern used by `serviceGuard` call sites such as `routes/quotas.ts:65`.

`MailboxBrokerConnectionAppClient` signs broker-to-App connection/OAuth/token-operation callbacks (`consumeOAuthAttempt`, `completeConnection`, `acquireTokenOperationLease`, `advanceTokenGeneration`, `releaseTokenOperationLease`, `recordRevocation`) with existing App service audience `CLERK_APP_SERVICE_AUDIENCE` (reused), subject `CLERK_MAILBOX_BROKER_SUBJECT` (value `mailbox-broker-app`), secret `CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY`, and scope `mailbox:write`, all inside the broker's own container.

Separate TypeScript `MailboxAppApiClient` in `services/workflow-worker` needs **two** new credential blocks in `src/config.ts` (not one — see Files above), both presenting `CLERK_MAILBOX_WORKER_SUBJECT`/`CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY` but targeting different audiences: `clerk.mailboxApp` (audience `CLERK_APP_SERVICE_AUDIENCE`, reused — same App target the worker's existing general `clerk.app` block already calls, but under the distinct mailbox-scoped identity so a leaked mailbox credential cannot reach non-mailbox App routes) for `mailbox:discover`/`mailbox:materialize` calls into App API, and `clerk.mailboxBroker` (audience `CLERK_MAILBOX_SERVICE_AUDIENCE`, new) to call the broker directly in 3D-B/C.

**Production wiring on the real `workflow-worker` service.** `deploy/production/docker-compose.yml` on `origin/dev` has no `workflow-worker` service yet (still `ai-worker` only). It exists today on branch `feature/task7-routing` (runtime migration Task 7; verified at `/Users/tobytran/personal/family-app/.worktrees/task7-routing/expense-tax-management/deploy/production/docker-compose.yml:148-178`), which this plan expects to merge to `dev` *before* 3D-A implementation starts — not "Stage B", a term that names an internal commit sequence on that branch, not a documented phase of `runtime-typescript-temporal-migration.md`. If `feature/task7-routing` has **not** merged by the time an implementer reaches this step, treat the `workflow-worker` service creation itself as a blocking prerequisite and coordinate with that work rather than creating a second, competing Compose entry here. Once merged, the implementer adds exactly these four new env keys to that service's existing `environment` block (its current keys — `TEMPORAL_HOST`, `TEMPORAL_NAMESPACE: expense-tax`, `AI_WORKER_TASK_QUEUE: expense-tax-processing`, `APP_API_BASE_URL`, `FOUNDRY_BASE_URL`, `CLERK_ISSUER_URL`, `CLERK_JWKS_URL`, `CLERK_APP_SERVICE_AUDIENCE`, `CLERK_FOUNDRY_SERVICE_AUDIENCE`, `CLERK_APP_MACHINE_SECRET_KEY`, `CLERK_FOUNDRY_MACHINE_SECRET_KEY`, `CLERK_APP_SERVICE_SUBJECT`, `CLERK_FOUNDRY_SERVICE_SUBJECT` — already present, untouched by this plan): `MAILBOX_BROKER_BASE_URL: http://mailbox-broker:8300` (hardcoded Compose literal, not `${VAR:?...}` — same treatment as the existing `APP_API_BASE_URL`/`FOUNDRY_BASE_URL` literals already on that block, resolved by Docker's internal DNS), `CLERK_MAILBOX_SERVICE_AUDIENCE`, `CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY`, `CLERK_MAILBOX_WORKER_SUBJECT` (these three *are* `${VAR:?VAR is required}`, matching the block's existing `CLERK_*` entries). The base URL and the Clerk audience/secret/subject are independent concerns: the base URL is *where* the HTTP request goes, while the Clerk vars are *who the request claims to be* once it gets there. Until this wiring lands, 3D-B/C's worker-side mailbox calls have no production Compose target at all, consistent with this plan's existing "3D-B/C production activation is blocked on runtime migration Task 7 cutover" constraint; there is nothing for 3D-A to deploy on the worker side before then.

- [ ] **Step 1: Write failing tests** for AES-256-GCM tamper detection, AAD mismatch rejection (ciphertext from one connection/generation fails to decrypt under another's AAD), unique `(key_id, nonce)` enforcement with collision retry, PKCE S256, state one-time behavior, nonce transport, token-vault losing-writer cleanup (compare-and-set on generation), revoke race, refresh-token rotation calling App's lease/advance/release in order (lease acquired before vault write, `advanceTokenGeneration` called only after the new vault row is verified, prior generation disabled only after `advanceTokenGeneration` succeeds, `releaseTokenOperationLease` called instead if the vault write fails, and never called again after a confirmed-successful advance), key rotation (new key encrypts new writes, old key still decrypts its own rows during the dual-key window, the CLI resumes correctly against partially-rotated connections, retirement verification returns nonzero while any non-disabled row references the retiring key, and the CLI's defensive post-timeout release call on an already-advanced connection is harmless), logger redaction, exact Clerk issuer/audience/subject/scope for both broker-accepted subjects, a negative test rejecting a tenant token or wrong subject/audience on every broker route, and worker token config (new `clerk.mailboxApp`/`clerk.mailboxBroker` blocks parse/validate like `clerk.app`/`clerk.foundry`, sharing subject/secret but differing in audience).
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/mailbox-broker exec vitest run test/oauth-state.test.ts test/token-vault.test.ts test/key-rotation.test.ts test/key-rotation-cli.test.ts test/auth.test.ts && pnpm --filter @expense-tax/app-api test -- test/mailbox-token-generation.test.ts && pnpm --filter @expense-tax/workflow-worker exec vitest run test/mailbox-client.test.ts test/config.test.ts`; expected FAIL.
- [ ] **Step 3: Implement state.** Payload carries `keyId`, `connectionId`, `attemptId`, `sessionNonce`, `pkceVerifier`, issue/expiry, and redirect origin. Callback decrypts, validates allowlist/session/expiry, computes `sha256(state)` and `sha256(sessionNonce)`, then calls App consume CAS before exchanging code. Invalid/replayed state redirects to fixed failure page with no details; no provider exchange occurs.
- [ ] **Step 4: Implement Gmail adapter's refresh-token rotation.** On the OAuth client's `tokens` event: call App's `acquireTokenOperationLease`; encrypt the new refresh token (12-byte random nonce, AAD-bound AES-256-GCM, new generation) and insert the vault row; call App's `advanceTokenGeneration` with the new generation/`vaultReference` under the lease; only then disable the prior vault-row generation. If the vault write fails before `advanceTokenGeneration`, call `releaseTokenOperationLease` and leave the prior generation active. Use `googleapis`, offline access, exact readonly scope, in-memory access token, and provider enum rejection for Outlook.
- [ ] **Step 5: Implement token vault and key rotation.** Implement the vault schema/CAS/AAD invariants, `rotateVaultKey`, and `key-rotation-cli.ts`'s `--retiring-key-id`/`--new-key-id`/`--connection-id`/`--verify-retired` flags exactly as specified in Interfaces above. The CLI calls the same App lease/advance/release endpoints as refresh-token rotation, so the two rotation paths cannot race each other on the same connection.
- [ ] **Step 6: Implement `MailboxBrokerConnectionAppClient`.** Implement OAuth-attempt consume, connection completion, token-operation lease/advance/release, and revocation-state callbacks. Never create scan, candidate, upload, or structured-result routes in A. Add tests for App audience, `mailbox-broker-app` subject, and `mailbox:write` scope.
- [ ] **Step 7: Implement broker's own inbound auth and worker's outbound credentials.** `src/auth/clerk.ts` accepts exactly the two configured subjects above; `workflow-worker/src/config.ts` gains the new `clerk.mailboxApp`/`clerk.mailboxBroker` blocks.
- [ ] **Step 8: Run:** `pnpm --filter @expense-tax/mailbox-broker test && pnpm --filter @expense-tax/mailbox-broker typecheck && pnpm --filter @expense-tax/app-api test -- test/mailbox-token-generation.test.ts && pnpm --filter @expense-tax/workflow-worker exec vitest run test/mailbox-client.test.ts test/config.test.ts`; expected PASS.
- [ ] **Step 9: Commit:** `git add services/mailbox-broker/src services/mailbox-broker/test services/workflow-worker/src/config.ts services/workflow-worker/src/clients/mailbox-client.ts services/workflow-worker/test/mailbox-client.test.ts services/workflow-worker/test/config.test.ts && git commit -m "feat(mailbox): secure OAuth and broker clients"`

### Task 4: Fastify Broker/App Routes and Office Mailbox Base

**Local testability:** Fully local with fakes. No Google credentials or production access needed.

**Files:**
- Create: `expense-tax-management/services/mailbox-broker/src/app.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/routes/oauth.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/routes/connections.ts`
- Create: `expense-tax-management/services/mailbox-broker/src/server.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/routes.test.ts`
- Modify: `expense-tax-management/services/app-api/src/app.ts` (register Task 2's `routes/mailbox-connections.ts` — both the customer-facing `POST .../mailbox-connections/google/start` route and the internal `POST /internal/v1/mailbox/oauth/attempts/:attemptId/consume` route — and wire the Task 2 `mailboxBrokerServiceSubject`/`mailboxWorkerServiceSubject` config into their `serviceGuard` calls, the same way `app.ts:347-403` already wires `workerServiceSubject`/`foundryServiceSubject`)
- Create: `expense-tax-management/services/app-api/test/mailbox-routes-registration.test.ts` (asserts both routes are reachable through the fully built app, and rejects a wrong subject/audience/tenant token through the real registration, not just the unit-level guard test from Task 2)
- Modify: `expense-tax-management/frontend/office-web/src/lib/api.ts`
- Create: `expense-tax-management/frontend/office-web/src/lib/mailbox.ts`
- Create: `expense-tax-management/frontend/office-web/src/lib/mailbox.test.ts`
- Create: `expense-tax-management/frontend/office-web/src/app/(office)/mailbox/page.tsx`
- Modify: `expense-tax-management/frontend/office-web/src/components/office-shell.tsx`
- Modify: `expense-tax-management/frontend/office-web/src/lib/page-data.ts`

- [ ] **Step 1: Write failing tests** for broker callback query redaction, method/host policy, state consume call ordering, exact M2M auth, Office session nonce creation/transport, no localStorage sensitive values, connection status rendering, and (in the new registration test) that App API's built app actually exposes both mailbox routes and rejects wrong subject/audience/tenant-token calls to them.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/mailbox-broker exec vitest run test/routes.test.ts && pnpm --filter @expense-tax/office-web test -- src/lib/mailbox.test.ts && pnpm --filter @expense-tax/app-api test -- test/mailbox-routes-registration.test.ts`; expected FAIL.
- [ ] **Step 3: Implement routes.** Public `GET /oauth/google/callback`; internal `POST /internal/v1/oauth/google/start`, `POST /internal/v1/connections/:connectionId/revoke`, and App completion callback. Broker calls App consume endpoint before Google code exchange.
- [ ] **Step 4: Implement Office base.** `POST /api/v1/tenants/:tenantId/mailbox-connections/google/start` receives fresh browser session nonce and trusted redirect origin; page owns connect/account/status/schedule/reviewer base. B modifies this page for scan/review; C modifies it for ingestion status.
- [ ] **Step 5: Register App routes.** Wire Task 2's mailbox routes into `app-api/src/app.ts` exactly as the Files entry above describes; until this step, Task 2's routes exist only as an unregistered, unit-tested module.
- [ ] **Step 6: Run:** `pnpm contracts:generate && pnpm contracts:check && pnpm --filter @expense-tax/mailbox-broker test && pnpm --filter @expense-tax/office-web test && pnpm --filter @expense-tax/app-api test -- test/mailbox-routes-registration.test.ts`; expected PASS and no generated drift.
- [ ] **Step 7: Commit:**
  ```bash
  git add services/mailbox-broker services/app-api/src/app.ts services/app-api/test/mailbox-routes-registration.test.ts frontend/office-web/src/lib/api.ts frontend/office-web/src/lib/mailbox.ts frontend/office-web/src/lib/mailbox.test.ts "frontend/office-web/src/app/(office)/mailbox/page.tsx" frontend/office-web/src/components/office-shell.tsx frontend/office-web/src/lib/page-data.ts packages/contracts/generated
  git commit -m "feat(mailbox): add broker routes and Office base"
  ```

### Task 5: VPS Compose Integration, Operator Vault Bootstrap, and Exact Three-Principal Provisioning

**Local testability:** Container build and Compose config are locally testable (Docker, no production access). The vault database/role bootstrap script and Clerk machine identity provisioning are **operator-only, human-action-gated**: they mutate shared production infrastructure and require explicit execution-time confirmation before running against the real VPS/Postgres cluster or Clerk.

**Files:**
- Create: `expense-tax-management/services/mailbox-broker/Dockerfile`
- Create: `expense-tax-management/services/mailbox-broker/.dockerignore`
- Modify: `expense-tax-management/deploy/production/docker-compose.yml` (add `mailbox-broker` service: loopback port `127.0.0.1:8300:8300`; env `PORT`, `APP_VERSION`, `AUTH_PROVIDER`, `MAILBOX_SERVICE_TOKEN_ISSUER`, `MAILBOX_SERVICE_TOKEN_AUDIENCE`, `MAILBOX_SERVICE_JWKS_URL`, `CLERK_MAILBOX_APP_API_SUBJECT`, `CLERK_MAILBOX_WORKER_SUBJECT`, `CLERK_ISSUER_URL`, `CLERK_JWKS_URL`, `CLERK_APP_SERVICE_AUDIENCE` (reused), `CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY`, `CLERK_MAILBOX_BROKER_SUBJECT` (value `mailbox-broker-app`), `MAILBOX_VAULT_DATABASE_URL`, `MAILBOX_VAULT_KEYS`, `MAILBOX_VAULT_ACTIVE_KEY_ID`, `APP_API_BASE_URL` — same `${VAR:?VAR is required}` style as every other service in this file; deploy `resources.limits` `{cpus: "0.5", memory: 512M}`, matching the Expense workflow worker's ceiling; `networks: [default, database]`)
- Modify: `expense-tax-management/deploy/production/docker-compose.yml` (add `mailbox-broker-migrate` one-shot service, same pattern as `app-api-migrate`/`foundry-service-migrate`, using `MAILBOX_VAULT_MIGRATION_DATABASE_URL`)
- Modify: `expense-tax-management/deploy/production/docker-compose.yml` (add the Task 2 outbound-credential and expected-subject env to the existing `app-api` service's `environment` block: `MAILBOX_BROKER_BASE_URL: http://mailbox-broker:8300` as a hardcoded literal, matching `APP_API_BASE_URL`-style entries elsewhere in this file — not a secret-bundle var; and `CLERK_MAILBOX_SERVICE_AUDIENCE`, `CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY`, `CLERK_MAILBOX_APP_API_SUBJECT`, `CLERK_MAILBOX_BROKER_SUBJECT`, `CLERK_MAILBOX_WORKER_SUBJECT` as `${VAR:?...}`, same style as its existing `CLERK_*` entries)
- Modify: `expense-tax-management/deploy/production/deploy.sh`. Two distinct additions:
  (a) add `mailbox-broker` to the `APPLICATION_SERVICES` array (line 131), so `compose up -d` actually starts it — building the image alone does not run the container;
  (b) add every new *bundle-sourced* env key this plan introduces to the `KNOWN_ENV_KEYS` allowlist (lines 15-27) — `MAILBOX_SERVICE_TOKEN_ISSUER`, `MAILBOX_SERVICE_TOKEN_AUDIENCE`, `MAILBOX_SERVICE_JWKS_URL`, `CLERK_MAILBOX_SERVICE_AUDIENCE`, `CLERK_MAILBOX_APP_API_SUBJECT`, `CLERK_MAILBOX_WORKER_SUBJECT`, `CLERK_MAILBOX_BROKER_SUBJECT`, `CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY`, `CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY`, `CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY`, `MAILBOX_VAULT_DATABASE_URL`, `MAILBOX_VAULT_MIGRATION_DATABASE_URL`, `MAILBOX_VAULT_KEYS`, `MAILBOX_VAULT_ACTIVE_KEY_ID` — without this, `deploy.sh`'s `is_known_key` check silently drops every one of these lines from the production env file even if the Secret Manager bundle carries them, and every mailbox-dependent container fails closed at startup. `MAILBOX_BROKER_BASE_URL` is **not** added here: like `APP_API_BASE_URL`/`FOUNDRY_BASE_URL`, it is a hardcoded Compose literal, never a bundle-sourced `${VAR:?...}`, so it never appears in the production env file at all.
- Create: `expense-tax-management/deploy/production/bootstrap-mailbox-vault-db.sh` (same directory and operator-only invocation style as the existing `bootstrap-temporal-db.sh`: credentials piped via `PGPASSWORD`/stdin SQL, never as CLI arguments; idempotent `CREATE ROLE`/`CREATE DATABASE IF NOT EXISTS` guards. Unlike Temporal's single `expense_temporal` role, this script creates **two** roles — a DML-only runtime role and a DDL-only migration role — mirroring the existing App/Foundry runtime-vs-migration split already visible in this Compose file as `APP_DATABASE_URL` vs `APP_MIGRATION_DATABASE_URL`, not Temporal's single-role pattern)
- Modify: `expense-tax-management/scripts/lib/production-secret-bundle.mjs`. This is the script that actually builds the Secret Manager bundle version `deploy.sh`'s allowlist (above) later filters at deploy time — without this change, the new keys above can never originate anywhere real. Three additions, each following that file's own existing category treatment for comparable keys:
  - `REQUIRED_SHELL_KEYS` (operator-supplied secrets, hard failure if missing — no safe inert default exists for an encryption key or a machine secret) gains `CLERK_MAILBOX_APP_API_MACHINE_SECRET_KEY`, `CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY`, `CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY`, `MAILBOX_VAULT_KEYS`, `MAILBOX_VAULT_ACTIVE_KEY_ID`.
  - `REQUIRED_DATABASE_KEYS` gains `MAILBOX_VAULT_DATABASE_URL`, `MAILBOX_VAULT_MIGRATION_DATABASE_URL` (same `rewriteDatabaseUrl` treatment as the four existing App/Foundry URLs).
  - `CLERK_RUNTIME_KEYS` (optional, shell-overridable, otherwise fail-closed) gains `CLERK_MAILBOX_SERVICE_AUDIENCE`, `CLERK_MAILBOX_APP_API_SUBJECT`, `CLERK_MAILBOX_WORKER_SUBJECT`, `CLERK_MAILBOX_BROKER_SUBJECT`; `FAIL_CLOSED_RUNTIME_VALUES` gains matching inert placeholder entries for those four plus `MAILBOX_SERVICE_TOKEN_ISSUER`/`MAILBOX_SERVICE_TOKEN_AUDIENCE`/`MAILBOX_SERVICE_JWKS_URL` (these three are broker-verifier-side config, so they follow the `APP_SERVICE_TOKEN_*` treatment exactly — fail-closed-only, not shell-overridable through this script, matching that existing precedent rather than introducing a different one).
- Create: `expense-tax-management/services/mailbox-broker/README.md` (includes an explicit "Workflow worker credential — runtime migration Task 7 handoff" section: the exact three env vars `CLERK_MAILBOX_SERVICE_AUDIENCE`/`CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY`/`CLERK_MAILBOX_WORKER_SUBJECT` that the real `workflow-worker` Compose service — added by runtime migration Task 7 on branch `feature/task7-routing`, expected to merge to `dev` before 3D-A implementation — must carry, with the exact value `workflow-worker-mailbox` for the subject, so that merge does not have to rediscover this plan's Task 3 config requirement)
- Create: `expense-tax-management/services/mailbox-broker/test/compose-config.test.ts`
- Create: `expense-tax-management/services/mailbox-broker/test/deploy-script.test.ts`
- Modify: `expense-tax-management/scripts/lib/production-secret-bundle.test.mjs` (cover the new keys)
- Modify: `.github/workflows/expense-tax-deploy.yml` (repo-root file, outside `expense-tax-management/`; add `- image: expense-tax-mailbox-broker` / `dockerfile: expense-tax-management/services/mailbox-broker/Dockerfile` to the build matrix, alongside the existing `expense-tax-workflow-worker` entry)
- Modify: `infrastructure/cloudflare/expense-tax/variables.tf` (add `mailbox_hostname` variable, default `expense-mailbox.tobytran.dev`, following the exact pattern of `api_hostname`/`foundry_hostname`)
- Modify: `infrastructure/cloudflare/expense-tax/main.tf` (add one ingress rule routing `var.mailbox_hostname` + `path = "/oauth/google/callback"` to `http://127.0.0.1:8300`, placed before the catch-all `http_status:404` rule, mirroring the existing path-scoped Foundry rule at `path = "/internal/v1/*"`; add the new hostname to `local.tunnel_hostnames` so its CNAME is created. No other broker path is added to `ingress`, so every other broker route falls through to the existing `http_status:404` catch-all and stays unreachable from the Tunnel.)
- Modify: `expense-tax-management/scripts/check-cloudflare-infrastructure.mjs` (add `includes(main, 'service  = "http://127.0.0.1:8300"')` and an assertion that the mailbox ingress rule carries `path = "/oauth/google/callback"`, mirroring the existing per-port `includes()` assertions)
- Modify: `expense-tax-management/scripts/check-cloudflare-infrastructure.test.mjs` (cover the new assertions)

**Local testability for the Cloudflare changes specifically:** the Terraform/variables/script changes and their static test are locally verifiable (`terraform validate`/`node --test`, no network). Running `terraform plan`/`apply` against the real Cloudflare account — the only way to actually create the DNS record and ingress rule — is **operator-gated** through the existing `.github/workflows/expense-tax-cloudflare.yml` plan/apply jobs (production environment + manual `workflow_dispatch`), unchanged by this plan.

- [ ] **Step 1: Write static tests** for no GCP identity/key in the broker container config, loopback-only port binding, no public route except `/oauth/google/callback` through the Tunnel, container resource ceiling present, three exact Clerk subjects/scopes including `workflow-worker-mailbox` App audience, `mailbox-broker` present in `deploy.sh`'s `APPLICATION_SERVICES` array, every new env key present in `deploy.sh`'s `KNOWN_ENV_KEYS` array, every new key present in the right `production-secret-bundle.mjs` category (and absent from the wrong one — e.g. a machine secret must never end up only in `CLERK_RUNTIME_KEYS`, which is shell-optional), and the Cloudflare `main.tf`/`check-cloudflare-infrastructure.mjs` assertions above.
- [ ] **Step 2: Run red:** `pnpm --filter @expense-tax/mailbox-broker exec vitest run test/compose-config.test.ts test/deploy-script.test.ts && pnpm exec vitest run scripts/lib/production-secret-bundle.test.mjs && node --test expense-tax-management/scripts/check-cloudflare-infrastructure.test.mjs`; expected FAIL.
- [ ] **Step 3: Implement Dockerfile and Compose service.** Add `mailbox-broker` (and its migrate job) to `deploy/production/docker-compose.yml` exactly as the Files entry above specifies: loopback port, environment from the existing Expense bundle, container CPU/memory ceiling (0.5 vCPU / 512 MB default), no GCP service-account mount. This image joins the existing immutable main-only deploy matrix (`.github/workflows/expense-tax-deploy.yml`); it is not deployed by `dev` merges, and not started in production until `deploy.sh`'s `APPLICATION_SERVICES` array includes it (Step 4 below) and the release is explicitly approved per `plans/PLAN.md`'s "Production rollout ... requires separate release planning and explicit deployment approval."
- [ ] **Step 4: Update `deploy.sh`.** Add `mailbox-broker` to the `APPLICATION_SERVICES` array (without this, the built image exists in GHCR but `compose up -d` never starts the container) and every new env key to `KNOWN_ENV_KEYS` exactly as the Files entry above lists (without this, `is_known_key` silently drops those lines from the production env file even when the Secret Manager bundle carries them).
- [ ] **Step 4a: Update `production-secret-bundle.mjs`.** Add the new keys to `REQUIRED_SHELL_KEYS`, `REQUIRED_DATABASE_KEYS`, and `CLERK_RUNTIME_KEYS`/`FAIL_CLOSED_RUNTIME_VALUES` exactly as the Files entry above specifies, so a rebuilt bundle version can actually carry them end to end.
- [ ] **Step 5: Implement operator-only vault bootstrap script.** `deploy/production/bootstrap-mailbox-vault-db.sh` creates the dedicated token-vault database plus separate runtime (DML-only) and migration (DDL-only) roles, following `bootstrap-temporal-db.sh`'s credential-handling and idempotency style (not its single-role shape — see the Files entry above). The normal deploy path never runs this script.
- [ ] **Step 6: Implement the Cloudflare Tunnel ingress change.** Modify `variables.tf`/`main.tf`/`check-cloudflare-infrastructure.mjs`/`.test.mjs` exactly as the Files entries above specify; run `terraform -chdir=infrastructure/cloudflare/expense-tax init -backend=false && terraform -chdir=infrastructure/cloudflare/expense-tax validate` to confirm the HCL is well-formed. Do not run `terraform plan`/`apply`.
- [ ] **Step 6a: Write the runtime migration Task 7 handoff note.** This plan cannot add env vars to the real `workflow-worker` Compose service itself — it lives on branch `feature/task7-routing` (runtime migration Task 7), expected to merge to `dev` before 3D-A implementation starts, not in this worktree. Write the exact three-variable requirement (`CLERK_MAILBOX_SERVICE_AUDIENCE`/`CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY`/`CLERK_MAILBOX_WORKER_SUBJECT`, subject value `workflow-worker-mailbox`) into `README.md` as specified in the Files entry above, so that merge carries them from day one instead of discovering the gap after deploying without mailbox credentials. If `feature/task7-routing` has not merged by the time an implementer reaches this plan, coordinate directly with that work instead of guessing at its Compose shape.
- [ ] **Step 7: Request explicit confirmation before remote commands.** Show the vault bootstrap script, Clerk machine-identity provisioning commands, the Compose/deploy diff, and the Cloudflare `terraform plan` output; execute only after confirmation. These touch shared production Postgres, Clerk, and Cloudflare and are not reversible by a revert commit alone.
- [ ] **Step 8: Verify:** `pnpm --filter @expense-tax/mailbox-broker test && docker build -f services/mailbox-broker/Dockerfile services/mailbox-broker && pnpm exec vitest run scripts/lib/production-secret-bundle.test.mjs && node --test expense-tax-management/scripts/check-cloudflare-infrastructure.test.mjs`; expected PASS and no unapproved paid product.
- [ ] **Step 9: Commit:** `git add services/mailbox-broker/Dockerfile services/mailbox-broker/.dockerignore services/mailbox-broker/README.md services/mailbox-broker/test/compose-config.test.ts services/mailbox-broker/test/deploy-script.test.ts deploy/production/docker-compose.yml deploy/production/deploy.sh deploy/production/bootstrap-mailbox-vault-db.sh scripts/lib/production-secret-bundle.mjs scripts/lib/production-secret-bundle.test.mjs ../.github/workflows/expense-tax-deploy.yml ../infrastructure/cloudflare/expense-tax/variables.tf ../infrastructure/cloudflare/expense-tax/main.tf scripts/check-cloudflare-infrastructure.mjs scripts/check-cloudflare-infrastructure.test.mjs && git commit -m "infra(mailbox): add broker container to VPS Compose and Tunnel"`

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
| 3. Broker token vault, key rotation, OAuth CAS, Clerk identity, worker client | Mostly (fake Google client, test Postgres) | Operator-gated: real Google OAuth client/test account for end-to-end token-refresh verification |
| 4. Fastify routes, App route registration, Office base | Yes, fully | No |
| 5. VPS Compose integration, deploy allowlist, Cloudflare Tunnel ingress, vault bootstrap, Clerk provisioning | Container build/Terraform-validate/config: yes | Operator-gated: vault DB/role bootstrap, Clerk machine-identity provisioning, and `terraform apply` against real infrastructure |
| 6. A verification and B handoff | Yes (integration test needs local test Postgres) | No |
