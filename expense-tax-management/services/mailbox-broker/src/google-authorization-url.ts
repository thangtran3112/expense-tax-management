/**
 * Phase 3D-A Task 4, fix round 2 (Important) — the `/oauth/google/begin`
 * route must build the Google authorization URL itself from trusted,
 * server-side configuration (client ID, redirect URI) and the already-
 * validated `state`/`codeChallenge`, never accept a URL from the client
 * (that was an open redirect: any caller could carry a valid `state` but
 * redirect the browser anywhere by supplying a different `authorizationUrl`
 * string).
 *
 * Deliberately independent of `google-mailbox.ts`'s own
 * `createAuthorizationUrl` (which also *creates* a fresh `state`/nonce via
 * `createOAuthState` -- not reusable here, since the begin route must
 * reuse the *exact* `state` already committed to App API's
 * `mailbox_oauth_attempts.state_digest` row, not mint a new one). The
 * googleapis call shape (`access_type`/`scope`/`prompt`/`code_challenge*`)
 * is intentionally identical so the regenerated URL is equivalent to the
 * one originally returned from `/internal/v1/mailbox/oauth/start`.
 */
import { google } from "googleapis";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Minimal surface needed -- mirrors `google-mailbox.ts`'s own `OAuth2ClientLike`, kept narrow so tests can substitute a fake. */
export interface GoogleAuthUrlClientLike {
  generateAuthUrl(options: Record<string, unknown>): string;
}

export interface GoogleAuthorizationUrlOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly createOAuth2Client?: () => GoogleAuthUrlClientLike;
}

export interface BuildGoogleAuthorizationUrlInput {
  readonly state: string;
  readonly codeChallenge: string;
}

export type GoogleAuthorizationUrlBuilder = (input: BuildGoogleAuthorizationUrlInput) => string;

export function createGoogleAuthorizationUrlBuilder(
  options: GoogleAuthorizationUrlOptions,
): GoogleAuthorizationUrlBuilder {
  const createClient =
    options.createOAuth2Client ??
    (() =>
      new google.auth.OAuth2(
        options.clientId,
        options.clientSecret,
        options.redirectUri,
      ) as unknown as GoogleAuthUrlClientLike);

  return (input) => {
    const client = createClient();
    return client.generateAuthUrl({
      access_type: "offline",
      scope: [GMAIL_READONLY_SCOPE],
      include_granted_scopes: false,
      prompt: "consent",
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    });
  };
}
