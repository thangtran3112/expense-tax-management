import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acquireAndExchange,
  applyExchangeResult,
  createSerialExchangeQueue,
  createSessionGatedTask,
  exchangeSessionToken,
  getGateState,
  initialSessionGateState,
  resetForSession,
  safeReturnTo,
  signOutTradingSession,
  SESSION_REFRESH_INTERVAL_MS,
  type SessionExchangeResult,
} from "./auth.ts";

test("not yet loaded is the loading state", () => {
  assert.equal(getGateState({ isLoaded: false, isSignedIn: undefined }), "loading");
});
test("loaded but not signed in is the signed-out state", () => {
  assert.equal(getGateState({ isLoaded: true, isSignedIn: false }), "signed-out");
});
test("loaded and signed in is ready", () => {
  assert.equal(getGateState({ isLoaded: true, isSignedIn: true }), "ready");
});
test("the refresh interval is well under the session cookie's one-hour cap", () => {
  assert.ok(SESSION_REFRESH_INTERVAL_MS < 3600_000);
  assert.ok(SESSION_REFRESH_INTERVAL_MS > 0);
});

// A hand-rolled fake fetch boundary: records every call it receives and
// returns a minimal Response-shaped object. No mocking framework, no
// network, no assertion on the mock's own existence -- only on what
// exchangeSessionToken/acquireAndExchange sent and what they returned
// given a status.
type FakeCall = { input: unknown; init: RequestInit | undefined };

function fakeFetch(status: number, calls: FakeCall[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return { status } as Response;
  }) as typeof fetch;
}

test("exchangeSessionToken posts a bearer token same-origin with credentials included and no body", async () => {
  const calls: FakeCall[] = [];
  const result = await exchangeSessionToken("tok-123", fakeFetch(204, calls));
  assert.equal(result, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "/__auth/session");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.credentials, "include");
  assert.equal(
    (calls[0].init?.headers as Record<string, string> | undefined)?.Authorization,
    "Bearer tok-123",
  );
  assert.equal(calls[0].init?.body, undefined);
});
test("exchangeSessionToken reports error for a non-204 status", async () => {
  const calls: FakeCall[] = [];
  assert.equal(await exchangeSessionToken("tok", fakeFetch(401, calls)), "error");
  assert.equal(await exchangeSessionToken("tok", fakeFetch(403, calls)), "error");
});
test("exchangeSessionToken reports error when the fetch boundary throws", async () => {
  const throwingFetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  assert.equal(await exchangeSessionToken("tok", throwingFetch), "error");
});

// --- acquireAndExchange: getToken() rejection handling (round-1 P1 b) ---

test("acquireAndExchange reports error when getToken() rejects, instead of hanging", async () => {
  const rejectingGetToken = async (): Promise<string | null> => {
    throw new Error("clerk token refresh failed");
  };
  const calls: FakeCall[] = [];
  const result = await acquireAndExchange(rejectingGetToken, fakeFetch(204, calls));
  assert.equal(result, "error");
  // The fetch boundary must never be reached: there is no token to send.
  assert.equal(calls.length, 0);
});
test("acquireAndExchange reports error when getToken() resolves to null", async () => {
  const calls: FakeCall[] = [];
  const result = await acquireAndExchange(async () => null, fakeFetch(204, calls));
  assert.equal(result, "error");
  assert.equal(calls.length, 0);
});
test("acquireAndExchange exchanges the token it acquired and returns the exchange's result", async () => {
  const calls: FakeCall[] = [];
  const result = await acquireAndExchange(async () => "tok-xyz", fakeFetch(204, calls));
  assert.equal(result, "ok");
  assert.equal(
    (calls[0].init?.headers as Record<string, string> | undefined)?.Authorization,
    "Bearer tok-xyz",
  );
});

// --- createSerialExchangeQueue: true serialization, not just cancellation
// (round-2 P1 a) ---
//
// A deferred fetch -- one whose promise we control and resolve by hand --
// proves the queue structurally waits, rather than merely usually
// winning a timing race. B's `fetch` must not even be *called* while A's
// is still outstanding, and only once A settles does B's cookie write
// happen, landing last.

