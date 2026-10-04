"use client";
import { useAuth, useOrganization } from "@clerk/nextjs";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PageHead, Panel, Status } from "@/components/ui";
import {
  EnrichmentReviewError,
  fetchExpenseDetail,
  fetchSuggestions,
  resolveSuggestion,
  getSuggestionSourceLabel,
  makeStableIdempotencyKey,
  formatSuggestionKind,
  type EnrichmentReviewState,
  getEnrichmentReviewState,
} from "@/lib/api";
import { MAILBOX_DUPLICATES_HREF } from "@/lib/mailbox";
import { readOfficeSession } from "@/lib/session";

type Suggestion = {
  id: string;
  kind: string;
  source: string;
  confidence: number;
  evidence: Record<string, unknown>;
  status: string;
  version: number;
  expenseVersion: number;
  tagId?: string | null;
  spendingCategoryId?: string | null;
  taxCategoryDefinitionId?: string | null;
  businessTaxProfileId?: string | null;
};

type ExpenseDetail = {
  id: string;
  merchant: string;
  incurredOn: string;
  amount: string;
  currency: string;
  status: string;
  version: number;
  personalProfileId?: string | null;
  businessId?: string | null;
  tags?: Array<{ id: string; name: string; color: string | null }>;
  /** Phase 3D-C Task 6 fix round 1 (review finding #6) -- connected-
   * mailbox provenance, metadata only. Present only when the expense's
   * source is "connected_mailbox". */
  mailboxProvenance?: {
    senderAddress: string;
    receivedAt: string;
    mailboxAccountEmail: string;
    pendingDuplicateReview: boolean;
  } | null;
};

function EvidencePanel({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence);
  if (entries.length === 0) return <p className="muted">No aggregate evidence provided.</p>;
  return (
    <dl className="evidence-list">
      {entries.map(([key, value]) => (
        <div key={key} className="evidence-item">
          <dt>{key}</dt>
          <dd>{Array.isArray(value) ? value.join(", ") : String(value ?? "-")}</dd>
        </div>
      ))}
    </dl>
  );
}

function ConfidenceMeter({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const tone = pct >= 90 ? "ok" : pct >= 70 ? "warn" : "bad";
  return <Status tone={tone}>{pct}% confidence</Status>;
}

function TaxAcceptForm({
  suggestion,
  onAccept,
  disabled,
}: {
  suggestion: Suggestion;
  onAccept: (taxProfileId: string, deductiblePercent: string, idemKey: string) => void;
  disabled: boolean;
}) {
  const [profileId, setProfileId] = useState(suggestion.businessTaxProfileId ?? "");
  const [deductiblePct, setDeductiblePct] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // No useRef for idemKey — key is computed at submit time from the actual
  // submitted profileId so changing the profileId field produces a different key.
  // Retrying the same payload reuses the same key (deterministic).

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedProfileId = profileId.trim();
    if (!trimmedProfileId) { setFormError("Tax profile ID is required."); return; }
    const pct = Number(deductiblePct.trim());
    if (isNaN(pct) || pct < 0 || pct > 100) { setFormError("Deductible percentage must be 0-100."); return; }
    setFormError(null);
    // Key derived from action + suggestion + profileId at submission time.
    // Same payload → same key (idempotent retry). Changed profileId → new key (different intent).
    const idemKey = makeStableIdempotencyKey("tax-accept", suggestion.id, "accepted", trimmedProfileId);
    // Contract requires deductiblePercent as string (regex-validated decimal)
    onAccept(trimmedProfileId, String(pct), idemKey);
  }

  return (
    <form onSubmit={handleSubmit} aria-label="Tax category acceptance" className="tax-accept-form">
      <p className="warn-note">Tax acceptance requires human-supplied deductible percentage. No automatic value is applied.</p>
      <div className="field-row">
        <label htmlFor={`tax-profile-${suggestion.id}`}>Business tax profile ID</label>
        <input
          id={`tax-profile-${suggestion.id}`}
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          required
          aria-required="true"
          disabled={disabled}
        />
      </div>
      <div className="field-row">
        <label htmlFor={`deductible-pct-${suggestion.id}`}>Deductible percentage (0-100)</label>
        <input
          id={`deductible-pct-${suggestion.id}`}
          type="number"
          min={0}
          max={100}
          step={1}
          value={deductiblePct}
          onChange={(e) => setDeductiblePct(e.target.value)}
          required
          aria-required="true"
          placeholder="e.g. 50"
          disabled={disabled}
        />
      </div>
      {formError && <div role="alert" className="field-error">{formError}</div>}
      <button type="submit" className="primary" disabled={disabled}>Accept tax category</button>
    </form>
  );
}

