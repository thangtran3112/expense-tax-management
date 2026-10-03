# Office Mailbox Candidate Review Gate — Phase 3D-B Task 5

- Prepared: 2026-10-03
- Scope: `review.html`, `review.css`, `review-mobile-375.png`, `review-tablet-768.png`, `review-desktop-1440.png`, `NOTES.md`
- **Status: Pending owner approval**

## What this covers

Office Web `/mailbox` candidate-review region, extending the approved Phase 3D-A base (`../office-mailbox/`) per the Phase 3D-B plan Task 5: scan status/schedule with single-flight manual "Scan now," a candidate list grouped by classification (likely receipt / uncertain / not a receipt) with sender, subject, date, attachment indicator, and deterministic reason codes, a candidate detail panel with scope assignment and approve-for-ingestion / dismiss / always-ignore-sender decisions, empty states per group, reauthorization-needed and partial-scan-failure states, and an explicit Personal-vs-business scope indication on every candidate.

## Design/mockup only

No application code was written or modified. This folder contains static HTML/CSS and PNG renders only, per `../README.md`'s conventions. `frontend/office-web` was read for interaction-pattern reference (the duplicates review page) but not edited.

## Open design questions (owner decision needed before implementation)

1. **"Always ignore this sender"** is not one of the canonical review actions in the design spec (`ingest`/`skip`/`not_receipt`/`retry`). Is a persistent per-sender suppression rule in scope for 3D-B, deferred to a later phase, or should this control be removed in favor of plain dismissal?
2. **Dismiss mapping** — does the Office "Dismiss" action map to `not_receipt` (terminal, shown here) or does the UI also need a separate `skip` ("not now" without the terminal training signal)?
3. **Reason-code vocabulary** — should Task 5's classifier emit from a fixed, documented catalog of reason codes, or is free-form `evidence` text acceptable to render directly in Office?
4. **Live vs. batch candidate list refresh** while a scan is running — poll during the run, or only refresh once the run completes?
5. **Review access during `reauth_required`** — confirm already-staged candidates stay reviewable while reconnection is pending, or should the queue go fully read-only?
6. **Pagination pattern** — reuse the existing duplicates-review cursor + "Load more" pattern per classification group, or paginate the whole queue?

Full detail and sourcing for each question is in `NOTES.md`.

## Sign-off checklist

- [ ] Covers scan status/schedule, single-flight manual scan, grouped candidate list, candidate detail with decision actions, empty states, error/reauth state, and explicit Personal/business scope indication.
- [ ] Desktop (1440) and mobile (375) renders present; tablet (768) included as a bonus third viewport.
- [ ] Accessible roles/labels on every interactive control and status region (see `NOTES.md` → Accessibility).
- [ ] No real email addresses, message bodies, or personal data.
- [ ] Visual language matches the approved Office shell and the 3D-A mailbox gate (`../office-mailbox/mailbox.css`, `../rebaseline/shared/tokens.css` reused, not duplicated).
- [ ] Open design questions above answered or explicitly deferred with an owner decision.
- [ ] Human reviewer (Toby Tran) approves scope, action set, and open-question resolutions.

## Evidence

- 3 PNG renders generated via `npx playwright screenshot --full-page` (headless Chromium, Playwright 1.63.0), 2026-10-03.
- Manual visual check of all three renders: grouped candidate list and detail panel split two-column on desktop and stack to one column at and below 900px; state-review grid collapses from 4 to 2 columns at 820px via existing shared tokens; no raw message content, real addresses, or personal data anywhere on the page.
