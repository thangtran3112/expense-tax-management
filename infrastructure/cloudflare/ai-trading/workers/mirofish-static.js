// infrastructure/cloudflare/ai-trading/workers/mirofish-static.js
// Worker for mirofish.tobytran.dev (staging only for now:
// mirofish-static.tobytran.dev — see task-8 brief Steps 8-9; the public
// hostname/route are a later activation task). Serves MiroFish's unmodified
// static Vue build (01e) with Vue history-mode fallback. Hashed assets stay
// public (01e point 5: only the backend holds private data); any other
// GET/HEAD is treated as an HTML/SPA route and is gated on
// `GET ORIGIN_HOSTNAME/__auth/check` (forwarding the visitor's cookie)
// before index.html is served. A 401 is translated into a 302 to the static
// hub's /login?returnTo=<encoded original request URL> (01e point 5; the
// verifier itself has no notion of the hub's login route, so the Worker
// synthesizes this redirect rather than relaying the verifier's bare 401).
// 403/5xx are relayed to the visitor unchanged. The bucket is never touched
// without a passing (204) check.
// `/api/*` forwards the Request unchanged to ORIGIN_HOSTNAME for every
// method — multipart POST bodies and WebSocket Upgrade headers pass through
// untouched, same `fetch(originUrl, request)` pattern as the hub's own
// Worker (../worker/hub-router.js). ORIGIN_HOSTNAME is the Caddy gateway
// (forward_auth to the verifier) on the tunnel, never mirofish:5001
// directly — Flask is not reachable from this Worker.
//
// No business logic, LLM calls, or persistent state here.

const STATIC_HOST = "storage.googleapis.com";
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};
const STRIPPED_RESPONSE_HEADERS = [
  "x-goog-hash",
  "x-goog-stored-content-length",
  "x-goog-storage-class",
  "x-guploader-uploadid",
];

export function isApiPath(pathname) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

export function hasFileExtension(pathname) {
  return /\.[A-Za-z0-9]+$/.test(pathname);
}

function withHeaders(response, status) {
  const headers = new Headers(response.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: status ?? response.status, headers });
}

async function fetchBucketPath(bucket, path, method) {
  const res = await fetch(`https://${STATIC_HOST}/${bucket}${path}`, { method });
  return withHeaders(res);
}

const HUB_LOGIN_URL = "https://trading.tobytran.dev/login";

// The redirect target's host/path are a fixed literal, never derived from
// the request; only the `returnTo` value is attacker-influenced, and it is
// carried as a single fully-percent-encoded opaque string (never spliced
// unescaped into the query string), so no request content can redirect the
// visitor off-domain or smuggle a second query parameter at this hop.
function loginRedirect(requestUrl) {
  const location = `${HUB_LOGIN_URL}?returnTo=${encodeURIComponent(requestUrl)}`;
  return new Response(null, { status: 302, headers: { location } });
}

async function checkAuth(originHostname, cookie) {
  return fetch(`https://${originHostname}/__auth/check`, {
    headers: { cookie: cookie || "" },
    redirect: "manual",
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (isApiPath(url.pathname)) {
      const originUrl = `https://${env.ORIGIN_HOSTNAME}${url.pathname}${url.search}`;
      return fetch(originUrl, request);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (hasFileExtension(url.pathname)) {
      return fetchBucketPath(env.STATIC_BUCKET, url.pathname, request.method);
    }

    // Vue history-mode HTML route: gate on the backend session before serving.
    const gate = await checkAuth(env.ORIGIN_HOSTNAME, request.headers.get("cookie"));
    if (gate.status === 401) return loginRedirect(request.url);
    if (gate.status !== 204) return gate; // 403/5xx relayed unchanged
    return fetchBucketPath(env.STATIC_BUCKET, "/index.html", request.method);
  },
};
