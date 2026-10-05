"use client";
import { useAuth, useOrganization } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { PageHead, Panel, Status } from "@/components/ui";
import { fetchLedger } from "@/lib/api";
import { readOfficeSession } from "@/lib/session";
import { loadExpenses } from "@/lib/page-data";

type LedgerItem = Awaited<ReturnType<typeof loadExpenses>>["items"][number];

// Active tag chip component
function TagChip({ tagId, onRemove }: { tagId: string; onRemove: (id: string) => void }) {
  return (
    <span className="tag-chip">
      <span>{tagId}</span>
      <button
        type="button"
        onClick={() => onRemove(tagId)}
        aria-label={`Remove tag filter ${tagId}`}
      >
        x
      </button>
    </span>
  );
}

function LedgerTable({ items }: { items: LedgerItem[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th aria-sort="descending">Date</th>
          <th>Merchant</th>
          <th>Project</th>
          <th>Tax</th>
          <th>Status</th>
          <th>Amount</th>
          <th>Tags</th>
          <th><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {items.map((row) => (
          <tr key={row.id}>
            <td>{row.incurredOn}</td>
            <td>{row.merchant}</td>
            <td>{row.projectId ?? "-"}</td>
            <td>{row.spendingCategoryId ?? "-"}</td>
            <td><Status tone={row.status === "ready" ? "ok" : "warn"}>{row.status}</Status></td>
            <td className="money">{row.amount} {row.currency}</td>
            <td>
              {row.tags && row.tags.length > 0 ? (
                <span className="tag-list" aria-label={`Tags: ${row.tags.map((t) => t.name).join(", ")}`}>
                  {row.tags.map((t) => (
                    <span key={t.id} className="tag-chip-display">{t.name}</span>
                  ))}
                </span>
              ) : "-"}
            </td>
            <td>
              <Link href={`/expenses/${row.id}`} aria-label={`Review expense from ${row.merchant}`}>Review</Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * ExpenseLedgerWithFilters is the single owner of all ledger data.
 * It fires the initial load via useEffect and handles filter changes and
 * cursor-based pagination entirely through fetchLedger. OfficeData is not
 * used here — using it alongside fetchLedger created a dual data path where
 * the table could show a mix of unfiltered OfficeData items and filtered
 * fetchLedger items.
 */
function ExpenseLedgerWithFilters() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();

  const [activeTagIds, setActiveTagIds] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [sort] = useState<"incurredOn" | "amount" | "merchant" | "createdAt">("incurredOn");
  const [direction] = useState<"asc" | "desc">("desc");

  // items=null means initial load pending; empty array means loaded but no results
  const [items, setItems] = useState<LedgerItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  const loadPage = useCallback(async (opts: {
    tagId?: string[];
    cursor?: string;
    /** When true, replace items; when false/undefined, append (pagination) */
    reset?: boolean;
  }) => {
    const session = readOfficeSession();
    if (!session) { setUnauthorized(true); return; }
    if (!organization) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLedger(session, getToken, organization.id, undefined, {
        tagId: opts.tagId?.length ? opts.tagId : undefined,
        cursor: opts.cursor,
        sort,
        direction,
        limit: 50,
      });
      if (opts.reset !== false) {
        // reset=true OR reset=undefined (initial load): replace items
        setItems(data.items as LedgerItem[]);
      } else {
        // append for load-more pagination
        setItems((prev) => [...(prev ?? []), ...(data.items as LedgerItem[])]);
      }
      setNextCursor(data.nextCursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ledger unavailable");
    } finally {
      setLoading(false);
    }
  }, [getToken, organization, sort, direction]);

  // Initial load: fire once when auth + org are ready (identified by stable org id).
  // We use organization.id (a string) rather than the organization object to
  // avoid re-firing when Clerk returns a new object reference on each render.
  const orgId = organization?.id;
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !organizationLoaded || !orgId) return;
    let active = true;
    void (async () => {
      // Defer setState calls into async context so they don't run synchronously in the effect body.
      await Promise.resolve();
      if (!active) return;
      void loadPage({ reset: true });
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, isSignedIn, organizationLoaded, orgId]);
  // Note: loadPage is stable via useCallback on [getToken, organization, sort, direction].

  function addTagFilter() {
    const id = tagInput.trim();
    if (!id || activeTagIds.includes(id)) return;
    const next = [...activeTagIds, id];
    setActiveTagIds(next);
    setTagInput("");
    void loadPage({ tagId: next, reset: true });
  }

  function removeTagFilter(id: string) {
    const next = activeTagIds.filter((t) => t !== id);
    setActiveTagIds(next);
    void loadPage({ tagId: next.length ? next : undefined, reset: true });
  }

  function loadMore() {
    if (!nextCursor || loading) return;
    void loadPage({
      tagId: activeTagIds.length ? activeTagIds : undefined,
      cursor: nextCursor,
      reset: false,
    });
  }

  if (unauthorized) {
    return (
      <div className="empty" role="alert">
        Office session unavailable. Sign in again.
      </div>
    );
  }

  const displayItems = items ?? [];

  return (
    <>
      <PageHead eyebrow="Ledger" title="Every expense, one scope.">
        <p>Server-paginated, cursor-stable, tag-filtered. No client-side data.items filtering.</p>
      </PageHead>
      <Panel title="Expense ledger">
        <div className="toolbar" role="toolbar" aria-label="Ledger filters">
          <div className="tag-filter-row">
            <label htmlFor="tag-filter-input">Filter by tag ID</label>
            <input
              id="tag-filter-input"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTagFilter()}
              placeholder="Enter tag ID and press Enter"
              aria-describedby="tag-filter-hint"
            />
            <button type="button" onClick={addTagFilter} disabled={!tagInput.trim()}>Add tag filter</button>
            <span id="tag-filter-hint" className="sr-only">Type a tag ID and press Enter or Add tag filter to filter expenses.</span>
          </div>
          {activeTagIds.length > 0 && (
            <div className="active-chips" role="group" aria-label="Active tag filters">
              {activeTagIds.map((id) => (
                <TagChip key={id} tagId={id} onRemove={removeTagFilter} />
              ))}
            </div>
          )}
          <button type="button">Date range</button>
          <button type="button">Review state</button>
          <button type="button">Project</button>
        </div>
        {error && <div role="alert" className="empty">{error}</div>}
        {(loading && items === null) && (
          <div role="status" aria-live="polite" className="empty">Loading expenses...</div>
        )}
        {items !== null && <LedgerTable items={displayItems} />}
        {items !== null && displayItems.length === 0 && !loading && (
          <div className="empty">No expenses match current filters.</div>
        )}
        {loading && items !== null && (
          <div role="status" aria-live="polite" className="empty">Loading expenses...</div>
        )}
        {nextCursor && (
          <button type="button" onClick={loadMore} disabled={loading} aria-busy={loading}>
            {loading ? "Loading more..." : "Load more"}
          </button>
        )}
      </Panel>
    </>
  );
}

export default function Expenses() {
  return <ExpenseLedgerWithFilters />;
}
