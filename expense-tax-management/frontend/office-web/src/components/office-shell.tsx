"use client";
import { useAuth, useOrganization } from "@clerk/nextjs";
import { Archive, Building2, ChartNoAxesCombined, Copy, FileDown, Forward, LayoutDashboard, List, Mail, Settings, Tags } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DUPLICATE_REVIEW_UPDATED_EVENT, fetchDuplicateMatches, formatPendingDuplicateCount, shouldApplyPendingDuplicateCount } from "@/lib/api";
import { readOfficeSession } from "@/lib/session";

const nav = [
  ["/dashboard", "Dashboard", LayoutDashboard], ["/expenses", "Expenses", List],
  ["/businesses", "Businesses", Building2], ["/projects", "Projects", ChartNoAxesCombined],
  ["/tax", "Tax", Tags], ["/exports", "Exports", FileDown],
  ["/forwarding", "Forwarding", Forward], ["/mailbox", "Mailbox", Mail],
  ["/settings", "Settings", Settings],
] as const;

const BUSINESS_ONLY_HREFS = new Set(["/businesses", "/projects", "/tax", "/exports"]);

export function OfficeShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();
  const [pendingCount, setPendingCount] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const session = isLoaded && isSignedIn ? readOfficeSession() : null;

  const scopeLabel = session?.label ?? "Office";
  // Null session: treat as personal scope to prevent business-only nav rendering
  const isPersonalOrNoSession = !session || session.scope.kind === "personal";

  useEffect(() => {
    if (!session || !organizationLoaded || !organization) return;
    let active = true;
    const refreshPendingCount = () => {
      const sequence = ++requestSequence.current;
      return fetchDuplicateMatches(session, getToken, organization.id)
        .then((matches) => { if (shouldApplyPendingDuplicateCount(active, sequence, requestSequence.current)) setPendingCount(formatPendingDuplicateCount(matches)); })
        .catch(() => { if (shouldApplyPendingDuplicateCount(active, sequence, requestSequence.current)) setPendingCount(null); });
    };
    void refreshPendingCount();
    window.addEventListener(DUPLICATE_REVIEW_UPDATED_EVENT, refreshPendingCount);
    return () => { active = false; requestSequence.current += 1; window.removeEventListener(DUPLICATE_REVIEW_UPDATED_EVENT, refreshPendingCount); };
  }, [getToken, session, organization, organizationLoaded]);

  return (
    <div className="office-shell">
      <aside>
        <Link className="brand" href="/dashboard"><span>O</span>ExpenseTax Office</Link>
        {session && (
          <p className="scope-label" aria-label={`Active scope: ${scopeLabel}`}>
            <span className={`status ${session.scope.kind === "personal" ? "ok" : "warn"}`} aria-hidden="true">
              {session.scope.kind === "personal" ? "Personal" : "Business"}
            </span>
            {scopeLabel}
          </p>
        )}
        <nav aria-label="Office navigation">
          {nav.map(([href, label, Icon]) => {
            const unavailable = isPersonalOrNoSession && BUSINESS_ONLY_HREFS.has(href);
            const isCurrent = path.startsWith(href);
            if (unavailable) {
              // Render as inert span — not a link, not keyboard-focusable as a navigation target.
              // Screen readers see it as static text; no href="#" pseudo-disabled link.
              return (
                <span
                  key={href}
                  className="nav-unavailable"
                  aria-label={`${label} — requires Business scope`}
                  title={`${label} requires Business scope`}
                >
                  <Icon size={17} aria-hidden="true" />
                  {label}
                  <span className="status warn" aria-hidden="true">B</span>
                </span>
              );
            }
            return (
              <Link
                key={href}
                href={href}
                aria-current={isCurrent ? "page" : undefined}
              >
                <Icon size={17} />{label}
              </Link>
            );
          })}
          <Link href="/duplicates" aria-current={path.startsWith("/duplicates") ? "page" : undefined}>
            <Copy size={17} />Duplicate Review
            {pendingCount !== null && pendingCount !== "0" && <span className="status warn">{pendingCount}</span>}
          </Link>
        </nav>
        <p><Archive size={15} /> Preparation + export<br />Never tax filing</p>
      </aside>
      <main>
        <div className="small-handoff">
          <h1>Use Capture on this screen.</h1>
          <p>Office needs at least 1024px for safe ledger and tax review.</p>
          <Link href={process.env.NEXT_PUBLIC_CAPTURE_URL ?? "http://localhost:7301/capture"}>Open Capture</Link>
        </div>
        <div className="desktop-content">{children}</div>
      </main>
    </div>
  );
}
