"use client";

import { useEffect } from "react";
import { safeReturnTo } from "@/lib/auth";

// The MiroFish Worker sends an unauthenticated visitor here as
// `/login?returnTo=<url>` (01e design, step 5). The root layout's
// AuthGate already blocks this page's children until Clerk sign-in AND the
// gateway session exchange both succeed, so by the time this component's
// effect runs the session cookie already exists. Only then does returnTo
// get a chance to send the browser on to the allowed MiroFish host;
// anything else (missing, malformed, or any other host) goes to the hub.
//
// Markup is static and environment-independent on purpose (round-1 fix):
// the destination is only knowable client-side (window.location.search),
// so it is computed and used purely to navigate away inside an effect --
// an external-system side effect, not React state. The previous version
// computed it in a useState lazy initializer, which runs during the
// client's first (hydration) render; that made the hydration render's
// output differ from the server's static prerender whenever `?returnTo=`
// was present (the server has no `window`), which is a hydration
// mismatch. Rendering identical text regardless of the destination avoids
// that mismatch entirely -- there is nothing destination-dependent to
// diverge.
export default function LoginPage() {
  useEffect(() => {
    const target = safeReturnTo(new URLSearchParams(window.location.search).get("returnTo"));
    window.location.replace(target);
  }, []);

  return (
    <main className="flex h-dvh items-center justify-center">
      <p className="text-muted-foreground">Signed in. Redirecting…</p>
    </main>
  );
}
