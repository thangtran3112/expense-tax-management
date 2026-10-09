"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { SignIn, useAuth } from "@clerk/react";
import type { ReactNode } from "react";
import {
  applyExchangeResult,
  createSerialExchangeQueue,
  createSessionGatedTask,
  getGateState,
  initialSessionGateState,
  resetForSession,
  signOutTradingSession,
  SESSION_REFRESH_INTERVAL_MS,
  type ExchangeQueue,
} from "@/lib/auth";

type SignOutStatus = "idle" | "pending" | "error";
const TradingSignOutContext = createContext<(() => Promise<void>) | null>(null);

export function useTradingSignOut() {
  const signOut = useContext(TradingSignOutContext);
  if (!signOut) throw new Error("Account controls require AuthGate");
  return signOut;
}

// --- Known, operator-facing limitation: an indefinite liveness ceiling --
//
// Round 4 added a manual "Reload the page" button here, reasoning that a
// full reload is safe because it tears down the JS realm. Round-5 review
// (and the controller's ruling) found that reasoning wrong: a reload
// does not synchronously cancel an in-flight request at the network
// layer in every browser, and cookies are a *browser*, not a *page*,
// concept -- if session A's exchange is genuinely active (not hung, just
// normally in flight) when the user hits Reload, the old request's
// response can still arrive and apply its Set-Cookie *after* the
// reloaded page has already started (and possibly finished) its own
// fresh exchange for a new session, with nothing coordinating between
// the two realms (the in-memory queue does not survive a reload). That
// button has been **removed**. Retry (below, on the error screen only)
// is not the same hazard: it stays inside this same JS realm and enqueues
// onto the very same queue, so it can only ever wait behind whatever is
// already queued -- never race it. A queue that never aborts an active
// exchange (round 3) therefore has a real, accepted cost: if a network
// request genuinely stalls (the connection drops without `fetch`'s own
// -- nonexistent by default -- timeout firing), every later exchange for
// this gate (a session switch, the next 20-minute refresh, a Retry
// click) waits behind it for as long as it takes the browser or network
// to resolve that, with **no automatic recovery and no in-app escape
// hatch**. This is accepted, not overlooked: the alternatives (abort the
// active exchange, or let the queue move on without it) are exactly the
// Set-Cookie ordering race rounds 2-3 exist to close, and are worse.
// Combined with the stateless cookie's own up-to-3600-second post-signout
// replay window (see `SESSION_REFRESH_INTERVAL_MS`'s comment in
// `lib/auth.ts`), both ceilings are explicit tradeoffs of this MVP's
// stateless design that the operator should accept
// before production activation, not implementation gaps to silently
// patch over with something that looks like a fix but reopens a race.

