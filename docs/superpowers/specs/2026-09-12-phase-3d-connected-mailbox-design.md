# Phase 3D Premium Connected Mailbox Design

**Date:** 2026-09-12  
**Status:** Approved; implementation not started; blocked by Phase 3C
**Depends on:** Phase 3C auto-tagging, Phase 0J1 entitlements, Phase 0L Temporal worker, Phase 0P forwarded intake, Phase 3B deduplication, Phase 1C gateway hardening

## Objective

Allow entitled users to connect Gmail, run scheduled or manual read-only receipt
scans, ingest PDF/image attachments and deterministic structured-HTML receipts,
and route ambiguous items to review. OAuth tokens remain outside App PostgreSQL,
Temporal history, browsers, logs, and VPS files.

Gmail is the first provider. Provider-neutral contracts and cursor semantics allow
later Outlook support without rewriting App data ownership or workflows.

## Product Decisions

- Feature requires effective entitlement `connected_mailbox_scan`.
- Gmail ships first behind a provider adapter.
- Google scope is `https://www.googleapis.com/auth/gmail.readonly` only.
- A connection has one authorized default Personal/business scope.
- High-confidence receipt candidates use the default scope.
- Ambiguous receipt or scope classification enters an explicit review queue.
- First release processes PDF/image attachments and deterministic structured HTML.
- Ambiguous free text is review-only; no live LLM classification or extraction.
- Phase 3B duplicate candidates remain pending review and never auto-merge.
- Mailbox broker runs as a TypeScript Fastify container in the Expense
  production Compose on the VPS, loopback port, public only through the
  existing Cloudflare Tunnel where the OAuth callback requires it.
- `main`/production deployment remains subject to a later release decision.

## Service Architecture

```text
Office Web
  -> App API (tenant/scope auth, entitlement, metadata, review)
  -> mailbox-broker on VPS (OAuth, token vault, Gmail calls)

App API
  -> Temporal Schedule / MailboxScanWorkflow

TypeScript workflow worker
  -> App API job-bound input
  -> mailbox-broker authenticated internal API
  -> App API versioned scan/candidate callbacks

mailbox-broker
  -> dedicated PostgreSQL token-vault database (AES-256-GCM refresh token per connection)
  -> Gmail API (gmail.readonly)
  -> App API internal staging/upload callbacks

Accepted candidate
  -> existing file/OCR or structured-receipt result path
  -> expense materialization
  -> Phase 3B provenance/deduplication
```

### Why a separate broker service

Mailbox Broker runs as its own TypeScript Fastify container in the Expense
production Compose on the VPS, loopback-only like every other Expense origin.
It is a separate service, not a separate host: isolating Google OAuth
credentials and Gmail calls behind one process keeps App API and the
workflow worker free of Google client libraries and refresh-token handling.

**Ruling (Task 4, fix round 1):** the browser must touch the broker's own
origin *before* Google, not only after, so the broker can set its session-
nonce binding cookie itself. A cookie Office JavaScript sets is host-only on
the Office origin and never reaches the broker's callback origin, and
JavaScript cannot set `HttpOnly` -- so the one-time OAuth attempt had no
way to be bound to the initiating browser session at all under the
original single-public-route design. The Cloudflare Tunnel therefore
exposes **two** browser-facing broker routes on the same existing
hostname/tunnel (an additive ingress-rule change, not a new host):

- Public: `GET /oauth/google/begin`, the browser's first stop. Wraps the
  already-built Google authorization URL; stateless (decrypts and
  validates the embedded OAuth `state` via the same logic the callback
  itself uses -- no DB row, no new secret), and only on success does it set
  the `Secure; HttpOnly; SameSite=Lax` session-nonce cookie and redirect to
  Google. App API's customer-facing start route returns this URL (not
  Google's directly); Office never creates, stores, or transports the
  nonce itself.
- Public: `GET /oauth/google/callback`, protected by encrypted one-time OAuth
  state, the cookie `/oauth/google/begin` set, and bounded rate limits.
