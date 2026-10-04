# Office Mailbox Ingestion Status Gate — Phase 3D-C Task 6

- Prepared: 2026-10-03
- Scope: `ingestion.html`, `ingestion.css`, `ingestion-mobile-375.png`, `ingestion-tablet-768.png`, `ingestion-desktop-1440.png`, `NOTES.md`
- **Status: Pending owner approval**
- Verdict: **Not yet reviewed.** Drafted for Toby Tran to approve or redirect before any Task 6 UI implementation starts.

## What this covers

Office Web `/mailbox` ingestion-status region, extending the approved Phase 3D-A base (`../office-mailbox/`) and Phase 3D-B candidate review (`../office-mailbox-review/`) per the Phase 3D-C plan Task 6: per-candidate ingestion status after "Approve for ingestion" (queued, materializing, malware-scan pending, malware-scan blocked, OCR in progress, ingested with a link to the created expense, duplicate detected with a link to the existing Duplicates queue, failed with a scoped retry, unsupported/oversize attachment), plus a new "Source" section on the existing Office expense detail page showing connected-mailbox provenance (sender, received date, scope) — metadata only, never message bodies.

## Design/mockup only

No application code was written or modified. This folder contains static HTML/CSS and PNG renders only, per `../README.md`'s conventions. `frontend/office-web` (expense detail and duplicates pages) was read for interaction-pattern and structural reference, not edited.

## Open questions

1. **Malware-scan-blocked — any user-facing next step?** The mockup shows this as a dead end ("source message must be re-sent or handled outside Office," no Retry). Is silence correct per the design's no-rollback model, or should Office offer a "Contact support" / "Mark reviewed" action?
2. **Duplicate-detected link target.** The mockup links "Review duplicate match" to the existing `/duplicates` queue (reusing its page, not a mailbox-specific view). Confirm that's the intended destination rather than a new mailbox-scoped duplicate panel.
3. **Retry conflict handling.** The mockup notes Retry should follow the same stale-candidate-version/409 pattern as candidate review (Scenario 6), but doesn't render the conflict state inline. Confirm that reuse is correct, or whether Retry needs its own visible conflict/refresh UI.
4. **Row retention/pagination.** How long do completed/failed ingestion rows stay visible on `/mailbox`, and do they need the same cursor + "Load more" pattern as the Duplicates queue and 3D-B candidate groups, or a time-bounded view (e.g., "last 7 days")?
5. **Expense-detail "Source" section placement.** Mocked as a new section below the existing expense header fields. Confirm placement (top vs. secondary section) against the real page's current layout before implementation.
6. **Opaque ID display.** The mockup shows shortened IDs (e.g. `cand_8f21…b309`, `job_51ae…2b7f`) to owners/reviewers. Confirm these are acceptable in production copy, or whether Office should show zero internal IDs and rely on status text alone.

## Sign-off checklist (to confirm on approval)

- [ ] Covers all nine states: queued, materializing, malware-scan pending, malware-scan blocked, OCR in progress, ingested (expense link), duplicate detected (duplicate-queue link), failed (scoped retry), unsupported/oversize attachment.
- [ ] Expense-detail provenance section covers sender, received date, and connected-mailbox scope; explicitly states metadata-only (no body/attachment content).
- [ ] Desktop (1440) and mobile (375) renders present; tablet (768) included as a bonus third viewport.
- [ ] Accessible roles/labels on every interactive control and status region (see `NOTES.md` → Accessibility).
- [ ] No real email addresses, message bodies, or personal data.
- [ ] Visual language matches the approved Office shell and the 3D-A/3D-B mailbox gates (`../office-mailbox/mailbox.css`, `../office-mailbox-review/review.css`, `../rebaseline/shared/tokens.css` reused, not duplicated).
- [ ] All open questions above resolved and recorded.
- [ ] Human reviewer (Toby Tran) approves scope, states, and link targets.

## Evidence

- 3 PNG renders via `npx playwright screenshot --full-page` (headless Chromium, Playwright 1.63.0), 2026-10-03.
