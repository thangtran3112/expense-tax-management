# Family Desk Phase 0: Verification Spike Results

Status: In progress, started 2026-10-10.
- The desk-side checks and the documentation research are done.
- The IBKR checks wait on the owner's account setup ([phase-0-spike.md](02c-desk-v1-tasks/phase-0-spike.md) Task 0.4).

Related:
- [02a §12](02a-desk-v1-strategies-design.md): the checks and their decided fallbacks
- [02c](02c-desk-v1-implementation-plan.md): the plan
- [ai-trading/tools/ibkr-probe](../../tools/ibkr-probe/README.md): the probe tools
- Raw research notes (local, gitignored): `ai-trading/temp/research/ibkr-spike-docs.md`, `market-data-vendors-2026-10.md`, `broker-data-apis-2026-10.md`, `upstream-tool-inventory.md`, `upstream-strategy-models.md`

## Results

### 1. Data username's paper login: shared live data, and 2FA

**Status:** pending the probe.

**From the docs:**
- An individual account holder can add a second username (Settings → Users & Access Rights).
- Live-to-paper data sharing exists: one paper account per live user, switched on in Settings → Paper Trading Account.
- IBKR policy applies two-factor login to paper as well. Daily auto-restarts avoid it, but a weekly re-login is still needed.
- **Unverified:** whether the second username gets its own paper account.

**Decision:**
- If the data username has its own paper account, use one gateway (02a §6).
- Otherwise, use two gateways:
  - the data username's live login, with Read-Only API on, for data;
  - an existing paper login for orders only. Paper fills do not need our market-data subscriptions.
- Either way, budget one phone approval per week. That is the Sunday 18:00 ET reminder in 02a §5.

### 2. $10 bundle waiver for a second username

**Status:** answered by the docs; confirm on the first bill.
- Subscriptions are billed per username.
- The waiver counts real commissions, so a username that only paper-trades will likely never earn it.

**Decision:**
- Budget about **$16/month**: $10 Snapshot and Futures Value Bundle, $4.50 Equity and Options Add-On Streaming Bundle (not waivable, and required to stream stocks over the API), and $1.50 OPRA Top of Book.
- That is under the $30 cap.
- Correct 02b's "$4.50–$14.50" after the first bill.

### 3. Option-chain speed under the 100-line cap

**Status:** pending the probe (`option_batch`).

**From the docs:**
- `reqSecDefOptParams` is not throttled.
- Model greeks arrive on tick 13.
- Short streaming subscriptions that are opened, read once, and cancelled avoid regulatory snapshots, which cost $0.01 each.

**Decision:** scans use batches of at most 30 lines (02a §7 leaves 30 for this). If `option_batch.seconds` is above 15, spread the 15:30 ET scan over about 5 minutes.

### 4. IV history for IV rank

**Status:** pending the probe (`iv_history`).

**From the docs:**
- `OPTION_IMPLIED_VOLATILITY` daily bars for one year come in one request.
- Pacing is 60 historical requests per 10 minutes, so an initial backfill of about 70 symbols takes about 12 minutes.

**Decision:** IV rank uses IBKR history. If the probe returns under 252 bars, the 02a §12 fallback applies.

### 5. Vibe-Trading's IBKR connector host and port

**Status: PASS.**
- `packages/vibe-trading/agent/src/trading/connectors/ibkr/local.py` reads `~/.vibe-trading/ibkr-local.json`, with `host`, `port`, `client_id`, `profile` (`paper` or `live-readonly`), and `readonly` (default true).
- There is no loopback-only restriction.

**Decision (after v1):**
- A wrapper-mounted JSON file can point Vibe at the Desk gateway with its own client ID, without upstream edits.
- Vibe's connector has no order methods. But a gateway with orders enabled accepts orders from any connected client, and Vibe's agent runs model-written code.
- So before attaching Vibe, either:
  - the Desk broker's reconciliation flags any order without a Desk `orderRef`; or
  - Vibe gets the read-only data gateway from the two-gateway layout.

### 6. VPS headroom

**Status: PASS, with limits** (read-only SSH check, 2026-10-10).
- 6 vCPU and 11.4 GiB RAM: 2.3 GiB used, 9.4 GiB available.
- No swap.
- 96 GB disk, 35 GB free.
- All current containers together use about 1.3 GiB.

**Decision:**
- Phase 3 sets these limits:
  - `ib-gateway`: 1.5 GiB, with a Java heap of 768 MiB
  - `desk-postgres`: 1 GiB
  - `api`: 768 MiB
  - `scheduler`: 512 MiB
- The main out-of-memory risk is MiroFish's 4 GiB limit with no swap, so MiroFish stays opt-in.
- **Disk is the tighter limit.** `deploy.sh` refuses to deploy below 30 GiB free (added after the 2026-10-10 disk incident), and 35 GB was free at this check.
  - Phase 3 must size the backend image and Desk Postgres to that margin.
  - The 1-minute bar archive is capped at 90 days (02b §5).
  - Database backups go to GCS, not the VPS disk.

### 7. Flex token for read-only holdings

**Status:** pending the owner's token.

**From the docs:**
- Flex v3 `SendRequest` and `GetStatement` on `ndcdyn.interactivebrokers.com`.
- An Activity Flex query can include Open Positions and Open Lots (tax lots, including options).
- Tokens last 6 hours to 1 year, with optional IP restriction.
- Limits: 1 request per second and 10 per minute.

**Decision:** Phase 5 imports nightly. CSV upload is the fallback.

### 8. `trading-hub` hostname move

**Status:** desk-side PASS.
- The session cookie is set with `Domain=tobytran.dev` (`ai-trading/auth/src/server.js`), so `trading-hub` and `trading` share sessions.
- `ALLOWED_ORIGINS` (a comma-separated list in `ai-trading/gateway`) must add `https://trading-hub.tobytran.dev` and keep `https://trading.tobytran.dev`.

**Decision:** Clerk and ttyd origin checks are verified on staging in Phase 4, before the cutover.

### 9. Paper account ID prefix

**Status:** pending the probe (`paper`, `accounts`). The docs say paper accounts start with `DU`.

**Decision:** the guard value stays `DU` unless the probe shows otherwise.

## Notes for Phase 3 (from the documentation research)

- **Gateway image:** `ghcr.io/gnzsnz/ib-gateway`. The stable tag is IB Gateway 10.50.1f with IBC 3.24.2. Pin the image by digest.
  - Supports arm64.
  - Paper API on 4004 and live on 4003, through socat.
  - Secrets through `*_FILE` variables.
- **IBC settings for unattended daily restarts:** `TRADING_MODE=paper`, `READ_ONLY_API`, `AUTO_RESTART_TIME`, `TWOFA_TIMEOUT_ACTION=restart`, `RELOGIN_AFTER_TWOFA_TIMEOUT=yes`.
- **Connections:** IB Gateway accepts up to 32 API client connections at once.
