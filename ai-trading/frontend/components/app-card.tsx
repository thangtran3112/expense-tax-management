import Link from "next/link";
import { ArrowRight, ExternalLink, Keyboard, Tablet } from "lucide-react";
import { appIcons, type HubApp } from "@/lib/apps";
import { StatusBadge } from "@/components/status-badge";

const deviceHints = {
  keyboard: { Icon: Keyboard, label: "Keyboard recommended" },
  touch: { Icon: Tablet, label: "Works on touch" },
} as const;

function CardBody({ app }: { app: HubApp }) {
  const Icon = appIcons[app.icon];
  const device = deviceHints[app.device];
  return (
    <>
      <div className="flex items-center gap-2">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon aria-hidden size={20} />
        </div>
        <h3 className="min-w-0 flex-1 truncate text-lg font-semibold text-foreground">{app.name}</h3>
        <StatusBadge app={app} />
      </div>
      <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">{app.summary}</p>
      <div className="mt-3 flex gap-2 overflow-hidden">
        {app.tags.slice(0, 3).map((tag) => (
          <span
            key={tag}
            title={tag}
            className="max-w-[9rem] shrink-0 truncate rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          >
            {tag}
          </span>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <device.Icon aria-hidden size={14} />
          {device.label}
        </span>
        {app.kind === "terminal" && (
          <span className="inline-flex items-center gap-1">
            Open in hub
            <ArrowRight aria-hidden size={14} />
          </span>
        )}
        {app.kind === "external" && (
          <span className="inline-flex items-center gap-1">
            Opens in a new tab
            <ExternalLink aria-hidden size={14} />
          </span>
        )}
      </div>
    </>
  );
}

export function AppCard({ app }: { app: HubApp }) {
  if (app.status === "planned") {
    return (
      <div
        aria-disabled="true"
        title={app.goodFor}
        className="flex min-h-[200px] flex-col rounded-xl border border-dashed border-border bg-card p-6 opacity-70"
      >
        <CardBody app={app} />
      </div>
    );
  }
  return (
    <Link
      href={`/apps/${app.slug}`}
      title={app.goodFor}
      className="flex min-h-[200px] flex-col rounded-xl border border-border bg-card p-6 transition-[color,background-color,border-color,transform] duration-150 ease-out hover:border-accent motion-safe:hover:-translate-y-px focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <CardBody app={app} />
    </Link>
  );
}
