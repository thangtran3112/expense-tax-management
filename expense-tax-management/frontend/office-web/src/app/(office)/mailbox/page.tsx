"use client";
import { useAuth, useOrganization } from "@clerk/nextjs";
import type { MailboxCandidateClassification, MailboxConnectionStatus, Scope } from "@expense-tax/contracts";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Panel, PageHead, Status } from "@/components/ui";
import {
  MailboxCandidateError,
  MailboxConnectionError,
  resolveMailboxCandidate,
  startMailboxScan,
  type MailboxCandidateReviewAction,
} from "@/lib/api";
import {
  mailboxCandidateReviewActionLabel,
  mailboxReasonCodeLabel,
  connectMailboxGoogle,
  mailboxStatusDisplay,
  isMailboxIngestionCandidate,
  mailboxIngestionAccessMessage,
  mailboxIngestionBucket,
  mailboxIngestionConflictMessage,
  mailboxIngestionStatusDisplay,
  MAILBOX_CANDIDATE_CLASSIFICATION_GROUPS,
  MAILBOX_DUPLICATES_HREF,
  MAILBOX_INGESTION_GROUPS,
  type MailboxIngestionAction,
} from "@/lib/mailbox";
import {
  loadAuthorizedBusinesses,
  loadMailboxCandidates,
  loadMailboxConnection,
  loadMailboxIngestionCandidates,
  loadMailboxScanRuns,
  loadOwnPersonalProfile,
} from "@/lib/page-data";
import { readOfficeSession, type OfficeSession } from "@/lib/session";

/**
 * Office mailbox base (Phase 3D-A Task 4, fix round 2). Implements every
 * approved mockup scenario (plans/mockups/office-mailbox/):
 * 1. No connection -- explicit Personal/business scope choice (every
 *    scope the user is authorized for, fetched from App API; none
 *    preselected), Connect disabled until chosen.
 * 2. OAuth in progress (after clicking Connect) / OAuth return (back from
 *    the broker with `?status=connected`).
 * 3. Connected -- real account email/status/scope/schedule from the real
 *    GET route (lib/api.ts's fetchMailboxConnection).
 * 4. Reauthorization-needed / revoked / error banners, driven by the real
 *    connection status.
 * 5. Disconnect confirmation dialog.
 *
 * Phase 3D-B extends this same page with scan history + candidate review;
 * Phase 3D-C extends it with ingestion status -- neither exists yet, so
 * "Candidate review queue" and the schedule controls remain reserved
 * placeholders (schedule editing has no write route yet either).
 */

type Phase = "idle" | "starting" | "oauth-pending" | "oauth-return" | "error";

function scopeKey(scope: Scope): string {
  return scope.kind === "personal" ? `personal:${scope.profileId}` : `business:${scope.businessId}`;
}

