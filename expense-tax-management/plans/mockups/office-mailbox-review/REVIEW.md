# Office Mailbox Candidate Review Gate — Phase 3D-B Task 5

- Prepared: 2026-10-03
- Scope: `review.html`, `review.css`, `review-mobile-375.png`, `review-tablet-768.png`, `review-desktop-1440.png`, `NOTES.md`
- **Status: Approved**
- Verdict: **Approved by Toby Tran on 2026-10-03**, as drafted, with the decisions below.

## What this covers

Office Web `/mailbox` candidate-review region, extending the approved Phase 3D-A base (`../office-mailbox/`) per the Phase 3D-B plan Task 5: scan status/schedule with single-flight manual "Scan now," a candidate list grouped by classification (likely receipt / uncertain / not a receipt) with sender, subject, date, attachment indicator, and deterministic reason codes, a candidate detail panel with scope assignment and approve-for-ingestion / skip / not-a-receipt decisions, empty states per group, reauthorization-needed and partial-scan-failure states, and an explicit Personal-vs-business scope indication on every candidate.

## Design/mockup only

No application code was written or modified. This folder contains static HTML/CSS and PNG renders only, per `../README.md`'s conventions. `frontend/office-web` was read for interaction-pattern reference (the duplicates review page) but not edited.

## Owner decisions (2026-10-03)

1. **"Always ignore this sender" — deferred.** Not a canonical review action in the design spec. Removed from the mockup and recorded as a future enhancement, out of scope for 3D-B's implementation.
2. **Dismiss splits into two actions.** "Skip" (maps to `skip`: retain metadata/audit, no expense) and "Not a receipt" (maps to `not_receipt`: terminal training/audit outcome) are separate buttons in the detail panel.
3. **Running-scan refresh is batch, not streaming.** Only scan status polls live; the candidate list refreshes once the run completes.
4. **Reauthorization blocks scanning only.** Already-staged candidates stay fully reviewable while a connection is `reauth_required`; only new scan starts are blocked.
5. **Reason-code vocabulary: fixed catalog** (decided consistent with the spec's deterministic classifier and documented in `NOTES.md`).
6. **Pagination: reuse the duplicates page's cursor + "Load more" pattern, per classification group** (decided consistent with the existing Office review-queue convention; documented in `NOTES.md`).

Full rationale and sourcing for decisions 5–6 is in `NOTES.md` → "Decisions made consistent with the 3D-B plan/spec and the duplicates page".

## Sign-off checklist

- [x] Covers scan status/schedule, single-flight manual scan, grouped candidate list, candidate detail with decision actions, empty states, error/reauth state, and explicit Personal/business scope indication.
- [x] Desktop (1440) and mobile (375) renders present; tablet (768) included as a bonus third viewport.
- [x] Accessible roles/labels on every interactive control and status region (see `NOTES.md` → Accessibility).
- [x] No real email addresses, message bodies, or personal data.
- [x] Visual language matches the approved Office shell and the 3D-A mailbox gate (`../office-mailbox/mailbox.css`, `../rebaseline/shared/tokens.css` reused, not duplicated).
- [x] All open design questions resolved and recorded (see Owner decisions above and `NOTES.md`).
- [x] Human reviewer (Toby Tran) approved scope, action set, and all decisions — 2026-10-03.

## Evidence

- 3 PNG renders regenerated via `npx playwright screenshot --full-page` (headless Chromium, Playwright 1.63.0) after the 2026-10-03 decision changes (always-ignore-sender removed; Skip/Not-a-receipt split; scan-running and reauth copy updated).
- Manual visual check of all three renders: three detail-panel action buttons (Approve for ingestion / Skip / Not a receipt) fit on one row at desktop and stack cleanly on mobile; no stray reference to "always ignore this sender" remains on the page; reauth banner reads "Only scanning is blocked."
