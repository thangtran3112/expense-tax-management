# office-mailbox — NOTES (Phase 3D-A Task 4 feature gate)

Screen: Office Web `/mailbox` — connect/account/status/schedule/reviewer base. Phase 3D-B extends this same page with scan history and candidate review; Phase 3D-C extends it with ingestion status. This mockup covers only the Task 4 base scope.

Required: `mailbox-mobile-375.png`, `mailbox-tablet-768.png`, `mailbox-desktop-1440.png`. All three are full-page renders; each contains every scenario below stacked in one scrollable page (precedent: `../auth/auth.html`'s login/signup/forgot-password "route cards" in one file).

Source: local `mailbox.html` (standalone, no build step) + `mailbox.css` (feature-specific additions only; shared tokens reused from `../rebaseline/shared/tokens.css` for visual parity with the approved Office shell). Renders via `npx playwright screenshot --full-page` (headless Chromium), 2026-10-03.

## Scenario coverage (per task requirement)

1. No connection — connect CTA + explicit Personal/business scope radio selection; no scope is preselected and Connect stays disabled until one is chosen.
2. OAuth in progress / return — "waiting on Google" (external consent window) and "finishing connection" (post-redirect confirmation) shown as two adjacent frames.
3. Connected — account email, status chip, granted scope, default Personal/business scope, connection metadata, scan schedule (daily time/timezone/enable + manual "Scan now"), reviewer grants (empty-state base; add-reviewer reserved for 3D-B), and a reserved "Candidate review queue" placeholder so 3D-B/C can extend this layout without a redesign.
4. Revoked / error / reauthorization-needed — three distinct `role="alert"` banners: `reauth_required` (amber), `revoked` (red), and a generic failed-attempt error (red), matching the status enum in the Phase 3D design spec (`pending/active/paused/reauth_required/disconnecting/revocation_pending/revoked`).
5. Disconnect confirmation — `role="alertdialog"` with explicit consequence copy (access revoked immediately; ingested expenses and audit history retained) and Cancel/Disconnect actions.

No real email addresses, message content, or personal data: all copy uses `owner@example.com` and the existing fixture tenant name "Tran Studio" already used in `../rebaseline/office/index.html`.

## Accessibility

- Scope choice is a native `<fieldset>`/`role="radiogroup"` with per-option `<label>` wrapping; focus-visible ring inherited from `tokens.css`.
- Status/progress frames use `role="status" aria-live="polite"`; problem banners use `role="alert"`; the disconnect panel uses `role="alertdialog"` with `aria-labelledby`/`aria-describedby`.
- All controls are real `<button>`/`<input>`/`<select>` elements, ≥44px touch target per shared tokens.
- "Add reviewer" is marked `aria-disabled="true"` with a `title` explaining it's reserved for 3D-B, not a dead/unlabeled control.

## Owner decisions (approved 2026-10-03)

1. **Scope selection** — no radio is preselected; "Connect Gmail" renders `disabled`/`aria-disabled="true"` until Personal or business is explicitly chosen.
2. **Mailbox nav position** — stays between "Forwarding" and "Settings".
3. **Mobile posture** — `/mailbox` is usable on phones with the responsive stacked layout; no hand-off to Capture. Sidebar helper text and the state-review card no longer imply a hand-off.

## Deferred to Phase 3D-B

- **Candidate review placeholder sizing** — the reserved region remains a single empty card in this base mockup. 3D-B decides whether it needs a taller/table-shaped reservation when scan history and the candidate queue are designed.
- **OAuth-in-progress fidelity** — "waiting" and "return" remain static review frames; 3D-B/implementation may add in-app polling UI beyond what's shown here if needed.

## Sources

- `../../../docs/superpowers/specs/2026-09-12-phase-3d-connected-mailbox-design.md` (sibling worktree `.worktrees/phase-3d`) — scope/status/OAuth-flow/disconnect model.
- `../../../docs/superpowers/plans/2026-09-12-phase-3d-a-mailbox-broker.md` Task 4 — exact files/routes this page corresponds to.
- `../rebaseline/office/index.html`, `../rebaseline/office/NOTES.md`, `../rebaseline/shared/tokens.css` — visual language, shell, and token reuse.
- `../settings/NOTES.md` — prior note flagging "connected-mailbox configuration" as an Office later feature gate.