- Internal: Clerk M2M issuer, exact mailbox-broker audience, exact App/worker
  subjects, and route-specific scopes.
- Health: GET/HEAD only, no customer data.
- Unknown host/path/method: reject.

Clerk M2M protects application calls; it does not replace tenant/scope
authorization in App API. Database-level least-privilege roles protect the
token vault; the broker's runtime role may read/write only its own vault
tables.

Provision three dedicated Clerk machine identities; do not reuse existing OCR or
Foundry credentials:

- App API -> broker: subject `app-api-mailbox`, broker audience, scopes
  `oauth:start`, `connections:read`, `connections:revoke`.
- Workflow worker -> broker: subject `workflow-worker-mailbox`, broker
  audience, scopes `mailbox:discover`, `mailbox:materialize`.
- Broker -> App API: subject `mailbox-broker-app`, App service audience, scopes
  `mailbox:write`, `files:write`.

Broker verifies exact issuer, singleton audience, subject, and route scope. App API
verifies exact broker subject/audience/scopes on staging and upload callbacks.
Machine secrets are stored in Secret Manager or the existing protected production
bundle according to runtime location; they are never shared between principals.
Contract and negative authorization tests cover every subject/audience/scope
confusion pair.

## Mailbox Broker

Add a Node 24 TypeScript Fastify service under `services/mailbox-broker`
running as a VPS container in the Expense production Compose. It owns a
dedicated PostgreSQL token-vault database and no other state. It uses:

- `googleapis` Gmail/OAuth2 client.
- Kysely/PostgreSQL client against its own token-vault database, with a
  separate least-privilege runtime role from its migration role.
- Node `crypto` AES-256-GCM encrypt/decrypt for refresh tokens, keyed by the
  active key ID from the Expense Secret Manager bundle (deployment-time env).
- Existing Clerk JWT/M2M verification patterns.
- Existing gateway hardening patterns for body limits, timeouts, rate limits,
  method policy, and security headers.

Provider interface:

```ts
interface MailboxProviderAdapter {
  createAuthorizationUrl(input: OAuthStartInput): Promise<OAuthStartResult>;
  exchangeAuthorizationCode(input: OAuthCallbackInput): Promise<ConnectedAccount>;
  discover(input: DiscoveryInput): Promise<DiscoveryPage>;
  materialize(input: MaterializeInput): Promise<MaterializeResult>;
  revoke(input: RevokeConnectionInput): Promise<void>;
}
```

Gmail is the only implementation in Phase 3D. Provider-specific message/history
IDs remain opaque strings behind App-owned connection/candidate records.

## OAuth Flow and Token Lifecycle

1. Office calls App API to start a Gmail connection with explicit default scope,
   timezone, and schedule. Office supplies no session nonce of its own (fix
   round 1 ruling, above): App API generates it.
2. App API verifies owner/admin connection permission, effective entitlement, and
   current membership to the requested Personal profile or Business.
3. App API creates pending connection and one-time OAuth attempt metadata. No code
   verifier, token, or client secret is stored in App PostgreSQL.
4. App API generates the session nonce and calls broker
   `POST /internal/v1/mailbox/oauth/start` with connection/attempt IDs and the
   nonce using Clerk M2M.
5. Broker returns a Google authorization URL using offline access, PKCE, exact
   readonly scope, encrypted state, and a short expiry. State uses AES-256-GCM
   authenticated encryption. It contains key ID, connection/attempt IDs, initiating
   user/session nonce digest, PKCE verifier, issued-at, expiry, and redirect-origin
   binding. Browser cannot read or modify it. App API wraps this URL and the raw
   nonce into a link to the broker's own `GET /oauth/google/begin` and returns
   that link to Office instead of Google's URL directly.
6. Office navigates the browser to the broker's `/oauth/google/begin` link.
   The broker re-validates the embedded state (same logic the callback below
   uses), then -- and only on success -- sets its own `Secure; HttpOnly;
   SameSite=Lax` session-nonce cookie and 302s the browser to the real Google
   authorization URL.
