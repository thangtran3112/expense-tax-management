export type GateState = "loading" | "signed-out" | "ready";

export function getGateState(input: { isLoaded: boolean; isSignedIn: boolean | undefined }): GateState {
  if (!input.isLoaded) return "loading";
  if (!input.isSignedIn) return "signed-out";
  return "ready";
}

// The gateway session cookie is capped at 3600s (ai-trading/auth/src/server.js);
// refresh well before that so a user never sees a mid-session 401.
//
// Operator-facing limitation, not an oversight, requiring explicit
// acceptance before production activation: the stateless two-route auth
// design has no revocation list, so a copied or not-yet-expired cookie
// remains usable for up to this same ~3600-second window after the user
// signs out of Clerk -- there is no server-side state to immediately
// invalidate it. Adding one is out of scope here (progress.md ruling,
// round 1: do not add a fake logout endpoint). See `components/
// auth-gate.tsx`'s module-level comment for the other accepted
// limitation (an indefinite liveness ceiling on a genuinely hung
// exchange) that should be reviewed alongside this one.
export const SESSION_REFRESH_INTERVAL_MS = 20 * 60 * 1000;

export function requireClerkPublishableKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key) throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required");
  return key;
}

export type SessionExchangeResult = "ok" | "error";

// Same-origin POST /__auth/session (ai-trading/auth/src/server.js):
// Authorization: Bearer <clerk token>, credentials "include" so the Worker's
// Set-Cookie response is honored, no JSON body. 204 is the only success
// status; anything else (400/401/403/405, or a network failure) is
// "error". Deliberately takes no AbortSignal: round-3 review found that
// aborting an already-dispatched exchange on a session switch makes it
// settle (with an AbortError, caught below as "error") before its real
// server response -- and Set-Cookie -- actually arrives, which is exactly
// the ordering bug the exchange queue (createSerialExchangeQueue) exists
// to prevent. An exchange that has started is always let run to its
// genuine completion; see createSessionGatedTask for how a *not yet
// started* one is skipped instead.
export async function exchangeSessionToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionExchangeResult> {
  try {
    const res = await fetchImpl("/__auth/session", {
      method: "POST",
      credentials: "include",
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.status === 204 ? "ok" : "error";
  } catch {
    return "error";
  }
}

// Clerk's getToken() can itself reject (its own network call to refresh the
// session token can fail). Round-1 review found this unhandled: the
// initial exchange hung in "loading" forever, and a rejected interval
// refresh was an unhandled promise rejection. Wrapping token acquisition
// and the exchange in one function makes both paths -- and both failure
// modes -- a single "ok" | "error" result, so every caller (initial
// exchange, periodic refresh, retry) gets the same fail-closed behavior.
export async function acquireAndExchange(
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionExchangeResult> {
  let token: string | null;
  try {
    token = await getToken();
  } catch {
    return "error";
  }
  if (!token) return "error";
  return exchangeSessionToken(token, fetchImpl);
}

// --- Session-tied gateway readiness -----------------------------------
//
// Round-1 review: readiness was a bare "pending" | "ok" | "error" status
// with no notion of *which* Clerk session it belongs to. Two failure
// modes followed: (1) Clerk can switch the active session (or sign a user
// out) without necessarily changing anything else the gate was watching,
// so a stale "ok" from the previous session kept rendering protected
// children; (2) two overlapping exchanges (old session's in-flight
// request, new session's fresh request) could resolve out of order, and
// whichever one lands second would win regardless of which session is
// actually current.
//
// `SessionGateState` fixes both by carrying the session the status
// belongs to, and `applyExchangeResult` refuses to apply any result whose
// session no longer matches -- a stale/out-of-order result is dropped,
// not applied. `resetForSession` demotes to "pending" (hiding children)
// the instant the session changes, independent of whether any exchange
// has resolved yet. A refresh failure (not just the initial exchange)
// goes through the same `applyExchangeResult` path, so it demotes
// already-rendered children back to "error" exactly like an initial
// failure -- that demotion is a deliberate, defined behavior, not an
// oversight.

export type ExchangeStatus = "pending" | "ok" | "error";

export type SessionGateState = {
  sessionId: string | null;
  status: ExchangeStatus;
};

export function initialSessionGateState(sessionId: string | null): SessionGateState {
  return { sessionId, status: "pending" };
}

export function resetForSession(current: SessionGateState, sessionId: string | null): SessionGateState {
  if (sessionId === current.sessionId) return current;
  return { sessionId, status: "pending" };
}

export function applyExchangeResult(
  current: SessionGateState,
  resultSessionId: string | null,
  result: ExchangeStatus,
): SessionGateState {
  if (resultSessionId !== current.sessionId) return current;
  return { sessionId: current.sessionId, status: result };
}

// --- Serializing exchanges across session changes -----------------------
//
// Round-2 review: AbortController cancellation plus sessionId-tied state
// (round 1) controls what the UI *shows*, but neither one controls the
// order in which the browser actually applies each request's Set-Cookie
// header. If session A's POST /__auth/session is still in flight when
// session B's POST is dispatched, and A's response happens to finish
// *after* B's 204, the browser's cookie jar ends up holding A's cookie
// even though the UI already shows B as ready.
//
// The fix is to never have two of these requests in flight at once.
// `createSerialExchangeQueue` is a minimal promise-chain mutex: each
// enqueued task only starts after the previous one has *settled*
// (resolved OR rejected), so a later session's `fetch` call is never
// issued while an earlier session's is still outstanding.
//
// Round-3 review found the round-2 wiring still broken: *how* a task
// settles matters too. The caller (AuthGate) was aborting session A's
// task on every session switch to make the queue move on quickly -- but
// `abort()` rejects the in-flight `fetch` immediately, long before A's
// real server response (and its Set-Cookie) would otherwise have
// arrived. The queue then let session B's task start right away,
// believing A had "settled", while A's genuine response -- and cookie --
// could still land on the wire afterward. Aborting an in-flight exchange
// to unblock the queue faster reintroduces the exact race the queue
// exists to close; it must never be done. The queue alone does not
// provide this guarantee -- it only guarantees *order*, not that an
// early, fake "settlement" wasn't forced. Combined with
// `createSessionGatedTask` below (which is what actually must not abort
// an active exchange, and instead skips a stale task only if it has not
// started yet), the queue is now exactly what makes B wait for A's
// genuine completion, with nothing manufacturing an early release.
export type ExchangeQueue = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerialExchangeQueue(): ExchangeQueue {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return enqueue;
}

// Wraps a queued exchange task so that if a newer session has already
// taken over by the time this task's turn in the queue actually arrives,
// it is skipped entirely: no token is acquired, no fetch is dispatched.
// This only ever matters for a task that has NOT started yet -- once a
// task begins running (its turn in the queue has come and this check has
// already passed), it is past this gate and runs to natural completion
// undisturbed, exactly as round-3 review requires: an exchange that is
// already active must never be aborted on a session switch, only a
// not-yet-started one may be skipped. `getCurrentSessionId` is read at
// call time (not captured at enqueue time), so it reflects whatever is
// current *when this task's turn actually comes up*, not when it was
// enqueued.
export function createSessionGatedTask(
  getCurrentSessionId: () => string | null,
  ownerSessionId: string | null,
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = fetch,
): () => Promise<SessionExchangeResult> {
  return async () => {
    if (getCurrentSessionId() !== ownerSessionId) return "error";
    return acquireAndExchange(getToken, fetchImpl);
  };
}

const HUB_FALLBACK = "/";
// B8's staging Worker (infrastructure/cloudflare/ai-trading/workers/
// mirofish-static.js) passes `mirofish-static.tobytran.dev` as returnTo
// before the public `mirofish.tobytran.dev` hostname is cut over
// (01i-mirofish-upstream-implementation progress.md ruling: "Allow EXACT
// public and staging MiroFish hostnames over HTTPS with no port/userinfo").
// Both are exact, family-owned hostnames; nothing else matches, including
// a hostname that merely starts with or contains one of these as a
// substring.
const ALLOWED_RETURN_TO_HOSTS: ReadonlySet<string> = new Set([
  "mirofish.tobytran.dev",
  "mirofish-static.tobytran.dev",
]);

// `URL` silently normalizes away an explicit port that matches the
// scheme's default: `new URL("https://host:443/").port` is `""`, same as
// no port at all, and `new URL("https://host:0443/").port` is *also* `""`
// (leading zeros are numerically folded first). Round-3 review: checking
// only the normalized `url.port` therefore let `https://<allowed
// host>:443/` and `:0443` both through, even though the approved rule is
// "no explicit port, period" -- not "no explicit *non-default* port".
// Detect an explicit port the way it actually appears in the raw string,
// before any of that normalization happens: take the authority (the
// `host[:port]` segment between `https://` and the first `/`, `?`, or
// `#`), drop any `user:pass@` prefix (which can itself contain a `:`),
// and check what's left for a `:`.
function hasExplicitPort(raw: string): boolean {
  const match = /^https:\/\/([^/?#]*)/i.exec(raw);
  if (!match) return false;
  const authority = match[1];
  const at = authority.lastIndexOf("@");
  const hostAndPort = at === -1 ? authority : authority.slice(at + 1);
  return hostAndPort.includes(":");
}

// Round-4 review: `hasExplicitPort`'s regex requires the string to start
// with a literal `https://`, but the WHATWG URL parser `new URL` uses
// does not -- per spec it first strips every ASCII tab/newline anywhere
// in the string, then strips any *leading or trailing* C0 control or
// space, before parsing anything else. So `" https://host:443/"` (a
// leading space) or `"https:\t//host:443/"` (an embedded tab) both parse
// into the exact same URL as the clean string -- but neither matches
// `hasExplicitPort`'s `^https:\/\/` regex, so that check silently no-ops
// (treats "didn't match my regex" as "no port", not "something's
// wrong"), and the request falls through to `new URL(raw)`, which
// normalizes the `:443`/`:0443` away exactly as before. Reject any raw
// ASCII whitespace or C0/DEL control character anywhere in the string
// up front, before either guard runs or `new URL` ever sees it -- a
// legitimate returnTo URL from the Worker has none of these, so this
// costs nothing real and closes the whole class of parser-normalization
// bypasses at once, not just the one port-specific instance found so far.
function hasRawWhitespaceOrControlChar(raw: string): boolean {
  return /[\u0000-\u0020\u007f]/.test(raw);
}

// The MiroFish Worker redirects an unauthenticated visitor to
// `/login?returnTo=<url>` (01e design, "HTTPS and same-origin routing" step
// 5). Only forward to one of the two exact family hostnames above over
// https, with no userinfo and no explicit port (not even the scheme's own
// default port, spelled out); anything else (a different host, a
// lookalike subdomain, http, a bare path, an unparsable string) falls
// back to the hub.
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw) return HUB_FALLBACK;
  if (hasRawWhitespaceOrControlChar(raw)) return HUB_FALLBACK;
  if (hasExplicitPort(raw)) return HUB_FALLBACK;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return HUB_FALLBACK;
  }
  if (url.protocol !== "https:") return HUB_FALLBACK;
  if (!ALLOWED_RETURN_TO_HOSTS.has(url.hostname)) return HUB_FALLBACK;
  // Kept alongside hasExplicitPort as defense-in-depth for a non-default
  // port (e.g. :8443): hasExplicitPort already catches this, since any
  // non-default port in `url.port` necessarily came from an explicit port
  // in the raw text too, but this is a security boundary (open-redirect
  // prevention) and the normalized object is an independent signal worth
  // keeping, not relied on alone (see hasExplicitPort's own comment for
  // why it alone is insufficient).
  if (url.port !== "") return HUB_FALLBACK;
  if (url.username !== "" || url.password !== "") return HUB_FALLBACK;
  return url.toString();
}
