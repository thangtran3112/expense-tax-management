# Mockups - Web UI Preflight (Phase 0F0)

> **Status:** Rebaseline approved 2026-09-09; Capture, Office, Foundry, and shared gates complete.
> Current approved source: `rebaseline/`. Root screen folders remain historical combined-app references only.
> Durable architecture: `../sub-plans/phase-0i-polyglot-platform-rebaseline-design.md` and `../sub-plans/phase-0f0-web-ui-mockups.md`.

## Viewport Intent

- **Capture PWA, mobile 375px**: receipt capture, business profile, camera recovery, offline queue, quick correction, forwarding address, and curated OCR mode.
- **Capture PWA, tablet 768px**: capture plus batch review; no dense reporting or tax filing preparation.
- **Office Web, laptop 1440px**: core dashboard, ledger, businesses, projects, tax preparation, exports, forwarding controls, and plans; later mailbox/search screens use feature-specific gates.
- **Foundry Web, laptop 1440px**: platform-only providers, models, curated routes, quotas, health, and audit.

Every folder now carries `mobile-375.png`, `tablet-768.png`, `desktop-1440.png`, and an HTML source. `mockup.css` contains shared tokens, focus/touch rules, safe-area insets, and authenticated shell styling.

## Folder Index

| Folder | Screen / Route | Files (HTML interactive + 3 viewport PNG renders) | Status |
|---|---|---|---|
| `auth/` | Legacy combined auth direction | Existing renders retained as reference | Rework/split required |
| `dashboard/` | Legacy mixed dashboard | Existing renders retained as reference | Move to Office Web |
| `upload/` | Capture and batch review | Existing renders retained as reference | Rework for business profile, curated modes, quotas, and forwarding |
| `expenses-list/` | Legacy mixed ledger | Existing renders retained as reference | Split PWA recents from Office ledger |
| `expense-detail/` | Legacy mixed detail/tax edit | Existing renders retained as reference | Split quick review from Office tax review |
| `projects/` | Legacy project tax summary | Existing renders retained as reference | Remove tax identity; move to Office project analysis |
| `categories/` | Legacy single taxonomy | Existing renders retained as reference | Separate spending and tax taxonomy views |
| `settings/` | Rejected tenant/provider administration mix | Existing renders retained as reference | Replace across three applications |
| `components/` | Legacy shared component gallery | Existing renders retained as reference | Split by application responsibility |
| `pwa-mobile/` | Capture PWA interaction reference | Existing renders retained as reference | Extend with profile, quota, and forwarding states |

## Conventions

- Naming: `<screen>-<viewport>.<ext>`, e.g. `dashboard-mobile-375.png`, `dashboard-tablet-768.png`, `dashboard-desktop-1440.png`.
- Dark mode default; mobile-375 is primary for capture, tablet-768 is primary for batch correction, desktop-1440 is primary for reporting/export.
- Each folder gets a `NOTES.md` with Figma/v0/Excalidraw source URLs + open questions.
- No application code or build artifacts — `.png`, `mockup.css`, and optional standalone `.html` only.

## Rebaseline Gate Index

- [x] **Capture gate -> Phase 0F**: Capture screen/state set approved at 375px and 768px.
- [x] **Office gate -> Phase 0M**: Office core set approved at 1024px and 1440px; no compressed mobile dashboard/tax UI.
- [x] **Foundry gate -> Phase 0N**: Platform-operator set approved at 1024px and 1440px.
- [x] Approved sets pass applicable shared role, boundary, accessibility, and failure-state checks from revised Phase 0F0.

**Review:** approved by Toby Tran on 2026-09-09. See `rebaseline/REVIEW.md`.

## Feature-Specific Gates

- [x] **Office mailbox gate -> Phase 3D-A Task 4**: connect/account/status/schedule/reviewer base for the connected-Gmail mailbox page; 1440/768/375 renders. **Approved by Toby Tran on 2026-10-03** — explicit scope choice required (no preselected radio, Connect disabled until chosen), Mailbox nav stays between Forwarding/Settings, `/mailbox` usable on mobile (no Capture hand-off). Candidate-review placeholder sizing deferred to Phase 3D-B. See `office-mailbox/REVIEW.md` and `office-mailbox/NOTES.md`.
- [x] **Office mailbox review gate -> Phase 3D-B Task 5**: candidate review queue extending the same `/mailbox` page — scan status/schedule, single-flight manual scan, candidate list grouped by classification, candidate detail with approve/skip/not-a-receipt decisions, empty/error/reauth states, explicit Personal/business scope indication; 1440/768/375 renders. **Approved by Toby Tran on 2026-10-03** — always-ignore-sender deferred as a future enhancement, dismiss split into Skip/Not a receipt, scan-running refresh is batch not streaming, reauth blocks scanning only (staged candidates stay reviewable). See `office-mailbox-review/REVIEW.md` and `office-mailbox-review/NOTES.md`.
- [ ] **Office mailbox ingestion gate -> Phase 3D-C Task 6**: ingestion status extending the same `/mailbox` page — per-candidate status after "Approve for ingestion" (queued, materializing, malware-scan pending/blocked, OCR in progress, ingested with expense link, duplicate detected with Duplicates-queue link, failed with scoped retry, unsupported/oversize attachment), plus a new "Source" section on the Office expense detail page (sender, received date, connected-mailbox scope — metadata only, never bodies); 1440/768/375 renders. **Status: pending owner approval** — see open questions in `office-mailbox-ingestion/REVIEW.md` and `office-mailbox-ingestion/NOTES.md`.

> Historical note: 30 legacy PNGs passed structural checks on 2026-09-06. That evidence does not approve the new three-application architecture.
