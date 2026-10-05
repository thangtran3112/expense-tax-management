import type { LucideIcon } from "lucide-react";
import { Bot, LineChart, MessagesSquare, Rocket } from "lucide-react";

export const hubCategories = [
  { id: "research", label: "Research and analysis" },
  { id: "funds", label: "Funds and backtesting" },
  { id: "desk", label: "Family desk" },
] as const;

export type CategoryId = (typeof hubCategories)[number]["id"];

export type AppIconKey = "tradingAgents" | "hedgeFund" | "vibeTrading" | "familyDesk";

export const appIcons: Record<AppIconKey, LucideIcon> = {
  tradingAgents: Bot,
  hedgeFund: LineChart,
  vibeTrading: MessagesSquare,
  familyDesk: Rocket,
};

type BaseApp = {
  slug: string;
  name: string;
  summary: string;
  category: CategoryId;
  tags: readonly string[];
  icon: AppIconKey;
  device: "keyboard" | "touch";
  goodFor: string;
  costNote: string;
};

export type PlannedApp = BaseApp & { kind: "planned"; status: "planned"; release: string };
export type TerminalApp = BaseApp & { kind: "terminal"; status: "live"; terminalPath: `/u/${string}/` };
export type ExternalApp = BaseApp & {
  kind: "external";
  status: "live";
  url: string;
  firstVisitNote: readonly string[];
};
export type HubApp = PlannedApp | TerminalApp | ExternalApp;

const vibeTradingUrl = process.env.NEXT_PUBLIC_VIBE_TRADING_URL ?? "https://vibe-trading.tobytran.dev";

export const hubApps: readonly HubApp[] = [
  {
    slug: "tradingagents",
    kind: "terminal",
    status: "live",
    terminalPath: "/u/tradingagents/",
    name: "TradingAgents",
    category: "research",
    tags: ["Multi-agent debate", "Single ticker", "Written report"],
    icon: "tradingAgents",
    device: "keyboard",
    summary: "A team of AI analysts debates one ticker and returns Buy, Hold, or Sell with a written report.",
    goodFor: "A deep second opinion on one stock before a trade.",
    costNote: "Each analysis makes dozens of LLM calls; the app's own provider spend limit caps the month.",
  },
  {
    slug: "ai-hedge-fund",
    kind: "terminal",
    status: "live",
    terminalPath: "/u/ai-hedge-fund/",
    name: "AI Hedge Fund",
    category: "funds",
    tags: ["Investor personas", "Backtests", "Paid data key"],
    icon: "hedgeFund",
    device: "keyboard",
    summary:
      "Investor personas (Buffett, Munger, Graham, Lynch, Druckenmiller) and quant models run a simulated fund with backtests and a paper book.",
    goodFor: "Testing value and growth ideas against history.",
    costNote: "Needs a paid Financial Datasets key for market data, plus LLM usage under the app's spend limit.",
  },
  {
    slug: "vibe-trading",
    kind: "external",
    status: "live",
    url: vibeTradingUrl,
    name: "Vibe-Trading",
    category: "research",
    tags: ["Natural language", "Strategy backtests", "Skill library"],
    icon: "vibeTrading",
    device: "touch",
    summary: "A research agent you talk to in plain English, with charts, strategy backtests, and a large skill library.",
    goodFor: "Exploring an idea or backtesting a strategy described in words.",
    costNote: "LLM usage under the app's spend limit; market data from free sources.",
    firstVisitNote: [
      "Open Settings.",
      "Find Local API access.",
      "Paste the Vibe-Trading access key into Server API key.",
      "Save it; the key is stored with the other ai-trading secrets.",
    ],
  },
  {
    slug: "desk",
    kind: "planned",
    status: "planned",
    release: "Release 2",
    name: "Family Desk",
    category: "desk",
    tags: ["Morning scan", "Covered calls", "Alerts"],
    icon: "familyDesk",
    device: "touch",
    summary: "Our own assistant: morning scan, covered-call scan, alerts, and chat.",
    goodFor: "Daily habits for both of us, built on the best ideas from the other three apps.",
    costNote: "Not built yet.",
  },
];

export function findApp(slug: string): HubApp | undefined {
  return hubApps.find((app) => app.slug === slug);
}
