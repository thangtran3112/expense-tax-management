# Phase 1C Gateway Hardening Design

**Date:** 2026-09-11  
**Status:** Complete; retained as executable input for `check-phase-1c-gateway.mjs`
**Depends on:** Production auth release `34125c6` and live gate evidence

## Cost Boundary

Cloudflare usage is restricted to the free tier plus domain registration. This
phase must not activate or depend on paid Cloudflare products:

- No Cloudflare Pro/Business/Enterprise upgrade.
- No paid Cloudflare Rate Limiting product.
- No managed WAF subscription or paid bot product.
- No Workers/edge functions for request processing.
- No paid Cloudflare Access/Zero Trust seats.

Free Cloudflare DNS, proxy/CDN, TLS, baseline DDoS protection, and the existing
Tunnel remain allowed. Any future paid control must be a separately approved
cost decision. The implementation must not silently create billable resources.

## Scope

Phase 1C adds defense-in-depth perimeter controls without replacing service
authorization. Cloudflare remains the first public edge. Current VPS origins
remain loopback-only behind Cloudflare Tunnel. Future GCP deployments preserve
the same policy model through an external HTTPS Load Balancer and Cloud Armor.

The design must work when services run as:

- Current VPS containers behind `cloudflared`.
- Cloud Run services behind an external HTTPS Load Balancer.
- Cloud Functions Gen 2 services behind the same load-balancer pattern.
- GKE workloads behind Gateway API or an external HTTPS Load Balancer.

## Non-Goals

- No Traefik ForwardAuth deployment.
- No edge conversion of Clerk user tokens into Google IAM identity.
- No trusted plain `X-User-*` or `X-Tenant-*` headers from browsers.
- No removal or weakening of App API tenant/resource authorization.
- No removal or weakening of Foundry platform/service authorization.
- No database migration in this phase.
- No public exposure of VPS application ports.

## Trust Boundaries

### Browser to public edge

Cloudflare may enforce free-tier host/path routing and baseline transport policy.
Cloudflare does not become source of application identity. Browser requests retain
Clerk bearer tokens for App API and Foundry to validate.

### Edge to origin

Current path: Cloudflare Tunnel -> loopback VPS origin.  
Future path: Cloudflare -> GCP external HTTPS Load Balancer/Cloud Armor ->
private Cloud Run, Functions Gen 2, or GKE origin.

Origin policy must prevent direct bypass:

- VPS: application ports stay bound to `127.0.0.1`.
- Cloud Run/Functions: use `internal-and-cloud-load-balancing` ingress where
  Cloud Armor protection is required; do not leave a bypassable default URL.
- GKE: use private backends and load-balancer/Gateway policy; do not publish pod
  or node application ports.

### Service authorization

App API and Foundry remain authoritative:

- Clerk tenant tokens: issuer, audience, organization, identity mapping,
  membership, and resource/profile scope.
- Clerk platform tokens: separate platform audience and exact operator role.
- M2M tokens: exact target audience, source subject, and operation scope.
- Gateway identity headers, if ever introduced, require a signed gateway
  assertion verified by downstream services. Plain forwarded identity headers
  are never trusted.

Google IAM is reserved for infrastructure/service identity:

- Load balancer to private serverless origin access.
- Cloud Run/Functions service invoker policy.
- GKE Workload Identity and service-to-service calls.
- Database and secret access through workload identities.

Google IAM does not replace Clerk customer identity or application membership.

## Public and Protected Route Matrix

### Host policy

| Host | Public paths | Protected paths | Default |
|---|---|---|---|
| `expense.tobytran.dev` | frontend document/static assets | browser API calls from Capture | Serve Capture Web; no API origin routing |
| `expense-capture.tobytran.dev` | frontend document/static assets | browser API calls from Capture | Serve Capture Web |
| `expense-office.tobytran.dev` | frontend document/static assets | browser API calls from Office | Serve Office Web |
| `expense-foundry.tobytran.dev` | frontend document/static assets | `/internal/v1/*` platform/service API | `/internal/v1/*` to Foundry Service; all other paths to Foundry Web |
| `expense-api.tobytran.dev` | `/health/live`, `/health/ready` | `/api/v1/*`, `/internal/v1/*` | App API origin |

Cloudflare edge must reject unknown hostnames and unsupported methods rather than
falling through to an origin. The final Tunnel catch-all remains `404`.

### Authentication matrix

