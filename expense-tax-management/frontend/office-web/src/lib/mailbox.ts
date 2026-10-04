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
import type { MailboxCandidateClassification, Scope } from "@expense-tax/contracts";

import type { ClerkGetToken } from "./clerk";
import {
  startMailboxConnection,
  type MailboxCandidateReviewAction,
  type StartMailboxConnectionInput,
} from "./api";
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
  readonly client?: Parameters<typeof startMailboxConnection>[5];
}

/**
 * Calls App API's google/start route for the given `scope` -- fix round 2:
 * explicit, not derived from `session.scope`, since the approved mockup
 * requires letting the user pick among every scope they're authorized
 * for, not just whichever one the Office session happens to be viewing.
 * The returned `authorizationUrl` is the mailbox broker's own
 * `/oauth/google/begin?...` link (not Google's URL directly) -- the
 * browser must navigate there first so the broker's origin can set its
 * session-nonce cookie before redirecting to Google.
 */
export async function connectMailboxGoogle(
  session: OfficeSession,
  scope: Scope,
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

  return startMailboxConnection(session, scope, input, getToken, organizationId, options.client);
}

// ------------------------------------------------------------------ //
// Candidate review queue display (Phase 3D-B Task 5)
// ------------------------------------------------------------------ //

/**
 * Candidate classification groups, display order and label, matching the
 * approved mockup (plans/mockups/office-mailbox-review/review.html):
 * "Likely receipt" / "Uncertain" / "Not a receipt".
 */
export const MAILBOX_CANDIDATE_CLASSIFICATION_GROUPS: readonly {
  readonly classification: MailboxCandidateClassification;
  readonly label: string;
  readonly emptyMessage: string;
}[] = [
  {
    classification: "receipt",
    label: "Likely receipt",
    emptyMessage: "No likely-receipt candidates. New scans add candidates here automatically.",
  },
  {
    classification: "ambiguous",
    label: "Uncertain",
    emptyMessage: "Nothing needs review. Uncertain items will appear here when found.",
  },
  {
    classification: "not_receipt",
    label: "Not a receipt",
    emptyMessage: "No dismissed candidates. Items you dismiss are kept here for audit only.",
  },
];

/**
 * Best-effort label for a candidate's deterministic reason-code evidence.
 * `evidence` is typed as `readonly string[]` in the wire contract (not an
 * enum -- see packages/contracts/src/mailbox-discovery.ts), so an unknown
 * code (e.g. from a future classifier version) falls back to the raw
 * string rather than throwing or disappearing.
 */
const REASON_CODE_LABELS: Readonly<Record<string, string>> = {
  pdf_attachment_detected: "PDF attachment",
  order_confirmation_schema: "Order confirmation",
  structured_html_invoice: "Structured invoice",
  sender_domain_known_retailer: "Known retailer",
  sender_domain_unverified: "Unverified sender",
  subject_keyword_order: "Order keyword",
  free_text_only_low_confidence: "Low-confidence text",
  marketing_keyword_match: "Marketing keyword",
  no_structured_or_attachment_evidence: "No structured evidence",
};

export function mailboxReasonCodeLabel(code: string): string {
  return REASON_CODE_LABELS[code] ?? code;
}

const REVIEW_ACTION_LABELS: Record<MailboxCandidateReviewAction, string> = {
  ingest: "Approve for ingestion",
  skip: "Skip",
  not_receipt: "Not a receipt",
  retry: "Retry",
};

export function mailboxCandidateReviewActionLabel(action: MailboxCandidateReviewAction): string {
  return REVIEW_ACTION_LABELS[action];
}