test("createSerialExchangeQueue: a later exchange's fetch is not dispatched until an earlier one settles, and its cookie write lands last", async () => {
  const calls: { authorization: string }[] = [];
  let resolveA: ((value: Response) => void) | undefined;

  const deferredFetchForA: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push({ authorization: (init?.headers as Record<string, string>).Authorization });
    return new Promise<Response>((resolve) => {
      resolveA = resolve;
    });
  }) as typeof fetch;

  const immediateFetchForB: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push({ authorization: (init?.headers as Record<string, string>).Authorization });
    return { status: 204 } as Response;
  }) as typeof fetch;

  const queue = createSerialExchangeQueue();
  const resultA = queue(() => exchangeSessionToken("tok-A", deferredFetchForA));
  const resultB = queue(() => exchangeSessionToken("tok-B", immediateFetchForB));

  // Let any microtasks that *could* run immediately actually run. If B's
  // fetch were dispatched eagerly instead of waiting on the queue, it
  // would already be in `calls` here -- before A has resolved anything.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 1, "B's fetch must not be dispatched while A is still outstanding");
  assert.equal(calls[0].authorization, "Bearer tok-A");

  // Settle A (its cookie write, conceptually) -- only now may B proceed.
  // Awaiting resultB (rather than counting further microtask ticks) is
  // the robust way to know B's task has actually run by this point: it
  // only settles after B's task function has been invoked and returned.
  resolveA!({ status: 401 } as Response);
  assert.equal(await resultA, "error");
  assert.equal(await resultB, "ok");

  assert.equal(calls.length, 2, "B's fetch dispatches only after A has settled");
  assert.equal(calls[1].authorization, "Bearer tok-B", "B's cookie write is the last one issued");
});
test("createSerialExchangeQueue: a rejecting task does not break the chain for the next one", async () => {
  const queue = createSerialExchangeQueue();
  const resultA = queue(async () => {
    throw new Error("A failed");
  });
  const resultB = queue(async () => "ok" as const);
  await assert.rejects(resultA, /A failed/);
  assert.equal(await resultB, "ok");
});

// --- createSessionGatedTask: an active exchange is never aborted on a
// session switch; only a not-yet-started one is skipped (round-3 P1) ---
//
// Round-2's fix (the queue alone) still let the *caller* abort an
// in-flight exchange to unblock the queue faster, which forces a fake
// early "settlement" before the real response -- and its Set-Cookie --
// actually arrives. These tests simulate the cleanup/session-switch path
// WITHOUT ever calling abort (there is nothing to abort by this design)
// and prove the queue genuinely waits for A's real response regardless.

