"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { LayoutGrid } from "lucide-react";
import { appIcons, hubApps, hubCategories } from "@/lib/apps";
import { StatusBadge } from "@/components/status-badge";

export function AppsMenu() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Apps"
        onClick={() => setOpen((value) => !value)}
        className="flex h-11 cursor-pointer items-center gap-2 rounded-md px-3 text-sm font-medium text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <LayoutGrid aria-hidden size={20} />
        <span className="hidden sm:inline">Apps</span>
      </button>
      {open && (
        <nav
          id={panelId}
          ref={panelRef}
          aria-label="Apps"
          className="absolute right-0 top-full z-20 mt-2 w-72 rounded-lg border border-border bg-card p-2 shadow-lg"
        >
          {hubCategories.map((category) => {
            const apps = hubApps.filter((app) => app.category === category.id);
            if (apps.length === 0) return null;
            return (
              <div key={category.id} className="mb-2 last:mb-0">
                <p className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {category.label}
                </p>
                {apps.map((app) => {
                  const Icon = appIcons[app.icon];
                  if (app.status === "planned") {
                    return (
                      <div
                        key={app.slug}
                        aria-disabled="true"
                        className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground opacity-60"
                      >
                        <Icon aria-hidden size={16} />
                        <span className="flex-1 truncate">{app.name}</span>
                        <StatusBadge app={app} />
                      </div>
                    );
                  }
                  return (
                    <Link
                      key={app.slug}
                      href={`/apps/${app.slug}`}
                      onClick={() => setOpen(false)}
                      className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <Icon aria-hidden size={16} />
                      <span className="flex-1 truncate">{app.name}</span>
                      <StatusBadge app={app} />
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>
      )}
    </div>
  );
}
