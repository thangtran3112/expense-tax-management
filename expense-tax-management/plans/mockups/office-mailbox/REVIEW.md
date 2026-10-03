# Office Mailbox Gate — Phase 3D-A Task 4

- Prepared: 2026-10-03
- Scope: `mailbox.html`, `mailbox.css`, `mailbox-mobile-375.png`, `mailbox-tablet-768.png`, `mailbox-desktop-1440.png`, `NOTES.md`
- **Status: Approved**
- Verdict: **Approved by Toby Tran on 2026-10-03**, as drafted, with the decisions below.

## What this covers

Office Web `/mailbox` base page per the revised Phase 3D spec and Phase 3D-A plan Task 4: connect-Gmail CTA with explicit Personal/business scope selection, OAuth in-progress/return, connected account/status/schedule/reviewer-grants base, reauthorization-needed/revoked/error states, and disconnect confirmation. Candidate review queue and scan history are reserved placeholders only — those ship with Phase 3D-B and extend this same page per the plan's ownership model.

## Design/mockup only

No application code was written or modified. This folder contains static HTML/CSS and PNG renders only, per `../README.md`'s conventions.

## Owner decisions (2026-10-03)

1. **Scope selection** — force an explicit Personal-or-business choice. No radio is preselected; "Connect Gmail" renders disabled until a scope is chosen. Mockup and renders updated to match.
2. **Sidebar** — Mailbox stays between "Forwarding" and "Settings". Already matched; no change needed.
3. **Mobile** — `/mailbox` is usable in Office with the responsive stacked layout at 375px; no hand-off to Capture. Already matched in layout; sidebar helper copy updated to remove the stale "hand off to Capture" wording.

## Deferred to Phase 3D-B

- Candidate review placeholder sizing (currently one empty reserved card; 3D-B decides final shape).
- OAuth-in-progress in-app fidelity beyond the two static review frames shown here.

## Sign-off checklist

- [x] Covers all 6 required states (no connection, OAuth in progress, OAuth return, connected, reauth/revoked/error, disconnect confirmation).
- [x] Desktop (1440) and mobile (375) renders present; tablet (768) included as a bonus third viewport.
- [x] Accessible roles/labels on every interactive control and status region (see NOTES.md → Accessibility).
- [x] No real email addresses, message content, or personal data.
- [x] Visual language matches the approved Office shell (`../rebaseline/shared/tokens.css` reused, not duplicated).
- [x] Scope selection forces explicit choice; Connect disabled until chosen.
- [x] Mobile renders a usable, responsive `/mailbox` page; no Capture hand-off language remains.
- [x] Human reviewer (Toby Tran) approved scope coverage, decisions, and nav placement — 2026-10-03.

## Evidence

- 3 PNG renders regenerated via `npx playwright screenshot --full-page` (headless Chromium, Chrome for Testing 153.0.8010.12) after the 2026-10-03 scope/disabled-button and mobile-copy changes.
- Manual visual check of all three renders: no preselected scope radio, Connect Gmail visibly disabled, sidebar/footer copy no longer references a Capture hand-off, Mailbox nav item between Forwarding and Settings confirmed.
