# Web Session Wiring Design

**Date:** 2026-10-06
**Status:** Approved by the owner ("build and release it"); implementation pending
**Depends on:** `origin/dev` at `432b59b`

## Problem

A receipt captured on `https://expense-capture.tobytran.dev` never leaves the
browser. Production has no upload sessions, files, or processing jobs, and over
six hours App API received no request from Capture.

| Gap | Evidence |
|---|---|
| No web session is ever created | `capture-web/src/lib/session.ts` `writeSession()` and `office-web/src/lib/session.ts` `writeOfficeSession()` have no callers. `readSession()` always returns null, so `retry()` throws "Capture session unavailable". |
| The API cannot tell a user their scopes | `GET /api/v1/tenants` lists tenants and `GET /api/v1/tenants/{tenantId}/businesses` lists businesses. No endpoint returns the caller's personal profile. |
| Capture never uploads on its own | `capture/page.tsx` only calls `enqueue()`. `uploadQueuedReceipt` runs only from the Queue page's Retry button. |
| Browsers cannot call App API cross-origin | App API has no CORS handling. The web apps call `https://expense-api.tobytran.dev` from other origins with `Authorization` and JSON content, so the browser sends a preflight. |
| Signed file URLs are unreachable | Local storage signs `${STORAGE_LOCAL_BASE_URL}/api/v1/file-content/{fileId}?expires&signature` (`services/app-api/src/storage/local.ts`). Production has `STORAGE_LOCAL_BASE_URL=http://127.0.0.1:8100`. Browsers cannot PUT there, and the worker cannot GET there. |

## Goals

1. After sign-in, Capture and Office create their session automatically:
   - load the user's tenants;
   - choose the only tenant, or the remembered one;
   - load the caller's scopes and default to the personal profile.

   Settings shows a scope picker.
2. Capture uploads each item right after capture when online. When the app
   loads online with a session, it also uploads any items already in the queue,
   including receipts queued before this release. Retry stays for failed items.
3. The browser can create upload sessions, PUT the file, confirm it, and start
   OCR against production App API. The TypeScript worker can download the file
   and complete the job.
4. `https://expense-capture.tobytran.dev/privacy` serves a public, static privacy
   page, so the Google sign-in app can be published.

## Non-Goals

- The GCS storage backend.
- Foundry web.
- The transitional `frontend/web` and `expense-service`.
- Mailbox (3D) activation.
- Multi-tenant pickers beyond the minimum: production has one tenant.
- Redesigning pages. UI additions use the existing classes and patterns.

## Design

### App API

1. **`GET /api/v1/tenants/{tenantId}/scopes`** (tenant bearer, like the other tenant routes).
   - Returns `{ personalProfiles: PersonalProfile[], businesses: Business[] }`.
     Reuse the existing `PersonalProfileSchema` and the business schema that
     `GET /api/v1/tenants/{tenantId}/businesses` uses.
   - Authorization follows the repository rule that a tenant role alone never
     grants profile access:
     - personal profiles appear only where the caller has a personal membership;
     - businesses appear only where the caller has a business membership.
   - A caller with no tenant membership gets the same denial as
     `GET /api/v1/tenants/{tenantId}`.
   - Foundry and service tokens are rejected by the existing tenant
     authentication.
   - Add the contract schema `TenantScopesSchema` to
     `packages/contracts/src/tenants.ts`. Regenerate generated artifacts only
     with `pnpm contracts:generate`; never hand-edit them.
2. **CORS allowlist.**
   - New optional env `APP_CORS_ALLOWED_ORIGINS`: a comma-separated list of exact
     origins.
   - For a request whose `Origin` is in the list, App API sets
     `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`.
   - `OPTIONS` preflight to any App API path from an allowed origin returns 204
     with these headers:
     - `Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS`;
     - `Access-Control-Allow-Headers: authorization, content-type, idempotency-key, if-match`
       (plus any other request header the web clients send today);
     - `Access-Control-Max-Age: 600`.
   - Origins not in the list get no CORS headers. An empty or unset list
     disables CORS, which is today's behavior.
   - No new dependency for a few lines of hook code. The hook must work with
     `registerGatewayHardening`: preflights must not be rate-limited into
     failure or rejected.
3. **Storage URL reachability.**
   - Browsers use `STORAGE_LOCAL_BASE_URL` as today. Production sets it to the
     public API origin, `https://expense-api.tobytran.dev`.
   - The worker must download files from inside the Docker network. The App API
     read URL it requests through `/internal/v1/files/{id}/read-url` must point
     at an origin the worker accepts and can reach. Preferred: a new optional App
     API env `STORAGE_INTERNAL_BASE_URL`. When set, internal read URLs use it
     (production: `http://app-api:8100`), while browser-facing upload and read
     URLs keep `STORAGE_LOCAL_BASE_URL`. The worker already accepts its App API
     origin (`APP_API_BASE_URL=http://app-api:8100`).
   - If the code shows a simpler correct path, use it and document it.

