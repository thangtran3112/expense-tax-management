# Phase 0: Verification Spike

Part of [02c-desk-v1-implementation-plan.md](../02c-desk-v1-implementation-plan.md). Read its Global Constraints and Shared Interfaces first. Results go in [02d-desk-spike-results.md](../02d-desk-spike-results.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Tasks 0.1–0.3 are done (checked). Task 0.4 is the owner's. The main session runs Tasks 0.5 and 0.6 after Task 0.4.

**Goal:** Answer every 02a §12 check with evidence, and apply each check's decided fallback where it fails, before Phases 2, 3, and 6 commit to a gateway layout.

**Architecture:**
- Desk-side checks are code reading, docs research, and a read-only VPS look.
- IBKR checks run two read-only probes against the owner's IB Gateway session and Flex query.
- No Desk code depends on the results until Phase 2.

**Tech Stack:** Python 3.12 single-file uv scripts (PEP 723), `ib_async` 2.1.0, pytest, ruff.

---

### Task 0.1: Desk-side checks (main session) — done

**Files:**
- Modify: [02d-desk-spike-results.md](../02d-desk-spike-results.md) (checks 2, 5, 6, 8; docs findings for 1, 3, 4, 7, 9)

**Interfaces:**
- Consumes: nothing.
- Produces: the 02d decisions that Phases 2, 3, 4, and 6 read.

- [x] **Step 1: Vibe-Trading connector.**
  - Run: `grep -n -E 'CONFIG_FILENAME|def load_config|host=|port=|client_id' ai-trading/packages/vibe-trading/agent/src/trading/connectors/ibkr/local.py`
  - Expected: `ibkr-local.json` config with `host`, `port`, `client_id`, and `readonly`; no loopback restriction.
- [x] **Step 2: VPS headroom.**
  - Run a read-only SSH check (`nproc`, `free -m`, `df -h /`, `docker stats --no-stream`). Use the pattern in `infrastructure/gcp/family-config/install-reader-key.sh`: `with-file shared/vps VPS_OPERATOR_SSH_PRIVATE_KEY`, plus known hosts from `shared/vps`.
  - Expected: the numbers recorded in 02d check 6. No IP addresses are recorded.
- [x] **Step 3: Hostname move.**
  - Run: `grep -n 'Domain=' ai-trading/auth/src/server.js`
  - Expected: `Domain=tobytran.dev`, so the session cookie is shared across subdomains.
- [x] **Step 4: Documentation research** (IBKR pricing, paper sharing, 2FA, IV history, option greeks, Flex, the gnzsnz image).
  - Expected: notes in `ai-trading/temp/research/ibkr-spike-docs.md`, summarized in 02d.

### Task 0.2: IBKR gateway probe — done

**Files:**
- Create: `ai-trading/tools/ibkr-probe/probe.py`, `ai-trading/tools/ibkr-probe/test_probe.py`, `ai-trading/tools/ibkr-probe/README.md`

**Interfaces:**
- Consumes: a running IB Gateway or TWS on `--host`/`--port`.
- Produces: one JSON report with these keys:
  - `probed_at_utc`, `server_version`, `accounts` (masked), `paper`, `clock_skew_s`
  - `streams[]` (`symbol`, `sec_type`, `data_type`, `has_bid_ask`, `updates`, `median_ms`, `p90_ms`)
  - `iv_history`, `minute_history[]`, `option_batch`, `news_providers`, `errors[]`

  Pure helpers, for reuse by Phase 2: `mask_account`, `redact`, `market_data_type_label`, `summarize_intervals`, `pick_expirations`, `pick_call_strikes`.

- [x] **Step 1: Write the failing tests** (`test_probe.py`). They cover:
  - account masking keeps only the letter prefix;
  - account IDs are redacted inside messages;
  - market-data type labels;
  - update-gap statistics;
  - expiry selection in 21–45 days;
  - out-of-the-money call strikes within 10%.
- [x] **Step 2: Run the tests.**
  - Run: `uv run --no-project --with pytest pytest -q ai-trading/tools/ibkr-probe`
  - Expected: collection error, because `probe` does not exist yet.
- [x] **Step 3: Implement `probe.py`.**
  - `ib_async` is imported only inside the probe functions, so the pure helpers test without it.
  - It connects with `readonly=True` and `fetchFields=StartupFetchNONE`, so no positions or account values are fetched.
  - Each report section is isolated, so one failure does not lose the others.
- [x] **Step 4: Run the tests and lint.**
  - Run: `uv run --no-project --with pytest pytest -q ai-trading/tools/ibkr-probe && uvx ruff check ai-trading/tools/ibkr-probe`
  - Expected: `9 passed` (with Task 0.3) and `All checks passed!`

### Task 0.3: Flex Web Service probe — done

**Files:**
- Create: `ai-trading/tools/ibkr-probe/flex_probe.py`, `ai-trading/tools/ibkr-probe/test_flex_probe.py`

**Interfaces:**
- Consumes: env `IBKR_FLEX_TOKEN` and `IBKR_FLEX_QUERY_ID`, from `family_config.py run ai-trading/desk`.
- Produces: JSON `{statements, detail[{account (masked), sections{<Section>: {records, fields, level_of_detail?, asset_category?}}}]}`, with no values. Phase 5 reuses `parse_response` and `summarize_statements`.

- [x] **Step 1: Write the failing tests** (`test_flex_probe.py`). They cover:
  - reading the `SendRequest` reference and URL;
  - the in-progress code `1019`;
  - the summary reports counts and field names, and no account digits, prices, symbols, or dates.
- [x] **Step 2: Implement `flex_probe.py`.**
  - `SendRequest`, then `GetStatement` with backoff while the code is `1019`.
  - A User-Agent header is set.
  - The token is masked in any printed error.
- [x] **Step 3: Run the tests and lint** (the Task 0.2 Step 4 command). Expected: pass.

### Task 0.4: Owner IBKR setup (owner)

**Files:**
- Modify: Firestore profile `ai-trading/desk` (through `family_config.py` only)

**Interfaces:**
- Consumes: nothing.
- Produces: a data username with live subscriptions and its paper login (or the two-gateway fallback); a Flex query ID and token stored in Firestore.

The owner follows the step-by-step guide [02e-ibkr-data-user-setup.md](../02e-ibkr-data-user-setup.md), which also explains why the Desk needs its own username.

- [ ] **Step 1: Create the data username** (02e Step 1).
- [ ] **Step 2: Subscribe the data username** (02e Step 2): the USD 10 bundle and the USD 4.50 streaming add-on; OPRA only if Task 0.5 shows it is needed.
- [ ] **Step 3: Paper account and data sharing** (02e Step 3). If there is no paper account, Task 0.5 probes the two-gateway fallback.
- [ ] **Step 4: Flex query and token in `ai-trading/desk`** (02e Step 4). One account for the spike; Phase 5 adds the other with per-account key names.
- [ ] **Step 5: Install IB Gateway on the Mac** (02e Step 5).

### Task 0.5: Run the probes and record the results (main session with the owner)

**Files:**
- Modify: [02d-desk-spike-results.md](../02d-desk-spike-results.md) (checks 1, 3, 4, 7, 9)
- Create (local only): `ai-trading/temp/spike/probe-*.json`

**Interfaces:**
- Consumes: Task 0.4.
- Produces: the final 02d table.

- [ ] **Step 1: Probe the paper login** (owner logs IB Gateway into the data username's paper login, on a weekday in US regular hours).
  - Run: `mkdir -p ai-trading/temp/spike && uv run ai-trading/tools/ibkr-probe/probe.py --port 4002 --out ai-trading/temp/spike/probe-paper.json`
  - Expected:
    - `paper: true`
    - every `streams[].data_type` is `live`, with `median_ms` near 250
    - `iv_history...bars` near 250
    - `option_batch.with_greeks == option_batch.contracts`
  - Also note whether the login asked for 2FA.
- [ ] **Step 2: If Step 1 shows `delayed`, or there is no own paper account, probe the fallback.**
  - The owner logs a second IB Gateway into the data username's live login, with Read-Only API on.
  - Run: `uv run ai-trading/tools/ibkr-probe/probe.py --port 4001 --out ai-trading/temp/spike/probe-live-data.json`
  - Expected: `paper: false`, and live streams.
- [ ] **Step 3: Probe Flex.**
  - Run: `common/config/family_config.py run ai-trading/desk -- uv run ai-trading/tools/ibkr-probe/flex_probe.py`
  - Expected: `OpenPositions` with `level_of_detail` including `LOT`.
- [ ] **Step 4: Record the results in 02d.**
  - For each check, record the status and the decision.
  - Copy only masked or aggregate values: counts, timings, data types, error codes. Never balances or positions.

### Task 0.6: Close the spike (main session)

**Files:**
- Modify: `02d-desk-spike-results.md` (status line), `02b-desk-market-data-options.md` (cost line), `../02c-desk-v1-implementation-plan.md` (Phase 0 status), `../../STATUS.md`

**Interfaces:**
- Consumes: Task 0.5.
- Produces: the final gateway layout (one or two gateways), the IV-rank mode, and the option-scan batch timing. These are the inputs of Phases 2, 3, and 6.

- [ ] **Step 1: Apply the decisions.**
  - Write the chosen gateway layout into 02d.
  - Correct 02b's cost line to the billed amount (expected about $16 per month).
- [ ] **Step 2: Mark Phase 0 done** in 02c and STATUS.md.
- [ ] **Step 3: Ship.**
  - Commit (one line, no trailer).
  - Push, open a pull request to `dev`, wait for checks, and squash-merge.
- [ ] **Step 4: Plan Phase 1.** Write `phase-1-strategy-core.md` with the writing-plans skill for owner review (if it was not already written while waiting on Task 0.4).
