"use client";

import { OrganizationSwitcher, SignIn, useAuth, useOrganization } from "@clerk/nextjs";
import { useEffect, useState, type ReactNode } from "react";
import { getTenantGateState } from "@/lib/clerk";
import { readSession } from "@/lib/session";
import { bootstrapCaptureSession } from "@/lib/session-bootstrap";

export function CaptureAuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { organization, isLoaded: organizationLoaded } = useOrganization();
  const [sessionReady, setSessionReady] = useState(() => readSession() !== null);
  const [error, setError] = useState<string | null>(null);

  const state = getTenantGateState({ isLoaded: isLoaded && organizationLoaded, isSignedIn, organizationId: organization?.id });

  useEffect(() => {
    if (state !== "ready" || sessionReady) return;
    let active = true;
    void bootstrapCaptureSession({
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
    return <main className="auth"><h1>Select an organization</h1><p>Choose active organization before accessing Capture.</p><OrganizationSwitcher afterSelectOrganizationUrl="/capture" /></main>;
  }
  if (!sessionReady) {
    if (error) {
      return <main className="auth"><h1>Session unavailable</h1><p>{error}</p></main>;
    }
    return <main className="auth"><p>Preparing your workspace...</p></main>;
  }
  return children;
}
