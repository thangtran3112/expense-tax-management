/**
 * Phase 3D-A Task 3 — OAuth `state` parameter: encrypted, self-contained,
 * stateless (no broker database row -- the only persisted state lives
 * in App API's `mailbox_oauth_attempts`, Task 1/2).
 *
 * Payload carries `connectionId`, `attemptId`, a session-nonce digest (the
 * raw nonce is never persisted, consistent with App API's own
 * `domain/mailbox-connections.ts`), a generated PKCE verifier, issue/
 * expiry, and the redirect origin. AES-256-GCM, 96-bit random nonce, AAD
 * `mailbox-oauth-state:v1` (domain-separates this ciphertext from
 * token-vault ciphertext encrypted under the same key material).
 *
 * `consumeOAuthState` only decrypts/validates/digests; it never talks to
 * App API or Google -- the caller (Task 4's callback route) calls App's
 * one-time `consumeOAuthAttempt` CAS with the returned digests *before*
 * exchanging the authorization code, exactly as the brief specifies.
 * One-time enforcement is therefore App API's CAS, not this module (no
 * database row exists here to CAS against); this module's own
 * contribution to that guarantee is that every `createOAuthState` call
 * produces a fresh random nonce, so no two attempts -- even for the same
 * connection/attempt -- ever share a `state`/`stateDigest`.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const AAD = Buffer.from("mailbox-oauth-state:v1", "utf8");
const STATE_PREFIX = "v1";

export interface VaultKeyMap {
  readonly keys: ReadonlyMap<string, Buffer>;
  readonly activeKeyId: string;
}

export interface CreateOAuthStateInput {
  readonly connectionId: string;
  readonly attemptId: string;
  readonly sessionNonce: string;
  readonly redirectOrigin: string;
  readonly ttlSeconds: number;
  readonly vaultKeys: VaultKeyMap;
  readonly now?: () => Date;
}

export interface CreateOAuthStateResult {
  readonly state: string;
  readonly stateDigest: string;
  readonly pkceVerifier: string;
  readonly codeChallenge: string;
  readonly expiresAt: string;
}

export interface ConsumeOAuthStateInput {
  readonly state: string;
  readonly sessionNonce: string;
  readonly allowedRedirectOrigins: ReadonlySet<string> | readonly string[];
  readonly vaultKeys: VaultKeyMap;
  readonly now?: () => Date;
}

export interface ConsumeOAuthStateResult {
  readonly connectionId: string;
  readonly attemptId: string;
  readonly pkceVerifier: string;
  readonly redirectOrigin: string;
  readonly stateDigest: string;
  readonly sessionNonceDigest: string;
}

export class OAuthStateInvalidError extends Error {
  constructor(reason: string) {
    super(`Invalid OAuth state: ${reason}`);
    this.name = "OAuthStateInvalidError";
  }
}

interface StatePayload {
  readonly connectionId: string;
  readonly attemptId: string;
  readonly sessionNonceDigest: string;
  readonly pkceVerifier: string;
  readonly redirectOrigin: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function digestsEqual(a: string, b: string): boolean {
  const hex64 = /^[a-f0-9]{64}$/;
  if (!hex64.test(a) || !hex64.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function generatePkceVerifier(): string {
  // RFC 7636: 43-128 unreserved characters. 64 bytes base64url-encoded
  // (no padding) yields 86 characters, well within range.
  return randomBytes(64).toString("base64url");
}

export function createOAuthState(input: CreateOAuthStateInput): CreateOAuthStateResult {
  const key = input.vaultKeys.keys.get(input.vaultKeys.activeKeyId);
  if (!key) {
    throw new Error(`Active vault key "${input.vaultKeys.activeKeyId}" is not loaded`);
  }

  const now = (input.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1_000);
  const pkceVerifier = generatePkceVerifier();

  const payload: StatePayload = {
    connectionId: input.connectionId,
    attemptId: input.attemptId,
    sessionNonceDigest: sha256Hex(input.sessionNonce),
    pkceVerifier,
    redirectOrigin: input.redirectOrigin,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const state = [
    STATE_PREFIX,
    input.vaultKeys.activeKeyId,
    nonce.toString("base64url"),
    Buffer.concat([ciphertext, authTag]).toString("base64url"),
  ].join(".");

  return {
    state,
    stateDigest: sha256Hex(state),
    pkceVerifier,
    codeChallenge: sha256Base64Url(pkceVerifier),
    expiresAt: payload.expiresAt,
  };
}

/**
 * Decrypts and expiry-checks `state`, with no session-nonce or
 * redirect-origin validation -- used internally by
 * `google-mailbox.ts`'s `exchangeAuthorizationCode`, whose fixed
 * `OAuthCallbackInput` contract (`@expense-tax/contracts`, Task 1) only
 * carries `{code, state, requestOrigin}`, never a session nonce. Session-
 * nonce verification happens earlier in the real flow, in
 * `consumeOAuthState` below, called directly by Task 4's callback route
 * (which does have the session nonce, e.g. from a cookie) before App's
 * one-time CAS and before `exchangeAuthorizationCode` is ever reached.
 */
