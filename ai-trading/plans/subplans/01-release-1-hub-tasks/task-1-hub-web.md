# Task 1: Hub Web App

Part of [01-release-1-hub-plan.md](../01-release-1-hub-plan.md). Read its Global Constraints and Shared Interfaces first.

**Owned paths:** `ai-trading/frontend/**` only. Do not run `git add`, `git commit`, or `git push`.

**Files:**
- Create (scaffold): `ai-trading/frontend/` via create-next-app
- Create: `lib/apps.ts`, `components/nav-bar.tsx`, `components/app-card.tsx`, `components/terminal-frame.tsx`, `app/apps/[slug]/page.tsx`, `Dockerfile`, `.dockerignore`
- Replace: `app/layout.tsx`, `app/page.tsx`, `app/globals.css`, `next.config.ts`
- Delete: `public/`, `README.md`, and any generated `AGENTS.md` or `CLAUDE.md`

**Interfaces:**
- Consumes: nothing.
- Produces: an image from `ai-trading/frontend/Dockerfile` serving port 3000 (build arg `NEXT_PUBLIC_VIBE_TRADING_URL`). Routes `/`, `/apps/tradingagents`, `/apps/ai-hedge-fund`, `/apps/vibe-trading` return 200; `/apps/desk` and unknown slugs return 404. Terminal pages embed `/u/tradingagents/` and `/u/ai-hedge-fund/`.

- [ ] **Step 1: Scaffold the app**

```bash
cd ai-trading
pnpm dlx create-next-app@16 frontend --ts --tailwind --eslint --app --import-alias "@/*" --use-pnpm --skip-install --disable-git --yes
cd frontend
rm -rf public README.md AGENTS.md CLAUDE.md
npm pkg set name=@ai-trading/frontend packageManager=pnpm@11.9.0 "engines.node=>=22.0.0" "scripts.lint=eslint ." "scripts.typecheck=tsc --noEmit"
npm pkg set private=true --json
pnpm install
```

Expected: `pnpm install` completes and writes `pnpm-lock.yaml`. If pnpm reports ignored build scripts, approve only the ones `next build` needs (`pnpm approve-builds`) and record them in your report.

- [ ] **Step 2: Write `next.config.ts`**

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
};

export default nextConfig;
```

- [ ] **Step 3: Write `lib/apps.ts`**

```ts
type BaseApp = {
  slug: string;
  name: string;
  summary: string;
  goodFor: string;
  costNote: string;
  deviceHint: string;
};

export type PlannedApp = BaseApp & { kind: "planned"; release: string };
export type TerminalApp = BaseApp & { kind: "terminal"; terminalPath: `/u/${string}/` };
export type ExternalApp = BaseApp & { kind: "external"; url: string; firstVisitNote: string };
export type HubApp = PlannedApp | TerminalApp | ExternalApp;

const vibeTradingUrl = process.env.NEXT_PUBLIC_VIBE_TRADING_URL ?? "https://vibe-trading.tobytran.dev";