function connectionSinceLabel(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

export default function MailboxPage() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();
  const searchParams = useSearchParams();

  // Fix round 2 (Important) -- readOfficeSession() returns a fresh object
  // every call. Memoizing on the auth-load flags (not on anything this
  // component's own state updates ever changes) keeps `session`'s
  // reference stable across re-renders, so effects below never see it as
  // "changed" just because *we* called setState. Every effect also
  // depends on primitive, derived keys (tenantId, a scope-kind+id string,
  // organization.id) rather than the `session`/`organization` objects
  // themselves, per the same principle.
  const session = useMemo<OfficeSession | null>(
    () => (isLoaded && isSignedIn ? readOfficeSession() : null),
    [isLoaded, isSignedIn],
  );
  const tenantId = session?.tenantId ?? null;
  const sessionScopeKey = session ? scopeKey(session.scope) : null;
  const organizationId = organization?.id ?? null;

  const [selectedScope, setSelectedScope] = useState<Scope | null>(null);
  const [businesses, setBusinesses] = useState<
    readonly { readonly id: string; readonly name: string }[] | undefined
  >(undefined);
  const [ownPersonalProfile, setOwnPersonalProfile] = useState<
    { readonly id: string; readonly name: string } | null | undefined
  >(undefined);
  const [phase, setPhase] = useState<Phase>(
    searchParams.get("status") === "connected" ? "oauth-return" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [connection, setConnection] = useState<Awaited<ReturnType<typeof loadMailboxConnection>> | undefined>(
    undefined,
  );
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [reconnectStarting, setReconnectStarting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const [disconnectNote, setDisconnectNote] = useState<string | null>(null);

  // Phase 3D-B Task 5 -- scan history/trigger + candidate review queue.
  const [scanRuns, setScanRuns] = useState<Awaited<ReturnType<typeof loadMailboxScanRuns>> | undefined>(
    undefined,
  );
  const [scanStarting, setScanStarting] = useState(false);
  const [scanActionError, setScanActionError] = useState<string | null>(null);
  const [candidateRefreshSignal, setCandidateRefreshSignal] = useState(0);
  // Fix round 1 (review Important #2) -- bumped by `handleScanNow` to
  // restart the poll effect below from a fresh immediate fetch, instead
  // of a separate uncoordinated fetch that left the effect's own timer
  // loop stopped (it had already stopped scheduling once the prior run
  // reached a terminal status).
  const [pollGeneration, setPollGeneration] = useState(0);
  const previousScanStatusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !organizationLoaded || !session || !organizationId) return;
    let active = true;
    loadMailboxConnection(session, session.scope, getToken, organizationId)
      .then((result) => {
        if (!active) return;
        setConnection(result);
        setPhase((current) => (current === "oauth-return" ? "idle" : current));
      })
      .catch(() => {
        if (active) setConnection(null);
      });
    return () => {
      active = false;
    };
    // Depends on primitive/derived keys only (fix round 2) -- never the
    // `session`/`organization` objects themselves, which change identity
    // on every render regardless of whether anything meaningful changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, sessionScopeKey, organizationId, organizationLoaded, isLoaded, isSignedIn]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !organizationLoaded || !session || !organizationId) return;
    let active = true;
    loadAuthorizedBusinesses(session, getToken, organizationId)
      .then((items) => {
        if (active) setBusinesses(items);
      })
      .catch(() => {
        if (active) setBusinesses([]);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, organizationId, organizationLoaded, isLoaded, isSignedIn]);

  // Fix round 3 (Important) -- the caller's own Personal profile, fetched
  // independently of `session.scope`'s kind so the picker offers Personal
  // under a business-scoped session too. `null` (no Personal profile in
  // this tenant) is a normal resolved state, not an error; a thrown fetch
  // falls back to `null` (option omitted) rather than leaving the
  // picker stuck loading.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !organizationLoaded || !session || !organizationId) return;
    let active = true;
    loadOwnPersonalProfile(session, getToken, organizationId)
      .then((profile) => {
        if (active) setOwnPersonalProfile(profile);
      })
      .catch(() => {
        if (active) setOwnPersonalProfile(null);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, organizationId, organizationLoaded, isLoaded, isSignedIn]);

  // Phase 3D-B Task 5 -- scan status polls live (mockup owner decision:
  // "Running-scan refresh is batch, not streaming"); the candidate list
  // itself refreshes only once the active run transitions to a terminal
  // status, via `candidateRefreshSignal`.
  const connectionId = connection && connection.status !== "pending" ? connection.id : null;
  useEffect(() => {
    if (!session || !organizationId || !connectionId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const items = await loadMailboxScanRuns(session!, connectionId!, getToken, organizationId);
        if (!active) return;
        setScanRuns(items);
        const latestStatus = items[0]?.status ?? null;
        const wasActive =
          previousScanStatusRef.current === "pending" || previousScanStatusRef.current === "running";
        const nowTerminal = latestStatus !== "pending" && latestStatus !== "running";
        if (wasActive && nowTerminal) setCandidateRefreshSignal((count) => count + 1);
        previousScanStatusRef.current = latestStatus;
        if (active && (latestStatus === "pending" || latestStatus === "running")) {
          timer = setTimeout(() => void poll(), 5_000);
        }
      } catch {
        if (active) setScanRuns([]);
      }
    }
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, organizationId, pollGeneration]);

  async function handleScanNow() {
    if (!session || !organizationId || !connectionId) return;
    setScanStarting(true);
    setScanActionError(null);
    try {
      await startMailboxScan(session, connectionId, getToken, organizationId);
    } catch (caught: unknown) {
      setScanActionError(
        caught instanceof MailboxConnectionError ? caught.message : "Could not start scan.",
      );
    } finally {
      setScanStarting(false);
      // Restart the poll effect from a fresh immediate fetch -- a scan
      // may now be pending/running even on a 409 skipped_overlap (someone
      // else's run is active), and the effect's own loop had already
      // stopped scheduling once the *previous* run reached a terminal
      // status.
      setPollGeneration((count) => count + 1);
    }
  }

  if (!isLoaded || !organizationLoaded) {
    return <div className="empty" aria-live="polite">Loading...</div>;
  }
  if (!isSignedIn || !session || !organizationId) {
    return <div className="empty" role="alert">Office session unavailable. Sign in again.</div>;
  }

  // Fix round 3 (Important) -- every scope the user is authorized for:
  // Personal whenever App API's scope-authorized lookup resolves one for
  // this tenant (regardless of whether the *current* session happens to
  // be business-scoped -- fix round 2's Ruling that gated this on
  // `session.scope.kind === "personal"` is superseded now that the
  // lookup route exists), plus every active business from the real
  // GET .../businesses list. None preselected.
  const scopeOptions: readonly { readonly scope: Scope; readonly label: string }[] =
    businesses === undefined || ownPersonalProfile === undefined
      ? []
      : [
          ...(ownPersonalProfile
            ? [{ scope: { kind: "personal" as const, profileId: ownPersonalProfile.id }, label: "Personal" }]
            : []),
          ...businesses.map((business) => ({
            scope: { kind: "business" as const, businessId: business.id },
            label: business.name,
          })),
        ];

  async function handleConnect() {
    if (!selectedScope || !session || !organizationId) return;
    setPhase("starting");
    setError(null);
    try {
      const result = await connectMailboxGoogle(session, selectedScope, getToken, organizationId);
      setAuthorizationUrl(result.authorizationUrl);
      setPhase("oauth-pending");
      if (typeof window !== "undefined") {
        window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (caught: unknown) {
      setPhase("error");
      setError(caught instanceof MailboxConnectionError ? caught.message : "Couldn't start the Gmail connection.");
    }
  }

  /**
   * Fix round 2 (review Important #1) -- a real OAuth re-authorization
   * attempt for this *existing* connection's own scope (App API's
   * `startConnection` reuses any non-revoked connection row for the same
   * scope rather than creating a second one -- see
   * domain/mailbox-connections.ts's `selectExistingConnectionId`), not a
   * stub. Reuses the same "waiting on Google" phase as a first-time
   * connect; a failure keeps the connected view visible with its own
   * `reconnectError` (the shared `error`/`phase` pair above only renders
   * inside the no-connection Scenario 1 view).
   */
  async function handleReconnect() {
    if (!session || !organizationId || !connection) return;
    setReconnectStarting(true);
    setReconnectError(null);
    try {
      const result = await connectMailboxGoogle(session, connection.scope, getToken, organizationId);
      setAuthorizationUrl(result.authorizationUrl);
      setPhase("oauth-pending");
      if (typeof window !== "undefined") {
        window.open(result.authorizationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (caught: unknown) {
      setReconnectError(
        caught instanceof MailboxConnectionError ? caught.message : "Couldn't start reconnection.",
      );
    } finally {
      setReconnectStarting(false);
    }
  }

  // ------------------------------------------------------------------ //
  // Scenario 2: OAuth in progress / OAuth return
  // ------------------------------------------------------------------ //
  if (phase === "oauth-pending" || phase === "oauth-return") {
    return (
      <>
        <PageHead eyebrow="Office Web · Mailbox" title="Connect a Gmail mailbox." />
        <Panel title={phase === "oauth-pending" ? "Waiting on Google" : "Finishing connection"}>
          <div role="status" aria-live="polite">
            {phase === "oauth-pending" ? (
              <>
                <p>A Google consent window opened in a new tab. Complete sign-in and grant access to continue.</p>
                {authorizationUrl && (
                  <p>
                    <a href={authorizationUrl} target="_blank" rel="noopener noreferrer">
                      Reopen the Google consent window
                    </a>
                  </p>
                )}
              </>
            ) : (
              <p>You&apos;re back from Google. Confirming granted scopes and activating the connection…</p>
            )}
          </div>
          {phase === "oauth-pending" && (
            <button type="button" className="secondary" onClick={() => setPhase("idle")}>
              Cancel connection attempt
            </button>
          )}
        </Panel>
      </>
    );
  }

  // ------------------------------------------------------------------ //
  // Loading the real connection status
  // ------------------------------------------------------------------ //
  if (connection === undefined) {
    return (
      <>
        <PageHead eyebrow="Office Web · Mailbox" title="Connect a Gmail mailbox." />
        <div className="empty" aria-live="polite">Loading mailbox status...</div>
      </>
    );
  }

  // ------------------------------------------------------------------ //
  // Scenario 1: no connection
  // ------------------------------------------------------------------ //
  if (connection === null || connection.status === "pending") {
    return (
      <>
        <PageHead eyebrow="Office Web · Mailbox" title="Connect a Gmail mailbox.">
          <p>
            Authorize read-only access to one Gmail account, bind it to exactly one Personal or business
            scope, and keep status, schedule, and reauthorization visible in one place.
          </p>
        </PageHead>
        <Panel title="No mailbox connected">
          <p>
            Connect a Gmail account to let ExpenseTax surface receipts for review. Pick the scope that will
            own this connection before continuing -- you cannot connect without choosing one.
          </p>
          <fieldset style={{ border: 0, padding: 0, margin: "14px 0 0" }}>
            <legend>
              Default Personal/business scope<span aria-hidden="true"> *</span>
            </legend>
            {businesses === undefined || ownPersonalProfile === undefined ? (
              <p aria-live="polite">Loading authorized scopes...</p>
            ) : (
              <div role="radiogroup" aria-required="true" aria-describedby="mailbox-scope-help">
                {scopeOptions.map((option) => (
                  <label key={scopeKey(option.scope)}>
                    <input
                      type="radio"
                      name="mailbox-scope"
                      value={scopeKey(option.scope)}
                      checked={selectedScope !== null && scopeKey(selectedScope) === scopeKey(option.scope)}
                      onChange={() => setSelectedScope(option.scope)}
                    />
                    <strong>{option.label}</strong>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <p id="mailbox-scope-help">
            No scope is selected by default. Choose one to enable Connect. Changing scope later requires
            disconnecting and reauthorizing.
          </p>
          <button
            type="button"
            className="primary"
            disabled={!selectedScope || phase === "starting"}
            aria-disabled={!selectedScope || phase === "starting"}
            title={selectedScope ? undefined : "Select a Personal or business scope to enable Connect"}
            onClick={() => void handleConnect()}
          >
            {phase === "starting" ? "Starting..." : "Connect Gmail"}
          </button>
          {error && (
            <p role="alert" className="status bad">
              {error}
            </p>
          )}
        </Panel>
      </>
    );
  }

  const display = mailboxStatusDisplay(connection.status);

  return (
    <>
      <PageHead eyebrow="Office Web · Mailbox" title="Connect a Gmail mailbox." />

      {/* Scenario 4: reauthorization-needed / revoked / error banners */}
      {connection.status === "reauth_required" && (
        <div className="banner warn" role="alert">
          <h3>Reconnect needed</h3>
          <p>
            Google requires renewed consent for {connection.accountEmail}. Only scanning is blocked —
            candidates already staged stay fully reviewable below.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={reconnectStarting}
            aria-disabled={reconnectStarting}
            onClick={() => void handleReconnect()}
          >
            {reconnectStarting ? "Starting..." : "Reconnect Gmail"}
          </button>
          {reconnectError && (
            <p role="alert" className="status bad">
              {reconnectError}
            </p>
          )}
        </div>
      )}
      {connection.status === "revoked" && (
        <div className="banner bad" role="alert">
          <h3>Connection revoked</h3>
          <p>Access to {connection.accountEmail} was revoked. Historical scan metadata remains for audit.</p>
        </div>
      )}
      {(connection.status === "disconnecting" || connection.status === "revocation_pending") && (
        <div className="banner warn" role="alert">
          <h3>Disconnecting</h3>
          <p>This connection is being revoked. This page updates once the broker confirms revocation.</p>
        </div>
      )}

      {/* Scenario 3: connected */}
      <Panel title="Connected mailbox">
        <div className="account-row">
          <span aria-hidden="true">G</span>
          <div>
            <p>{connection.accountEmail}</p>
            <p>
              <Status tone={display.tone}>{display.label}</Status>
            </p>
          </div>
        </div>
        <div className="field-row">
          <label>Connected since</label>
          <span>{connectionSinceLabel(connection.createdAt)}</span>
        </div>
        <div className="field-row">
          <label>Granted scope</label>
          <span>{connection.grantedScopes.join(", ") || "—"}</span>
        </div>
        <div className="field-row">
          <label>Default scope</label>
          <span>{connection.scope.kind === "business" ? session.label : "Personal"}</span>
        </div>
        <div className="field-row">
          <label>Last scan</label>
          <span>{connection.lastScanAt ? new Date(connection.lastScanAt).toLocaleString() : "Never"}</span>
        </div>
        <div className="field-row">
          <label>Next scan</label>
          <span>{connection.nextScheduleAt ? new Date(connection.nextScheduleAt).toLocaleString() : "Not scheduled"}</span>
        </div>
        {connection.status !== "revoked" && (
          <button type="button" className="danger" onClick={() => setConfirmingDisconnect(true)}>
            Disconnect
          </button>
        )}
      </Panel>

      <Panel title="Scan schedule">
        <p>Daily scan time, timezone, and enable/disable arrive with a later phase&apos;s write route.</p>
        <div className="field-row">
          <label>Last scan</label>
          <span>
            {scanRuns?.[0]?.completedAt ? new Date(scanRuns[0].completedAt).toLocaleString() : "Never"}
          </span>
        </div>
        <div className="field-row">
          <label>Last run result</label>
          <span>
            {scanRuns?.[0]
              ? `${scanRuns[0].discoveredCount} discovered · ${scanRuns[0].stagedCount} staged · ${scanRuns[0].reviewCount} review · ${scanRuns[0].duplicateCount} duplicate · ${scanRuns[0].skippedCount} skipped · ${scanRuns[0].failedCount} failed`
              : "No runs yet"}
          </span>
        </div>
        {(() => {
          const running = scanRuns?.[0]?.status === "pending" || scanRuns?.[0]?.status === "running";
          // Fix round 2 (review Important #1) -- reauth_required blocks
          // *scanning* only, not review (owner decision, mockup
          // "Reauth pauses discovery only"). "Scan now" must be disabled
          // with an accessible explanation and a reconnect path; the
          // candidate review panel below stays fully open regardless.
          const reauthBlocked = connection.status === "reauth_required";
          return (
            <>
              <button
                type="button"
                className="secondary"
                disabled={scanStarting || running || reauthBlocked}
                aria-disabled={scanStarting || running || reauthBlocked}
                title={
                  reauthBlocked
                    ? "Reconnect Gmail to resume scanning"
                    : running
                      ? "A scan is already running"
                      : undefined
                }
                onClick={() => void handleScanNow()}
              >
                {scanStarting ? "Starting..." : "Scan now"}
              </button>
              {reauthBlocked && (
                <p role="status">
                  Scanning is paused until you reconnect Gmail. Review of already-staged candidates stays
                  open below.
                </p>
              )}
              {running && (
                <p role="status" aria-live="polite">
                  Scan in progress — {scanRuns?.[0]?.discoveredCount ?? 0} discovered so far. The candidate
                  list below refreshes once this run completes.
                </p>
              )}
            </>
          );
        })()}
        {scanActionError && (
          <p role="alert" className="status bad">
            {scanActionError}
          </p>
        )}
      </Panel>

      <Panel title="Reviewer grants">
        <p>No reviewers added. Owners can grant read-only review access to this connection&apos;s scope.</p>
        <button type="button" className="secondary" aria-disabled="true" title="Reserved for a later phase">
          Add reviewer
        </button>
      </Panel>

      <MailboxCandidateReviewPanel
        session={session}
        connectionId={connection.id}
        scopeOptions={scopeOptions}
        refreshSignal={candidateRefreshSignal}
      />

      <MailboxIngestionStatusPanel
        session={session}
        connectionId={connection.id}
        connectionStatus={connection.status}
        refreshSignal={candidateRefreshSignal}
      />

      {/* Scenario 5: disconnect confirmation */}
      {confirmingDisconnect && (
        <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="disconnect-heading">
          <h2 id="disconnect-heading">Disconnect Gmail?</h2>
          <p>
            This immediately revokes ExpenseTax&apos;s access to <strong>{connection.accountEmail}</strong>.
            Already-ingested expenses are not deleted. Minimal scan history remains for audit and duplicate
            prevention.
          </p>
          {disconnectNote && <p role="status">{disconnectNote}</p>}
          <div className="actions">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setConfirmingDisconnect(false);
                setDisconnectNote(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              onClick={() =>
                setDisconnectNote(
                  "Disconnect isn't available yet -- the customer-facing revoke route arrives with a later phase.",
                )
              }
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ //
// Candidate review queue (Phase 3D-B Task 5)
// ------------------------------------------------------------------ //

type MailboxCandidateItem = Awaited<ReturnType<typeof loadMailboxCandidates>>["items"][number];

interface CandidateGroupState {
  readonly items: readonly MailboxCandidateItem[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_CANDIDATE_GROUP: CandidateGroupState = {
  items: [],
  nextCursor: null,
  loading: false,
  error: null,
};

export function MailboxCandidateReviewPanel({
  session,
  connectionId,
  scopeOptions,
  refreshSignal,
}: {
  session: OfficeSession;
  connectionId: string;
  scopeOptions: readonly { readonly scope: Scope; readonly label: string }[];
  refreshSignal: number;
}) {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const organizationId = organization?.id ?? null;

  const [groups, setGroups] = useState<Record<MailboxCandidateClassification, CandidateGroupState>>({
    receipt: EMPTY_CANDIDATE_GROUP,
    ambiguous: EMPTY_CANDIDATE_GROUP,
    not_receipt: EMPTY_CANDIDATE_GROUP,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedScopeKey, setSelectedScopeKey] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function loadGroup(classification: MailboxCandidateClassification, cursor?: string) {
    if (!organizationId) return;
    setGroups((current) => ({
      ...current,
      [classification]: { ...current[classification], loading: true, error: null },
    }));
    try {
      const data = await loadMailboxCandidates(
        session,
        connectionId,
        classification,
        getToken,
        organizationId,
        cursor,
      );
      setGroups((current) => ({
        ...current,
        [classification]: {
          items: cursor ? [...current[classification].items, ...data.items] : data.items,
          nextCursor: data.nextCursor,
          loading: false,
          error: null,
        },
      }));
    } catch (caught: unknown) {
      setGroups((current) => ({
        ...current,
        [classification]: {
          ...current[classification],
          loading: false,
          error: caught instanceof Error ? caught.message : "Could not load candidates",
        },
      }));
    }
  }

  useEffect(() => {
    if (!organizationId) return;
    void loadGroup("receipt");
    void loadGroup("ambiguous");
    void loadGroup("not_receipt");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, organizationId, refreshSignal]);

  const selected = selectedId
    ? ([...groups.receipt.items, ...groups.ambiguous.items, ...groups.not_receipt.items].find(
        (candidate) => candidate.id === selectedId,
      ) ?? null)
    : null;

  async function resolve(candidate: MailboxCandidateItem, action: MailboxCandidateReviewAction) {
    if (!organizationId) return;
    setWorking(true);
    setActionError(null);
    try {
      let scope: Scope | undefined;
      if (action === "ingest") {
        const option = scopeOptions.find((candidateOption) => scopeKey(candidateOption.scope) === selectedScopeKey);
        if (!option) {
          setActionError("Choose a scope above to enable approval.");
          setWorking(false);
          return;
        }
        scope = option.scope;
      }
      await resolveMailboxCandidate(
        session,
        connectionId,
        candidate.id,
        action,
        candidate.version,
        getToken,
        organizationId,
        scope,
      );
      setGroups((current) => ({
        ...current,
        [candidate.classification]: {
          ...current[candidate.classification],
          items: current[candidate.classification].items.filter((item) => item.id !== candidate.id),
        },
      }));
      if (selectedId === candidate.id) {
        setSelectedId(null);
        setSelectedScopeKey(null);
      }
    } catch (caught: unknown) {
      if (caught instanceof MailboxCandidateError && caught.status === 409) {
        setActionError("This candidate changed. Refreshing review list.");
        void loadGroup(candidate.classification);
      } else {
        setActionError(caught instanceof Error ? caught.message : "Action failed");
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <Panel title="Candidate review queue">
      {actionError && (
        <p role="alert" className="status bad">
          {actionError}
        </p>
      )}
      {MAILBOX_CANDIDATE_CLASSIFICATION_GROUPS.map((group) => {
        const state = groups[group.classification];
        return (
          <section key={group.classification} aria-label={`${group.label} candidates`}>
            <h3>
              {group.label} <span>{state.items.length}</span>
            </h3>
            {state.error && (
              <p role="alert" className="status bad">
                {state.error}
              </p>
            )}
            {state.items.length === 0 && !state.loading ? (
              <p role="status">{group.emptyMessage}</p>
            ) : (
              <ul>
                {state.items.map((candidate) => (
                  <li key={candidate.id}>
                    <article
                      aria-labelledby={`mailbox-candidate-${candidate.id}-sender`}
                      aria-current={selectedId === candidate.id}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedId(candidate.id);
                          setSelectedScopeKey(null);
                          setActionError(null);
                        }}
                      >
                        <span id={`mailbox-candidate-${candidate.id}-sender`}>{candidate.senderAddress}</span>
                        <Status tone={candidate.scope ? "ok" : "warn"}>
                          {candidate.scope
                            ? candidate.scope.kind === "personal"
                              ? "Scope: Personal"
                              : "Scope: Business"
                            : "Scope: unassigned"}
                        </Status>
                        <p>{candidate.subject}</p>
                        <p>{new Date(candidate.receivedAt).toLocaleString()}</p>
                        <p>
                          {candidate.attachmentManifest.length > 0
                            ? `${candidate.attachmentManifest.length} attachment(s)`
                            : "No attachment"}
                        </p>
                        <p>
                          {candidate.evidence.map((code) => (
                            <span key={code} className="tag-chip-display">
                              {mailboxReasonCodeLabel(code)}
                            </span>
                          ))}
                        </p>
                      </button>
                    </article>
                  </li>
                ))}
              </ul>
            )}
            {state.nextCursor && (
              <button
                type="button"
                disabled={state.loading}
                aria-busy={state.loading}
                onClick={() => void loadGroup(group.classification, state.nextCursor ?? undefined)}
              >
                {state.loading ? "Loading more..." : "Load more"}
              </button>
            )}
          </section>
        );
      })}

      {selected && (
        <aside aria-labelledby="mailbox-candidate-detail-heading">
          <h3 id="mailbox-candidate-detail-heading">{selected.senderAddress}</h3>
          <p>{selected.subject}</p>
          <p>
            {selected.classification} · {Math.round(selected.confidence * 100)}% confidence
          </p>
          <p>
            {selected.evidence.map((code) => (
              <span key={code} className="tag-chip-display">
                {mailboxReasonCodeLabel(code)}
              </span>
            ))}
          </p>

          {/* Fix round 2 (review Important #2) -- the approved gate's
              metadata fields (plans/mockups/office-mailbox-review/
              review.html): candidate/scan-run IDs, content fingerprint,
              and per-attachment name/type/size/hash. Metadata only --
              `MailboxCandidateV1` carries no body/HTML/content field to
              render in the first place. */}
          <div style={{ marginTop: 16 }}>
            <div className="field-row">
              <label>Received</label>
              <span>{new Date(selected.receivedAt).toLocaleString()}</span>
            </div>
            <div className="field-row">
              <label>Candidate ID</label>
              <span>{selected.id}</span>
            </div>
            <div className="field-row">
              <label>Scan run</label>
              <span>{selected.scanRunId}</span>
            </div>
            <div className="field-row">
              <label>Content fingerprint</label>
              <span>sha256:{selected.contentHash}</span>
            </div>
          </div>

          {selected.attachmentManifest.length > 0 && (
            <>
              <h4>Attachments (metadata only)</h4>
              {selected.attachmentManifest.map((attachment) => (
                <div className="field-row" key={attachment.sha256}>
                  <label>{attachment.name}</label>
                  <span>
                    {attachment.mimeType} · {attachment.sizeBytes} bytes · sha256:{attachment.sha256}
                  </span>
                </div>
              ))}
            </>
          )}

          <fieldset style={{ border: 0, padding: 0, margin: "14px 0 0" }}>
            <legend>
              Assign scope before approving<span aria-hidden="true"> *</span>
            </legend>
            <div role="radiogroup" aria-required="true">
              {scopeOptions.map((option) => (
                <label key={scopeKey(option.scope)}>
                  <input
                    type="radio"
                    name="mailbox-candidate-scope"
                    checked={selectedScopeKey === scopeKey(option.scope)}
                    onChange={() => setSelectedScopeKey(scopeKey(option.scope))}
                  />
                  <strong>{option.label}</strong>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="toolbar">
            <button
              type="button"
              className="primary"
              disabled={working || !selectedScopeKey}
              aria-disabled={working || !selectedScopeKey}
              title={selectedScopeKey ? undefined : "Choose a scope above to enable approval"}
              onClick={() => void resolve(selected, "ingest")}
            >
              {mailboxCandidateReviewActionLabel("ingest")}
            </button>
            <button type="button" disabled={working} onClick={() => void resolve(selected, "skip")}>
              {mailboxCandidateReviewActionLabel("skip")}
            </button>
            <button type="button" disabled={working} onClick={() => void resolve(selected, "not_receipt")}>
              {mailboxCandidateReviewActionLabel("not_receipt")}
            </button>
          </div>
        </aside>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ //
// Ingestion status board (Phase 3D-C Task 6)
//
// Per-candidate status after "Approve for ingestion" -- the approved
// gate (plans/mockups/office-mailbox-ingestion/). Reuses the existing
// candidate list route with no classification filter (no backend
// change -- see task-6-report.md Ruling 1); grouping/pagination is
// therefore one shared feed bucketed client-side into the gate's three
// sections, rather than the mockup's three independent per-status
// cursors, which the real list route has no status filter to support
// (Ruling 2).
// ------------------------------------------------------------------ //

type MailboxIngestionItem = Awaited<ReturnType<typeof loadMailboxIngestionCandidates>>["items"][number];

function MailboxIngestionStatusPanel({
  session,
  connectionId,
  connectionStatus,
  refreshSignal,
}: {
  session: OfficeSession;
  connectionId: string;
  connectionStatus: MailboxConnectionStatus;
  refreshSignal: number;
}) {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const organizationId = organization?.id ?? null;

  const [rawItems, setRawItems] = useState<readonly MailboxIngestionItem[] | undefined>(undefined);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(new Set());
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const accessMessage = mailboxIngestionAccessMessage(connectionStatus);

  useEffect(() => {
    if (!organizationId || accessMessage) return;
    let active = true;
    async function load() {
      setRawItems(undefined);
      setListError(null);
      try {
        const data = await loadMailboxIngestionCandidates(session, connectionId, getToken, organizationId);
        if (!active) return;
        setRawItems(data.items);
        setNextCursor(data.nextCursor);
      } catch (caught: unknown) {
        if (!active) return;
        setRawItems([]);
        setListError(caught instanceof Error ? caught.message : "Could not load ingestion status.");
      }
    }
    void load();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, organizationId, refreshSignal, accessMessage]);

  async function loadMore() {
    if (!organizationId || !nextCursor) return;
    setLoadingMore(true);
    try {
      const data = await loadMailboxIngestionCandidates(session, connectionId, getToken, organizationId, nextCursor);
      setRawItems((current) => [...(current ?? []), ...data.items]);
      setNextCursor(data.nextCursor);
    } catch (caught: unknown) {
      setListError(caught instanceof Error ? caught.message : "Could not load more ingestion status.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function act(candidate: MailboxIngestionItem, action: MailboxIngestionAction) {
    if (action.kind === "dismiss") {
      setDismissedIds((current) => new Set(current).add(candidate.id));
      return;
    }
    if (action.kind === "viewExpense" || action.kind === "viewDuplicate") return;
    if (!organizationId) return;
    // "retryIngest" re-approves a candidate a prior retry already cleared
    // back to "review" -- same scope, no reviewer input needed (approved
    // gate: "Approve again to retry -- the same scope is reused").
    const reviewAction: MailboxCandidateReviewAction = action.kind === "retryIngest" ? "ingest" : "retry";
    if (reviewAction === "ingest" && !candidate.scope) return;
    setWorkingId(candidate.id);
    setActionError(null);
    try {
      const updated = await resolveMailboxCandidate(
        session,
        connectionId,
        candidate.id,
        reviewAction,
        candidate.version,
        getToken,
        organizationId,
        reviewAction === "ingest" ? (candidate.scope ?? undefined) : undefined,
      );
      setRawItems((current) => (current ?? []).map((item) => (item.id === candidate.id ? updated : item)));
    } catch (caught: unknown) {
      if (caught instanceof MailboxCandidateError && caught.status === 409) {
        setActionError(mailboxIngestionConflictMessage(caught.status));
        if (organizationId) {
          void loadMailboxIngestionCandidates(session, connectionId, getToken, organizationId).then((data) => {
            setRawItems(data.items);
            setNextCursor(data.nextCursor);
          });
        }
      } else {
        setActionError(caught instanceof Error ? caught.message : "Action failed.");
      }
    } finally {
      setWorkingId(null);
    }
  }

  if (accessMessage) {
    return (
      <Panel title="Ingestion status">
        <p role="status">{accessMessage}</p>
      </Panel>
    );
  }

  const ingestionItems = (rawItems ?? []).filter(
    (item) => isMailboxIngestionCandidate(item) && !dismissedIds.has(item.id),
  );

  return (
    <Panel title="Ingestion status">
      <p>
        Once a candidate is approved for ingestion, it moves here -- status text and counts only. No
        provider message IDs, attachment bytes, or message content ever render in Office.
      </p>
      {listError && (
        <p role="alert" className="status bad">
          {listError}
        </p>
      )}
      {actionError && (
        <p role="alert" className="status bad">
          {actionError}
        </p>
      )}
      {rawItems === undefined ? (
        <p aria-live="polite">Loading ingestion status...</p>
      ) : ingestionItems.length === 0 ? (
        <p role="status">
          No ingestion activity yet. Approve a candidate from the review queue above to see its status here.
        </p>
      ) : (
        MAILBOX_INGESTION_GROUPS.map((group) => {
          const items = ingestionItems.filter((item) => mailboxIngestionBucket(item) === group.bucket);
          return (
            <section key={group.bucket} aria-label={`${group.label} ingestion candidates`}>
              <h3>
                {group.label} <span>{items.length}</span>
              </h3>
              {items.length === 0 ? (
                <p role="status">{group.emptyMessage}</p>
              ) : (
                <ul>
                  {items.map((candidate) => {
                    const display = mailboxIngestionStatusDisplay(candidate);
                    const busy = workingId === candidate.id;
                    return (
                      <li key={candidate.id}>
                        <article aria-labelledby={`mailbox-ingestion-${candidate.id}-sender`} role="status">
                          <span id={`mailbox-ingestion-${candidate.id}-sender`}>{candidate.senderAddress}</span>
                          <Status tone={display.tone}>{display.label}</Status>
                          <p>{candidate.subject}</p>
                          <p>{display.note}</p>
                          <p>
                            Scope:{" "}
                            {candidate.scope
                              ? candidate.scope.kind === "personal"
                                ? "Personal"
                                : "Business"
                              : "unassigned"}
                          </p>
                          {display.action?.kind === "retry" && (
                            <button type="button" disabled={busy} onClick={() => void act(candidate, display.action!)}>
                              {busy ? "Retrying..." : "Retry"}
                            </button>
                          )}
                          {display.action?.kind === "retryIngest" && (
                            <button type="button" disabled={busy} onClick={() => void act(candidate, display.action!)}>
                              {busy ? "Retrying..." : "Retry"}
                            </button>
                          )}
                          {display.action?.kind === "dismiss" && (
                            <button type="button" disabled={busy} onClick={() => void act(candidate, display.action!)}>
                              Dismiss
                            </button>
                          )}
                          {display.action?.kind === "viewExpense" && (
                            <Link href={`/expenses/${display.action.expenseId}`}>View expense →</Link>
                          )}
                          {display.action?.kind === "viewDuplicate" && (
                            <Link href={MAILBOX_DUPLICATES_HREF}>Review duplicate match →</Link>
                          )}
                          <details>
                            <summary>Support details</summary>
                            <div className="field-row">
                              <label>Candidate ID</label>
                              <span>{candidate.id}</span>
                            </div>
                          </details>
                        </article>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })
      )}
      {nextCursor && (
        <button type="button" disabled={loadingMore} aria-busy={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? "Loading more..." : "Load more"}
        </button>
      )}
    </Panel>
  );
}
