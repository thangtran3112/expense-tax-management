# office-mailbox-review — NOTES (Phase 3D-B Task 5 feature gate)

Screen: Office Web `/mailbox` — candidate review queue region. Extends the approved Phase 3D-A base (`../office-mailbox/`) in place, per the Phase 3D-B plan's ownership model (A owns connect/account/schedule/reviewer-grants; B adds scan history and candidate review on the same page). This mockup covers only the Task 5 review-queue addition — it does not re-render the already-approved connect/OAuth/disconnect scenarios from `../office-mailbox/mailbox.html`.

Required: `review-mobile-375.png`, `review-tablet-768.png`, `review-desktop-1440.png`. All three are full-page renders; each contains every scenario below stacked in one scrollable page (precedent: `../office-mailbox/mailbox.html`).

Source: local `review.html` (standalone, no build step) + `review.css` (feature-specific additions only). Reuses `../rebaseline/shared/tokens.css` (shell/tokens) and `../office-mailbox/mailbox.css` (banner, scope-option, field-row, oauth-row, spinner-dot, placeholder-card — same visual language as the approved 3D-A gate, not duplicated). Renders via `npx playwright screenshot --full-page` (headless Chromium), 2026-10-03.

## Scenario coverage (per task requirement)

1. **Scan status, idle** — status chip, last/next scan, prior run's counts (discovered/staged/review/duplicate/skipped/failed per `MailboxScanRunV1`), manual "Scan now".
2. **Scan running (single-flight)** — `role="status" aria-live="polite"` progress line, "Scan now" disabled with a `title` explaining why, and a note that an overlapping scheduled run would be recorded `skipped_overlap` rather than started twice.
3. **Candidate review queue, populated** — candidates grouped by `MailboxCandidateClassification` (`receipt` → "Likely receipt", `ambiguous` → "Uncertain", `not_receipt` → "Not a receipt"). Each row shows sender address + domain, bounded subject, received date, an attachment indicator (count + MIME family, never content), and reason-code chips drawn from the candidate's `evidence` array — no message body anywhere. A selected uncertain candidate opens a detail panel with full fields (candidate/scan-run IDs, content-hash fingerprint, attachment manifest metadata, classification/confidence, reason chips), a required scope-assignment radiogroup (disabled "Approve for ingestion" until chosen, same disabled-until-valid pattern as the 3D-A Connect button), "Dismiss — not a receipt", and "Always ignore this sender" (flagged as reserved/open, see below).
4. **Empty states** — one empty card per classification group ("No likely-receipt candidates", "Nothing needs review", "No dismissed candidates"), `role="status"`.
5. **Reauthorization / partial-scan-failure** — reused `.banner.warn`/`.banner.bad` pattern from the 3D-A gate: reconnect-needed (scans paused, already-staged candidates stay reviewable) and a partial-failure banner reflecting the design's "per-message failures do not roll back successful candidates" rule.
6. **State + boundary review** — no-raw-body, attachment-evidence-only, scope-immutable-post-ingest, assignment-needs-target-scope-membership, single-flight scan, keyboard, screen reader, and mobile-stacking notes.

No real email addresses, message bodies, or personal data: synthetic senders/subjects only (`shopwaveco.example`, `northline-hardware.example`, etc.), matching the "never full email bodies" requirement and the design spec's stored-fields list (sender address/domain, bounded subject, content hash, attachment manifest name/MIME/size/SHA-256 — no raw MIME/HTML/body).

## Accessibility

- Group headings are real `<h3>` elements with a visible count; status/alert regions use `role="status"` / `role="alert"` matching the 3D-A gate's convention.
- The scope-assignment control is a native `<fieldset>`/`role="radiogroup"` with per-option `<label>` wrapping, reusing `.scope-option` from `mailbox.css`.
- "Approve for ingestion" is `disabled`/`aria-disabled="true"` with an explanatory `title` until a scope is chosen; "Always ignore this sender" carries an `aria-describedby` note explaining its reserved status rather than being a silently dead control.
- Candidate rows are `<article>` elements with `aria-labelledby` pointing at the sender; the selected row carries `aria-current="true"`.
- All controls are real `<button>`/`<input>` elements, ≥44px touch target per shared tokens.

