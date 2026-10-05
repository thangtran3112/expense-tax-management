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
    firstVisitNote: "On the first visit in each browser, open Settings, find Local API access, paste the Vibe-Trading access key into Server API key, and save. The key is stored with the other ai-trading secrets.",
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
