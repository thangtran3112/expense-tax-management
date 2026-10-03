/**
 * Phase 3D-A Task 4 — Office mailbox base: session-nonce creation/transport
 * and connection-status display helpers for the `/mailbox` page.
 *
 * The session nonce binds this browser session to one OAuth attempt
 * (App API persists only its sha256 digest, never the raw value -- see
 * `services/app-api/src/domain/mailbox-connections.ts`). It travels via a
 * short-lived cookie, never `localStorage` or `sessionStorage`: the
 * broker's public OAuth callback (a different origin/process than this
 * Next.js app) reads it back from the request's `Cookie` header when
 * Google redirects the browser there, which only a cookie -- not storage
 * APIs scoped to this origin's JS context -- can deliver.
 */
import type { ClerkGetToken } from "./clerk";
import { startMailboxConnection, type StartMailboxConnectionInput } from "./api";
import type { OfficeSession } from "./session";

export const MAILBOX_SESSION_NONCE_COOKIE = "mailbox_oauth_nonce";
const SESSION_NONCE_TTL_SECONDS = 600;

/** 32 random bytes, hex-encoded (64 chars) -- matches the broker's own nonce-length expectations. */
export function createMailboxSessionNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function writeMailboxSessionNonceCookie(nonce: string): void {
  if (typeof document === "undefined") return;
  document.cookie = [
    `${MAILBOX_SESSION_NONCE_COOKIE}=${encodeURIComponent(nonce)}`,
    "Path=/",
    `Max-Age=${SESSION_NONCE_TTL_SECONDS}`,
    "SameSite=Lax",
    "Secure",
  ].join("; ");
}

export function readMailboxSessionNonceCookie(): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() !== MAILBOX_SESSION_NONCE_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    } catch {
      return part.slice(separatorIndex + 1).trim();
    }
  }
  return null;
}

export function clearMailboxSessionNonceCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${MAILBOX_SESSION_NONCE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

// ------------------------------------------------------------------ //
// Connection status display
// ------------------------------------------------------------------ //

export type MailboxConnectionStatus =
  | "pending"
  | "active"
  | "paused"
  | "reauth_required"
  | "disconnecting"
  | "revocation_pending"
  | "revoked";

export type MailboxStatusTone = "ok" | "warn" | "bad";

const STATUS_DISPLAY: Record<MailboxConnectionStatus, { label: string; tone: MailboxStatusTone }> = {
  pending: { label: "Connecting", tone: "warn" },
  active: { label: "Active", tone: "ok" },
  paused: { label: "Paused", tone: "warn" },
  reauth_required: { label: "Reconnect needed", tone: "warn" },
  disconnecting: { label: "Disconnecting", tone: "warn" },
  revocation_pending: { label: "Disconnecting", tone: "warn" },
  revoked: { label: "Revoked", tone: "bad" },
};

export function mailboxStatusDisplay(status: MailboxConnectionStatus): { label: string; tone: MailboxStatusTone } {
  return STATUS_DISPLAY[status];
}

// ------------------------------------------------------------------ //
// Start a Gmail connection attempt
// ------------------------------------------------------------------ //

export interface ConnectMailboxGoogleOptions {
  readonly localScanTime?: string;
  readonly timezone?: string;
  readonly redirectOrigin?: string;
  readonly requestId?: string;
  readonly client?: Parameters<typeof startMailboxConnection>[4];
}

/**
 * Generates a fresh session nonce, writes its cookie, and calls App API's
 * google/start route. The raw nonce is sent to the server exactly once (in
 * the request body, over HTTPS); only its cookie copy -- never
 * localStorage -- survives on the client for the broker's callback to read
 * back later.
 */
export async function connectMailboxGoogle(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  options: ConnectMailboxGoogleOptions = {},
) {
  const sessionNonce = createMailboxSessionNonce();
  writeMailboxSessionNonceCookie(sessionNonce);

  const input: StartMailboxConnectionInput = {
    sessionNonce,
    redirectOrigin: options.redirectOrigin ?? window.location.origin,
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    localScanTime: options.localScanTime ?? "07:00",
    requestId: options.requestId ?? crypto.randomUUID(),
  };

  return startMailboxConnection(session, input, getToken, organizationId, options.client);
}
