# Office Mailbox Ingestion Status Gate — Phase 3D-C Task 6

- Prepared: 2026-10-03
- Scope: `ingestion.html`, `ingestion.css`, `ingestion-mobile-375.png`, `ingestion-tablet-768.png`, `ingestion-desktop-1440.png`, `NOTES.md`
- **Status: Approved**
- Verdict: **Approved by Toby Tran on 2026-10-03**, as drafted, with the decisions below.

## What this covers

Office Web `/mailbox` ingestion-status region, extending the approved Phase 3D-A base (`../office-mailbox/`) and Phase 3D-B candidate review (`../office-mailbox-review/`) per the Phase 3D-C plan Task 6: per-candidate ingestion status after "Approve for ingestion" (queued, materializing, malware-scan pending, malware-scan blocked, OCR in progress, ingested with a link to the created expense, duplicate detected with a link to the existing Duplicates queue, failed with a scoped retry, unsupported/oversize attachment), plus a new "Source" block on the existing Office expense detail page showing connected-mailbox provenance (sender, received date, scope) — metadata only, never message bodies.

## Design/mockup only

No application code was written or modified. This folder contains static HTML/CSS and PNG renders only, per `../README.md`'s conventions. `frontend/office-web` (expense detail and duplicates pages) was read for interaction-pattern and structural reference, not edited.

## Owner decisions (2026-10-03)

1. **Malware-scan blocked is a dead end.** Shows the reason and a `Dismiss` action only — no retry, no download.
2. **Duplicate-detected links to the existing `/duplicates` review queue**, not a mailbox-specific view.
3. **No shortened opaque IDs on rows.** Status text only; candidate/job IDs sit inside a per-row "Support details" disclosure with Copy buttons, for support use.
4. **Retry's 409/stale-candidate conflict reuses the candidate-review pattern inline** — an inline `role="alert"` banner on the affected row, same stale-refresh handling as candidate review and the Duplicates queue.
5. **Retention/pagination reuses the review-queue cursor pattern** — each status group gets its own cursor + "Load more" footer, the same per-group pattern approved for 3D-B candidate classification groups.
6. **Expense-detail "Source" block placement follows the existing page's convention** — inside the current "Expense details" panel, after Date/Merchant/Amount/Status and tags, before the pending-suggestions panel.

Full rationale and sourcing for all six decisions is in `NOTES.md` → "Owner decisions (approved 2026-10-03)".

## Sign-off checklist

- [x] Covers all nine states: queued, materializing, malware-scan pending, malware-scan blocked (dead end + Dismiss), OCR in progress, ingested (expense link), duplicate detected (`/duplicates` link), failed (scoped retry, including a stale-conflict variant), unsupported/oversize attachment.
- [x] Expense-detail provenance block covers sender, received date, and connected-mailbox scope; explicitly states metadata-only (no body/attachment content); IDs moved to a support-only disclosure; placed per the existing page's panel order.
- [x] Desktop (1440) and mobile (375) renders present; tablet (768) included as a bonus third viewport.
- [x] Accessible roles/labels on every interactive control and status region (see `NOTES.md` → Accessibility).
- [x] No real email addresses, message bodies, or personal data.
- [x] Visual language matches the approved Office shell and the 3D-A/3D-B mailbox gates (`../office-mailbox/mailbox.css`, `../office-mailbox-review/review.css`, `../rebaseline/shared/tokens.css` reused, not duplicated).
- [x] All open questions from the prior draft resolved and recorded as Owner decisions above.
- [x] Human reviewer (Toby Tran) approved scope, states, and link targets — 2026-10-03.

## Evidence

- 3 PNG renders regenerated via `npx playwright screenshot --full-page` (headless Chromium, Playwright 1.63.0) after the 2026-10-03 decision changes (IDs moved into "Support details" disclosures; malware-blocked row given a `Dismiss`-only action; duplicate links pointed at `/duplicates`; a stale-conflict `Retry` variant and per-group "Load more" footers added).
- Manual visual check of all three renders: no visible candidate/job IDs on any row by default; malware-blocked row shows only `Dismiss`; both duplicate links point to `/duplicates`; the conflict alert renders inline on its row at all three viewports; group footers wrap cleanly on mobile.
