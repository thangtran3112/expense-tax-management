// Session exchange, check, and browser-cookie logout only. Caddy (ai-trading/deploy/production/Caddyfile, the
// "gateway" service) owns every reverse-proxy and WebSocket concern
// declaratively; this file never does either -- no `node:net`, no
// `http.request` against another service, no WebSocket handling.
import { createServer } from "node:http";
import { sign, verify } from "./session.js";
import { verifyClerkToken } from "./clerk.js";
import { isAllowedEmail } from "./allowlist.js";
import { isAllowedOrigin } from "./origin.js";

const COOKIE_NAME = "__ai_trading_session";
const COOKIE_MAX_AGE_SECONDS = 3600;
const HEX_64 = /^[0-9a-f]{64}$/i;
// Exactly one whitespace-free token after the scheme: "Bearer token extra"
// or "Bearer tok\ten" must be malformed (400), not a token that merely fails
// verification (401). `\S+` cannot itself contain whitespace, and `\s*$`
// requires everything after it to be trailing whitespace only -- so any
// embedded space/tab anywhere in the credential makes the whole match fail.
const BEARER = /^Bearer\s+(\S+)\s*$/i;

function csvList(csv) {
  return (csv || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = BEARER.exec(header);
  if (!match) return null;
  const token = match[1].trim();
  return token ? token : null;
}

export function createAuthServer(env) {
  const { SESSION_SIGNING_KEY, ALLOWED_EMAILS, ALLOWED_ORIGINS, CLERK_SECRET_KEY, verifyToken } = env;

  // Fail closed at startup, not on first request: a bad signing key or an
  // empty allowlist must never silently serve as "allow everyone".
  if (typeof SESSION_SIGNING_KEY !== "string" || !HEX_64.test(SESSION_SIGNING_KEY)) {
    throw new Error("SESSION_SIGNING_KEY must be exactly 64 hexadecimal characters");
  }
  const allowedOrigins = csvList(ALLOWED_ORIGINS);
  if (allowedOrigins.length === 0) {
    throw new Error("ALLOWED_ORIGINS must name at least one origin");
  }
  if (csvList(ALLOWED_EMAILS).length === 0) {
    throw new Error("ALLOWED_EMAILS must name at least one email");
  }

  async function handleSession(req, res) {
    if (req.method !== "POST") return res.writeHead(405).end();
    // Origin gate first: a disallowed Origin is rejected before the
    // Authorization header is even read.
    if (!isAllowedOrigin(req.headers.origin, ALLOWED_ORIGINS)) return res.writeHead(403).end();
    const token = bearerToken(req);
    if (!token) return res.writeHead(400).end();
    const claims = await verifyClerkToken(token, {
      secretKey: CLERK_SECRET_KEY,
      authorizedParties: allowedOrigins,
      ...(verifyToken ? { verify: verifyToken } : {}),
    });
    if (!claims || !isAllowedEmail(claims.email, ALLOWED_EMAILS)) return res.writeHead(401).end();
    const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_SECONDS;
    const cookieValue = sign({ email: claims.email, exp }, SESSION_SIGNING_KEY);
    res.writeHead(204, {
      "set-cookie": `${COOKIE_NAME}=${cookieValue}; Domain=tobytran.dev; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    });
    res.end();
  }

  function handleCheck(req, res) {
    if (req.method !== "GET") return res.writeHead(405).end();
    const token = readCookie(req, COOKIE_NAME);
    const session = token ? verify(token, SESSION_SIGNING_KEY) : null;
    if (!session) return res.writeHead(401).end();
    res.writeHead(204, { "x-verified-email": session.email });
    res.end();
  }

  function handleLogout(req, res) {
    if (req.method !== "POST") return res.writeHead(405).end();
    if (!isAllowedOrigin(req.headers.origin, ALLOWED_ORIGINS)) return res.writeHead(403).end();
    // Delete only this browser's cookie with exactly the scope used to set it.
    // This does not revoke copied stateless cookies or already-open streams.
    res.writeHead(204, {
      "set-cookie": `${COOKIE_NAME}=; Domain=tobytran.dev; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      "cache-control": "no-store",
    });
    res.end();
  }

  return createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://auth");
    if (pathname === "/__auth/session") return void handleSession(req, res);
    if (pathname === "/__auth/check") return void handleCheck(req, res);
    if (pathname === "/__auth/logout") return void handleLogout(req, res);
    res.writeHead(404).end();
  });
}

/* c8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createAuthServer({
    SESSION_SIGNING_KEY: process.env.SESSION_SIGNING_KEY,
    ALLOWED_EMAILS: process.env.ALLOWED_EMAILS,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
  });
  const port = Number(process.env.PORT || 8181);
  server.listen(port, () => console.log(`auth listening on ${port}`));
}
/* c8 ignore stop */
