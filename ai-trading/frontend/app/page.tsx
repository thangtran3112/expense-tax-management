import { AppCard } from "@/components/app-card";
import { hubApps } from "@/lib/apps";

export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-white">Trading Hub</h1>
      <p className="mt-1 text-sm text-slate-400">
        Three open-source trading AI apps, exactly as their authors ship them, plus our own desk in release 2.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {hubApps.map((app) => (
          <AppCard key={app.slug} app={app} />
        ))}
      </div>
    </div>
  );
}
