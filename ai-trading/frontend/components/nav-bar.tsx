import Link from "next/link";
import { hubApps } from "@/lib/apps";

export function NavBar() {
  return (
    <header className="border-b border-slate-800 bg-slate-950">
      <nav className="mx-auto flex max-w-6xl items-center gap-4 overflow-x-auto px-4 py-3 text-sm">
        <Link href="/" className="font-semibold whitespace-nowrap text-white">
          Trading Hub
        </Link>
        {hubApps.map((app) =>
          app.kind === "planned" ? (
            <span key={app.slug} className="whitespace-nowrap text-slate-500">
              {app.name} <span className="text-xs">({app.release.toLowerCase()})</span>
            </span>
          ) : (
            <Link key={app.slug} href={`/apps/${app.slug}`} className="whitespace-nowrap text-slate-300 hover:text-white">
              {app.name}
            </Link>
          ),
        )}
      </nav>
    </header>
  );
}
