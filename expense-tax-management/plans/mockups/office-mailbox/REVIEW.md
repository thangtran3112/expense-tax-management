# Office Mailbox Gate — Phase 3D-A Task 4

- Prepared: 2026-10-03
- Scope: `mailbox.html`, `mailbox.css`, `mailbox-mobile-375.png`, `mailbox-tablet-768.png`, `mailbox-desktop-1440.png`, `NOTES.md`
- **Status: pending owner approval**
- Verdict: _not yet reviewed_

## What this covers

Office Web `/mailbox` base page per the revised Phase 3D spec and Phase 3D-A plan Task 4: connect-Gmail CTA with explicit Personal/business scope selection, OAuth in-progress/return, connected account/status/schedule/reviewer-grants base, reauthorization-needed/revoked/error states, and disconnect confirmation. Candidate review queue and scan history are reserved placeholders only — those ship with Phase 3D-B and extend this same page per the plan's ownership model.

## Design/mockup only

No application code was written or modified. This folder contains static HTML/CSS and PNG renders only, per `../README.md`'s conventions.

## Decisions baked into this mockup (confirm or override)

- Mailbox sits in the Office sidebar between Forwarding and Settings.
- Scope selector defaults to "Personal" (no scope pre-selected would also be defensible).
- Mobile (375px) renders a stacked, usable layout rather than a hand-off notice, despite Office's laptop-first posture elsewhere in `../rebaseline/`.
- Reauthorization, revocation, and error are three visually distinct banners, not one generic "problem" state.

## Open questions

See `NOTES.md` → "Open questions for owner review" (5 items: nav position, mobile posture, OAuth-progress fidelity, scope default, candidate-queue placeholder sizing).

## Sign-off checklist

- [x] Covers all 6 required states (no connection, OAuth in progress, OAuth return, connected, reauth/revoked/error, disconnect confirmation).
- [x] Desktop (1440) and mobile (375) renders present; tablet (768) included as a bonus third viewport.
- [x] Accessible roles/labels on every interactive control and status region (see NOTES.md → Accessibility).
- [x] No real email addresses, message content, or personal data; fixture matches existing `Tran Studio` tenant used elsewhere in `../rebaseline/`.
- [x] Visual language matches the approved Office shell (`../rebaseline/shared/tokens.css` reused, not duplicated).
- [ ] Human reviewer (Toby Tran) approves scope coverage, open questions, and nav placement.

## Evidence

- 3 PNG renders regenerated via `npx playwright screenshot --full-page` (headless Chromium, Chrome for Testing 153.0.8010.12), 2026-10-03.
- Manual visual check of all three renders for overlap/collision/contrast; no issues found. The fixed mobile bottom nav appears once at its pinned position in the full-page mobile render, which is expected screenshot behavior for `position: fixed` elements, not a layout bug.
