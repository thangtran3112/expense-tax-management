/**
 * Phase 3D-A Task 4 — Office mailbox base: connection-status display
 * helpers and the Gmail connect action for the `/mailbox` page.
 *
 * Fix round 1 (Critical): this module used to generate a session nonce and
 * write it to a cookie here, in Office JavaScript. That cookie is
 * host-only on the Office origin -- it is never sent to the mailbox
 * broker's own origin, where the OAuth callback actually runs, and
 * JavaScript can't set `HttpOnly` anyway. App API now generates the
 * session nonce itself (never caller-supplied) and returns a link to the
 * broker's own `/oauth/google/begin`, which is where the broker's origin
 * sets that cookie, before it redirects to Google. Office is reduced to a
 * mere messenger: it never creates, stores, or transports the nonce
 * itself, so there is no cookie-handling code left in this module at all.
 */
import type { ClerkGetToken } from "./clerk";
import { startMailboxConnection, type StartMailboxConnectionInput } from "./api";
import type { OfficeSession } from "./session";

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
 * Calls App API's google/start route. The returned `authorizationUrl` is
 * the mailbox broker's own `/oauth/google/begin?...` link (not Google's
 * URL directly) -- the browser must navigate there first so the broker's
 * origin can set its session-nonce cookie before redirecting to Google.
 */
export async function connectMailboxGoogle(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  options: ConnectMailboxGoogleOptions = {},
) {
  const input: StartMailboxConnectionInput = {
    redirectOrigin: options.redirectOrigin ?? window.location.origin,
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    localScanTime: options.localScanTime ?? "07:00",
    requestId: options.requestId ?? crypto.randomUUID(),
  };

  return startMailboxConnection(session, input, getToken, organizationId, options.client);
}
