# Real Receipt OCR via OpenAI — Design

**Date:** 2026-10-09
**Status:** Awaiting owner review
**Depends on:** `origin/dev` with the TypeScript `workflow-worker`, Foundry routes and quotas, the Capture/Office upload flow, and the connected mailbox in production.

## Problem

Every receipt processed since the TypeScript worker cutover has returned placeholder data. `services/workflow-worker/src/worker.ts` wires `extractReceipt: extractFakeReceipt` for both the receipt OCR workflow and the mailbox attachment OCR activity. The fake returns "Fake OCR Merchant", 12.34 USD, 2026-09-09 for any non-empty file. Jobs report `SUCCEEDED`, expenses are created from invented data, and the identical fake values make the duplicate detector flag unrelated receipts (Office shows 31 pending duplicate reviews). Foundry's catalog contains only a `fake` provider with one model behind the three OCR modes.

## Goals

1. Capture/Office uploads and mailbox attachments are read by a real vision model and produce a correct `OcrExtractionResultV1`: merchant, amount, currency, incurredOn, optional orderNumber and notes, confidence.
2. Foundry stays the source of truth for which model serves each OCR mode (route versions), so a model change is a data change, not a deploy.
3. OpenAI keys live only in Firestore `family-config` (the single-source rule) and reach only `workflow-worker`. The three keys are rotated with failover.
4. OpenAI keeps no copy of the receipts (`store: false`).

## Non-goals

- Cost and latency logging into Foundry's `provider_call_logs` (the contract already accepts `latencyMs` and `costUsd`; follow-up).
- Other providers, a Foundry admin UI, an accuracy evaluation set, and multi-receipt PDFs.
- Re-extracting receipts already stored with fake data (see Open items).

## Verified facts (2026-10-09)

- **Live probe** with `ItemizedReceipt.jpg` (84 KB) against the OpenAI Responses API, image input, strict JSON schema:
  - `gpt-5.4-mini`: Harbor Lane Cafe, 31.39 USD, 2019-11-20, order 34362, in 1.4 s (1,521 input and 86 output tokens).
  - `gpt-5.4`: same values, 2.2 s.
  - `gpt-5.4-nano`: returned `incurredOn: "2019-11-20 11:05 AM"`, which violates the date format, so it is not used.
- Foundry's `EffectiveRouteResponse` already carries `providerKind` and `providerModelId`, and `ocr_resolve_route` already returns it. The worker only passes `aiModelId` on today.
- The database allows provider kinds `openai`, `openrouter`, `anthropic`, `google`, `paddleocr` and `fake`.
- `foundry.tenant_ai_quotas` is empty and the trial plan's RECEIPT_OCR entitlement is unlimited, so new models need no quota rows.
- Firestore `shared/llm` already holds `OPENAI_API_KEY_1` and `OPENAI_API_KEY_2`. `OPENAI_API_KEY` exists only in the owner's shell and will be added there.
- The contract fields: `amount` matches `^(0|[1-9]\d*)(\.\d{1,2})?$` and is positive; `currency` is `^[A-Z]{3}$`; `incurredOn` is an ISO date; `orderNumber` is at most 200 characters; `notes` is at most 2000; `confidence` is 0 to 1.

## Design

### 1. Foundry catalog (new Foundry migration, same style as 004)

- A `provider_secrets` row whose value is a non-secret marker (`family-config:shared/llm`). The schema requires a secret reference, but the keys stay in Firestore.
- A `provider_connections` row: key `openai`, kind `openai`, active.
- Two `ai_models`: `gpt-5.4-mini` (metered key `openai-gpt-5.4-mini`) and `gpt-5.4` (`openai-gpt-5.4`).
- A new route version 2 for each mode, made current in one transaction while version 1 stops being current:
  - `ocr_mode_fast`: `gpt-5.4-mini`
  - `ocr_mode_balanced`: `gpt-5.4-mini`
  - `ocr_mode_accurate`: `gpt-5.4`
- Mode descriptions drop the "fake (dev/test only)" wording. `down()` restores version 1.
- The `fake` provider stays in the database and in the worker: a route whose kind is `fake` still returns fake data (tests, deliberate fallback). The worker logs a warning when it is used.

### 2. Worker extractor (`services/workflow-worker/src/providers/`)

- `openai-ocr.ts`: `createOpenAiReceiptExtractor({ apiKeys, fetch })` returns `(data, route) => OcrExtractionResultV1`.
  1. Sniff the bytes: JPEG, PNG, WebP become `input_image` data URLs (`detail: "high"`); PDF becomes `input_file` with a data URL. Anything else is a non-retryable "unsupported format".
  2. `POST https://api.openai.com/v1/responses` with `model` set to the route's `providerModelId`, `store: false`, and `text.format` a strict `json_schema` (all fields required; the optional fields are nullable). The prompt asks for the grand total actually paid, a plain decimal, the ISO currency, the purchase date, the printed order or invoice number, short notes, and a confidence.
  3. Parse `output_text`. Normalize: `amount` to two decimals, `currency` uppercased, `confidence` clamped, null or empty optionals omitted, long strings truncated to the contract maxima. Then validate with `OcrExtractionResultV1Schema`.