7. Google redirects to broker `GET /oauth/google/callback`, carrying the
   cookie `/oauth/google/begin` set (browser and broker share an origin, so
   this works; it could not when the cookie was set by Office JavaScript on
   a different origin).
8. Broker selects state key by key ID, verifies AEAD tag, expiry, redirect origin,
   the session-nonce cookie's digest against the one embedded in state, and
   one-time pending attempt, then compares a
   constant-time state digest with App API before exchanging the code.
9. Broker validates returned scopes and Gmail profile, inserts one token-vault
   row for the connection, and stores the refresh token as AES-256-GCM
   ciphertext with nonce, key ID, and generation 1. Short-lived access tokens
   exist only in broker memory.
10. Broker calls authenticated App API completion endpoint with connection ID,
    attempt ID, opaque vault reference, provider account ID, email, granted
    scopes, and initial Gmail history ID. No token value crosses this boundary.
11. App API atomically activates connection and closes attempt. Broker clears
    its session-nonce cookie and redirects the browser to Office's `/mailbox`
    connection result page.

Google may emit a new refresh token through the OAuth client's `tokens` event.
Broker writes a new vault-row generation, verifies it, then disables/destroys
the prior generation within the same token-vault transaction. Token revocation
marks connection `reauth_required`; it does not silently fall back to broader
scopes.

State AEAD keys come from the Expense Secret Manager bundle (deployment-time
env) and rotate by overlapping key IDs. New starts use current key; callbacks
may use prior key only until their 10-minute attempt expiry. App API stores
only state digest/session nonce digest, never plaintext state or verifier.

Refresh, reauthorization, and revoke operations acquire an App API connection
lease bound to expected connection version. The vault row includes monotonic
token generation. Broker adds and verifies a new generation, then App API
compare-and-swaps active generation/version before the old generation is
disabled. A losing operation destroys only its own newly created generation.
Revocation increments connection version, invalidates refresh leases, revokes
provider credentials, then destroys every token-vault generation. Repeated
cleanup/revoke is idempotent.

Vault rows key by opaque connection UUID, never tenant names or email
addresses. The existing production environment-bundle secret remains separate;
its single-version policy does not apply to per-connection vault rows.

Broker must redact authorization/token/ciphertext/nonce fields at logger
construction and test that no plaintext token or ciphertext appears in logs or
errors.

## Token Vault and Database Boundary

Mailbox Broker owns a dedicated PostgreSQL token-vault database on the shared
cluster, separate from App and Foundry databases. Creating this database and
its roles is an explicit operator-only step, identical in kind to Temporal
database bootstrap; normal deploy never creates databases.

Use separate least-privilege roles:

- Runtime role: read/write on vault rows only; no DDL.
- Migration role: DDL on vault tables only; not used by the running service.

The broker container has no GCP identity and no ambient cloud credentials. Its
only GCP touchpoint is reading the active AES-256-GCM key ID from the Expense
Secret Manager bundle at deployment time, the same mechanism every other
Expense service uses for its environment file.

Broker resource limits join the existing VPS container ceilings in
`ARCHITECTURE.md`'s Runtime Sizing table. Pending measurement, start at the
same 0.5 vCPU / 512 MB ceiling as the Expense workflow worker; it is mostly
I/O-bound Gmail and vault calls.

This phase runs on infrastructure already paid for; there is no per-scan GCP
compute cost to track. Any live LLM cost remains separately prohibited.

## App API Data Model

Add migrations after Phase 3C.

### Mailbox connections

Add `app.mailbox_connections`:

- `id`, `tenant_id`, `owner_user_id`.
- `provider`: `gmail` (schema permits later `outlook`).
- `provider_account_id`, normalized account email.
- `vault_reference` opaque token-vault row reference, never secret value.
- Exactly one default `personal_profile_id` or `business_id`.
- `status`: `pending`, `active`, `paused`, `reauth_required`, `disconnecting`,
  `revocation_pending`, or `revoked`.
