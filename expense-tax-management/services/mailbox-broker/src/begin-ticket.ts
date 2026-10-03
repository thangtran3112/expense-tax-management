/**
 * Phase 3D-A Task 4, fix round 2 (Important) — the `/oauth/google/begin`
 * route no longer accepts a client-supplied `authorizationUrl` (open
 * redirect) or an unbounded-lifetime capability (the full 10-minute OAuth
 * attempt window). It instead accepts only this opaque, broker-minted,
 * short-lived (default 60s) ticket wrapping the already-built OAuth
 * `state` string and the raw session nonce -- the begin route decrypts it,
 * re-derives the Google authorization URL itself from trusted config (see
 * `google-authorization-url.ts`), and ignores everything else in the
 * request.
 *
 * Reuses the exact same AES-256-GCM vault-key material `oauth-state.ts`
 * already uses (`VaultKeyMap`) -- no new secret -- domain-separated by a
 * distinct AAD tag so this ciphertext can never be confused with a real
 * OAuth `state` blob or a token-vault row.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import type { VaultKeyMap } from "./oauth-state.js";

const AAD = Buffer.from("mailbox-begin-ticket:v1", "utf8");
const TICKET_PREFIX = "bt1";
const DEFAULT_TTL_SECONDS = 60;

export interface BeginTicketPayload {
  readonly state: string;
  readonly sessionNonce: string;
}

export interface CreateBeginTicketInput extends BeginTicketPayload {
  readonly vaultKeys: VaultKeyMap;
  readonly ttlSeconds?: number;
  readonly now?: () => Date;
}

export class BeginTicketInvalidError extends Error {
  constructor(reason: string) {
    super(`Invalid begin ticket: ${reason}`);
    this.name = "BeginTicketInvalidError";
  }
}

export function createBeginTicket(input: CreateBeginTicketInput): string {
  const key = input.vaultKeys.keys.get(input.vaultKeys.activeKeyId);
  if (!key) {
    throw new Error(`Active vault key "${input.vaultKeys.activeKeyId}" is not loaded`);
  }

  const now = (input.now ?? (() => new Date()))();
  const expiresAt = new Date(now.getTime() + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1_000);
  const body = JSON.stringify({
    state: input.state,
    sessionNonce: input.sessionNonce,
    expiresAt: expiresAt.toISOString(),
  });

  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(body, "utf8")), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    TICKET_PREFIX,
    input.vaultKeys.activeKeyId,
    nonce.toString("base64url"),
    Buffer.concat([ciphertext, authTag]).toString("base64url"),
  ].join(".");
}

export function consumeBeginTicket(
  ticket: string,
  vaultKeys: VaultKeyMap,
  now: () => Date = () => new Date(),
): BeginTicketPayload {
  const parts = ticket.split(".");
  if (parts.length !== 4 || parts[0] !== TICKET_PREFIX) {
    throw new BeginTicketInvalidError("malformed ticket");
  }
  const [, keyId, nonceEncoded, bodyEncoded] = parts;
  const key = vaultKeys.keys.get(keyId ?? "");
  if (!key) {
    throw new BeginTicketInvalidError("unknown or retired key");
  }

  let payload: BeginTicketPayload & { expiresAt: string };
  try {
    const nonce = Buffer.from(nonceEncoded ?? "", "base64url");
    const body = Buffer.from(bodyEncoded ?? "", "base64url");
    if (nonce.length !== 12 || body.length < 16) {
      throw new Error("malformed ticket body");
    }
    const ciphertext = body.subarray(0, body.length - 16);
    const authTag = body.subarray(body.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(authTag);
    decipher.setAAD(AAD);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    payload = JSON.parse(plaintext.toString("utf8")) as BeginTicketPayload & { expiresAt: string };
  } catch (error) {
    if (error instanceof BeginTicketInvalidError) throw error;
    // Tamper (GCM auth-tag mismatch), AAD mismatch, or malformed base64url.
    throw new BeginTicketInvalidError("decryption failed");
  }

  if (now().getTime() >= new Date(payload.expiresAt).getTime()) {
    throw new BeginTicketInvalidError("expired");
  }

  return { state: payload.state, sessionNonce: payload.sessionNonce };
}