// A small deferred helper so tests synchronize on "has this actually
// started running" rather than counting microtask ticks, which is
// fragile against unrelated changes to how many `await`s sit between
// "enqueued" and "fetch actually called" (acquireAndExchange's own
// `await getToken()` is one such hop createSessionGatedTask adds).
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("createSessionGatedTask: an already-started exchange is never aborted on a session switch -- it settles naturally, and B starts only once it genuinely has", async () => {
  const calls: { authorization: string }[] = [];
  const aDispatched = deferred<void>();
  const aResponse = deferred<Response>();

  const deferredFetchForA: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push({ authorization: (init?.headers as Record<string, string>).Authorization });
    aDispatched.resolve();
    return aResponse.promise;
  }) as typeof fetch;
  const immediateFetchForB: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push({ authorization: (init?.headers as Record<string, string>).Authorization });
    return { status: 204 } as Response;
  }) as typeof fetch;

  let currentSessionId: string | null = "sess_a";
  const getCurrentSessionId = () => currentSessionId;

  const queue = createSerialExchangeQueue();
  const taskA = createSessionGatedTask(getCurrentSessionId, "sess_a", async () => "tok-A", deferredFetchForA);
  const resultA = queue(taskA);

  // Wait for A's fetch to have actually been dispatched (not a fixed
  // number of ticks) before the "session switch" below, which simulates
  // the effect cleanup that fires when Clerk moves to a new session
  // while A is still outstanding.
  await aDispatched.promise;
  assert.equal(calls.length, 1, "A's fetch must have been dispatched already");
  assert.equal(calls[0].authorization, "Bearer tok-A");

  // Simulate the session switch. Crucially: no abort is called anywhere
  // here -- there is nothing in this design that ever aborts A. Only the
  // "current session" pointer changes, and a new task for B is enqueued
  // behind A.
  currentSessionId = "sess_b";
  const taskB = createSessionGatedTask(getCurrentSessionId, "sess_b", async () => "tok-B", immediateFetchForB);
  const resultB = queue(taskB);

  // A keeps running undisturbed. Prove the queue has not released early:
  // B's fetch still has not been dispatched no matter how many microtask
  // ticks pass, because A -- now stale for the UI, but not aborted -- has
  // not actually settled.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(calls.length, 1, "B must not start before A genuinely settles, even though A is now stale");

  // Only now does A's real network response finally arrive.
  aResponse.resolve({ status: 204 } as Response);
  assert.equal(await resultA, "ok", "A's own result is genuine (not an AbortError) -- the caller just ignores it");
  assert.equal(await resultB, "ok");
  assert.equal(calls.length, 2, "B dispatches only after A has genuinely settled");
  assert.equal(calls[1].authorization, "Bearer tok-B", "B's cookie write is the last one issued");
});

test("createSessionGatedTask: a task that is already stale by the time its turn arrives is skipped -- no token acquired, no fetch dispatched", async () => {
  const calls: { authorization: string }[] = [];
  const fetchImpl: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push({ authorization: (init?.headers as Record<string, string>).Authorization });
    return { status: 204 } as Response;
  }) as typeof fetch;

  let currentSessionId: string | null = "sess_a";
  const getCurrentSessionId = () => currentSessionId;
  let staleTokenCalls = 0;

  const queue = createSerialExchangeQueue();
  // A blocker task occupies the queue first, so the next task can be
  // enqueued and go stale *before* its turn ever arrives -- "queued, not
  // yet started".
  const blockerStarted = deferred<void>();
  const releaseBlocker = deferred<SessionExchangeResult>();
  const blocker = queue(() => {
    blockerStarted.resolve();
    return releaseBlocker.promise;
  });

  const staleGetToken = async () => {
    staleTokenCalls += 1;
    return "tok-stale";
  };
  const resultForStale = queue(createSessionGatedTask(getCurrentSessionId, "sess_a", staleGetToken, fetchImpl));

  // The session moves on before the stale task ever gets its turn.
  currentSessionId = "sess_b";

  await blockerStarted.promise;
  releaseBlocker.resolve("ok");
  await blocker;
  assert.equal(await resultForStale, "error", "a superseded, not-yet-started task reports error without ever running");
  assert.equal(staleTokenCalls, 0, "no token is acquired for a task that is already stale when its turn arrives");
  assert.equal(calls.length, 0, "no fetch is ever dispatched for a task that is already stale when its turn arrives");
});
test("createSessionGatedTask: a task that is still current when its turn arrives runs normally", async () => {
  const calls: { authorization: string }[] = [];
  const fetchImpl: typeof fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push({ authorization: (init?.headers as Record<string, string>).Authorization });
    return { status: 204 } as Response;
  }) as typeof fetch;
  const getCurrentSessionId = () => "sess_a";

  const result = await createSessionGatedTask(getCurrentSessionId, "sess_a", async () => "tok-A", fetchImpl)();
  assert.equal(result, "ok");
  assert.equal(calls.length, 1);
});

test("a queued exchange is skipped when sign-out clears the current session pointer", async () => {
  const queue = createSerialExchangeQueue();
  const release = deferred<void>();
  const calls: FakeCall[] = [];
  let sessionId: string | null = "sess_a";
  const blocker = queue(() => release.promise);
  const exchange = queue(createSessionGatedTask(() => sessionId, "sess_a", async () => "tok", fakeFetch(204, calls)));
  sessionId = null;
  release.resolve();
  await blocker;
  assert.equal(await exchange, "error");
  assert.equal(calls.length, 0);
});