- Granted scopes, timezone, local scan time, scan enabled flag.
- Provider cursor (`history_id`) and cursor timestamp.
- Active token generation and nullable token-operation lease ID/expiry.
- Nullable active scan-run ID/lease expiry for connection-wide single flight.
- Last scan timestamp, next schedule timestamp, version, created/updated/revoked.
- Unique active `(tenant_id, provider, provider_account_id, scope)`.

Composite foreign keys and triggers enforce exact tenant/scope agreement.
Changing default scope requires current authorization and versions the connection;
it never rewrites already-ingested candidates/expenses.

### Review grants

Add `app.mailbox_connection_reviewers`:

- Connection/tenant/user IDs.
- Role `reviewer` or `manager`.
- Version and audit timestamps.

Connection owner is an implicit manager. Explicit grants make unassigned candidates
visible before a Personal/business assignment exists. Tenant role alone never
grants review access. Assignment requires target-scope membership at action time.

### OAuth attempts

Add `app.mailbox_oauth_attempts`:

- Attempt/connection/tenant/actor IDs.
- State digest, expiry, terminal status, created/completed timestamps.
- No authorization code, PKCE verifier, access token, refresh token, or client
  secret.

Attempts are one-time and expire after 10 minutes.

### Scan runs

Add `app.mailbox_scan_runs`:

- Run/connection/tenant IDs and initiating actor or `schedule`.
- Bound entitlement version, connection version, cursor-before/cursor-after.
- Status: `pending`, `running`, `completed`, `partial`, `failed`, `skipped`.
- Counts: discovered, staged, ingested, review, duplicate, skipped, failed.
- Typed error code, started/completed timestamps, idempotency key.
- Unique `(connection_id, idempotency_key)` with permanent replay result.

### Mailbox candidates

Add `app.mailbox_candidates`:

- Candidate/run/connection/tenant IDs.
- Provider message ID and thread ID.
- Received timestamp, sender address/domain, bounded subject.
- Message content hash and attachment manifest containing names, MIME types,
  sizes, and SHA-256 only.
- Classification: `receipt`, `ambiguous`, or `not_receipt`; confidence/evidence.
- Exactly one assigned Personal/business scope or unassigned review state.
- Status: `staged`, `review`, `queued`, `processed`, `duplicate`, `skipped`,
  `failed`.
- Processing job, expense, inbound/provenance, and duplicate-match references.
- Version, idempotency key, error code, timestamps.
- Unique `(connection_id, provider_message_id)`.
- Unique `(connection_id, idempotency_key)`; same key/different normalized payload
  returns conflict.

Raw MIME, body HTML/text, inline images, and OAuth values are never stored here.
Accepted PDF/image attachments become normal encrypted/signed storage objects under
existing file retention rules.

All scan/candidate/upload/result callbacks use operation-scoped permanent keys:
`connection:run:operation:provider-message-or-page:version`. Database uniqueness,
not temporary HTTP idempotency retention, returns original result for identical
replay and rejects same-key/different-payload replay.

## Gmail Discovery and Cursor Semantics

Initial full sync:

- Read current Gmail profile history ID as pre-sync fence.
- Use `messages.list` with readonly scope, receipt-oriented query, maximum 100
  messages, and configured lookback.
- Default lookback is 30 days; hard maximum is 90 days.
- Fetch message details in bounded pages/batches.
- After durable staging, replay `users.history.list` from pre-sync fence to catch
  messages arriving during full sync.
- Persist post-replay history ID only after every discovered message ID has a
  durable candidate or durable retry record.

Incremental sync:

- Use `users.history.list(startHistoryId)` and follow pagination.
- Gmail history is typically available for at least one week but may be shorter.
- Gmail returns HTTP 404 when `startHistoryId` is outside retained history.
- On that 404, perform a bounded 30-day full sync. Existing unique message IDs
  make recovery idempotent; use same pre-fence/full-sync/replay sequence.
- A failed message fetch creates durable retry state before cursor advances.
- Cursor advances only after App API records every page/message outcome, so later
  retries do not depend on Gmail retaining old history.