export function decodeOAuthStatePayload(
  state: string,
  vaultKeys: VaultKeyMap,
  now: () => Date = () => new Date(),
): ConsumeOAuthStateResult {
  const payload = decryptStatePayload(state, vaultKeys);
  if (now().getTime() >= new Date(payload.expiresAt).getTime()) {
    throw new OAuthStateInvalidError("expired");
  }
  return {
    connectionId: payload.connectionId,
    attemptId: payload.attemptId,
    pkceVerifier: payload.pkceVerifier,
    redirectOrigin: payload.redirectOrigin,
    stateDigest: sha256Hex(state),
    sessionNonceDigest: payload.sessionNonceDigest,
  };
}

function decryptStatePayload(state: string, vaultKeys: VaultKeyMap): StatePayload {
  const parts = state.split(".");
  if (parts.length !== 4 || parts[0] !== STATE_PREFIX) {
    throw new OAuthStateInvalidError("malformed state");
  }
  const [, keyId, nonceEncoded, bodyEncoded] = parts;
  const key = vaultKeys.keys.get(keyId ?? "");
  if (!key) {
    throw new OAuthStateInvalidError("unknown or retired key");
  }

  try {
    const nonce = Buffer.from(nonceEncoded ?? "", "base64url");
    const body = Buffer.from(bodyEncoded ?? "", "base64url");
    if (nonce.length !== 12 || body.length < 16) {
      throw new Error("malformed state body");
    }
    const ciphertext = body.subarray(0, body.length - 16);
    const authTag = body.subarray(body.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(authTag);
    decipher.setAAD(AAD);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as StatePayload;
  } catch (error) {
    if (error instanceof OAuthStateInvalidError) throw error;
    // Tamper (GCM auth-tag mismatch), AAD mismatch, or malformed base64url.
    throw new OAuthStateInvalidError("decryption failed");
  }
}

export function consumeOAuthState(input: ConsumeOAuthStateInput): ConsumeOAuthStateResult {
  const payload = decryptStatePayload(input.state, input.vaultKeys);

  const now = (input.now ?? (() => new Date()))();
  if (now.getTime() >= new Date(payload.expiresAt).getTime()) {
    throw new OAuthStateInvalidError("expired");
  }

  const sessionNonceDigest = sha256Hex(input.sessionNonce);
  if (!digestsEqual(sessionNonceDigest, payload.sessionNonceDigest)) {
    throw new OAuthStateInvalidError("session nonce mismatch");
  }

  const allowedOrigins =
    input.allowedRedirectOrigins instanceof Set
      ? input.allowedRedirectOrigins
      : new Set(input.allowedRedirectOrigins);
  if (!allowedOrigins.has(payload.redirectOrigin)) {
    throw new OAuthStateInvalidError("redirect origin not allowed");
  }

  return {
    connectionId: payload.connectionId,
    attemptId: payload.attemptId,
    pkceVerifier: payload.pkceVerifier,
    redirectOrigin: payload.redirectOrigin,
    stateDigest: sha256Hex(input.state),
    sessionNonceDigest,
  };
}
