# Mailbox Broker

Phase 3D-A connected-mailbox feature. Owns Google OAuth, Gmail provider
calls, short-lived credentials, and its own PostgreSQL token-vault
database. App API owns tenant/scope authorization, connection metadata,
OAuth attempt state, and reviewer grants — this service never persists
customer metadata and has no GCP identity.

Deployed as a container in the Expense production VPS Compose, loopback
port `127.0.0.1:8300`, with no public ingress except the two OAuth
browser-facing routes (`GET /oauth/google/begin`, `GET
/oauth/google/callback`) through the existing Cloudflare Tunnel.

## Production wiring is opt-in (Phase 3D-A Task 5)

This broker, its migration job, and the mailbox-only environment
additions to `app-api`/`workflow-worker` live entirely in
`deploy/production/docker-compose.mailbox.yml` — a Compose override, not
the base `docker-compose.yml`. `deploy.sh` includes that override (and
runs `mailbox-broker-migrate` before starting the broker) only when the
validated production env file sets `MAILBOX_FEATURE_ENABLED=true`. An
ordinary dev→main release never requires mailbox secrets, the vault
database, or Clerk mailbox identities — it deploys the base Compose only,
with `MAILBOX_FEATURE_ENABLED=false` passed to `app-api` as a hardcoded
literal.

To enable: an operator sets every mailbox env var, then
`MAILBOX_FEATURE_ENABLED=true`, in the Firestore production profile
(`common/config/family_config.py set expense-tax-management/production
<NAME>`; `deploy.sh` refuses an enabled profile with missing mailbox keys),
and separately runs `deploy/production/bootstrap-mailbox-vault-db.sh`
(operator-only, never part of normal deploy) to create the
`mailbox_vault` database and its two roles before the first enabled
deploy.

## Required environment (when enabled)

| Variable | Purpose |
|---|---|
| `MAILBOX_BROKER_DATABASE_URL` | Runtime (DML-only) token-vault connection |
| `MAILBOX_BROKER_MIGRATION_DATABASE_URL` | Migration (DDL-only) token-vault connection |
| `MAILBOX_SERVICE_TOKEN_ISSUER` / `_AUDIENCE` / `MAILBOX_SERVICE_JWKS_URL` | Inbound M2M verifier config (App API / workflow worker callers) |
| `CLERK_MAILBOX_APP_API_SUBJECT` / `CLERK_MAILBOX_WORKER_SUBJECT` | Expected inbound caller subjects — each is the caller's Clerk machine ID (`mch_...`), not a human-readable name |
| `CLERK_ISSUER_URL` / `CLERK_JWKS_URL` / `CLERK_APP_SERVICE_AUDIENCE` | Outbound call into App API (reused from the base bundle) |
| `CLERK_MAILBOX_BROKER_MACHINE_SECRET_KEY` / `CLERK_MAILBOX_BROKER_SUBJECT` | Outbound M2M credential to App API |
| `MAILBOX_VAULT_KEYS` / `MAILBOX_VAULT_ACTIVE_KEY_ID` | AES-256-GCM token-vault encryption keys |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | Google OAuth client credentials |
| `MAILBOX_ALLOWED_REDIRECT_ORIGINS` | Origin allowlist for the OAuth state/cookie flow |
| `MAILBOX_CALLBACK_HOST` (optional) | Host-header allowlist for the public callback route |

## Workflow worker credentials — two machines, one per audience (fix round 5)

App API's inbound service-token verifier deliberately accepts only a
single audience (`hasExpectedAudience` in
`services/app-api/src/auth/verifier.ts`) — it never relaxes to Clerk's own
multi-audience `aud` semantics, unlike this broker's own verifier. A
worker Clerk machine scoped to both this broker and App API would mint
tokens carrying both audiences, and App API would reject every one. The
ruling is one machine per audience: the real `workflow-worker` Compose
service carries credentials for **two distinct Clerk machines**, added in
Phase 3D-A Task 3/5 and split in fix round 5:

| Variable | Value |
|---|---|
| `CLERK_MAILBOX_SERVICE_AUDIENCE` | shared with `app-api`'s own value |
| `CLERK_MAILBOX_WORKER_MACHINE_SECRET_KEY` | secret for the **broker-scoped** machine (`workflow-worker-mailbox`), audience = this broker |
| `CLERK_MAILBOX_WORKER_SUBJECT` | the Clerk machine ID (`mch_...`) of the broker-scoped machine — **not** a human-readable name. This is the only worker subject this broker's inbound verifier ever authorizes |
| `CLERK_MAILBOX_WORKER_APP_MACHINE_SECRET_KEY` | secret for the **App-API-scoped** machine (`workflow-worker-mailbox-app`), audience = `CLERK_APP_SERVICE_AUDIENCE` |
| `CLERK_MAILBOX_WORKER_APP_SUBJECT` | the Clerk machine ID (`mch_...`) of the App-API-scoped machine — the subject App API's mailbox worker routes authorize. This broker never sees it |

`services/workflow-worker/src/config.ts` treats all six of its mailbox env
vars (the five above plus `MAILBOX_BROKER_BASE_URL`) as optional, required
together or not at all — see Phase 3D-A Task 5's controller ruling: an
ordinary dev→main deploy with no mailbox env at all still starts cleanly.
