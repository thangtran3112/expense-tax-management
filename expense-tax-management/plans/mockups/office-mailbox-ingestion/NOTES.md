# office-mailbox-ingestion — NOTES (Phase 3D-C Task 6 feature gate, approved)

Screen: Office Web `/mailbox` — ingestion status region. Extends the approved Phase 3D-A base (`../office-mailbox/`) and Phase 3D-B candidate review (`../office-mailbox-review/`) in place, per the Phase 3D-C plan's ownership model ("A creates mailbox Office page/API base; B modifies it for scan/review; C modifies it only for ingestion status"). This mockup covers only the Task 6 ingestion-status addition, plus the new "Source" section on the existing Office expense detail page where connected-mailbox provenance is shown. It does not re-render the already-approved connect/OAuth/scan/candidate-review scenarios from `../office-mailbox/mailbox.html` or `../office-mailbox-review/review.html`.

Required: `ingestion-mobile-375.png`, `ingestion-tablet-768.png`, `ingestion-desktop-1440.png`. All three are full-page renders; each contains every scenario below stacked in one scrollable page (precedent: `../office-mailbox-review/review.html`).

Source: local `ingestion.html` (standalone, no build step) + `ingestion.css` (feature-specific additions only). Reuses `../rebaseline/shared/tokens.css` (shell/tokens), `../office-mailbox/mailbox.css` (banner, chip, field-row, spinner-dot, placeholder-card), and `../office-mailbox-review/review.css` (candidate-row-style visual language, reused for ingestion rows) — same visual language as the two approved gates, not duplicated. Renders via `npx playwright screenshot --full-page` (headless Chromium, Playwright 1.63.0), 2026-10-03.

## Scenario coverage (per task requirement)

