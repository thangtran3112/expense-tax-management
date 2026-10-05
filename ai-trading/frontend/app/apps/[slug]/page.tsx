import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TerminalFrame } from "@/components/terminal-frame";
import { findApp, hubApps } from "@/lib/apps";

export const dynamicParams = false;

export function generateStaticParams() {
  return hubApps.filter((app) => app.kind !== "planned").map((app) => ({ slug: app.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${findApp(slug)?.name ?? "App"} | Trading Hub` };
}

export default async function AppPage({ params }: Props) {
  const { slug } = await params;
  const app = findApp(slug);
  if (!app || app.kind === "planned") notFound();
  if (app.kind === "terminal") return <TerminalFrame name={app.name} src={app.terminalPath} />;
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-white">{app.name}</h1>
      <p className="mt-2 text-slate-300">{app.summary}</p>
      <p className="mt-4 text-sm text-slate-400">{app.firstVisitNote}</p>
      <a
        href={app.url}
        target="_blank"
        rel="noopener"
        className="mt-6 inline-block rounded bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500"
      >
        Open {app.name}
      </a>
      <p className="mt-6 text-xs text-slate-500">{app.name} opens in its own tab because it does not allow embedding in other pages.</p>
    </div>
  );
}