export const hubApps: readonly HubApp[] = [
  {
    slug: "desk",
    kind: "planned",
    release: "Release 2",
    name: "Family Desk",
    summary: "Our own assistant: morning scan, covered-call scan, alerts, and chat.",
    goodFor: "Daily habits for both of us, built on the best ideas from the other three apps.",
    costNote: "Not built yet.",
    deviceHint: "Coming in release 2.",
  },
  {
    slug: "tradingagents",
    kind: "terminal",
    terminalPath: "/u/tradingagents/",
    name: "TradingAgents",
    summary: "A team of AI analysts debates one ticker and returns Buy, Hold, or Sell with a written report.",
    goodFor: "A deep second opinion on one stock before a trade.",
    costNote: "Each analysis makes dozens of LLM calls; the app's own provider spend limit caps the month.",
    deviceHint: "Terminal app: best with a keyboard.",
  },
  {
    slug: "ai-hedge-fund",
    kind: "terminal",
    terminalPath: "/u/ai-hedge-fund/",
    name: "AI Hedge Fund",
    summary: "Investor personas (Buffett, Munger, Graham, Lynch, Druckenmiller) and quant models run a simulated fund with backtests and a paper book.",
    goodFor: "Testing value and growth ideas against history.",
    costNote: "Needs a paid Financial Datasets key for market data, plus LLM usage under the app's spend limit.",
    deviceHint: "Terminal app: best with a keyboard.",
  },
  {
    slug: "vibe-trading",
    kind: "external",
    url: vibeTradingUrl,
    firstVisitNote: "On the first visit in each browser, paste the Vibe-Trading access key when it asks. The key is stored with the other ai-trading secrets.",
    name: "Vibe-Trading",
    summary: "A research agent you talk to in plain English, with charts, strategy backtests, and a large skill library.",
    goodFor: "Exploring an idea or backtesting a strategy described in words.",
    costNote: "LLM usage under the app's spend limit; market data from free sources.",
    deviceHint: "Opens in its own tab; works on any device.",
  },
];

export function findApp(slug: string): HubApp | undefined {
  return hubApps.find((app) => app.slug === slug);
}
```

- [ ] **Step 4: Write `components/nav-bar.tsx`**

```tsx
import Link from "next/link";
import { hubApps } from "@/lib/apps";

export function NavBar() {
  return (
    <header className="border-b border-slate-800 bg-slate-950">
      <nav className="mx-auto flex max-w-6xl items-center gap-4 overflow-x-auto px-4 py-3 text-sm">
        <Link href="/" className="font-semibold whitespace-nowrap text-white">
          Trading Hub
        </Link>
        {hubApps.map((app) =>
          app.kind === "planned" ? (
            <span key={app.slug} className="whitespace-nowrap text-slate-500">
              {app.name} <span className="text-xs">({app.release.toLowerCase()})</span>
            </span>
          ) : (
            <Link key={app.slug} href={`/apps/${app.slug}`} className="whitespace-nowrap text-slate-300 hover:text-white">
              {app.name}
            </Link>
          ),
        )}
      </nav>
    </header>
  );
}
```

- [ ] **Step 5: Write `components/app-card.tsx`**

```tsx
import Link from "next/link";
import type { HubApp } from "@/lib/apps";

export function AppCard({ app }: { app: HubApp }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">{app.name}</h2>
        {app.kind === "planned" && (
          <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{app.release}</span>
        )}
      </div>
      <p className="mt-2 text-sm text-slate-300">{app.summary}</p>
      <dl className="mt-4 space-y-1 text-xs text-slate-400">
        <div>
          <dt className="inline font-medium text-slate-300">Good for: </dt>
          <dd className="inline">{app.goodFor}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-300">Cost: </dt>
          <dd className="inline">{app.costNote}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-slate-300">Device: </dt>
          <dd className="inline">{app.deviceHint}</dd>
        </div>
      </dl>
    </>
  );
  const base = "block rounded-lg border border-slate-800 bg-slate-900 p-5";
  if (app.kind === "planned") {
    return (
      <div aria-disabled="true" className={`${base} opacity-60`}>
        {body}
      </div>
    );
  }
  return (
    <Link href={`/apps/${app.slug}`} className={`${base} hover:border-slate-600`}>
      {body}
    </Link>
  );
}
```

- [ ] **Step 6: Write `components/terminal-frame.tsx`**

```tsx
"use client";

import { useState } from "react";

export function TerminalFrame({ name, src }: { name: string; src: string }) {
  const [connection, setConnection] = useState(0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-2 text-sm">
        <span className="font-medium text-white">{name}</span>
        <button
          type="button"
          onClick={() => setConnection((n) => n + 1)}
          className="rounded border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800"
        >
          Reconnect
        </button>
        <a href={src} target="_blank" rel="noopener" className="rounded border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800">
          Open in new tab
        </a>
        <span className="ml-auto hidden text-xs text-slate-500 sm:inline">
          Closing this page keeps your session running. Reconnect picks it up.
        </span>
      </div>
      <iframe key={connection} src={src} title={`${name} terminal`} className="min-h-0 w-full flex-1 border-0 bg-black" />
    </div>
  );
}
```

- [ ] **Step 7: Replace `app/globals.css`**

```css
@import "tailwindcss";

