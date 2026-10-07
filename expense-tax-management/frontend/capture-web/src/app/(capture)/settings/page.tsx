"use client";

import { useAuth, useOrganization } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useState } from "react";

import { fetchTenantScopes } from "@/lib/api";
import { readSession, writeSession, type CaptureScope } from "@/lib/session";

function scopeKey(scope: CaptureScope): string {
  return scope.kind === "personal" ? `personal:${scope.profileId}` : `business:${scope.businessId}`;
}

export default function SettingsPage() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();
  const session = isLoaded && isSignedIn ? readSession() : null;

  const [activeScope, setActiveScope] = useState<CaptureScope | null>(session?.scope ?? null);
  const [choices, setChoices] = useState<readonly CaptureScope[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !organizationLoaded || !organization || !session) return;
    let active = true;
    void fetchTenantScopes(session, getToken, organization.id)
      .then((scopes) => {
        if (!active) return;
        setChoices([
          ...scopes.personalProfiles.map(
            (profile): CaptureScope => ({ kind: "personal", profileId: profile.id, label: profile.name }),
          ),
          ...scopes.businesses.map(
            (business): CaptureScope => ({ kind: "business", businessId: business.id, label: business.name }),
          ),
        ]);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : "Profiles unavailable");
      });
    return () => {
      active = false;
    };
  }, [getToken, isLoaded, isSignedIn, organization, organizationLoaded, session]);

  function choose(scope: CaptureScope) {
    if (!session) return;
    writeSession({ ...session, scope });
    setActiveScope(scope);
  }

  return (
    <>
      <header className="page-head">
        <div>
          <p className="kicker">Account + profile</p>
          <h1>Small controls,<br />clear scope.</h1>
          <p>Dense administration stays in Office.</p>
        </div>
      </header>
      <section className="settings-grid">
        <article className="panel">
          <h2>Active profile</h2>
          {error && <div className="inline-error" role="alert">{error}</div>}
          {choices === undefined && !error && <p>Loading profiles...</p>}
          {choices?.map((choice) => (
            <button
              key={scopeKey(choice)}
              type="button"
              className={`profile-choice${activeScope && scopeKey(activeScope) === scopeKey(choice) ? " active" : ""}`}
              onClick={() => choose(choice)}
            >
              {choice.label}
              <span>{choice.kind === "personal" ? "Owner" : "Business · Owner"}</span>
            </button>
          ))}
        </article>
        <article className="panel">
          <h2>Office handoff</h2>
          <p>Open ledger, projects, tax preparation, and export history on a laptop.</p>
          <Link className="primary link-button" href={process.env.NEXT_PUBLIC_OFFICE_URL ?? "http://localhost:7302"}>
            Open ExpenseTax Office
          </Link>
        </article>
        <article className="panel">
          <h2>Install Capture</h2>
          <p>Use the browser install action for a camera-first standalone experience.</p>
        </article>
      </section>
    </>
  );
}
