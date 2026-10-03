"use client";
import { useAuth, useOrganization } from "@clerk/nextjs";
import type { Scope } from "@expense-tax/contracts";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Panel, PageHead, Status } from "@/components/ui";
import { MailboxConnectionError } from "@/lib/api";
import { connectMailboxGoogle, mailboxStatusDisplay } from "@/lib/mailbox";
import { loadAuthorizedBusinesses, loadMailboxConnection } from "@/lib/page-data";
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
  const [phase, setPhase] = useState<Phase>(
    searchParams.get("status") === "connected" ? "oauth-return" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [connection, setConnection] = useState<Awaited<ReturnType<typeof loadMailboxConnection>> | undefined>(
    undefined,
  );
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnectNote, setDisconnectNote] = useState<string | null>(null);

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

  if (!isLoaded || !organizationLoaded) {
    return <div className="empty" aria-live="polite">Loading...</div>;
  }
  if (!isSignedIn || !session || !organizationId) {
    return <div className="empty" role="alert">Office session unavailable. Sign in again.</div>;
  }

  // Fix round 2 (Important) -- every scope the user is authorized for:
  // Personal when the current session already knows its profile ID (App
  // API exposes no standalone "look up this tenant's personal profile"
  // route yet -- see the report's Ruling), plus every active business
  // from the real GET .../businesses list. None preselected.
  const scopeOptions: readonly { readonly scope: Scope; readonly label: string }[] =
    businesses === undefined
      ? []
      : [
          ...(session.scope.kind === "personal" ? [{ scope: session.scope, label: "Personal" }] : []),
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
            {businesses === undefined ? (
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
            Google requires renewed consent for {connection.accountEmail}. Receipt scans are paused until
            you reconnect.
          </p>
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
        <p>Daily scan time, timezone, and enable/disable arrive with Phase 3D-B&apos;s scheduling write route.</p>
        <button type="button" className="secondary" disabled aria-disabled="true" title="Reserved for Phase 3D-B">
          Scan now
        </button>
      </Panel>

      <Panel title="Reviewer grants">
        <p>No reviewers added. Owners can grant read-only review access to this connection&apos;s scope.</p>
        <button type="button" className="secondary" aria-disabled="true" title="Reserved for Phase 3D-B review workflow">
          Add reviewer
        </button>
      </Panel>

      <Panel title="Candidate review queue" className="placeholder-card">
        <p>
          Reserved layout region. Scan runs, staged candidates, and ingest/skip/not-receipt actions arrive
          with Phase 3D-B and extend this same page.
        </p>
      </Panel>

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
