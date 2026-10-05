"use client";

import { useState } from "react";
import { ExternalLink, RotateCw } from "lucide-react";
import { appIcons, type TerminalApp } from "@/lib/apps";
import { StatusBadge } from "@/components/status-badge";

export function TerminalFrame({ app }: { app: TerminalApp }) {
  const [connection, setConnection] = useState(0);
  const Icon = appIcons[app.icon];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 flex-wrap items-center gap-3 border-b border-border px-4 py-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon aria-hidden size={16} />
        </div>
        <h1 className="text-sm font-semibold text-foreground">{app.name}</h1>
        <StatusBadge app={app} />
        <button
          type="button"
          onClick={() => setConnection((n) => n + 1)}
          className="flex h-11 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <RotateCw aria-hidden size={16} />
          Reconnect
        </button>
        <a
          href={app.terminalPath}
          target="_blank"
          rel="noopener"
          className="flex h-11 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ExternalLink aria-hidden size={16} />
          Open in new tab
        </a>
        <span className="ml-auto hidden text-xs text-muted-foreground md:inline">
          Closing this page keeps your session running.
        </span>
      </div>
      <iframe key={connection} src={app.terminalPath} title={`${app.name} terminal`} className="min-h-0 w-full flex-1 border-0 bg-black" />
    </div>
  );
}
