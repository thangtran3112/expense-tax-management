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