First release uses scheduled polling, not Gmail Pub/Sub/watch. Sender allow/block
lists are optional connection settings. The scanner never labels, modifies,
archives, marks read, or deletes mailbox messages.

## Deterministic Classification and Extraction

Broker classifies using versioned rules:

- Allowed PDF/image attachments with Phase 0P MIME, size, magic-byte, and malware
  checks.
- JSON-LD or microdata with recognized order/invoice/receipt structures.
- Known structured HTML patterns validated against merchant/sender rules.
- Subject/sender receipt keywords as evidence, not sufficient alone for automatic
  ingestion.

High-confidence attachment or structured-HTML receipts are staged for default
scope ingestion. Ambiguous or conflicting evidence enters review. Plain free text
never creates an expense automatically.

Parser limits are fixed: maximum 1 MiB decoded HTML, 20,000 DOM nodes, depth 64,
2-second parse budget, no external resource fetch, no script execution, no XML
DTD/entity expansion, and no decompression beyond bounded Gmail decoding. Message
may include at most 5 accepted attachments, each at most existing
`MAX_UPLOAD_BYTES` (25 MiB). Exceeding a limit creates typed review/skip outcome,
never partial parsing.

### Attachment path

1. Broker refetches candidate by App-bound connection/message reference.
2. Broker requests an internal App upload grant bound to candidate and default or
   reviewed scope.
3. Broker streams attachment to existing storage path without placing bytes in
   Temporal history.
4. App API creates standard file/OCR job.
5. Existing OCR result materializes expense and Phase 3B records
   `connected_mailbox` provenance/dedup evidence.

### Structured HTML path

1. Broker parses recognized structured fields in memory.
2. Broker submits a versioned structured-receipt result bound to candidate.
3. App API validates merchant, money/currency scale, date, order number, scope,
   connection, and candidate versions.
4. App API materializes a ready expense through `insertExpenseInTransaction` (or
   its shared transaction helper), atomically creating the Phase 3C enrichment
   job/outbox exactly like manual and OCR/forwarded expenses.
5. App API invokes Phase 3B evidence/provenance path.

No raw HTML/text enters result contracts or Temporal history.

## Temporal Scheduling

Create one Temporal Schedule per active connection:

- Default daily at `02:00` in connection timezone.
- User may change local time/timezone or run manually.
- Schedule overlap policy skips a new run while prior run is active.
- Stable schedule ID derived from connection UUID.
- Manual scan uses distinct deterministic workflow ID/idempotency key.

Schedule and manual starts both acquire the same database-backed connection scan
lease by compare-and-swap. If an unexpired run owns the lease, scheduled start
returns typed `skipped_overlap` and manual start returns the existing run with
HTTP 409 semantics; neither starts another workflow. Lease expiry/recovery is
audited and requires confirming the prior workflow is terminal.

`MailboxScanWorkflow` receives only opaque scan-run reference. First activity calls
App API for job-bound input and re-checks:

- Effective `connected_mailbox_scan` entitlement and version.
- Connection status/version.
- Default scope existence.
- Connection owner/reviewer policy.

Temporal workflow inputs, activity inputs/results, heartbeats, exceptions, and
retry details contain only scan-run/candidate UUIDs, bounded counts, page ordinal,
and typed error codes. They never contain Gmail message/thread/history IDs, sender,
subject, attachment metadata/bytes, structured receipt fields, HTML/text, OAuth
state, or provider error bodies. Broker stages metadata directly into App API and
returns only opaque App IDs/counts to worker.

Entitlement disabled or connection paused returns typed `skipped`, pauses future
scheduling, and preserves configuration. Re-enablement requires explicit resume.

Per-message failures do not roll back successful candidates. Workflow records a
partial run and bounded error counts. All broker/App callbacks use deterministic
idempotency keys and expected versions.

## Scope and Review Behavior

- Connection creation requires authorization to default scope.
- Every scheduled run revalidates default scope existence and owner access.
- High-confidence candidates use default scope.
- Ambiguous candidates remain unassigned and visible only to owner or explicit
  connection reviewers.
