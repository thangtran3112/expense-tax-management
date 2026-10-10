# Setting Up the IBKR Data User

Owner guide for [phase-0-spike.md](02c-desk-v1-tasks/phase-0-spike.md) Task 0.4. It creates the one IBKR login that the Family Desk (and later the other ai-trading apps) uses for live market data and paper orders. Decision: [02b §4](02b-desk-market-data-options.md); checks it feeds: [02d](02d-desk-spike-results.md).

Time: about 30 minutes, plus up to a day if IBKR has to create a paper account or approve a permission.

> Never paste a username, password, token, query ID, or account number into chat, a commit, or a screenshot you share. Keep them in your password manager. The only place they go is Firestore, through the commands in Step 4.

## Why a Separate Login

It is a second login on an account you already have, not a new account. Adding it is free; only its market-data subscriptions cost money.

Your existing logins cannot serve the Desk:

1. **One session per login.** A login holds one session at a time across TWS, IB Gateway, Client Portal, and IBKR Mobile. The Desk's IB Gateway stays signed in all week. If it used your login, opening the IBKR app would sign the gateway out, or the gateway would sign you out.
2. **Shared data cuts out.** A paper login receives its live login's data only while that live login is not signed in elsewhere. Every time you checked your phone, the Desk would lose live data and stop paper orders.
3. **Passwords on a server.** The gateway's password has to be stored for the VPS. With a separate login, your real trading logins never leave your own devices.
4. **Billing is per login.** Subscriptions on your current logins do not carry over to another login. One data login serves every ai-trading app.

## Before You Start