### Web apps

1. **API base URL:** `NEXT_PUBLIC_APP_API_URL`, inlined at build time.
   - The `capture-web` and `office-web` Dockerfiles take
     `ARG NEXT_PUBLIC_APP_API_URL=https://expense-api.tobytran.dev`, so no
     GitHub variable is needed.
   - Local runs get it from the Firestore local profile through `pnpm with-env`.
   - Read the Next.js docs in `node_modules/next/dist/docs/` first: this Next.js
     version differs from older ones.
2. **Session bootstrap**, one small module per app, unit-tested as pure logic:
   - Inputs: the Clerk `getToken`, the organization ID, and the API base URL.
   - Steps:
     1. `GET /api/v1/tenants`.
     2. Pick a tenant: the remembered one if still listed, else the only one.
        With none, show a clear message.
     3. `GET /api/v1/tenants/{tenantId}/scopes`.
     4. Choose the remembered scope if still listed, else the personal profile,
        else the first business.
     5. `writeSession(...)` / `writeOfficeSession(...)`.
   - Run it from the signed-in shell when no valid session exists.
   - The existing auth-gated layout and component are `capture-auth-gate.tsx`
     and `capture-shell.tsx` for Capture, and the matching office shell.
3. **Scope picker in Settings** for both apps. It lists the personal profile and
   the businesses, and writes the session on change.
4. **Capture auto-upload.**
   - After `enqueue()`, and when the Queue page loads or the browser comes back
     online, process every `queued` item with the existing
     `uploadQueuedReceipt`, sequentially.
   - On error the item becomes `failed` with its message, exactly like
     `retry()`. Move the shared logic out of `retry()` instead of duplicating it.
5. **Privacy page:** `capture-web/src/app/privacy/page.tsx`. It is static and
   public, outside the `(capture)` auth gate. Text:
   - private family app;
   - receipts and expense data are stored on the family VPS and used only to run
     the app;
   - sign-in through Clerk and Google;
   - nothing is sold or shared;
   - contact `thangtran3112@gmail.com`.

### Configuration and deploy

- New production env keys: `APP_CORS_ALLOWED_ORIGINS`, plus
  `STORAGE_INTERNAL_BASE_URL` if used. Wire them in all of these:
  - `deploy/production/docker-compose.yml` (app-api environment);
  - `deploy/production/deploy.sh` `KNOWN_ENV_KEYS`;
  - the App API config parser;
  - the boundary tests that pin env key sets.
- Local compose may set the same keys with local values.
- The operator, not the code change, sets the production values in Firestore
  `expense-tax-management/production`:
  - `APP_CORS_ALLOWED_ORIGINS=https://expense-capture.tobytran.dev,https://expense-office.tobytran.dev,https://expense.tobytran.dev`;
  - `STORAGE_LOCAL_BASE_URL=https://expense-api.tobytran.dev`;
  - `STORAGE_INTERNAL_BASE_URL=http://app-api:8100`.

### Rule

`expense-tax-management/AGENTS.md` gains one line: production is the only
environment until commercialization (no dev or staging). Local runs and the VPS
are production. The only exception is that local frontends keep Clerk
development keys, because Clerk rejects production keys on `localhost`.

## Testing

- **App API scopes route:**
  - a member sees their own personal profile and only member businesses;
  - a tenant member without a personal membership gets no personal profile;
  - a non-member is denied;
  - a Foundry token is rejected.
- **App API CORS:**
  - an allowed origin gets headers on GET and a 204 preflight;
  - a disallowed origin gets no headers;
  - an unset list means no headers.
- **Storage:** internal read URLs use `STORAGE_INTERNAL_BASE_URL` when set;
  browser URLs use `STORAGE_LOCAL_BASE_URL`.
- **Web:** session bootstrap selection logic, queue auto-processing (sequential,
  failure marks the item failed), and the privacy page renders without auth.
- **Existing suites stay green:** `pnpm ci:lint`, `pnpm ci:typecheck`,
  `pnpm ci:test`, `pnpm exec vitest run test/integration` (static), and
  `pnpm contracts:check`.

## Rollout

1. One PR to `dev`, then an expense-only release to `main` that excludes
   ai-trading, like #26.
2. Before the release deploy, set the production Firestore values above.
3. After the deploy:
   - open Capture; the queued receipt auto-uploads;
   - confirm an OCR job ran on the TypeScript worker (namespace `expense-tax`);
   - publish the Google sign-in app with home page
     `https://expense-capture.tobytran.dev` and privacy URL
     `https://expense-capture.tobytran.dev/privacy`.