/**
 * SuggestionCard does NOT manage its own resolving/disabled state.
 * The `disabled` prop from the parent (ExpenseDetail.resolving) is the sole
 * source of truth for whether buttons are enabled. This prevents local
 * `resolving=true` getting stuck on failure — the parent's finally block
 * always resets its own state regardless of outcome.
 */
function SuggestionCard({
  suggestion,
  onResolve,
  disabled,
}: {
  suggestion: Suggestion;
  onResolve: (suggId: string, action: "accepted" | "rejected", idemKey: string, taxAcceptance?: { businessTaxProfileId: string; deductiblePercent: string }) => void;
  disabled: boolean;
}) {
  const sourceLabel = getSuggestionSourceLabel(suggestion.source as Parameters<typeof getSuggestionSourceLabel>[0]);

  function handleReject() {
    // Key includes action so "accepted" and "rejected" produce distinct keys for same suggestion.
    const idemKey = makeStableIdempotencyKey("resolve-suggestion", suggestion.id, "rejected");
    onResolve(suggestion.id, "rejected", idemKey);
  }

  function handleTaxAccept(taxProfileId: string, deductiblePercent: string, taxIdemKey: string) {
    // taxIdemKey is computed at submit time in TaxAcceptForm from profileId+action+suggestion.
    onResolve(suggestion.id, "accepted", taxIdemKey, { businessTaxProfileId: taxProfileId, deductiblePercent });
  }

  function handleAccept() {
    // Key includes action so accept and reject are distinct.
    const idemKey = makeStableIdempotencyKey("resolve-suggestion", suggestion.id, "accepted");
    onResolve(suggestion.id, "accepted", idemKey);
  }

  const isTaxCategory = suggestion.kind === "tax_category";
  const isWorking = disabled;

  return (
    <article className="suggestion-card panel" aria-labelledby={`sugg-${suggestion.id}`}>
      <div className="toolbar">
        <div>
          <Status tone="warn">{formatSuggestionKind(suggestion.kind)}</Status>
          <Status tone={suggestion.source === "ai" ? "ok" : "warn"}>{sourceLabel}</Status>
          <ConfidenceMeter confidence={suggestion.confidence} />
        </div>
        <span className="muted">Version {suggestion.version}</span>
      </div>

      <h3 id={`sugg-${suggestion.id}`}>
        {isTaxCategory ? "Tax category suggestion" : suggestion.kind === "tag" ? `Tag suggestion: ${suggestion.tagId ?? ""}` : `Spending category suggestion: ${suggestion.spendingCategoryId ?? ""}`}
      </h3>

      <section aria-label="Aggregate evidence">
        <h4>Evidence</h4>
        <EvidencePanel evidence={suggestion.evidence} />
      </section>

      {isTaxCategory ? (
        <>
          <TaxAcceptForm suggestion={suggestion} onAccept={handleTaxAccept} disabled={isWorking} />
          <button type="button" onClick={handleReject} disabled={isWorking} className="danger">Reject</button>
        </>
      ) : (
        <div className="toolbar">
          <button type="button" className="primary" onClick={handleAccept} disabled={isWorking}>Accept</button>
          <button type="button" onClick={handleReject} disabled={isWorking} className="danger">Reject</button>
        </div>
      )}
    </article>
  );
}