:root {
  color-scheme: dark;
}
```

- [ ] **Step 8: Replace `app/layout.tsx` (no `next/font`, so builds never fetch fonts)**

```tsx
import type { Metadata } from "next";
import { NavBar } from "@/components/nav-bar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trading Hub",
  description: "Private family hub for AI trading apps.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="flex h-dvh flex-col bg-slate-950 text-slate-100 antialiased">
        <NavBar />
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</main>
      </body>
    </html>
  );
}
```

- [ ] **Step 9: Replace `app/page.tsx`**

```tsx
import { AppCard } from "@/components/app-card";
import { hubApps } from "@/lib/apps";

export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-white">Trading Hub</h1>
      <p className="mt-1 text-sm text-slate-400">
        Three open-source trading AI apps, exactly as their authors ship them, plus our own desk in release 2.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {hubApps.map((app) => (
          <AppCard key={app.slug} app={app} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 10: Write `app/apps/[slug]/page.tsx`**

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TerminalFrame } from "@/components/terminal-frame";
import { findApp, hubApps } from "@/lib/apps";

export const dynamicParams = false;

export function generateStaticParams() {
  return hubApps.filter((app) => app.kind !== "planned").map((app) => ({ slug: app.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${findApp(slug)?.name ?? "App"} | Trading Hub` };
}

export default async function AppPage({ params }: Props) {
  const { slug } = await params;
  const app = findApp(slug);
  if (!app || app.kind === "planned") notFound();
  if (app.kind === "terminal") return <TerminalFrame name={app.name} src={app.terminalPath} />;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-white">{app.name}</h1>
      <p className="mt-2 text-slate-300">{app.summary}</p>
      <p className="mt-4 text-sm text-slate-400">{app.firstVisitNote}</p>
      <a
        href={app.url}
        target="_blank"
        rel="noopener"
        className="mt-6 inline-block rounded bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500"
      >
        Open {app.name}
      </a>
      <p className="mt-6 text-xs text-slate-500">{app.name} opens in its own tab because it does not allow embedding in other pages.</p>
    </div>
  );
}
```

- [ ] **Step 11: Write `Dockerfile`**

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG NEXT_PUBLIC_VIBE_TRADING_URL=https://vibe-trading.tobytran.dev
ENV NEXT_PUBLIC_VIBE_TRADING_URL=$NEXT_PUBLIC_VIBE_TRADING_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
USER app
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 12: Write `.dockerignore`**

```gitignore
node_modules
.next
Dockerfile
.dockerignore
```

- [ ] **Step 13: Run the app checks**

```bash
cd ai-trading/frontend
pnpm lint && pnpm typecheck && pnpm build
```

Expected: all three succeed. The build output lists `/apps/[slug]` with three prerendered paths.

- [ ] **Step 14: Run the container checks (from the repository root)**

```bash
docker build -t ai-trading/web:check ai-trading/frontend
docker run -d --rm --name hub-check -p 127.0.0.1:13000:3000 ai-trading/web:check
sleep 3
for path in / /apps/tradingagents /apps/ai-hedge-fund /apps/vibe-trading /apps/desk /apps/unknown; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:13000$path")" "$path"
done
curl -s http://127.0.0.1:13000/apps/tradingagents | grep -o '/u/tradingagents/' | head -1
curl -s http://127.0.0.1:13000/apps/vibe-trading | grep -o 'https://vibe-trading.tobytran.dev' | head -1
docker rm -f hub-check
```

Expected: `200` for the first four paths and `404` for `/apps/desk` and `/apps/unknown`. Then the lines `/u/tradingagents/` and `https://vibe-trading.tobytran.dev`.
