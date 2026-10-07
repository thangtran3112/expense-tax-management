import Link from "next/link";
import { PageShell } from "@/components/page-shell";

export default function NotFound() {
  return (
    <PageShell>
      <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col items-center justify-center px-4 text-center">
        <h1 className="text-2xl font-semibold text-foreground">This app is not in the hub</h1>
        <Link
          href="/"
          className="mt-4 cursor-pointer rounded-md bg-accent px-4 py-3 font-medium text-on-accent transition-opacity duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Back to Trading Hub
        </Link>
      </div>
    </PageShell>
  );
}
