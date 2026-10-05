# Phase 0D Implementation Plan: App-Owned Signed Uploads + Storage Adapter Boundary

> **Status:** Local signed-upload/storage boundary complete. Retained because App API explicitly references it and production GCS adapter/credentials remain pending. Do not re-execute completed tasks.

Source of truth: [phase-0i-polyglot-platform-rebaseline-design.md](phase-0i-polyglot-platform-rebaseline-design.md)
sections 4.1 (App API owns "Signed upload sessions and receipt metadata";
"App API is the only service allowed to mutate customer-domain tables"),
8.3 (`ExpenseFile` primary record), roadmap row 5B ("Direct signed GCS
upload, metadata ownership, worker access, thumbnails, export storage",
depends on 0I + 0J — satisfied), and section 22 gate ("Fake-provider
end-to-end flow covers App API, Foundry, Temporal, Python worker, and
GCS").

Supersedes the removed legacy cloud-storage plan: do not implement
upload-through-FastAPI or Python ownership. GCS bucket/IAM/lifecycle work remains
a separate deployment concern tracked in `../ROADMAP.md`.

## Scope

In scope:
- `ExpenseFile` metadata ownership in App API (new tables, domain, tenant
  routes), with the same exactly-one-scope invariant as expenses
  (`CHECK ((personal_profile_id IS NULL) <> (business_id IS NULL))` +
  composite FKs).
- Signed upload sessions: tenant creates a session, gets a signed upload
  target, PUTs bytes directly to storage (bypassing App API request
  bodies), then confirms. App API verifies and flips metadata to READY.
- Storage adapter boundary (`src/storage/`): interface + local-filesystem
  implementation + factory. The interface is GCS-shaped (signed URLs with
  expiry, stat/head, delete); the local adapter proves the semantics with
  HMAC-signed URLs served by App API's own content routes. A real GCS
  adapter is explicitly deferred to the GCP infrastructure gate (no creds
  in this environment, and shipping an unverifiable GCS implementation
  would violate this repo's TDD bar) — same standing as every other GCP
  item in the infrastructure gate.
- Worker read access: `serviceGuard("ai-worker", ["files:read"])` route
  issuing short-lived signed read URLs (the mechanism 0C's OCR activities
  will call; no worker caller exists yet in this phase, but "worker
  access" is literally in this phase's roadmap row, so the 10-line route
  ships now rather than as 0C scope creep).
- Image thumbnails via `sharp` on confirm (300px WebP, alongside the
  original). PDFs store original-only with thumbnail deferred to 0C's
  Python worker (Pillow/pypdfium2 per the old plan; sharp prebuilts don't
  reliably bundle PDF rendering, and proving that out is 0C's job).
- Export-storage *primitive*: adapter supports arbitrary namespaced keys
  and the plan documents the `exports/` key convention. Export *records*
  and generation belong to 0E (roadmap 7A depends on 0J + 0D precisely so
  0D only owes it the storage seam).

Out of scope (explicitly deferred, no caller exists yet):
- Real GCS adapter implementation, bucket provisioning, IAM, lifecycle
  rules — GCP infrastructure gate + Phase 1B territory.
- Malware scanning on uploads — design doc requires it only for email
  intake (0P, section 12.2), not direct uploads. Noted, not built.
- Scheduled expiry sweeper for stale PENDING sessions — expiry is checked
  lazily on confirm/read (mirrors 0K Wave B / 0L "no scheduler yet"
  precedent).
- OCR, receipt extraction, expense auto-creation from files — Phase 0C.
- Frontend upload UI — Phase 0F.

## Tables (migration `009_expense_files.ts`)

- `app.expense_files`: `id`, `tenant_id`, `personal_profile_id` /
  `business_id` (same scope CHECK + composite-FK pattern as
  `app.expenses`), `expense_id` NULLABLE (files may be uploaded before
  their expense exists — Capture PWA offline queue photographs first;
  FK to `app.expenses(id)` with same-scope enforcement in code, since a
  cross-scope composite FK to expenses would need `(id, tenant_id)` plus
  scope matching that composite FKs can't express — domain validates
  expense belongs to the same tenant+scope on bind), `original_filename`,
  `content_type`, `size_bytes` (nullable until confirm), `sha256_hex`
  (nullable until confirm), `storage_key` (unique, tenant-partitioned),
  `thumbnail_storage_key` (nullable), `thumbnail_status`
  (`pending`/`ready`/`skipped`/`failed`), `status`
  (`PENDING`/`READY`/`FAILED`/`DELETED`), `version`, timestamps.
  CHECKs: content_type allowlist (`image/jpeg`, `image/png`,
  `image/webp`, `application/pdf`), filename length, non-negative size.
- `app.upload_sessions`: `id`, `expense_file_id` (FK, one live session
  per file — UNIQUE on `expense_file_id` where status PENDING? Simpler:
  UNIQUE(expense_file_id), since a file needs at most one outstanding
  session; a second create while PENDING conflicts, after confirm the
  file is READY and new sessions are rejected in code), `status`
  (`PENDING`/`CONFIRMED`/`EXPIRED`), `expires_at`, `confirmed_at`
  (nullable), timestamps. Follows the `processing_jobs` +
  `processing_job_dispatch_outbox` precedent (durable row + transactional
  companion row).

Storage key layout (documented convention, enforced in code):
`tenants/{tenantId}/{personal-{profileId}|business-{businessId}}/originals/{fileId}/{sanitizedFilename}`
and `.../thumbnails/{fileId}/thumb.webp`. Exports (0E) will use
`tenants/{tenantId}/exports/{exportId}/...` under the same adapter.

## Storage adapter (`services/app-api/src/storage/`)

```ts
interface StorageAdapter {
  // Returns the absolute URL the client PUTs bytes to (bearer-free,
  // expiring, single-object-scoped) plus any required request headers.
  issueUploadTarget(input: { storageKey, contentType, expiresAt }): Promise<{ url, requiredHeaders }>;
  statObject(storageKey): Promise<{ exists, sizeBytes } | null>;
  readObject(storageKey): Promise<Buffer>; // server-side read (confirm validation, thumbnails)
  issueReadUrl(input: { storageKey, expiresAt }): Promise<{ url }>;
  deleteObject(storageKey): Promise<void>;
}
```

- `LocalStorageAdapter`: root dir from `LOCAL_STORAGE_DIR`; signed URLs
  are App API content-route URLs
  (`PUT/GET /api/v1/file-content/:fileId?expires=&signature=`) with HMAC-
  SHA256 over `method + "\n" + fileId + "\n" + expires`, key from new
  required env `STORAGE_URL_SIGNING_KEY`, constant-time compare,
  expiry-checked. This preserves GCS signed-URL security properties
  (unforgeable, expiring, scoped, bearer-free) with zero GCP dependency.
- `createStorageAdapter(config)` factory: `STORAGE_BACKEND=local` works;
  `"gcs"` throws an explicit "not configured until the GCP
  infrastructure gate" error (honest, not a silent fallback).
- Injectable into the domain via `buildApp` options (same DI convention
  as `database`/`temporalStarter`), so unit tests inject a fake.

## Domain (`src/domain/files.ts`, `FilesDomain`)

- `createUploadSession(...)`: membership check (active tenant +
  profile/business membership, same join pattern as `expenses.ts`),
  optional expense binding validated to same tenant+scope, one
  transaction inserts `expense_files` (PENDING) + `upload_sessions`
  row, returns file + upload target. Wrapped in
  `executeIdempotentMutation` (caller-supplied idempotency key, actorKey
  `user:{actorUserId}`, operationKey `file.upload-session.create`) per
  the tenants/businesses precedent.
- `confirmUploadSession(...)`: lazy expiry check (expired → mark
  EXPIRED + `DomainError.conflict()`... actually expired is a 410-ish;
  this codebase has no GONE code — use conflict, documented),
  `statObject` must exist and match declared content-type family,
  server-computed sha256, image → sharp metadata (validates
  decodability) + 300px WebP thumbnail written via adapter (thumbnail
  failure → thumbnail_status `failed`, file still READY — thumbnails
  are best-effort, originals are the record), PDF → thumbnail
  `skipped`. Flips file READY + session CONFIRMED + audit event, all
  one transaction.
- `getFile`/`listFiles` (scope-bound reads with membership checks),
  `issueFileReadUrl` (tenant bearer, short TTL e.g. 15 min),
  `issueWorkerReadUrl` (ai-worker principal, job-agnostic in 0D — 0C
  binds reads to ProcessingJob scope when it wires OCR),
  `deleteFile` (membership + role check: owner/editor may delete,
  viewer may not — mirrors expense archive authorization; sets DELETED
  + adapter `deleteObject` for original and thumbnail, best-effort
  with logged failure? No — if object delete fails, throw and roll
  back the status flip; storage and metadata must not diverge
  silently).
- Size cap 25MB constant (`MAX_UPLOAD_BYTES`), shared by session-create
  validation and content-route PUT enforcement (413 on overflow —
  Fastify handles via content-length? The content PUT route must enforce
  itself since it's bearer-free; read Content-Length header, reject
  early, plus stream cap).

## Routes (`src/routes/files.ts`)

Tenant (tenantBearer + profile membership enforced in domain):
- `POST /api/v1/tenants/:tenantId/personal-profiles/:profileId/files/upload-sessions`
  and business equivalent (mirrors expenses route prefixes exactly).
- `POST .../upload-sessions/:sessionId/confirm`
- `GET .../files` (list, cursor pagination? Expenses has ledger
  pagination; files list can start simple with limit/offset... to stay
  consistent use the same LedgerQuery cursor pattern? Files don't need
  full ledger semantics — but consistency wins: reuse LedgerQuery. Hmm,
  LedgerQuery is expense-ledger-shaped (filters/sorts). Simpler: plain
  `limit` query with created_at+id cursor? I'll define a minimal
  `FileListQuerySchema` (limit only, newest-first) — documented as
  intentionally smaller than the expense ledger contract.)
- `GET .../files/:fileId`, `DELETE .../files/:fileId`
- `POST .../files/:fileId/read-url` (short-lived download URL for the
  frontend)

Bearer-free signed content (signature is the auth):
- `PUT /api/v1/file-content/:fileId` (query: expires, signature)
- `GET /api/v1/file-content/:fileId` (same query shape)

Internal (service audience):
- `POST /internal/v1/files/:fileId/read-url` —
  `serviceGuard("ai-worker", ["files:read"])`.

## Config

- `STORAGE_BACKEND` (required; only `local` accepted until GCP gate),
  `LOCAL_STORAGE_DIR` (required), `STORAGE_URL_SIGNING_KEY` (required,
  added to `SENSITIVE_FIELD_NAMES` in `app.ts` as `urlSigningKey` —
  check exact field naming when implementing),
  `STORAGE_LOCAL_BASE_URL` (required in compose env; dev default
  `http://127.0.0.1:8100` in `.env.example`).
- Root `.env`/`.env.example` already declare `STORAGE_BACKEND`,
  `LOCAL_STORAGE_DIR` (old prototype names — reuse as-is, no rename
  churn), plus add the two new vars. Compose `app-api` env block gains
  all four (container-network base URL is still `http://127.0.0.1:8100`
  since content URLs are consumed by external clients via the published
  loopback port, NOT container-to-container — document this pointedly,
  it mirrors the `.env`-architecture lesson from 0J1: these URLs leave
  the cluster, so loopback-published address is correct here unlike
  `TEMPORAL_HOST`).

## Testing

1. **Contracts** (`phase-0d-contracts.test.ts`): session/file schemas,
   content-type allowlist, scope-exactly-one on file shape.
2. **Unit** (`services/app-api/test/files.test.ts`): route
   auth/scoping with mocked domain + fake adapter, mirrors
   `jobs.test.ts` fake-verifier convention; signed-URL verify logic
   (valid/expired/forged/tampered) tested directly against the real
   HMAC functions (pure, no I/O).
3. **Postgres + real local-adapter integration**
   (`test/integration/app-domain-0d-files.test.ts`, gated
   `PHASE_0D_INTEGRATION=1`): full create → PUT bytes via real signed
   URL semantics → confirm → READY with real thumbnail bytes on disk
   in a tmpdir adapter; PDF-without-thumbnail path; expiry/confirm-
   twice conflicts; worker read-url issuance; delete removes objects.
   The signed content PUT/GET routes are exercised over a real
   `buildApp().listen()` like the 0L worker-loop tier (they're
   bearer-free, so no auth-verifier fakery needed — the signature IS
   the test subject).
4. **Verify** (`scripts/verify-phase-0d.mjs`): cascades through
   `verify:phase-0l`, adds contracts/app-api tests, the 0D
   integration gate, drift check, app-api Docker build (sharp must
   survive the Alpine build — this is a real risk, verified here not
   assumed).

## Non-goals (revisit only with a real caller)

- GCS adapter, bucket, IAM, lifecycle — GCP gate + 1B.
- Malware scanning on direct uploads — only email intake requires it
  (0P); noted.
- OCR/extraction/expense auto-creation — 0C.
- Export records/generation — 0E (uses the key convention + adapter
  from here).
- Scheduled expiry sweeper — lazy checks, established precedent.
