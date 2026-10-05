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
