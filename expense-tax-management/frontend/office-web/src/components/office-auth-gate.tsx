"use client";

import { OrganizationSwitcher, SignIn, useAuth, useOrganization } from "@clerk/nextjs";
import { useEffect, useState, type ReactNode } from "react";
import { getTenantGateState } from "@/lib/clerk";
import { readOfficeSession } from "@/lib/session";
import { bootstrapOfficeSession } from "@/lib/session-bootstrap";

export function OfficeAuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();
  const [sessionReady, setSessionReady] = useState(() => readOfficeSession() !== null);
  const [error, setError] = useState<string | null>(null);

  const state = getTenantGateState({ isLoaded: isLoaded && organizationLoaded, isSignedIn, organizationId: organization?.id });

  useEffect(() => {
    if (state !== "ready" || sessionReady) return;
    let active = true;
    void bootstrapOfficeSession({
      getToken,
      organizationId: organization?.id,
      apiBaseUrl: process.env.NEXT_PUBLIC_APP_API_URL ?? "http://127.0.0.1:8100",
    }).then((result) => {
      if (!active) return;
      if (result.status === "ok") {
        setSessionReady(true);
        setError(null);
      } else {
        setError(result.message);
      }
    });
    return () => {
      active = false;
    };
  }, [state, sessionReady, getToken, organization?.id]);

  if (state === "loading") {
    return <main className="auth"><p>Loading secure workspace...</p></main>;
  }
  if (state === "signed-out") {
    return <main className="auth"><SignIn routing="hash" /></main>;
  }
  if (state === "missing-organization") {
    return <main className="auth"><h1>Select an organization</h1><p>Choose active organization before accessing Office.</p><OrganizationSwitcher afterSelectOrganizationUrl="/dashboard" /></main>;
  }
  if (!sessionReady) {
    if (error) {
      return <main className="auth"><h1>Session unavailable</h1><p>{error}</p></main>;
    }
    return <main className="auth"><p>Preparing your workspace...</p></main>;
  }
  return children;
}
