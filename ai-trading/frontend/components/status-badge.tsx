import { Clock } from "lucide-react";
import type { HubApp } from "@/lib/apps";

export function StatusBadge({ app }: { app: HubApp }) {
  if (app.status === "planned") {
    return (
      <span
        title={app.costNote}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      >
        <Clock aria-hidden size={12} />
        {app.release}
      </span>
    );
  }
  return (
    <span
      title={app.costNote}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent"
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
      Live
    </span>
  );
}