- Assigning/reassigning requires current membership to target scope.
- Once ingestion starts, scope is immutable for that candidate; correction occurs
  through existing expense move/correction policy, not by rewriting provenance.
- No tenant-admin shortcut grants access to Personal/business candidate data.

Every connection/candidate list, detail, and mutation revalidates current tenant
membership, connection status/version, owner or non-revoked reviewer grant, and
grant version. Review assignment additionally revalidates target-scope membership.
Revoked connection/grant immediately removes read and mutation access even if a
browser retained old candidate data.

Review actions:

- `ingest`: assign authorized scope and queue processing.
- `skip`: retain metadata/audit, no expense.
- `not_receipt`: terminal training/audit outcome, no mailbox modification.
- `retry`: allowed for typed transient failure only.

## APIs

Office/App API:

- `POST /api/v1/tenants/:tenantId/mailbox-connections/google/start`
- `GET /api/v1/tenants/:tenantId/mailbox-connections`
- `GET/PATCH /api/v1/tenants/:tenantId/mailbox-connections/:connectionId`
- `POST .../:connectionId/scan-runs`
- `GET .../:connectionId/scan-runs`
- `GET .../:connectionId/candidates`
- `POST .../candidates/:candidateId/resolve`
- `POST .../:connectionId/disconnect`
- Reviewer grant management under connection.

Internal App/broker/worker routes are versioned separately and accept only
connection/attempt/scan/candidate/job references, expected versions, result data,
and idempotency keys. Caller-provided tenant/profile/business/expense targets are
not trusted; App API resolves bindings server-side.

## Office Web

Settings owns connected-mailbox administration:

- Connect Gmail and OAuth result.
- Account, status, granted readonly scope, default Personal/business scope.
- Reviewer grants.
- Daily local scan time/timezone and enable/pause.
- Manual Scan now action.
- Last/next scan and run history counts.
- Reauthorization and disconnect.
- Candidate review queue with sender, subject, received date, attachment summary,
  deterministic reason, scope selector, ingest/skip/not-receipt actions.

Capture Web shows resulting expenses but does not manage mailbox connections.
Foundry sees no mailbox account, message, receipt, or token data.

## Disconnect and Revocation

1. App API marks connection disconnecting and pauses Temporal schedule.
2. Broker loads refresh token, calls Google revocation, clears in-memory
   credentials, and destroys/disables all token secret versions.
3. App API marks connection `revoked`, closes pending candidates, and writes audit.
4. Minimal scan/candidate metadata remains for audit and duplicate prevention.

Failure to contact Google records `revocation_pending` internally and retries
boundedly; local scan access remains disabled immediately. No hard deletion of
expenses, provenance, or audit history occurs.

## Failure Behavior

- Gmail 401/invalid grant: connection `reauth_required`; no repeated refresh loop.
- Gmail 429/5xx: bounded retries honoring `Retry-After`; run may end partial.
- Expired history ID HTTP 404: bounded full-sync recovery, not connection failure.
- Entitlement disabled: typed skipped run and paused schedule.
- Candidate conflict/version mismatch: no ingestion; return stale/conflict.
- Broker/App callback uncertainty: retry same idempotency key; never duplicate
  candidate, file, job, expense, or provenance.
- Secret write succeeds but App completion fails: broker retains attempt ID and
  retries completion; expired orphan token version is destroyed by cleanup.
- Raw provider/API errors are mapped to typed codes and scrubbed of headers,
  tokens, MIME bodies, and email content.

## Implementation Decomposition

One design governs three independently reviewable implementation plans:

Phase 3D-A defines canonical `MailboxConnectionV1`, OAuth attempt, reviewer,
broker M2M, typed error, connection-version, token-generation, and permanent
idempotency contracts consumed unchanged by B/C. Phase 3D-B adds `MailboxScanRunV1`
and `MailboxCandidateV1`; Phase 3D-C may add ingestion result variants but cannot
reinterpret A/B states. Each migration has a distinct name/order and each callback
version remains accepted until no persisted job/run references it.

