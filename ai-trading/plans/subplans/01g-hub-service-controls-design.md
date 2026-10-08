# Phase 1B Design: Trading Hub Service Controls

Status: User requested this phase on 2026-10-05, after approving the release-1 hub designs. Written spec awaiting review. Build after the four-upstream MVP and before release 2's Family Desk. The frontend remains a static export in GCS; every control action runs on the VPS.

## Purpose

Either authorized family user can open `/settings` in the Trading Hub and switch an upstream backend **on or off** to release VPS memory when the family isn't using it. The setting is shared across both users and reflects actual container state. Toggling one app never restarts or stops another.

| UI label | Allowed Compose service | When stopped |
|---|---|---|
| TradingAgents | `ta-terminal` | CLI and its tmux sessions stop; reports/checkpoints in the named volume remain |
| AI Hedge Fund | `ahf-terminal` | TUI and any active backtest stop; paper-fund files in the named volume remain |
| Vibe-Trading | `vibe-trading` | Its upstream UI and API stop together; sessions/uploads in named volumes remain |
| MiroFish | `mirofish` | Flask simulation processes stop; the original Vue UI remains in GCS but API actions report "Stopped"; uploads and SQLite state in its named volume remain |

The static hub, its Clerk gateway, the Cloudflare tunnel/Worker, Firestore config reader, and (later) Family Desk's core API/scheduler are **not** switchable. MiroFish cannot be started before its Zep and OpenAI keys and auth gate are configured.

## User experience

- `/settings` lists four rows/cards with the app name, a status label (`Running`, `Starting`, `Stopping`, `Stopped`, `Needs setup`, `Unhealthy`, or `Error`), and an accessible on/off switch. Each control is keyboard-operable, at least 44 px tall, and labeled by app name and intended action. Status uses text and icon, never color alone. Include a plain note: "These switches affect both family members. Static hub stays online."
- On switch-off, explain that active analyses/simulations for **both** people end; require confirmation only when the app is actually running. Named volumes are not deleted. On switch-on, show `Starting` until its health check passes or a bounded timeout reports an error. A failed start leaves the app `Off` or `Error` with an actionable retry.
- When a backend is off, its hub card and route show `Stopped` plus a link to settings. The VPS gateway checks desired/actual state before forwarding **every** terminal/API request and returns an authenticated 503 with a clear message for a stopped backend, not an unexplained tunnel 502. For MiroFish, the Vue app remains static but API calls return the same 503.
- Poll current state when the settings page opens and after a change; refresh periodically so a spouse's changes appear in the other browser. The page also offers a normal manual Refresh button. No WebSocket or Next.js server is needed.

## VPS control plane

- Add an authenticated gateway endpoint `GET /__control/apps` returning each allowlisted app's desired state, actual Docker health/status, and latest change time. `PUT /__control/apps/{id}` takes `enabled: boolean` plus an expected revision; repeat requests for the same desired state are idempotent. A stale revision returns 409 with the current state. Start/stop requests return 202 while the operation is running; clients poll GET to completion.
- Every GET/PUT goes through the Clerk verifier and family allowlist from [the static hub design](01e-static-hub-gcs-design.md). The PUT also checks `Origin` and prevents cross-site request forgery. The edge Worker forwards only `/__control/*` to the VPS tunnel origin. It never has a Docker credential.
- A **small root-owned VPS helper** receives requests from the unprivileged gateway on a Unix socket. It checks the connecting process's Unix peer credentials (`SO_PEERCRED`) against the dedicated gateway user/group; it does not trust arbitrary local callers. After this check, it accepts only four fixed service IDs, a boolean desired state, and the Clerk-verified actor ID from that gateway. It maps each ID to a hard-coded Compose service name and uses fixed paths to the deployed Compose file and project. No caller-supplied shell command, image name, container ID, file path, or Docker API operation is accepted. Do **not** mount `/var/run/docker.sock` in the public gateway or frontend container.
- Start with `docker compose --project-name ai-trading ... up -d --wait --wait-timeout 300 <service>`; stop with `docker compose --project-name ai-trading ... stop --timeout 60 <service>`. MiroFish's Compose service/profile is a **prerequisite** from [its earlier release-1 integration](01d-mirofish-hub-design.md); Phase 1B is not built against the current three-app Compose file. Explicitly select its service and verify this starts it without turning on unrelated profiles. The helper and `deploy.sh` both hold `flock /var/lib/family-app/ai-trading/.control.lock` while reconciling service state, so a user toggle cannot race a deployment. The helper records actor/outcome/timestamp in a local audit log and reports actual state rather than assuming the command succeeded.
- Store desired booleans and a revision in a root-owned file under `/var/lib/family-app/ai-trading/`, written atomically. This is **operational state**, not an API key or environment configuration; Firestore remains the source for app config/secrets. Document copying this file during VPS migration. Defaults on first activation: the three already-working upstream apps retain their current running state, while MiroFish stays off until setup succeeds.
- Rework `deploy.sh` **and `health-check.sh`** to honor this desired-state file: start and require healthy only enabled upstream services, and leave disabled services stopped. A blanket `docker compose up -d` would otherwise restart a manually stopped backend; a deploy must not undo a user's choice. Shared hub/auth/tunnel services always start. The deployment may still pull disabled apps' images so a later user-initiated start needs no persistent GHCR login; this costs disk/bandwidth but saves RAM, which is the requested resource. On a failed deployment, restore the prior desired state and previous image tag as one rollback. On host reboot, reconcile to the desired file after Docker starts. `restart: unless-stopped` alone is not the complete persistence mechanism.

## Verification

1. Unit checks: only four IDs accepted; unknown/path-like IDs and malformed booleans rejected; the same desired state is a no-op; concurrent/stale revisions fail rather than overwrite; unauthorized Clerk sessions, wrong Origins, and forged identity headers cannot change state.
2. Integration with a fake Compose executable: enabling calls only the mapped service; disabling calls `stop` without deleting volumes; a failed/slow start reports an error; the `flock` lock serializes toggles against both the helper and deploy; `health-check.sh` omits intentionally stopped services; an initially disabled backend stays off through deploy/rollback and reboot reconciliation. A non-gateway Unix peer cannot invoke the helper.
3. Browser checks: both family logins see the same state; a switch persists after reload; stopped cards and API paths show a useful message; starting one app never toggles another. Measure memory with `docker stats --no-stream` before/after stopping one app on the VPS. No stop/start test runs against production without a separate operator approval.

## Non-goals

No arbitrary container console, no shell command textbox, no Docker-socket exposure to the browser, no automatic scheduling of on/off times, no deletion of app volumes, and no switch for the shared infrastructure or the future Family Desk's core services.
