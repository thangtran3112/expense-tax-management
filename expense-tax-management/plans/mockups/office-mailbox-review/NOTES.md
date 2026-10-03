# office-mailbox-review — NOTES (Phase 3D-B Task 5 feature gate)

Screen: Office Web `/mailbox` — candidate review queue region. Extends the approved Phase 3D-A base (`../office-mailbox/`) in place, per the Phase 3D-B plan's ownership model (A owns connect/account/schedule/reviewer-grants; B adds scan history and candidate review on the same page). This mockup covers only the Task 5 review-queue addition — it does not re-render the already-approved connect/OAuth/disconnect scenarios from `../office-mailbox/mailbox.html`.

Required: `review-mobile-375.png`, `review-tablet-768.png`, `review-desktop-1440.png`. All three are full-page renders; each contains every scenario below stacked in one scrollable page (precedent: `../office-mailbox/mailbox.html`).

Source: local `review.html` (standalone, no build step) + `review.css` (feature-specific additions only). Reuses `../rebaseline/shared/tokens.css` (shell/tokens) and `../office-mailbox/mailbox.css` (banner, scope-option, field-row, oauth-row, spinner-dot, placeholder-card — same visual language as the approved 3D-A gate, not duplicated). Renders via `npx playwright screenshot --full-page` (headless Chromium), 2026-10-03.

## Scenario coverage (per task requirement)

1. **Scan status, idle** — status chip, last/next scan, prior run's counts (discovered/staged/review/duplicate/skipped/failed per `MailboxScanRunV1`), manual "Scan now".
2. **Scan running (single-flight)** — `role="status" aria-live="polite"` progress line, "Scan now" disabled with a `title` explaining why, and a note that an overlapping scheduled run would be recorded `skipped_overlap` rather than started twice.
3. **Candidate review queue, populated** — candidates grouped by `MailboxCandidateClassification` (`receipt` → "Likely receipt", `ambiguous` → "Uncertain", `not_receipt` → "Not a receipt"). Each row shows sender address + domain, bounded subject, received date, an attachment indicator (count + MIME family, never content), and reason-code chips drawn from the candidate's `evidence` array — no message body anywhere. A selected uncertain candidate opens a detail panel with full fields (candidate/scan-run IDs, content-hash fingerprint, attachment manifest metadata, classification/confidence, reason chips), a required scope-assignment radiogroup (disabled "Approve for ingestion" until chosen, same disabled-until-valid pattern as the 3D-A Connect button), "Skip" (maps to `skip`), and "Not a receipt" (maps to `not_receipt`).
4. **Empty states** — one empty card per classification group ("No likely-receipt candidates", "Nothing needs review", "No dismissed candidates"), `role="status"`.
5. **Reauthorization / partial-scan-failure** — reused `.banner.warn`/`.banner.bad` pattern from the 3D-A gate: reconnect-needed (only scanning is blocked; already-staged candidates stay fully reviewable) and a partial-failure banner reflecting the design's "per-message failures do not roll back successful candidates" rule.
6. **State + boundary review** — no-raw-body, attachment-evidence-only, scope-immutable-post-ingest, assignment-needs-target-scope-membership, single-flight scan, keyboard, screen reader, and mobile-stacking notes.

No real email addresses, message bodies, or personal data: synthetic senders/subjects only (`shopwaveco.example`, `northline-hardware.example`, etc.), matching the "never full email bodies" requirement and the design spec's stored-fields list (sender address/domain, bounded subject, content hash, attachment manifest name/MIME/size/SHA-256 — no raw MIME/HTML/body).

## Accessibility

- Group headings are real `<h3>` elements with a visible count; status/alert regions use `role="status"` / `role="alert"` matching the 3D-A gate's convention.
- The scope-assignment control is a native `<fieldset>`/`role="radiogroup"` with per-option `<label>` wrapping, reusing `.scope-option` from `mailbox.css`.
- "Approve for ingestion" is `disabled`/`aria-disabled="true"` with an explanatory `title` until a scope is chosen.
- Candidate rows are `<article>` elements with `aria-labelledby` pointing at the sender; the selected row carries `aria-current="true"`.
- All controls are real `<button>`/`<input>` elements, ≥44px touch target per shared tokens.

## Owner decisions (approved 2026-10-03)

1. **"Always ignore this sender" — deferred.** Not a canonical review action (`ingest`/`skip`/`not_receipt`/`retry` only; no per-sender suppression entity in the canonical B contracts). Removed from this mockup. Recorded as a future enhancement, not part of 3D-B's implementation scope.
2. **Dismiss splits into two actions.** "Skip" maps to `skip` (retain metadata/audit, no expense — use for "not now"). "Not a receipt" maps to `not_receipt` (terminal training/audit outcome). Both shown as separate buttons in the detail panel.
3. **Running-scan refresh is batch, not streaming.** Only scan *status* (the Scenario 2 progress line) polls/updates live. The candidate list refreshes once the run completes (`GET .../:connectionId/candidates` re-called then), not per-message.
4. **Reauthorization blocks scanning only.** Already-staged candidates stay fully reviewable (review/resolve actions remain available) while a connection is `reauth_required`; only new scan starts are blocked.

## Decisions made consistent with the 3D-B plan/spec and the duplicates page

5. **Reason-code vocabulary: fixed catalog.** The design spec's classifier is explicitly deterministic (versioned rules: attachment checks, JSON-LD/microdata, structured HTML, subject/sender keywords) even though `evidence` is typed as `readonly string[]` with no enum in the wire contract. A fixed, documented reason-code catalog (the `snake_case` codes already used in this mockup — `pdf_attachment_detected`, `order_confirmation_schema`, `sender_domain_unverified`, `sender_domain_known_retailer`, `structured_html_invoice`, `subject_keyword_order`, `free_text_only_low_confidence`, `marketing_keyword_match`, `no_structured_or_attachment_evidence`) keeps classifier output machine-checkable in tests and copy/i18n-stable in Office, matching "deterministic" intent better than ad hoc free text. Task 5's classifier module should export this catalog as a typed union/const, not accept arbitrary strings.
6. **Pagination: reuse the duplicates page's cursor + "Load more" pattern, per classification group.** The existing Office duplicates-review page (`frontend/office-web/src/app/(office)/duplicates/page.tsx`) already establishes the project's review-queue pagination convention: a cursor-based `nextCursor`, a `Load more` button disabled during any in-flight action, and a shared `aria-busy`/`aria-live` status line. Candidates are grouped by classification for review triage, so each group gets its own cursor and "Load more" rather than one flat list — consistent with the existing single-queue pattern but scoped per group to keep triage order stable as new pages load.

## Sources

- `../../../docs/superpowers/plans/2026-09-12-phase-3d-b-mailbox-discovery.md` (Goal/Architecture header, Canonical B Contracts, Task 5) — candidate/scan-run shapes, Office page ownership.
- `../../../docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md` ("Deterministic Classification and Extraction", "Scope and Review Behavior", "Office Web" sections) — classification/evidence model, review actions, required Office fields.
- `../office-mailbox/mailbox.html`, `mailbox.css`, `NOTES.md`, `REVIEW.md` — approved 3D-A base, visual language, and the explicit deferral of candidate-review shape to 3D-B.
- `frontend/office-web/src/app/(office)/duplicates/page.tsx` — existing Office review-queue pattern (status badges, confidence chip, per-item action row, cursor pagination, conflict/unauthorized/empty states) used for interaction-pattern consistency.
- `frontend/office-web/AGENTS.md`, `.opencode/rules/frontend.rules` — transitional/contract boundaries respected (no application code written; static mockup only).
