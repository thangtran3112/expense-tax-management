# Hub Pages (home, app pages, not-found)

> **Project:** Trading Hub. **Source:** ui-ux-pro-max (2026-10-04).
> Rules here override `../MASTER.md`. Everything not mentioned follows the Master.

The generated override (an 800px single column with AI-chat recommendations) did not fit an app launcher. This file replaces it with decisions checked against the skill's data:

| Decision | Source |
|---|---|
| Layout pattern | landing pattern `marketplace-directory` |
| Status badges | ux "Color Only" and "Compact Label Overflow" |
| Touch targets | ux "Touch Target Size" and "Touch Spacing" |
| Search empty state | ux "No Results" and "Empty States" |
| Fonts | nextjs stack rules: `next/font`, no external font links |

## Pattern: private app directory

Order:

1. Search-first intro.
2. Category filters.
3. App grid grouped by category.
4. "Coming next" roadmap cards.

No marketing sections: no hero image, logo wall, testimonials, or sales CTA. Adding a future app or tool means adding one registry entry; the page shape stays the same.

## Layout

- Content max width 1200px, centered, horizontal padding `--space-md` (16px), `--space-lg` (24px) from 768px.
- App grid: 1 column below 640px, 2 columns from 640px, 3 columns from 1024px. Gap `--space-md`.
- The page body is a `h-dvh` flex column. The header never overlaps content. App pages give the iframe all remaining height.
- No horizontal scroll at 375px.

## Header (every page)

- Sticky, 56px tall, `--color-background` with a 1px `--color-border` bottom border.
- Left: brand link to `/`. A 32px rounded tile in `--color-accent` holds the Lucide `CandlestickChart` icon in `--color-on-accent`, followed by the text "Trading Hub" (600 weight).
- On app pages, a breadcrumb follows the brand: `Hub / <App name>`.
- Right: an "Apps" disclosure button (Lucide `LayoutGrid` plus a visible label from 640px; aria-label always).
  - It opens a panel listing every app grouped by category, with icon, name, and status. Planned apps show as disabled items.
  - Keyboard: Enter/Space toggles, Escape closes and returns focus to the button. Clicking outside closes it.
  - The panel replaces the old flat nav list, so the header stays usable with many apps.
- A "Skip to content" link is the first focusable element.

## Home (`/`)

1. **Intro**
   - h1 "Trading Hub" and the subtitle "Open-source trading AI apps, exactly as their authors ship them, plus our own desk in release 2."
   - A search field with visible label "Search apps", a Lucide `Search` icon, 16px text (prevents iOS zoom), and a clear button (aria-label "Clear search") shown when non-empty.
   - Filtering is instant and client-side over name, summary, tags, and category label, case-insensitive.
2. **Category chips**
   - "All" plus each category in registry order, each with a count of matching apps.
   - Toggle buttons with `aria-pressed`, at least 44px tall, 8px gaps.
   - One active chip at a time; "All" is the default.
3. **Sections**
   - One `<section>` per category with at least one match.
   - h2 with the category label and a count (for example "Research and analysis · 2"), then the grid of app cards.
4. **Empty state**
   - When nothing matches: `No apps match "<query>"`, a suggestion line, and a "Clear filters" button that resets the search and the chip.
5. **Coming next**
   - Planned apps (status `planned`) in their own section after the categories.
   - Dashed-border cards that are not links, each with a status badge naming the release.

## App card

