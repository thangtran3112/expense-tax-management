import type { LucideIcon } from "lucide-react";
import { Bot, Fish, LineChart, MessagesSquare, Rocket } from "lucide-react";

export const hubCategories = [
  { id: "research", label: "Research and analysis" },
  { id: "funds", label: "Funds and backtesting" },
  { id: "simulation", label: "Simulation lab" },
  { id: "desk", label: "Family desk" },
] as const;

export type CategoryId = (typeof hubCategories)[number]["id"];

export type AppIconKey = "tradingAgents" | "hedgeFund" | "vibeTrading" | "familyDesk" | "mirofish";

export const appIcons: Record<AppIconKey, LucideIcon> = {
  tradingAgents: Bot,
  hedgeFund: LineChart,
  vibeTrading: MessagesSquare,
  familyDesk: Rocket,
  mirofish: Fish,
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
export type TerminalApp = BaseApp & {
  kind: "terminal";
  status: "live";
  terminalPath: `/u/${string}/`;
  hostUrl: `https://${string}/`;
};
export type ExternalApp = BaseApp & {
  kind: "external";
  status: "live";
  url: string;
  firstVisitNote: readonly string[];
};
export type UpstreamSetupApp = BaseApp & {
  kind: "upstream-setup";
  status: "setup-required";
  sourceUrl: string;
  licenseUrl: string;
  pinnedCommit: string;
  requiredKeys: readonly string[];
};
export type HubApp = PlannedApp | TerminalApp | ExternalApp | UpstreamSetupApp;

const vibeTradingUrl = process.env.NEXT_PUBLIC_VIBE_TRADING_URL ?? "https://vibe-trading.tobytran.dev";

export const hubApps: readonly HubApp[] = [
  {
    slug: "tradingagents",
    kind: "terminal",
    status: "live",
    terminalPath: "/u/tradingagents/",
    hostUrl: "https://tradingagents.tobytran.dev/",
    name: "TradingAgents",
    category: "research",
    tags: ["Multi-agent debate", "Single ticker", "Written report"],
    icon: "tradingAgents",
    device: "keyboard",
    summary: "A team of AI analysts debates one ticker and returns Buy, Hold, or Sell with a written report.",
    goodFor: "A deep second opinion on one stock before a trade.",
    costNote: "Each analysis makes dozens of LLM calls; every call is billed to the family provider keys (no spend limit set).",
  },
  {
    slug: "ai-hedge-fund",
    kind: "terminal",
    status: "live",
    terminalPath: "/u/ai-hedge-fund/",
    hostUrl: "https://ai-hedge-fund.tobytran.dev/",
    name: "AI Hedge Fund",
    category: "funds",
    tags: ["Investor personas", "Backtests", "Paid data key"],
    icon: "hedgeFund",
    device: "keyboard",
    summary:
      "Investor personas (Buffett, Munger, Graham, Lynch, Druckenmiller) and quant models run a simulated fund with backtests and a paper book.",
    goodFor: "Testing value and growth ideas against history.",
    costNote: "Needs a paid Financial Datasets key for market data, plus LLM usage billed to the family provider keys.",
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
    costNote: "LLM usage billed to the family provider keys; market data from free sources.",
    firstVisitNote: ["Nothing to set up: your hub sign-in also signs you in to Vibe-Trading."],
  },
  {
    slug: "mirofish",
    kind: "upstream-setup",
    status: "setup-required",
    name: "MiroFish",
    category: "simulation",
    tags: ["Multi-agent simulation", "Upload to report", "Experimental"],
    icon: "mirofish",
    device: "touch",
    summary:
      "Experimental simulation lab: upload source material and watch thousands of AI agents with independent memory interact in a digital sandbox, then read a report. Financial prediction is not shipped upstream yet.",
    goodFor: "Trying the original MiroFish simulator — not stock, futures, or broker analysis.",
    costNote: "Needs a Zep Cloud free-tier key and an OpenAI-compatible LLM key, both kept server-side.",
    sourceUrl: "https://github.com/666ghj/MiroFish/tree/7657031ac01184afe2cb220f5ee3545573b5e843",
    licenseUrl: "https://github.com/666ghj/MiroFish/blob/7657031ac01184afe2cb220f5ee3545573b5e843/LICENSE",
    pinnedCommit: "7657031ac01184afe2cb220f5ee3545573b5e843",
    requiredKeys: ["ZEP_API_KEY", "LLM_API_KEY"],
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