## Open design questions (owner input needed before implementation)

1. **"Always ignore this sender" is not a canonical review action.** The design spec's review-action set is `ingest` / `skip` / `not_receipt` / `retry` (`docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md`, "Review actions"). The task brief asks for an "always-ignore-sender" decision, which implies a persistent per-sender suppression rule affecting *future* scans — that entity doesn't exist in the canonical B contracts (`MailboxCandidateOutcomeV1`, `MailboxCandidateStatus`). Mockup shows it as a reserved/disabled-feeling action with an inline note. **Decision needed:** is this in scope for 3D-B's implementation, a 3D-C+ follow-up, or should it simply map to `not_receipt` (dismiss) with no sender-level memory?
2. **Does "dismiss" in the task brief mean `skip` or `not_receipt`?** Both exist in the canonical action set with different audit semantics (`skip`: retain metadata/audit, no expense; `not_receipt`: terminal training/audit outcome). Mockup uses one "Dismiss — not a receipt" button mapped to `not_receipt`. **Decision needed:** does the implementation need a separate `skip` affordance distinct from "not a receipt," or does the Office UI only ever expose one dismissal action?
3. **Reason-code vocabulary.** The design spec defines `evidence` as `readonly string[]` with no fixed enum. This mockup invents plausible deterministic codes (`pdf_attachment_detected`, `order_confirmation_schema`, `sender_domain_unverified`, etc.) for illustration. **Decision needed:** does Task 5's classifier need a fixed, documented reason-code catalog (for consistent copy/i18n), or is free-form evidence text acceptable in Office?
4. **Streaming vs. batch refresh during an active scan.** Scenario 2 implies candidates "appear below as they finish staging." **Decision needed:** does the Office candidate list poll/refresh live during a running scan, or does it only update once the run completes (`GET .../:connectionId/candidates` called again by the user)?
5. **Review access while reauth is required.** The reconnect-needed banner here claims already-staged candidates "remain reviewable." The design spec says a reauth-required connection pauses *scans*; it does not explicitly state whether existing candidate review/resolve actions stay available. **Decision needed:** confirm review/resolve stays open during `reauth_required`, or should the whole queue go read-only until reconnected?
6. **List pagination pattern.** The existing Office duplicates-review page (`frontend/office-web/src/app/(office)/duplicates/page.tsx`) uses a cursor + "Load more" button with a shared `aria-busy` toolbar. This mockup shows one bounded page per group for layout clarity. **Decision needed:** should the real candidate list reuse that exact load-more pattern per classification group, or paginate the queue as a whole?

## Sources

- `../../../docs/superpowers/plans/2026-09-12-phase-3d-b-mailbox-discovery.md` (Goal/Architecture header, Canonical B Contracts, Task 5) — candidate/scan-run shapes, Office page ownership.
- `../../../docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md` ("Deterministic Classification and Extraction", "Scope and Review Behavior", "Office Web" sections) — classification/evidence model, review actions, required Office fields.
- `../office-mailbox/mailbox.html`, `mailbox.css`, `NOTES.md`, `REVIEW.md` — approved 3D-A base, visual language, and the explicit deferral of candidate-review shape to 3D-B.
- `frontend/office-web/src/app/(office)/duplicates/page.tsx` — existing Office review-queue pattern (status badges, confidence chip, per-item action row, cursor pagination, conflict/unauthorized/empty states) used for interaction-pattern consistency.
- `frontend/office-web/AGENTS.md`, `.opencode/rules/frontend.rules` — transitional/contract boundaries respected (no application code written; static mockup only).