test("an exchange without a Clerk session never acquires a token or issues a request", async () => {
  const calls: FakeCall[] = [];
  let acquired = false;
  const task = createSessionGatedTask(() => null, null, async () => { acquired = true; return "tok"; }, fakeFetch(204, calls));
  assert.equal(await task(), "error");
  assert.equal(acquired, false);
  assert.equal(calls.length, 0);
});

test("sign-out waits for an active exchange before clearing the cookie and ending Clerk", async () => {
  const queue = createSerialExchangeQueue();
  const started = deferred<void>();
  const response = deferred<Response>();
  const order: string[] = [];
  let cookie = "old";
  const active = queue(async () => {
    started.resolve();
    await response.promise;
    cookie = "issued";
    order.push("exchange");
    return "ok";
  });
  await started.promise;
  const calls: FakeCall[] = [];
  const logoutFetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    cookie = "";
    order.push("logout");
    return { status: 204 } as Response;
  }) as typeof fetch;
  const signOut = signOutTradingSession(queue, async () => { order.push("clerk"); }, logoutFetch);
  await Promise.resolve();
  assert.equal(calls.length, 0);
  response.resolve({ status: 204 } as Response);
  await active;
  assert.equal(await signOut, "ok");
  assert.equal(cookie, "");
  assert.deepEqual(order, ["exchange", "logout", "clerk"]);
  assert.equal(calls[0].input, "/__auth/logout");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.credentials, "include");
  assert.equal(calls[0].init?.body, undefined);
});

test("failed gateway logout does not report success or sign out Clerk", async () => {
  for (const status of [401, 403, 500]) {
    let signedOut = false;
    const result = await signOutTradingSession(createSerialExchangeQueue(), async () => { signedOut = true; }, fakeFetch(status, []));
    assert.equal(result, "error");
    assert.equal(signedOut, false);
  }
});

test("network and Clerk sign-out failures are retryable errors", async () => {
  const down = (async () => { throw new Error("network down"); }) as typeof fetch;
  assert.equal(await signOutTradingSession(createSerialExchangeQueue(), async () => {}, down), "error");
  const queue = createSerialExchangeQueue();
  assert.equal(await signOutTradingSession(queue, async () => { throw new Error("Clerk unavailable"); }, fakeFetch(204, [])), "error");
  assert.equal(await signOutTradingSession(queue, async () => {}, fakeFetch(204, [])), "ok");
});

// --- session-tied gateway readiness: reset + stale-result rejection
// (round-1 P1 a) ---