// Clerk reporting signed-in is not enough: the gateway's own
// `Secure; HttpOnly` session cookie (ai-trading/auth) must exist before any
// protected child renders, or the terminal iframes/WebSockets race ahead of
// the cookie and hit a 401. Hold "pending" (same loading UI) until the
// POST /__auth/session exchange returns 204; on failure, show a retry
// button instead of the children.
//
// Readiness is tied to Clerk's `sessionId`, not a bare status (round-1
// review): `resetForSession` demotes to "pending" -- hiding children --
// the instant the session changes, including on sign-out (sessionId
// becomes null) or a session switch (sessionId changes while still signed
// in). That reset happens synchronously during render (the documented
// "adjusting state when a prop changes" pattern), so there is no frame
// where stale children are visible under a new session.
export function AuthGate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, sessionId, getToken, signOut } = useAuth();
  const gateState = getGateState({ isLoaded, isSignedIn });
  const currentSessionId = sessionId ?? null;

  const [sessionGateState, setSessionGateState] = useState(() => initialSessionGateState(currentSessionId));
  const resetState = resetForSession(sessionGateState, currentSessionId);
  if (resetState !== sessionGateState) setSessionGateState(resetState);

  const [attempt, setAttempt] = useState(0);
  const [signOutStatus, setSignOutStatus] = useState<SignOutStatus>("idle");
  const signOutStatusRef = useRef<SignOutStatus>("idle");

  // One serializer for this gate's whole lifetime: every exchange it ever
  // issues -- across every session change and every refresh tick --
  // enqueues onto it, so at most one POST /__auth/session is ever in
  // flight at a time (see createSerialExchangeQueue for why sessionId-tied
  // state alone doesn't guarantee cookie ordering, only this does, and
  // why it must never be paired with aborting an active exchange).
  const queueRef = useRef<ExchangeQueue | null>(null);
  if (queueRef.current === null) {
    queueRef.current = createSerialExchangeQueue();
  }

  // The single source of truth for "which session is current right now",
  // readable from inside a queued task at whatever later moment its turn
  // actually arrives (a plain closure over `currentSessionId` would only
  // ever see the value from the render that enqueued it). Synced after
  // every render via its own effect (writing a ref during render itself
  // is not allowed); a queued task's continuation always runs later, as
  // at least one subsequent microtask, so it always sees this effect's
  // latest write.
  const currentSessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    currentSessionIdRef.current = signOutStatusRef.current === "idle" ? currentSessionId : null;
  });

  async function handleSignOut() {
    if (signOutStatusRef.current === "pending") return;
    const ownerSessionId = currentSessionId;
    // Pause synchronously: already-queued refreshes must skip before their
    // turn, and an active one must finish before logout clears its cookie.
    signOutStatusRef.current = "pending";
    currentSessionIdRef.current = null;
    setSignOutStatus("pending");
    const result = await signOutTradingSession(
      queueRef.current!,
      () => ownerSessionId ? signOut({ sessionId: ownerSessionId }) : Promise.resolve(),
    );
    const next = result === "ok" ? "idle" : "error";
    signOutStatusRef.current = next;
    setSignOutStatus(next);
  }

  useEffect(() => {
    if (gateState !== "ready" || signOutStatus !== "idle") return;
    const ownerSessionId = currentSessionId;
    let cancelled = false;

    async function run() {
      // Enqueued, not dispatched directly: if an earlier session's
      // exchange is still outstanding, this call waits for it to settle
      // -- genuinely, never aborted -- before its own fetch is ever
      // issued, so two Set-Cookie responses can never be in flight at
      // once. createSessionGatedTask additionally skips this task with no
      // network call at all if `ownerSessionId` is already stale by the
      // time its turn comes up (i.e. it never got a chance to start).
      const task = createSessionGatedTask(
        () => signOutStatusRef.current === "idle" ? currentSessionIdRef.current : null,
        ownerSessionId, getToken, fetch,
      );
      const result = await queueRef.current!(task);
      if (cancelled) return;
      // A refresh failure (not just the initial exchange) applies here
      // too: applyExchangeResult demotes an already-"ok" session straight
      // back to "error" on any later failed refresh -- a deliberate,
      // defined behavior rather than a silently-ignored background error.
      setSessionGateState((prev) => applyExchangeResult(prev, ownerSessionId, result));
    }

    run();
    const id = setInterval(run, SESSION_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
      // Deliberately no abort() here. An exchange that has already
      // dispatched its fetch must be allowed to settle naturally (round-3
      // review): aborting it would make the queue treat it as "settled"
      // before its real response -- and Set-Cookie -- actually arrives,
      // reopening the exact ordering race the queue exists to close. Its
      // eventual real result is still harmless: applyExchangeResult above
      // drops it once `ownerSessionId` no longer matches the current
      // session, and createSessionGatedTask is what skips a task that
      // hasn't started yet instead.
    };
  }, [gateState, currentSessionId, getToken, attempt, signOutStatus]);

  if (signOutStatus === "pending") {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-2 px-4 text-center" role="status">
        <p className="font-medium">Signing out…</p>
        <p className="text-sm text-muted-foreground">Finishing your secure session.</p>
      </main>
    );
  }
  if (signOutStatus === "error") {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
        <p role="alert">Could not finish signing out. Please retry.</p>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          className="min-h-11 cursor-pointer rounded-md border border-border px-4 text-sm transition-colors duration-150 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
        >
          Retry sign out
        </button>
      </main>
    );
  }

  if (gateState === "loading" || (gateState === "ready" && resetState.status === "pending")) {
    // Deliberately no manual recovery action here (see the module-level
    // comment above): this screen cannot distinguish a normal
    // sub-second load from a genuinely hung exchange, and offering a
    // button that could abandon or race an active one would be worse
    // than an indefinite, honest wait.
    return (
      <main className="flex h-dvh items-center justify-center">
        <p className="text-muted-foreground">Loading secure workspace...</p>
      </main>
    );
  }
  if (gateState === "signed-out") {
    return (
      <main className="flex h-dvh items-center justify-center">
        <SignIn routing="hash" />
      </main>
    );
  }
  if (resetState.status === "error") {
    // Safe by construction, unlike the removed Reload button: this only
    // ever reaches here once the current session's own exchange has
    // actually settled (that's what produced "error" in the first
    // place), and clicking it enqueues onto the exact same long-lived
    // queue rather than starting an independent, uncoordinated one. It
    // can therefore only ever *wait* behind some other already-queued
    // work (e.g. a background refresh that happens to also be hung) --
    // never race it or desynchronize cookie order. That wait is the same
    // accepted liveness ceiling documented above, not a new hazard.
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Could not establish a secure session.</p>
        <button
          type="button"
          onClick={() => setAttempt((n) => n + 1)}
          className="min-h-11 cursor-pointer rounded-md border border-border px-4 text-sm transition-colors duration-150 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={() => void handleSignOut()}
          className="min-h-11 cursor-pointer rounded-md px-4 text-sm transition-colors duration-150 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
        >
          Sign out
        </button>
      </main>
    );
  }
  return <TradingSignOutContext.Provider value={handleSignOut}>{children}</TradingSignOutContext.Provider>;
}
