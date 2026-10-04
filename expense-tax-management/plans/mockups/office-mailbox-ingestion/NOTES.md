# office-mailbox-ingestion — NOTES (Phase 3D-C Task 6 feature gate, pending owner approval)

Screen: Office Web `/mailbox` — ingestion status region. Extends the approved Phase 3D-A base (`../office-mailbox/`) and Phase 3D-B candidate review (`../office-mailbox-review/`) in place, per the Phase 3D-C plan's ownership model ("A creates mailbox Office page/API base; B modifies it for scan/review; C modifies it only for ingestion status"). This mockup covers only the Task 6 ingestion-status addition, plus the new "Source" section on the existing Office expense detail page where connected-mailbox provenance is shown. It does not re-render the already-approved connect/OAuth/scan/candidate-review scenarios from `../office-mailbox/mailbox.html` or `../office-mailbox-review/review.html`.

Required: `ingestion-mobile-375.png`, `ingestion-tablet-768.png`, `ingestion-desktop-1440.png`. All three are full-page renders; each contains every scenario below stacked in one scrollable page (precedent: `../office-mailbox-review/review.html`).

Source: local `ingestion.html` (standalone, no build step) + `ingestion.css` (feature-specific additions only). Reuses `../rebaseline/shared/tokens.css` (shell/tokens), `../office-mailbox/mailbox.css` (banner, chip, field-row, spinner-dot, placeholder-card), and `../office-mailbox-review/review.css` (candidate-row-style visual language, reused for ingestion rows) — same visual language as the two approved gates, not duplicated. Renders via `npx playwright screenshot --full-page` (headless Chromium, Playwright 1.63.0), 2026-10-03.

## Scenario coverage (per task requirement)

1. **In progress** — `queued`, `materializing`, `malware-scan pending`, `OCR in progress`. In-progress rows use `role="status" aria-live="polite"` consistent with the 3D-B scan-running pattern; only status/counts refresh, not byte-level progress (per the design spec's "per-message failures do not roll back" / batch-refresh behavior already decided in 3D-B).
2. **Needs attention** — `malware-scan blocked` (terminal, no retry — security-sensitive, source message must be re-sent), `failed` with a transient-error note and a `Retry` button (spec: "`retry`: allowed for typed transient failure only"), `unsupported/oversize attachment` (terminal, no retry — exceeds the 25 MiB / 5-attachment cap), and `duplicate detected` (links into the existing Duplicates queue; "no automatic merge" per Phase 3B).
3. **Completed** — `ingested`, with a `View expense →` link to the created expense and the opaque `candidateId`/`jobId` references shown (never a provider message ID).
4. **Expense detail — connected mailbox provenance** — a new "Source" section mocked as an excerpt of the existing Office expense detail page (`frontend/office-web/src/app/(office)/expenses/[expenseId]/page.tsx`), not a redesign of that page. Shows origin, sender, received date, and scope for two outcomes: a clean ingest and one still pending duplicate review (with a link into the Duplicates queue). An explicit note states message body/attachment bytes are never rendered.
5. **Empty state** — no ingestion activity yet, `role="status"`, matching the empty-state pattern from `../office-mailbox-review/review.html`.
6. **State + boundary review** — opaque-references-only, no-raw-content, retry-is-scoped, duplicate-stays-pending, batch-refresh, stale-conflict, scope-immutable, disconnected-access, keyboard, screen reader, and mobile-stacking notes.

No real email addresses, message bodies, or personal data: synthetic senders/subjects reused from the approved 3D-B gate (`shopwaveco.example`, `northline-hardware.example`, `cloudbooks-saas.example`) plus one new synthetic sender (`slatehouse-supply.example`) for the malware-scan and duplicate scenarios, matching the design spec's stored-fields list (sender address, bounded subject, scope, opaque IDs — no raw MIME/HTML/body).

## Accessibility

- In-progress rows (`materializing`, `malware-scan pending`, `OCR in progress`) use `role="status" aria-live="polite"`, matching the 3D-B scan-running convention.
- Status is communicated by chip text, not color alone (e.g. "Malware scan blocked", "Duplicate detected" are always spelled out).
- "Retry" and "Review duplicate match" / "View expense" are real `<button>`/`<a>` elements, ≥44px touch target per shared tokens; `Retry` is the only action gated to a specific terminal state (transient failure).
- The empty state and placeholder regions use `role="status"`, matching prior gates.
- Expense-detail provenance fields use the existing `.field-row` label/value pattern already approved in `../office-mailbox/mailbox.css`.

## Open questions for owner approval

See `REVIEW.md` "Open questions" — this gate is **pending owner approval** and not yet signed off.

## Sources

- `../../../docs/superpowers/plans/2026-09-12-phase-3d-c-mailbox-ingestion.md` (header: Goal/Architecture/Tech Stack; Task 6: Office Ingestion Status UI — exact files/behavior this page corresponds to; "3D-B Handoff Corrections" section — candidate states, `MailboxMaterializationResultV1` status union).
- `../../../docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md` ("Deterministic Classification and Extraction", "Scope and Review Behavior", "Failure Behavior", "Office Web" sections) — ingestion/materialization states, retry/duplicate/scope rules, required Office fields.
- `../office-mailbox/mailbox.html`, `mailbox.css`, `NOTES.md`, `REVIEW.md` — approved 3D-A base and visual language.
- `../office-mailbox-review/review.html`, `review.css`, `NOTES.md`, `REVIEW.md` — approved 3D-B candidate-review region, row/status visual language reused here.
- `frontend/office-web/src/app/(office)/expenses/[expenseId]/page.tsx` — existing Office expense detail page structure (where the new "Source" section is positioned).
- `frontend/office-web/src/app/(office)/duplicates/page.tsx` — existing Office duplicate-review queue (link target for "Review duplicate match" and the pending-duplicate provenance note).
- `frontend/office-web/AGENTS.md`, `.opencode/rules/frontend.rules` — transitional/contract boundaries respected (no application code written; static mockup only).
