import Link from "next/link";
import { CandlestickChart } from "lucide-react";
import { AppsMenu } from "@/components/apps-menu";

export function Header({ breadcrumb }: { breadcrumb?: string }) {
  return (
    <header className="sticky top-0 z-10 h-14 shrink-0 border-b border-border bg-background">
      <div className="mx-auto flex h-full w-full max-w-[1200px] items-center justify-between px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/"
            className="flex h-11 shrink-0 items-center gap-2 rounded-md font-semibold text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-on-accent">
              <CandlestickChart aria-hidden size={18} />
            </span>
            Trading Hub
          </Link>
          {breadcrumb && (
            <span className="truncate text-sm text-muted-foreground">
              Hub <span aria-hidden>/</span> {breadcrumb}
            </span>
          )}
        </div>
        <AppsMenu />
      </div>
    </header>
  );
}