1. **In progress** — `queued`, `materializing`, `malware-scan pending`, `OCR in progress`. In-progress rows use `role="status" aria-live="polite"` consistent with the 3D-B scan-running pattern; only status/counts refresh, not byte-level progress (per the design spec's "per-message failures do not roll back" / batch-refresh behavior already decided in 3D-B). Each group ends with a cursor-style "Load more" footer (see Owner decisions #2 below).
2. **Needs attention** — `malware-scan blocked` (dead end: reason shown, a `Dismiss` action only, no retry and no download), `failed` with a transient-error note and a `Retry` button (spec: "`retry`: allowed for typed transient failure only"), a second `failed` row showing the inline stale-candidate/409 conflict alert that `Retry` can surface, `unsupported/oversize attachment` (terminal, no retry — exceeds the 25 MiB / 5-attachment cap), and `duplicate detected` (links to the existing `/duplicates` queue; "no automatic merge" per Phase 3B).
3. **Completed** — `ingested`, with a `View expense →` link to the created expense. No opaque ID is visible on the row by default (see Owner decisions #3).
4. **Expense detail — connected mailbox provenance** — a new "Source" block mocked as an excerpt of the existing Office expense detail page (`frontend/office-web/src/app/(office)/expenses/[expenseId]/page.tsx`), not a redesign of that page. Shows origin, sender, received date, and scope for two outcomes: a clean ingest and one still pending duplicate review (with a link into the `/duplicates` queue). An explicit note states message body/attachment bytes are never rendered.
5. **Empty state** — no ingestion activity yet, `role="status"`, matching the empty-state pattern from `../office-mailbox-review/review.html`.
6. **State + boundary review** — no-visible-IDs, no-raw-content, retry-is-scoped, malware-block-is-a-dead-end, duplicate-stays-pending, batch-refresh, stale-conflict-reuses-candidate-review, pagination-reuses-the-review-queue, scope-immutable, disconnected-access, keyboard, and screen reader notes.

No real email addresses, message bodies, or personal data: synthetic senders/subjects reused from the approved 3D-B gate (`shopwaveco.example`, `northline-hardware.example`, `cloudbooks-saas.example`) plus one new synthetic sender (`slatehouse-supply.example`) for the malware-scan and duplicate scenarios, matching the design spec's stored-fields list (sender address, bounded subject, scope, opaque IDs — no raw MIME/HTML/body).

## Accessibility

- In-progress rows (`materializing`, `malware-scan pending`, `OCR in progress`) use `role="status" aria-live="polite"`, matching the 3D-B scan-running convention.
- Status is communicated by chip text, not color alone (e.g. "Malware scan blocked", "Duplicate detected" are always spelled out).
- "Retry", "Dismiss", "Review duplicate match" / "View expense" are real `<button>`/`<a>` elements, ≥44px touch target per shared tokens; `Retry` is the only action gated to a specific terminal state (transient failure); `Dismiss` is the only action on a malware-blocked row.
- The stale-candidate/409 conflict alert on Retry uses `role="alert"`, matching the `.banner.warn` pattern already approved in `../office-mailbox/mailbox.css`.
- Candidate/job IDs sit inside a native `<details>`/`<summary>` "Support details" disclosure per row, not in the default row view; each ID has its own `Copy` button with a descriptive `aria-label` (e.g. "Copy candidate ID").
- The empty state and placeholder regions use `role="status"`, matching prior gates.
- Expense-detail provenance fields use the existing `.field-row` label/value pattern already approved in `../office-mailbox/mailbox.css`.

## Owner decisions (approved 2026-10-03)

1. **Malware-scan blocked is a dead end.** Shows the reason and a `Dismiss` action only — no retry and no download, ever. The source message must be re-sent or handled outside Office.
2. **Pagination reuses the review-queue cursor pattern.** Each status group ("In progress", "Needs attention", "Completed") gets its own cursor + "Load more" footer with a "Showing N of M" status line, the same per-group pattern already approved for 3D-B candidate classification groups (`../office-mailbox-review/NOTES.md` decision 6) and used by the Duplicates queue (`frontend/office-web/src/app/(office)/duplicates/page.tsx`).
3. **No shortened opaque IDs on rows.** Rows show status text and scope only. Candidate/job IDs are available solely inside a per-row "Support details" `<details>` disclosure, with a `Copy` button per ID, for support use. This also applies to the expense-detail "Source" block (Scenario 4): the candidate ID is likewise moved into its own "Support details" disclosure rather than a visible field.
4. **Duplicate-detected links to the existing `/duplicates` review queue** (not a mailbox-specific duplicate view) — both from the ingestion row and from the expense-detail "pending duplicate review" Source block.
5. **Retry's 409/stale-candidate conflict reuses the candidate-review pattern inline.** Demonstrated as a second "Failed — transient error" row (Scenario 2) whose `Retry` surfaced a stale-version conflict: an inline `role="alert"` banner ("Candidate changed while retrying — status refreshed below. Confirm before retrying again.") appears directly on the row, mirroring the stale-refresh handling already used by candidate review and the Duplicates queue's resolve actions — the row's own data refreshes and `Retry` re-enables, rather than navigating away or showing a full-page error.
6. **Expense-detail "Source" block placement follows the existing page's convention.** It sits inside the current "Expense details" panel, directly after the Date/Merchant/Amount/Status fields and tags, and before the pending-suggestions panel — matching the real page's existing order of settled facts before review actions (`frontend/office-web/src/app/(office)/expenses/[expenseId]/page.tsx`: `Panel title="Expense details"` → suggestions `Panel` below it).

**Verdict: Approved by Toby Tran on 2026-10-03**, as drafted, with the six decisions above. See `REVIEW.md`.

## Sources

- `../../../docs/superpowers/plans/2026-09-12-phase-3d-c-mailbox-ingestion.md` (header: Goal/Architecture/Tech Stack; Task 6: Office Ingestion Status UI — exact files/behavior this page corresponds to; "3D-B Handoff Corrections" section — candidate states, `MailboxMaterializationResultV1` status union).
- `../../../docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md` ("Deterministic Classification and Extraction", "Scope and Review Behavior", "Failure Behavior", "Office Web" sections) — ingestion/materialization states, retry/duplicate/scope rules, required Office fields.
- `../office-mailbox/mailbox.html`, `mailbox.css`, `NOTES.md`, `REVIEW.md` — approved 3D-A base and visual language.
- `../office-mailbox-review/review.html`, `review.css`, `NOTES.md`, `REVIEW.md` — approved 3D-B candidate-review region, row/status visual language reused here.
- `frontend/office-web/src/app/(office)/expenses/[expenseId]/page.tsx` — existing Office expense detail page structure (where the new "Source" section is positioned).
- `frontend/office-web/src/app/(office)/duplicates/page.tsx` — existing Office duplicate-review queue (link target for "Review duplicate match" and the pending-duplicate provenance note).
- `frontend/office-web/AGENTS.md`, `.opencode/rules/frontend.rules` — transitional/contract boundaries respected (no application code written; static mockup only).
