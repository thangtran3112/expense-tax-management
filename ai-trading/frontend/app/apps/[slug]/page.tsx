import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { PageShell } from "@/components/page-shell";
import { StatusBadge } from "@/components/status-badge";
import { TerminalFrame } from "@/components/terminal-frame";
import { appIcons, findApp, hubApps } from "@/lib/apps";

export const dynamicParams = false;

export function generateStaticParams() {
  return hubApps.filter((app) => app.status !== "planned").map((app) => ({ slug: app.slug }));
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `${findApp(slug)?.name ?? "App"} | Trading Hub` };
}

export default async function AppPage({ params }: Props) {
  const { slug } = await params;
  const app = findApp(slug);
  if (!app || app.status === "planned") notFound();

  if (app.kind === "terminal") {
    return (
      <PageShell breadcrumb={app.name} scroll={false}>
        <TerminalFrame app={app} />
      </PageShell>
    );
  }

  if (app.kind === "upstream-setup") {
    const Icon = appIcons[app.icon];
    return (
      <PageShell breadcrumb={app.name}>
        <div className="mx-auto w-full max-w-[720px] px-4 py-12 md:px-6">
          <div className="rounded-xl border border-border bg-card p-6 text-center sm:p-8">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-muted">
              <Icon aria-hidden size={20} />
            </div>
            <h1 className="mt-4 text-2xl font-semibold text-foreground">{app.name}</h1>
            <div className="mt-2 flex justify-center">
              <StatusBadge app={app} />
            </div>
            <p className="mt-4 text-muted-foreground">{app.summary}</p>
            <dl className="mt-4 space-y-1 text-left text-sm text-muted-foreground">
              <div>
                <dt className="inline font-medium text-foreground">Good for: </dt>
                <dd className="inline">{app.goodFor}</dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">Cost: </dt>
                <dd className="inline">{app.costNote}</dd>
              </div>
              <div>
                <dt className="inline font-medium text-foreground">Needs: </dt>
                <dd className="inline">{app.requiredKeys.join(", ")}</dd>
              </div>
            </dl>
            <p className="mt-6 text-left text-sm text-muted-foreground">
              Both of us share this experimental instance&apos;s projects. Activation (auth, keys, and a verified
              end-to-end run) is a separate, reviewed change — this page has no launch link yet.
            </p>
            <div className="mt-6 flex justify-center gap-4 text-sm">
              <a href={app.sourceUrl} target="_blank" rel="noopener" className="underline underline-offset-2">
                Pinned source
              </a>
              <a href={app.licenseUrl} target="_blank" rel="noopener" className="underline underline-offset-2">
                AGPL-3.0 license
              </a>
            </div>
          </div>
        </div>
      </PageShell>
    );
  }

  const Icon = appIcons[app.icon];
  return (
    <PageShell breadcrumb={app.name}>
      <div className="mx-auto w-full max-w-[720px] px-4 py-12 md:px-6">
        <div className="rounded-xl border border-border bg-card p-6 text-center sm:p-8">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-muted">
            <Icon aria-hidden size={20} />
          </div>
          <h1 className="mt-4 text-2xl font-semibold text-foreground">{app.name}</h1>
          <div className="mt-2 flex justify-center">
            <StatusBadge app={app} />
          </div>
          <p className="mt-4 text-muted-foreground">{app.summary}</p>
          <dl className="mt-4 space-y-1 text-left text-sm text-muted-foreground">
            <div>
              <dt className="inline font-medium text-foreground">Good for: </dt>
              <dd className="inline">{app.goodFor}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-foreground">Cost: </dt>
              <dd className="inline">{app.costNote}</dd>
            </div>
          </dl>
          <div className="mt-6 text-left">
            <h2 className="text-sm font-semibold text-foreground">First visit in this browser</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              {app.firstVisitNote.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
          <a
            href={app.url}
            target="_blank"
            rel="noopener"
            className="mt-6 inline-flex cursor-pointer items-center gap-2 rounded-md bg-accent px-4 py-3 font-medium text-on-accent transition-opacity duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Open {app.name}
            <ExternalLink aria-hidden size={16} />
          </a>
          <p className="mt-6 text-xs text-muted-foreground">
            {app.name} opens in its own tab because it does not allow embedding in other pages.
          </p>
        </div>
      </div>
    </PageShell>
  );
}
