// infrastructure/cloudflare/ai-trading/worker/hub-router.js
// Route-resolution rule matches ai-trading/frontend/static-server.mjs's
// resolveObjectPath exactly (same build output, two different runtimes —
// kept as two files on purpose, see Task 1's Interfaces note).

export function resolveStaticObjectKey(pathname) {
  if (pathname === "/") return "index.html";
  const clean = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (/\.[A-Za-z0-9]+$/.test(clean)) return clean;
  return `${clean}.html`;
}

export function isDynamicPath(pathname) {
  return (
    pathname === "/u" || pathname.startsWith("/u/") ||
    pathname === "/__auth" || pathname.startsWith("/__auth/") ||
    pathname === "/__control" || pathname.startsWith("/__control/")
  );
}

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

function withHeaders(response, status) {
  const headers = new Headers(response.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: status ?? response.status, headers });
}

async function fetchStatic(bucket, pathname, method) {
  const key = resolveStaticObjectKey(pathname);
  const res = await fetch(`https://${STATIC_HOST}/${bucket}/${key}`, { method });
  if (res.status === 404 && key !== "404.html") {
    const notFound = await fetch(`https://${STATIC_HOST}/${bucket}/404.html`, { method });
    return withHeaders(notFound, 404);
  }
  return withHeaders(res);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isDynamicPath(url.pathname)) {
      const originUrl = `https://${env.ORIGIN_HOSTNAME}${url.pathname}${url.search}`;
      // ttyd's --check-origin needs Origin == Host (the origin hostname here).
      // Vouch only for upgrades from this Worker's own origin; others pass unchanged.
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && request.headers.get("origin") === url.origin) {
        const headers = new Headers(request.headers);
        headers.set("origin", `https://${env.ORIGIN_HOSTNAME}`);
        return fetch(originUrl, { headers });
      }
      return fetch(originUrl, request);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    return fetchStatic(env.STATIC_BUCKET, url.pathname, request.method);
  },
};
