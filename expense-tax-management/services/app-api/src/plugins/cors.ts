import type { FastifyInstance } from "fastify";

export interface CorsPluginOptions {
  /**
   * Web session wiring design (2026-10-06) -- exact-match allowlist of
   * trusted browser origins (`APP_CORS_ALLOWED_ORIGINS`). Empty/unset
   * disables CORS entirely (today's behavior): no headers on any
   * response, no OPTIONS handling.
   */
  readonly allowedOrigins: readonly string[];
}

const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS = "authorization, content-type, idempotency-key, if-match";
const MAX_AGE_SECONDS = "600";

/**
 * Registered BEFORE registerGatewayHardening in app.ts: an OPTIONS
 * preflight from an allowed origin short-circuits here (reply.send() in
 * an onRequest hook stops the hook chain), so it never reaches the rate
 * limiter or a 404 for a path with no registered OPTIONS route.
 */
export function registerCors(app: FastifyInstance, options: CorsPluginOptions): void {
  if (options.allowedOrigins.length === 0) return;
  const allowed = new Set(options.allowedOrigins);

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !allowed.has(origin)) return;

    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");

    if (request.method === "OPTIONS") {
      reply
        .header("Access-Control-Allow-Methods", ALLOWED_METHODS)
        .header("Access-Control-Allow-Headers", ALLOWED_HEADERS)
        .header("Access-Control-Max-Age", MAX_AGE_SECONDS)
        .code(204)
        .send();
    }
  });
}