export default function ExpenseDetail() {
  const params = useParams();
  const expenseId = typeof params.expenseId === "string" ? params.expenseId : "";
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();

  const [expense, setExpense] = useState<ExpenseDetail | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());
  const [unauthorized, setUnauthorized] = useState(false);
  // loadError: fatal page-level load failure → triggers full-page error state
  const [loadError, setLoadError] = useState<string | null>(null);
  // resolveError: inline transient resolve error → displayed within suggestion panel, card stays enabled
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [stale, setStale] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolvedMessage, setResolvedMessage] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const hasSession = !!(isLoaded && isSignedIn && readOfficeSession());

  const reviewState: EnrichmentReviewState = getEnrichmentReviewState({
    isLoaded: isLoaded && organizationLoaded,
    isSignedIn: isSignedIn ?? false,
    hasSession,
    hasOrganization: !!organization,
    suggestions: suggestions ?? undefined,
    // Only load errors drive the page-level error state; resolve errors are inline
    error: loadError ?? undefined,
    conflict,
    stale,
  });

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !organizationLoaded || !organization) return;
    const session = readOfficeSession();
    let active = true;
    async function load() {
      if (!session) { if (active) setUnauthorized(true); return; }
      if (!organization) return;
      try {
        const [expData, suggData] = await Promise.all([
          fetchExpenseDetail(session, expenseId, getToken, organization.id),
          fetchSuggestions(session, expenseId, getToken, organization.id),
        ]);
        if (active) {
          setExpense(expData as unknown as ExpenseDetail);
          setSuggestions(suggData.items as Suggestion[]);
        }
      } catch (e) {
        if (!active) return;
        if (e instanceof EnrichmentReviewError && (e.status === 401 || e.status === 403)) {
          setUnauthorized(true);
        } else {
          setLoadError(e instanceof Error ? e.message : "Failed to load expense");
        }
      }
    }
    void load();
    return () => { active = false; };
  }, [expenseId, getToken, isLoaded, isSignedIn, organization, organizationLoaded, reloadKey]);

  async function handleResolve(
    suggId: string,
    action: "accepted" | "rejected",
    idemKey: string,
    taxAcceptance?: { businessTaxProfileId: string; deductiblePercent: string },
  ) {
    const session = readOfficeSession();
    if (!session || !organization || !expense) return;
    setResolving(true);
    setConflict(false);
    setStale(false);
    setResolveError(null);
    try {
      const sugg = suggestions?.find((s) => s.id === suggId);
      if (!sugg) throw new Error("Suggestion not found");
      await resolveSuggestion(session, expenseId, suggId, {
        action,
        expectedSuggestionVersion: sugg.version,
        expectedExpenseVersion: expense.version,
        idempotencyKey: idemKey,
        ...(taxAcceptance ? { taxAcceptance } : {}),
      }, getToken, organization.id);
      setResolvedIds((prev) => new Set([...prev, suggId]));
      setResolvedMessage(action === "accepted" ? "Suggestion accepted. Expense marked unreviewed pending re-evaluation." : "Suggestion rejected.");
      try {
        const [refreshedExpense, refreshedSuggestions] = await Promise.all([
          fetchExpenseDetail(session, expenseId, getToken, organization.id),
          fetchSuggestions(session, expenseId, getToken, organization.id),
        ]);
        setExpense(refreshedExpense as unknown as ExpenseDetail);
        setSuggestions(refreshedSuggestions.items as Suggestion[]);
      } catch (e) {
        setResolveError(e instanceof Error ? `Resolution succeeded, but refresh failed: ${e.message}` : "Resolution succeeded, but refresh failed");
      }
    } catch (e) {
      if (e instanceof EnrichmentReviewError) {
        if (e.status === 409) setConflict(true);
        else if (e.status === 401 || e.status === 403) setUnauthorized(true);
        // Inline resolve error — does not switch to page-level error state
        else setResolveError(e.message);
      } else {
        // Inline transient error — card stays enabled for retry
        setResolveError(e instanceof Error ? e.message : "Resolution failed");
      }
    } finally {
      setResolving(false);
    }
  }

  // Render states
  if (reviewState === "loading") {
    return <main className="auth"><p aria-live="polite">Loading expense review...</p></main>;
  }
  if (unauthorized || reviewState === "unauthorized") {
    return <main className="auth" role="alert"><p>Office authorization required. Sign in and select a scope before reviewing expenses.</p></main>;
  }
  if (reviewState === "error") {
    return <main className="auth"><div role="alert">{loadError ?? "Failed to load expense."}</div><button type="button" onClick={() => { setLoadError(null); setReloadKey((key) => key + 1); }}>Retry</button></main>;
  }
  if (reviewState === "conflict") {
    return (
      <main className="auth">
        <div role="alert" className="warn-note">This expense changed while you were reviewing. Refresh to see the latest state.</div>
        <button type="button" onClick={() => window.location.reload()}>Refresh</button>
      </main>
    );
  }
  if (reviewState === "stale") {
    return (
      <main className="auth">
        <div role="alert" className="warn-note">Tax profile changed since suggestion was created. Re-evaluate before accepting.</div>
        <button type="button" onClick={() => window.location.reload()}>Refresh</button>
      </main>
    );
  }

  const pendingSuggestions = (suggestions ?? []).filter((s) => s.status === "pending" && !resolvedIds.has(s.id));

  return (
    <>
      <PageHead eyebrow="Expense review" title={expense?.merchant ?? "Expense"}>
        <p>Pending AI and historical suggestions for this expense. Tax acceptance requires human deductible percentage.</p>
      </PageHead>

      {expense && (
        <Panel title="Expense details">
          <dl className="evidence-list">
            <div className="evidence-item"><dt>Date</dt><dd>{expense.incurredOn}</dd></div>
            <div className="evidence-item"><dt>Merchant</dt><dd>{expense.merchant}</dd></div>
            <div className="evidence-item"><dt>Amount</dt><dd>{expense.amount} {expense.currency}</dd></div>
            <div className="evidence-item"><dt>Status</dt><dd><Status tone={expense.status === "ready" ? "ok" : "warn"}>{expense.status}</Status></dd></div>
          </dl>
          {expense.tags && expense.tags.length > 0 && (
            <div className="tag-list" aria-label="Active tags">
              {expense.tags.map((t) => (
                <span key={t.id} className="tag-chip-display">{t.name}</span>
              ))}
            </div>
          )}
          {expense.mailboxProvenance && (
            <section aria-label="Source">
              <h4>Source</h4>
              <div className="field-row">
                <label>Origin</label>
                <span><Status tone="ok">Connected Gmail mailbox</Status></span>
              </div>
              <div className="field-row">
                <label>From</label>
                <span>{expense.mailboxProvenance.senderAddress}</span>
              </div>
              <div className="field-row">
                <label>Received</label>
                <span>{new Date(expense.mailboxProvenance.receivedAt).toLocaleString()}</span>
              </div>
              <div className="field-row">
                <label>Scope</label>
                <span>{expense.personalProfileId ? "Personal" : "Business"}</span>
              </div>
              <p>
                Metadata only -- sender address, received date, and scope. Message body, attachment
                bytes, and other provider content are never rendered in Office.
              </p>
              {expense.mailboxProvenance.pendingDuplicateReview && (
                <p>
                  <Link href={MAILBOX_DUPLICATES_HREF}>Review duplicate match →</Link> -- this expense
                  stays until a reviewer resolves the match in the Duplicates queue; no automatic merge.
                </p>
              )}
            </section>
          )}
        </Panel>
      )}

      {resolvedMessage && (
        <div role="status" aria-live="polite" className="empty">{resolvedMessage}</div>
      )}
      {resolveError && <div role="alert" className="empty">{resolveError}</div>}

      {reviewState === "empty" || pendingSuggestions.length === 0 ? (
        <Panel title="No pending suggestions">
          <div className="empty" role="status">No pending enrichment suggestions for this expense.</div>
        </Panel>
      ) : (
        <Panel title={`${pendingSuggestions.length} pending suggestion${pendingSuggestions.length === 1 ? "" : "s"}`}>
          {pendingSuggestions.map((sugg) => (
            <SuggestionCard
              key={sugg.id}
              suggestion={sugg}
              onResolve={handleResolve}
              disabled={resolving}
            />
          ))}
        </Panel>
      )}

    </>
  );
}