Pick the account that will pay for data. It needs:
- at least USD 500 of equity (IBKR's minimum for data subscriptions);
- US futures trading permission (futures data requires it);
- room for one more username: IBKR allows at most two usernames per account holder. If that account holder already has two, use your other account.

Check the futures permission, signed in with your usual username:
1. Head-and-shoulders icon (top right) → **Settings** → **Trading** → **Trading Permissions**.
2. Look for **Futures** in the **United States**. If it is missing, click **Request**, accept the disclosures, and **Save**. IBKR may take a day to approve it. Stocks and options steps below can go ahead meanwhile.

## Step 1: Create the Data Username

Signed in with your usual username on the paying account:

1. Head-and-shoulders icon → **Settings** → **User & Access Rights** ([direct link](https://www.interactivebrokers.com/sso/resolver?action=UarConfig)).
2. In the **Users** panel, click **Add (+)**.
3. Enter a new username and a strong password. Save both in your password manager.
4. For **Secondary user**, choose **Yes**.
5. Click **Continue**. Review the summary and click **Continue** again.
6. Confirm with IBKR Mobile, or enter the confirmation number IBKR emails you. Click **Ok**.
7. Sign out. Sign in again with the **new** username and finish its first-login steps:
   - enroll it in two-factor login. IBKR Mobile can hold several users, so add it to the app on your phone;
   - if it asks the market-data questions, answer as **Non-Professional** (you trade for yourself, are not registered with a regulator, and do not use the data for a business).

From now on this phone receives the data user's approvals, including one gateway sign-in approval each week (Sunday evening or Monday).

## Step 2: Subscribe the Data Username

Signed in as the **data username**:

1. **Settings** → **Trading Platform** → **Market Data Subscriptions** ([direct link](https://www.interactivebrokers.com/sso/resolver?action=UserSettings&config=MarketData)).
2. In **Market Data Subscriber Status**, check that it says **Non-Professional**. If it does not, click that panel's gear icon and fix the answers.
3. Click the gear icon in the **Current Subscriptions** title bar. The Configure Market Data screen opens.
4. Stay on the **TWS** tab and open **North America**. Tick:
   - **US Securities Snapshot and Futures Value Bundle**, USD 10 per month;
   - **US Equity and Options Add-On Streaming Bundle**, USD 4.50 per month.
5. Leave **OPRA Top of Book** (USD 1.50) unticked. The add-on bundle should already cover options; the probe in Task 0.5 shows whether it does.
6. Do not pick anything on the **Non-Display** tab. If either bundle is missing from the TWS tab, stop here and tell me.
7. Click **Continue**. Review, accept the exchange agreements as a non-professional, and click **Continue**.
8. Confirm with IBKR Mobile (or the emailed number) and click **Ok**. Subscriptions start right away.

## Step 3: Turn On the Paper Account and Data Sharing

Still signed in as the **data username**:

1. **Settings** → **Account Configuration** → **Paper Trading Account** ([direct link](https://www.interactivebrokers.com/sso/resolver?action=AccountSettings&config=PaperTrading)).
2. **If it shows a paper username and an account number starting with `DU`:**
   1. Set **Share real-time market data subscriptions with paper trading account** to **Yes** and save.
   2. If you do not have the paper password, click **Reset password** on the same page and save the new one in your password manager.
3. **If there is no paper account:** request one if the page offers it. IBKR emails you when it is ready, usually within 24 hours. Then repeat this step.
4. **If the page offers no paper account at all:** stop and tell me "no paper account". The Desk then uses two gateways: the data username for data only, and an existing paper login for orders ([02d](02d-desk-spike-results.md) check 1).

## Step 4: Create the Flex Query and Token

Signed in with your **usual** username on the account whose holdings the Desk should import. One account is enough for now.

1. **Performance & Reports** → **Flex Queries**.
2. In **Activity Flex Query**, click **+**. Name it `desk-holdings`.
3. Click **Open Positions**. Choose the level of detail that includes lots, click **Select All** for the fields, and **Save**.
4. If **Open Lots** is listed, add it the same way.
5. In the delivery settings, set **Format** to **XML** and **Period** to **Last Business Day**. Leave the rest as it is, and click **Save**.
6. The query list now shows the new query's **Query ID**.
7. On the right, click the gear icon in **Flex Web Service Configuration**. Switch the service on, generate a token, choose the longest expiry, and leave the IP restriction empty. Copy the token: IBKR shows it only once.
8. In a terminal, from the repository root (`/Users/tobytran/personal/family-app`), store both values without echoing them. Each `read -rs` waits silently: paste the value and press Enter. The first command also creates the `ai-trading/desk` profile.

   ```bash
   read -rs value && printf '%s' "$value" | common/config/family_config.py set ai-trading/desk IBKR_FLEX_TOKEN; unset value
   read -rs value && printf '%s' "$value" | common/config/family_config.py set ai-trading/desk IBKR_FLEX_QUERY_ID; unset value
   ```

9. Check that both names exist (this prints names, not values):

   ```bash
   common/config/family_config.py keys ai-trading/desk
   ```

The token can only read reports; it cannot trade. The second account is imported later (Phase 5).

## Step 5: Install IB Gateway on the Mac

1. Download **IB Gateway (stable)** for macOS from <https://www.interactivebrokers.com/en/trading/ibgateway-stable.php> and install it.
2. Do not sign in yet. We sign in together for the probe, on a weekday during US regular hours (09:30–16:00 ET), following Task 0.5.

## After Setup

- Do not sign in as the data username anywhere else (Client Portal, IBKR Mobile, TWS) during market hours. Each sign-in cuts the Desk's live data. Use it only for account changes, ideally on weekends.
- IBKR ends a login's subscriptions if it has not signed in to TWS for 60 days. The Desk's daily gateway sign-in is expected to count; the Desk's watchdog will report a signed-out gateway.
- The USD 10 bundle's commission waiver will probably not apply, because this login places only paper orders.

## Cost

| Item | Per month |
|---|---|
| US Securities Snapshot and Futures Value Bundle | USD 10.00 |
| US Equity and Options Add-On Streaming Bundle | USD 4.50 |
| OPRA Top of Book, only if Task 0.5 shows it is needed | USD 1.50 |
| **Total** | **USD 14.50–16.00** (cap: USD 30) |

## What to Tell Me When Done

Reply with these yes/no answers only, never the values:

- [ ] Data username created and enrolled in two-factor login
- [ ] Subscriber status is Non-Professional, and both bundles are active
- [ ] US futures permission is on (or requested, waiting for approval)
- [ ] Data username has its own paper account (`DU...`): yes or no
- [ ] Data sharing to that paper account is on
- [ ] `keys ai-trading/desk` lists `IBKR_FLEX_TOKEN` and `IBKR_FLEX_QUERY_ID`
- [ ] IB Gateway is installed on the Mac

## Sources

- Adding a second username: <https://www.ibkrguides.com/uar/uar/addingusernamestoauser.htm>
- Market data subscriptions: <https://www.ibkrguides.com/orgportal/usersettings/marketdatasubscriptions.htm>
- Paper trading account and data sharing: <https://www.ibkrguides.com/clientportal/papertradingaccount.htm>, <https://www.interactivebrokers.com/docs/general/market-data-subscriptions/market-data-users/market-data-sharing.md>
- Trading permissions: <https://www.ibkrguides.com/clientportal/tradingpermissions.htm>
- Pricing and minimum equity: <https://www.interactivebrokers.com/en/pricing/market-data-pricing.php>
