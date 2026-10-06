// Verifies a Clerk session token and returns the caller's normalized identity,
// or null for any invalid, misconfigured, or unverifiable token (fail-closed).
//
// Operator precondition (cannot be enforced by this code): the Clerk Dashboard's
// default session token (Sessions -> Customize session token) must add TWO custom
// claims on top of Clerk's default claims:
//   - `email`, e.g. { "email": "{{user.primary_email_address}}" }
//   - `aud`,   e.g. { "aud": "https://trading.tobytran.dev" }
// Clerk's default session token already includes `iss`, `sub`, and (when the
// session was minted against a known frontend origin) `azp`, but it does not
// include `email` or `aud` unless the operator adds them. Until both custom
// claims are provisioned on the Clerk instance, every verification here fails
// closed — this is proven by this module's tests, not assumed.
import { verifyToken } from "@clerk/backend";

// Fixed per 01e's binding ruling: this hub's Clerk instance issuer and this
// hub's own audience. Not caller-configurable — a wrong value here must not be
// satisfiable by a malicious or misconfigured caller.
export const CLERK_ISSUER = "https://clerk.tobytran.dev";
export const CLERK_AUDIENCE = "https://trading.tobytran.dev";

/**
 * @param {string} token - Bearer token from the client's Authorization header.
 * @param {object} options
 * @param {string} [options.secretKey] - Clerk secret key, forwarded to `verify`.
 * @param {string[]} options.authorizedParties - Nonempty allowlist of frontend
 *   origins. Required: Clerk's `azp` claim must be a member of this list, both
 *   as a defense-in-depth check here and as an input to `verify` itself (the
 *   real `@clerk/backend` SDK also validates `azp` against this list).
 * @param {(token: string, opts: object) => Promise<{data?: object, errors?: Error[]}>} [options.verify] -
 *   Injectable in place of the real `verifyToken` for offline tests. The real
 *   SDK call additionally validates signature, expiry, issuer well-formedness,
 *   audience, and authorized party over the network/JWKS; an injected fake only
 *   replaces that network dependency; it must not replace this function's own
 *   claim checks below, which run unconditionally against whatever `verify`
 *   returns.
 * @returns {Promise<{sub: string, email: string} | null>}
 */
export async function verifyClerkToken(
  token,
  { secretKey, authorizedParties, verify = verifyToken } = {},
) {
  if (!token) return null;

  // A missing/empty authorized-party allowlist is a misconfiguration, not an
  // open allow: fail closed before even attempting verification.
  if (!Array.isArray(authorizedParties) || authorizedParties.length === 0) {
    return null;
  }

  let result;
  try {
    result = await verify(token, {
      secretKey,
      authorizedParties,
      audience: CLERK_AUDIENCE,
    });
  } catch {
    return null;
  }

  if (!result || result.errors) return null;

  const payload = result.data ?? result;
  if (!payload || typeof payload !== "object") return null;

  if (typeof payload.sub !== "string" || payload.sub === "") return null;
  if (typeof payload.email !== "string" || payload.email === "") return null;
  if (payload.iss !== CLERK_ISSUER) return null;
  if (payload.aud !== CLERK_AUDIENCE) return null;
  if (
    typeof payload.azp !== "string" ||
    !authorizedParties.includes(payload.azp)
  ) {
    return null;
  }

  return { sub: payload.sub, email: payload.email.toLowerCase() };
}