- The whole card is one link (`/apps/<slug>`). Planned cards are not links and carry `aria-disabled="true"`.
- Surface `--color-card`, 1px `--color-border`, radius 12px, padding `--space-lg`, minimum height 200px.
- Hover: border color moves toward the accent and the card lifts `translateY(-1px)`, transitions 150-200ms on color, border, and transform only.
- Focus-visible: 2px `--color-ring` outline with 2px offset.
- Content, top to bottom:
  1. A 40px icon tile (`--color-muted` background, Lucide icon, `aria-hidden`), then the name (h3, 18px, 600 weight) and a status badge on the same row.
  2. Summary: two lines, clamped.
  3. Tags: up to three chips; no wrapping; truncate with the full text in `title`.
  4. Footer row:
     - device hint, icon plus text: `Keyboard` "Keyboard recommended" or `Tablet` "Works on touch";
     - launch hint: `ArrowRight` "Open in hub" for terminal apps, `ExternalLink` "Opens in a new tab" for external apps.
- Status badge: always an icon plus text, never color alone.
  - `live`: a filled dot with "Live" in `--color-accent` on a translucent accent background.
  - `planned`: a Lucide `Clock` with the release name in `--color-muted-foreground`.

## App pages (`/apps/<slug>`)

- **Terminal apps.** A toolbar under the header shows:
  - the app icon, name, and status badge;
  - a "Reconnect" button (`RotateCw`, remounts the iframe);
  - an "Open in new tab" link (`ExternalLink`);
  - from 768px, the helper text "Closing this page keeps your session running."

  Toolbar buttons are at least 44px tall. The iframe (`title="<App> terminal"`) fills the remaining height on a black background.
- **External apps.** A centered card (max width 720px) holds:
  - the icon, name, status, and summary;
  - an ordered list "First visit in this browser" with the setup steps;
  - a primary accent button "Open <App>" (new tab, `rel="noopener"`);
  - the note "<App> opens in its own tab because it does not allow embedding in other pages."
- **Not found.** Unknown and planned slugs render a not-found page: the message "This app is not in the hub" and a link back to `/`.

## Registry contract (`lib/apps.ts`)

- `hubCategories` is an ordered list of `{ id, label }`. Initial entries:
  - `research`: "Research and analysis" (TradingAgents, Vibe-Trading);
  - `funds`: "Funds and backtesting" (AI Hedge Fund);
  - `desk`: "Family desk" (Family Desk, planned).
- Each `HubApp` has:
  - `slug`, `name`, `summary`, `category` (a category id), `status` (`live` or `planned`);
  - `tags` (string list), `icon` (a key of a small Lucide icon map), `device` (`keyboard` or `touch`);
  - `goodFor` and `costNote`;
  - the kind-specific fields that exist today (`terminalPath`; `url` and `firstVisitNote`; `release`).
- Routes, static params, `dynamicParams = false`, iframe paths, and `NEXT_PUBLIC_VIBE_TRADING_URL` behave exactly as today.

## Implementation notes (Next.js 16, Tailwind 4)

- **Tokens:** the Master colors become Tailwind v4 `@theme` variables in `app/globals.css` (`--color-background`, `--color-card`, `--color-muted`, `--color-muted-foreground`, `--color-border`, `--color-accent`, `--color-on-accent`, `--color-ring`, `--color-destructive`). Components use the generated utilities (`bg-card`, `text-muted-foreground`, `border-border`, `bg-accent`); no raw hex in components.
- **Font:** Inter variable, self-hosted with `next/font/local` from the `@fontsource-variable/inter` package's latin woff2 file, applied on `<body>` in `layout.tsx`. No external font links, so offline builds keep working.
- **Icons:** `lucide-react`. The skill's icon dataset returned no verified match for this product (two queries), so this uses the Master checklist's named default (Lucide). Decorative icons get `aria-hidden`; icon-only controls get `aria-label`.
- **Motion:** CSS only. 150-250ms ease-out on color, border, opacity, and transform. Under `prefers-reduced-motion: reduce`, drop transforms. No animation library.
- **Accessibility:**
  - text contrast at least 4.5:1 (muted foreground `#94A3B8` on card `#0E1223` is about 6.6:1);
  - visible focus on every control;
  - landmarks `header`, `nav` (Apps panel), `main`;
  - one h1 per page.
- **Responsive checks:** 375, 768, 1024, and 1440px wide.
