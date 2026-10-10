# IBKR Probe Tools

Read-only tools for the Family Desk verification spike ([02a §12](../../plans/subplans/02a-desk-v1-strategies-design.md); results in [02d](../../plans/subplans/02d-desk-spike-results.md)). After the spike, they serve as the manual smoke test for the Desk's IB Gateway.

| Tool | What it does |
|---|---|
| `probe.py` | Connects to a running IB Gateway or TWS and prints one JSON report: account prefix, live or delayed data per symbol with update rates, implied-volatility history depth, 1-minute history depth, option-greeks batch timing, and news providers |
| `flex_probe.py` | Calls the Flex Web Service and prints section names, record counts, and field names of one Activity Flex statement |

Both tools are read-only:
- They place no orders and request no positions, balances, or account values.
- `flex_probe.py` reads a statement but prints no values.
- Account IDs are masked to their prefix (`DU*******` for paper, `U*******` for live).

Keep any saved output under `ai-trading/temp/`, which is gitignored.

## Probe a Gateway Session

1. Start IB Gateway in Paper Trading mode and log in.
   - For the spike, use the data username's paper login.
   - Any existing paper login works for a first pass.
2. In Configure → Settings → API → Settings, set:
   - **Enable ActiveX and Socket Clients:** on
   - **Socket port:** 4002
   - **Read-Only API:** on
   - **Trusted IPs:** 127.0.0.1 only
3. Run the probe:

   ```bash
   mkdir -p ai-trading/temp/spike
   uv run ai-trading/tools/ibkr-probe/probe.py --port 4002 --out "ai-trading/temp/spike/probe-$(date +%Y%m%d-%H%M).json"
   ```

Run it during US regular hours (09:30–16:00 ET) to measure stock update rates. Futures update on weekdays almost around the clock. For the two-gateway fallback, probe the data username's live login with `--port 4001`. Read-Only API stays on for that login.

How to read the report:

| Field | Good result | Otherwise |
|---|---|---|
| `paper` | `true` (accounts start with `DU`) | The session is live, so it must not be the order gateway |
| `streams[].data_type` | `live`, with `median_ms` near 250 during market hours | `delayed`: the subscription is missing or not shared with this paper login |
| `iv_history.option_implied_volatility.bars` | About 250 bars | Fewer: IV rank shows "short history" (02a §12) |
| `minute_history` | Bars at 5, 30, and 180 days back | Missing older days: keep our own 1-minute archive |
| `option_batch` | `with_greeks == contracts`, `seconds` under 15 | Spread the covered-call scan over about 5 minutes |
| `errors[].code` | None, or informational only | Missing subscription (see below) |

Missing-subscription error codes:
- `354`, `10089`, `10168`: the data is not subscribed for the API.
- `10167`: delayed data was shown instead.

## Probe a Flex Query

1. In Client Portal, go to Performance & Reports → Flex Queries and create an **Activity Flex Query** in XML format with:
   - the **Open Positions** section, with level of detail including lots;
   - the **Open Lots** section, if it is offered.
2. Under Flex Web Service, enable the service and generate a token. Choose the expiry, and optionally restrict it to known IPs.
3. Store the token and query ID without echoing them. Paste each value at the hidden prompt:

   ```bash
   read -rs value && printf '%s' "$value" | common/config/family_config.py set ai-trading/desk IBKR_FLEX_TOKEN; unset value
   read -rs value && printf '%s' "$value" | common/config/family_config.py set ai-trading/desk IBKR_FLEX_QUERY_ID; unset value
   ```

4. Run the probe:

   ```bash
   common/config/family_config.py run ai-trading/desk -- uv run ai-trading/tools/ibkr-probe/flex_probe.py
   ```

A good result has `OpenPositions` with `level_of_detail` containing `LOT`, and `asset_category` including `OPT` when options are held.

## Tests

```bash
uv run --no-project --with pytest pytest -q ai-trading/tools/ibkr-probe
```
