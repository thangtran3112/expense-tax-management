import { HomeDirectory } from "@/components/home-directory";
import { PageShell } from "@/components/page-shell";

export default function HomePage() {
  return (
    <PageShell>
      <div className="mx-auto w-full max-w-[1200px] px-4 py-8 md:px-6">
        <h1 className="text-2xl font-semibold text-foreground">Trading Hub</h1>
        <p className="mt-2 text-muted-foreground">
          Open-source trading AI apps, exactly as their authors ship them, plus our own desk in release 2.
        </p>
        <HomeDirectory />
      </div>
    </PageShell>
  );
}