| Route class | Edge action | Origin action |
|---|---|---|
| Frontend documents/assets | Allow GET/HEAD; cache only immutable assets | Frontend serves page/assets; Clerk gates browser UI |
| Health endpoints | Allow GET/HEAD with tight rate limit | Readiness/live checks only; no customer data |
| Clerk webhook | Allow POST only; no browser CORS; body cap | Verify Svix signature, idempotency, event schema |
| Tenant API | Allow normal API methods; standard rate limit | Verify Clerk tenant token and membership/resource scope |
| App worker API | No public browser route | Verify M2M source/audience/scope |
| Foundry platform API | Allow only required HTTPS paths | Verify platform audience and exact operator role |
| Foundry service API | No browser authorization shortcut | Verify M2M source/audience/scope |
| Unknown/internal path | Reject at edge/origin | No handler execution |

## Free Cloudflare Controls

Terraform owns only free-tier controls that are stable across origin platforms:

1. Existing Tunnel ingress and explicit final `http_status:404`.
2. Host/path route allowlist, with Foundry service path before generic Web path.
3. HTTPS-only behavior through existing DNS/proxy/Tunnel behavior.

Paid WAF, paid rate limiting, edge header transforms, and Workers are explicitly
out of scope. Security headers, method restrictions, route limits, and rate
limits are origin/application responsibilities in this phase.

## Origin Controls

App API, Foundry, and the three frontends own controls that remain useful after
GCP migration:

- Explicit body limits per route class, including webhook and upload paths.
- In-process rate limits with bounded memory and fail-closed route classes. Do not
  pretend these are globally distributed; future GCP deployment may replace them
  with a GCP-native paid control or shared store after a cost decision.
- Explicit method/path rejection in application route registration.
- Request and downstream-operation timeouts.
- Safe request ID propagation; client request IDs are validated and bounded.
- Correct proxy trust configuration; never derive authorization from forwarded
  identity headers.
- Security response headers for direct/internal test clients where applicable.
- Structured rejection metrics without token, cookie, body, or secret logging.
- Tests for method rejection, oversized bodies, timeout behavior, malformed
  forwarding headers, and direct-origin bypass assumptions.

Origin controls cannot assume VPS, Docker, Cloud Run, or GKE. They operate at
HTTP/service boundaries and use deployment-specific environment configuration
only for limits and trusted proxy/network settings.

## Future GCP Mapping

### Cloud Run and Functions Gen 2

Use an external HTTPS Load Balancer with private serverless ingress when needed.
Cloud Armor is optional and requires a separate cost approval. Without Cloud
Armor, retain origin/application limits and accept that edge WAF/rate protection
is not present. Cloud Run IAM controls which Google principals may invoke private
services; it does not validate Clerk customer tokens.

### GKE

Use Gateway API or an external HTTPS Load Balancer. Cloud Armor is optional and
requires a separate cost approval. Use Workload Identity for pod-to-GCP services
and Google IAM for internal service calls. Keep application-level Clerk and M2M
verification in App API/Foundry.

### Cloudflare relationship

Cloudflare remains the free DNS/TLS/proxy/Tunnel layer. GCP LB is the future
origin perimeter; Cloud Armor is an optional paid upgrade. Origin/application
controls remain the portable baseline.

An edge function is unnecessary unless later requirements need custom token
exchange, tenant-aware routing, or response transformation. Such a function
would create a new identity trust boundary and requires a separate design.

## Rollout

1. Add static route matrix and origin-control tests before changing production.
2. Apply only free-tier Tunnel/DNS changes through reviewed Terraform artifact.
3. Verify public pages, health, webhook `202`/replay, expected `401`/`403`, rate
   responses, and security headers from each hostname.
4. Verify direct VPS ports remain unreachable externally.
5. Add a future-GCP contract test proving direct Cloud Run default URL bypass is
   unavailable when private ingress/LB is active.
6. Record any proposed paid Cloudflare/GCP control as a separate decision with
   monthly and usage-based cost before implementation.

## Acceptance Criteria

- Route matrix is executable as static tests and matches Terraform ingress.
- Unknown hosts/paths/methods fail closed.
- Required public frontend and health paths remain reachable.
- Webhook, tenant, platform, and M2M boundaries retain current behavior.
- Security headers are present without breaking Clerk or frontend assets.
- Origin rate limits are scoped by route class and tested without relying on paid
  edge services or production mutation.
- No client-supplied identity header grants access.
- Future Cloud Run, Functions Gen 2, GKE, and container origins can use the same
  edge policy without converting Clerk identity to Google IAM.