### Phase 3D-A: Broker and connection lifecycle

- Mailbox broker service, VPS Compose integration, and PostgreSQL token-vault
  infrastructure.
- Gmail OAuth start/callback/revoke.
- App connection/OAuth/reviewer schema and APIs.
- Office connect/status/reauth/disconnect UI.
- Dedicated Clerk machine identities and negative auth tests.

### Phase 3D-B: Scheduling, discovery, and review

- Temporal schedule and workflow.
- Entitlement/version checks.
- Gmail full/incremental sync and HTTP 404 recovery.
- Scan/candidate persistence, deterministic classification, review queue.

### Phase 3D-C: Ingestion and deduplication

- Attachment streaming into existing upload/OCR path.
- Structured HTML parser/result contract.
- Connected-mailbox provenance extension.
- Phase 3B cross-channel dedup integration.
- End-to-end Office scan history and candidate resolution.

Each plan ships working, testable behavior and cannot assume later subphase code.

## Verification

- OAuth uses offline access, PKCE, exact readonly scope, short-lived encrypted
  state, and one-time attempts.
- App PostgreSQL (customer domain database), Temporal history, Office/browser
  storage or response bodies, VPS files, and logs contain no plaintext access
  token, refresh token, authorization code, PKCE verifier, or client secret.
  The broker's token-vault database holds only AES-256-GCM ciphertext, nonce,
  key ID, and generation. Google necessarily sends the one-time authorization
  code in the broker callback URL; broker disables query logging, consumes it
  immediately, and never persists or returns it.
- Logger redacts ciphertext/nonce/token fields; no plaintext secret or
  ciphertext appears in logs or errors.
- Broker container has no GCP identity; it reads only its deployment-time
  environment bundle like other Expense services and cannot reach GCP APIs at
  runtime.
- App, worker, and broker machine identities reject wrong audience, subject, and
  scope combinations.
- Cross-tenant/profile/business connection/candidate access fails closed.
- Tenant admin without connection grant or target-scope membership cannot review
  or assign candidates.
- Initial and incremental scans are idempotent.
- Concurrent schedule/manual/retry starts produce one connection scan lease/run.
- Expired Gmail history ID recovers through fenced bounded full sync and replays
  messages arriving during recovery.
- Cursor never advances before durable staging.
- Failed message fetch has durable retry state before cursor advancement.
- Entitlement removal pauses scans without deleting configuration.
- Attachment path uses existing security checks, OCR, and pending dedup review.
- Structured HTML path stores no raw HTML and produces validated expense data.
- Oversize/deep/slow/external-resource HTML fails within parser limits.
- Ambiguous free text creates no automatic expense.
- Disconnect disables access immediately and destroys/disables token versions.
- Refresh/revoke races cannot disable newest committed generation or retain usable
  token after revocation.
- Broker container joins the existing immutable deploy matrix with no
  additional paid GCP compute enabled.
- Broker, App API, worker, Office, PostgreSQL integration, and end-to-end tests
  pass with generated artifacts clean.

## Non-Goals

- No Outlook implementation in Phase 3D; adapter compatibility only.
- No Gmail modify/labels scope.
- No Gmail Pub/Sub push notifications.
- No LLM classification or extraction.
- No raw mailbox body retention.
- No plaintext OAuth tokens anywhere; only AES-256-GCM ciphertext in the
  dedicated token-vault database.
- No GCP compute (Cloud Run, Cloud Functions, or any always-on service) for
  Mailbox Broker; no GCP identity of any kind on the broker container.
- No automatic duplicate merge.
- No automatic cross-scope routing without authorized review.
- No changes to transitional `expense-service` or `frontend/web`.

## Documentation References

- Google APIs Node.js client: OAuth offline access, token refresh events, and
  credential revocation.
- Gmail synchronization guide (updated 2026-09-10): full sync,
  `users.history.list`, and HTTP 404 recovery for expired history IDs.
- PostgreSQL pgcrypto / Node `crypto`: AES-256-GCM authenticated encryption
  patterns for the token vault.