test("initialSessionGateState starts pending for the given session", () => {
  assert.deepEqual(initialSessionGateState("sess_a"), { sessionId: "sess_a", status: "pending" });
});
test("resetForSession is a no-op when the session is unchanged", () => {
  const state = { sessionId: "sess_a", status: "ok" as const };
  assert.equal(resetForSession(state, "sess_a"), state);
});
test("resetForSession demotes to pending on sign-out (session becomes null)", () => {
  const state = { sessionId: "sess_a", status: "ok" as const };
  assert.deepEqual(resetForSession(state, null), { sessionId: null, status: "pending" });
});
test("resetForSession demotes to pending when switching to a different session", () => {
  const state = { sessionId: "sess_a", status: "ok" as const };
  assert.deepEqual(resetForSession(state, "sess_b"), { sessionId: "sess_b", status: "pending" });
});
test("applyExchangeResult applies a result that matches the current session", () => {
  const state = { sessionId: "sess_a", status: "pending" as const };
  assert.deepEqual(applyExchangeResult(state, "sess_a", "ok"), { sessionId: "sess_a", status: "ok" });
});
test("applyExchangeResult demotes an already-ready session on a refresh failure", () => {
  const state = { sessionId: "sess_a", status: "ok" as const };
  assert.deepEqual(applyExchangeResult(state, "sess_a", "error"), { sessionId: "sess_a", status: "error" });
});
test("applyExchangeResult drops a result for a session that is no longer current", () => {
  const state = { sessionId: "sess_b", status: "pending" as const };
  // Session A's exchange was in flight when the user switched to session B;
  // it must not overwrite session B's state when it finally resolves.
  assert.equal(applyExchangeResult(state, "sess_a", "ok"), state);
});
test("session-switch ordering: a late-arriving old-session result never overwrites the new session", () => {
  // Simulates the exact race the reviewer flagged: session A's exchange is
  // in flight, the user switches to session B (reset fires immediately),
  // and only then does A's exchange resolve -- late, and stale.
  let state = initialSessionGateState("sess_a");
  state = applyExchangeResult(state, "sess_a", "ok"); // A's exchange resolves first
  assert.deepEqual(state, { sessionId: "sess_a", status: "ok" });

  state = resetForSession(state, "sess_b"); // user switches session -> hides children
  assert.deepEqual(state, { sessionId: "sess_b", status: "pending" });

  state = applyExchangeResult(state, "sess_a", "ok"); // stale: A's old result lands late
  assert.deepEqual(state, { sessionId: "sess_b", status: "pending" }, "stale result must be dropped");

  state = applyExchangeResult(state, "sess_b", "ok"); // B's own exchange resolves
  assert.deepEqual(state, { sessionId: "sess_b", status: "ok" });
});