- `receipt-extractor.ts`: dispatches on `route.providerKind`: `fake` calls the existing fake, `openai` calls the OpenAI extractor, anything else is a non-retryable "unsupported provider".
- **Key pool:** the non-empty values of `OPENAI_API_KEY`, `OPENAI_API_KEY_1`, `OPENAI_API_KEY_2`, deduplicated by value. Each call starts at a random key and tries each at most once, failing over on 401, 403, 429, 408, 5xx and network errors. A 400 is non-retryable and never fails over. An empty pool is a non-retryable "OpenAI not configured".
- **Time budget:** 25 s per request, 50 s total. The extraction activity's 60 s timeout is unchanged.
- **Failure classes** (the existing `runExtraction` wrapper must pass through failures the extractor already classified instead of re-wrapping them as retryable):
  - retryable: network errors, 429, 5xx, all keys failing, malformed model output (one retry via the activity's 2 attempts);
  - non-retryable: unsupported format or provider, 400, a model refusal, an incomplete response, no keys.
- **Logging:** only `{provider, model, status, errorType, attempt, latencyMs, keyIndex}`. Never prompts, response bodies, receipt data or keys.

### 3. Workflow and activity wiring

- `runOcr` passes the resolved route (`providerKind`, `providerModelId`) to `ocr_extract_receipt`. Temporal replay matches commands by activity type and ID, not input, so no new `patched()` marker is needed. An activity attempt scheduled before the deploy has no route and fails non-retryably with "route missing". No jobs are in flight at deploy time.
- The legacy `ocr_run_extraction` branch (old histories only) keeps using the fake extractor.
- Mailbox attachment OCR (`createMailboxOcrActivities`) resolves the `ocr_mode_balanced` route through the same Foundry client and calls the same extractor. It does no quota reservation, as today.
- `worker.ts` builds the key pool from its environment and wires the dispatcher in place of `extractFakeReceipt`.

### 4. Keys, config, deploy

- Firestore: add `OPENAI_API_KEY` to `shared/llm` (from the owner's shell, never printed), then link `OPENAI_API_KEY`, `OPENAI_API_KEY_1` and `OPENAI_API_KEY_2` into the `expense-tax-management/production` and `expense-tax-management/local` profiles with `family_config.py link <profile> <NAME> shared/llm <NAME>`. `ANTHROPIC_API_KEY` is not linked.
- `workflow-worker` config reads the three variables, each optional. Compose passes them to `workflow-worker` only, in `deploy/production/docker-compose.yml` and the root `docker-compose.yml`. `deploy.sh` adds them to `KNOWN_ENV_KEYS` and requires at least one to be non-empty. `.env.example` gets placeholders.
- `scripts/audit-credential-boundaries.mjs` and the boundary tests are updated so the OpenAI keys may reach `workflow-worker` and no other service.

### 5. Rollback

Redeploying the previous tag restores the old worker, which ignores routes and uses the fake. To make Foundry itself route back to `fake`, flip route version 1 to current for the mode. The Foundry route data is otherwise harmless to leave.

## Testing

- Unit tests:
  - byte sniffing for each format and an unknown type;
  - the request builder (image and PDF, `store: false`, strict schema, model from the route);
  - response normalization (a table including `"31.390"`, a currency in lowercase, a date with a time, null optionals, an over-long note, a refusal, an incomplete response);
  - key pool: 401 on the first key uses the next, 429 fails over, all keys failing is retryable, a 400 never fails over, duplicate keys are used once, an empty pool is non-retryable, the 50 s budget stops further attempts.
- A test that sample output conforming to the strict JSON schema parses with `OcrExtractionResultV1Schema`.
- `TestWorkflowEnvironment`: the workflow passes the route to `ocr_extract_receipt` and still handles the failure classes.
- Foundry: after migrations each of the three modes' current route points at the OpenAI models, and `down()` restores the fake.
- Existing suites stay green, including the deployment boundary and credential audit suites.

## Rollout and verification

1. Set the Firestore keys and links first, so the deploy's key check passes.
2. One PR to `dev`, then the expense-only cherry-pick release to `main` and the deploy (same recipe as #31 to #68).
3. Verify with the real flow using `ItemizedReceipt.jpg`: upload, confirm, OCR job. Expect merchant "Harbor Lane Cafe", 31.39, USD, 2019-11-20. Then a Gmail attachment path check.
4. Update `AGENTS.md` and the runbook to say OCR uses OpenAI through Foundry routes.

## Open items (defaults apply unless you say otherwise)

1. Model mapping: fast and balanced use `gpt-5.4-mini`; accurate uses `gpt-5.4`.
2. Existing placeholder data: 3 expenses created by fake OCR ("Fake OCR Merchant", 12.34 USD) and the 31 duplicate reviews they caused. Default: leave them until real OCR is verified, then propose a cleanup for your approval. Nothing is deleted without asking.
