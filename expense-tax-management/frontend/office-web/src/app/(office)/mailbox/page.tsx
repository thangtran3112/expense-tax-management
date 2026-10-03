"use client";
import { useAuth, useOrganization } from "@clerk/nextjs";
import { useState } from "react";
import { Panel, PageHead, Status } from "@/components/ui";
import { MailboxConnectionError } from "@/lib/api";
import { connectMailboxGoogle, mailboxStatusDisplay } from "@/lib/mailbox";
import { readOfficeSession } from "@/lib/session";

/**
 * Office mailbox base (Phase 3D-A Task 4). Owns connect/account/status/
 * schedule/reviewer layout per the approved mockup
 * (plans/mockups/office-mailbox). Phase 3D-B extends this same page with
 * scan history + candidate review; Phase 3D-C extends it with ingestion
 * status -- neither exists yet, so "Candidate review queue" below is a
 * reserved placeholder, matching the mockup.
 *
 * Scope selection: the mockup illustrates Personal and a named business as
 * two simultaneously selectable radio options. This Office session only
 * ever carries ONE active scope at a time (no API in this task's scope
 * lists every scope the user could pick from) -- so the radio here offers
 * exactly the session's own current scope. The owner's approved decision
 * (no preselected scope; Connect disabled until explicitly chosen) is
 * still honored: the radio starts unselected and Connect stays disabled
 * until the user clicks it.
 *
 * No live "connected account" read endpoint exists yet (Task 2/4 only
 * built start/consume/complete/revoke -- no GET). The "Connected",
 * "Needs attention", and "Disconnect confirmation" sections below are
 * static, mockup-faithful scaffold (same fidelity as the existing
 * forwarding/exports pages' own placeholder content) until a later task
 * adds a real status read.
 */

type Phase = "idle" | "starting" | "oauth-pending" | "error";

export default function MailboxPage() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();
  const session = isLoaded && isSignedIn ? readOfficeSession() : null;
  const [scopeChosen, setScopeChosen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);

  if (!isLoaded || !organizationLoaded) {
    return <div className="empty" aria-live="polite">Loading...</div>;
  }
  if (!isSignedIn || !session || !organization) {
    return <div className="empty" role="alert">Office session unavailable. Sign in again.</div>;
  }

  const scopeLabel = session.scope.kind === "business" ? session.label : "Personal";

  async function handleConnect() {
    if (!scopeChosen || !session || !organization) return;
    setPhase("starting");
    setError(null);
    try {
      const result = await connectMailboxGoogle(session, getToken, organization.id);
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

  return (
    <>
      <PageHead eyebrow="Office Web · Mailbox" title="Connect a Gmail mailbox.">
        <p>
          Authorize read-only access to one Gmail account, bind it to exactly one Personal or business
          scope, and keep status, schedule, and reauthorization visible in one place. Candidate review and
          scan history arrive with Phase 3D-B.
        </p>
      </PageHead>

      {phase !== "oauth-pending" && (
        <Panel title="No mailbox connected">
          <p>
            Connect a Gmail account to let ExpenseTax surface receipts for review. Pick the scope that will
            own this connection before continuing -- you cannot connect without choosing one.
          </p>
          <fieldset style={{ border: 0, padding: 0, margin: "14px 0 0" }}>
            <legend>
              Default Personal/business scope<span aria-hidden="true"> *</span>
            </legend>
            <div role="radiogroup" aria-required="true" aria-describedby="mailbox-scope-help">
              <label>
                <input
                  type="radio"
                  name="mailbox-scope"
                  value={session.scope.kind}
                  checked={scopeChosen}
                  onChange={() => setScopeChosen(true)}
                />
                <strong>{scopeLabel}</strong>
              </label>
            </div>
          </fieldset>
          <p id="mailbox-scope-help">
            No scope is selected by default. Choose one to enable Connect. Changing scope later requires
            disconnecting and reauthorizing.
          </p>
          <button
            type="button"
            className="primary"
            disabled={!scopeChosen || phase === "starting"}
            aria-disabled={!scopeChosen || phase === "starting"}
            title={scopeChosen ? undefined : "Select a Personal or business scope to enable Connect"}
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
      )}

      {phase === "oauth-pending" && (
        <Panel title="Waiting on Google" className="status-panel">
          <div role="status" aria-live="polite">
            <p>
              A Google consent window opened in a new tab. Complete sign-in and grant access to continue.
            </p>
            {authorizationUrl && (
              <p>
                <a href={authorizationUrl} target="_blank" rel="noopener noreferrer">
                  Reopen the Google consent window
                </a>
              </p>
            )}
          </div>
          <button type="button" className="secondary" onClick={() => setPhase("idle")}>
            Cancel connection attempt
          </button>
        </Panel>
      )}

      <Panel title="Scan schedule">
        <div className="field-row">
          <label htmlFor="mailbox-scan-time">Daily scan time</label>
          <input id="mailbox-scan-time" type="time" defaultValue="07:00" disabled />
        </div>
        <div className="field-row">
          <label htmlFor="mailbox-scan-enabled">Enabled</label>
          <input id="mailbox-scan-enabled" type="checkbox" disabled />
        </div>
        <p>Overlapping runs are skipped automatically; a manual run never races the scheduled one.</p>
        <button type="button" className="secondary" disabled aria-disabled="true" title="Reserved until a mailbox is connected">
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

      <Panel title="Status reference">
        <ul>
          {(
            [
              "pending",
              "active",
              "paused",
              "reauth_required",
              "disconnecting",
              "revocation_pending",
              "revoked",
            ] as const
          ).map((status) => {
            const display = mailboxStatusDisplay(status);
            return (
              <li key={status}>
                <Status tone={display.tone}>{display.label}</Status>
              </li>
            );
          })}
        </ul>
      </Panel>
    </>
  );
}