test("safeReturnTo falls back to the hub when there is no returnTo", () => {
  assert.equal(safeReturnTo(null), "/");
  assert.equal(safeReturnTo(undefined), "/");
  assert.equal(safeReturnTo(""), "/");
});
test("safeReturnTo allows the public https mirofish.tobytran.dev URL with a path", () => {
  assert.equal(safeReturnTo("https://mirofish.tobytran.dev/graph/123"), "https://mirofish.tobytran.dev/graph/123");
});
// B8's staging Worker returns this exact second hostname as returnTo
// before public cutover (01i progress.md ruling: allow both EXACT
// hostnames, not a prefix/suffix match against either).
test("safeReturnTo allows the staging https mirofish-static.tobytran.dev URL with a path", () => {
  assert.equal(
    safeReturnTo("https://mirofish-static.tobytran.dev/projects/42"),
    "https://mirofish-static.tobytran.dev/projects/42",
  );
});
test("safeReturnTo rejects a non-https scheme on either allowed host", () => {
  assert.equal(safeReturnTo("http://mirofish.tobytran.dev/"), "/");
  assert.equal(safeReturnTo("http://mirofish-static.tobytran.dev/"), "/");
});
test("safeReturnTo rejects a different host entirely", () => {
  assert.equal(safeReturnTo("https://evil.example.com/"), "/");
});
test("safeReturnTo rejects a host that is neither allowed hostname, even though it contains one as a substring", () => {
  assert.equal(safeReturnTo("https://mirofish-staging.tobytran.dev/"), "/");
});
test("safeReturnTo rejects a lookalike subdomain suffix of either allowed host", () => {
  assert.equal(safeReturnTo("https://mirofish.tobytran.dev.evil.com/"), "/");
  assert.equal(safeReturnTo("https://mirofish-static.tobytran.dev.evil.com/"), "/");
});
test("safeReturnTo rejects userinfo in the URL on either allowed host", () => {
  assert.equal(safeReturnTo("https://user:pass@mirofish.tobytran.dev/"), "/");
  assert.equal(safeReturnTo("https://user:pass@mirofish-static.tobytran.dev/"), "/");
});
test("safeReturnTo rejects a non-default port on either allowed host", () => {
  assert.equal(safeReturnTo("https://mirofish.tobytran.dev:8443/"), "/");
  assert.equal(safeReturnTo("https://mirofish-static.tobytran.dev:8443/"), "/");
});
// Round-3 P2: `URL` silently normalizes away an *explicit* port that
// equals the scheme's own default -- `new URL("https://host:443/").port`
// is `""`, same as no port at all written -- so checking only the
// normalized `url.port` let `:443` (and even `:0443`, numerically the
// same port after leading-zero folding) sail through as if no port had
// been written, even though the approved rule is "no explicit port,
// period", not "no explicit *non-default* port". These assert against
// the raw string, independent of what the normalized URL object claims.
test("safeReturnTo rejects an explicit default port (:443) on either allowed host, even though URL normalizes it away", () => {
  assert.equal(safeReturnTo("https://mirofish.tobytran.dev:443/"), "/");
  assert.equal(safeReturnTo("https://mirofish-static.tobytran.dev:443/"), "/");
});
test("safeReturnTo rejects a zero-padded explicit default port (:0443), which URL also folds to the same default", () => {
  assert.equal(safeReturnTo("https://mirofish.tobytran.dev:0443/"), "/");
  assert.equal(safeReturnTo("https://mirofish-static.tobytran.dev:0443/"), "/");
});
test("safeReturnTo still allows either host with genuinely no port written at all", () => {
  assert.equal(safeReturnTo("https://mirofish.tobytran.dev/graph/1"), "https://mirofish.tobytran.dev/graph/1");
  assert.equal(
    safeReturnTo("https://mirofish-static.tobytran.dev/projects/1"),
    "https://mirofish-static.tobytran.dev/projects/1",
  );
});
// Round-4 review: `new URL` strips every ASCII tab/newline anywhere in
// its input, then strips any *leading or trailing* C0 control or space,
// before parsing anything else -- so a leading space or an embedded tab
// defeated `hasExplicitPort`'s `^https:\/\/` regex (it simply didn't
// match, which that check silently treated as "no port" rather than
// "something's wrong"), while `new URL` still happily normalized the
// `:443`/`:0443` away exactly as in round 3. Each case below is a
// genuinely *different* raw string than its round-3 counterpart (an
// added space/tab/newline somewhere), not a restatement of the same
// input -- proving the new whitespace/control-char guard, not the
// existing port guard, is what catches these.
test("safeReturnTo rejects a :443 return URL with a leading space, which URL parsing would otherwise silently strip", () => {
  assert.equal(safeReturnTo(" https://mirofish.tobytran.dev:443/"), "/");
  assert.equal(safeReturnTo(" https://mirofish-static.tobytran.dev:443/"), "/");
});
test("safeReturnTo rejects a :443 return URL with a trailing space", () => {
  assert.equal(safeReturnTo("https://mirofish.tobytran.dev:443/ "), "/");
  assert.equal(safeReturnTo("https://mirofish-static.tobytran.dev:443/ "), "/");
});
test("safeReturnTo rejects a :443 return URL with a tab embedded inside the scheme, which URL parsing strips from anywhere in the string", () => {
  assert.equal(safeReturnTo("https:\t//mirofish.tobytran.dev:443/"), "/");
  assert.equal(safeReturnTo("https:\t//mirofish-static.tobytran.dev:443/"), "/");
});
test("safeReturnTo rejects a :0443 return URL with embedded whitespace too", () => {
  assert.equal(safeReturnTo(" https://mirofish.tobytran.dev:0443/"), "/");
  assert.equal(safeReturnTo("https://mirofish.tobytran.dev\n:0443/"), "/");
});
test("safeReturnTo rejects a leading NUL/control character even with no port at all", () => {
  assert.equal(safeReturnTo("\u0000https://mirofish.tobytran.dev/"), "/");
});
test("safeReturnTo rejects an otherwise-valid return URL with an embedded newline, even with no port", () => {
  assert.equal(safeReturnTo("https://mirofish\n.tobytran.dev/"), "/");
});
test("safeReturnTo rejects an unparsable value", () => {
  assert.equal(safeReturnTo("not a url"), "/");
});
test("safeReturnTo rejects a bare path (not an absolute URL on either allowed host)", () => {
  assert.equal(safeReturnTo("/apps/mirofish"), "/");
});
