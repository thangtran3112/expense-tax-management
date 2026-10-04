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
import type {
  MailboxCandidateClassification,
  MailboxCandidateV1,
  Scope,
} from "@expense-tax/contracts";

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

// ------------------------------------------------------------------ //
// Ingestion status (Phase 3D-C Task 6)
//
// Reuses the existing candidate read API (MailboxCandidateV1 already
// carries status/scope/errorCode/expenseId -- no backend change needed;
// see task-6-report.md). A candidate only reaches this board once it has
// been approved for ingestion at least once -- detected by `scope` being
// assigned (only `resolveCandidate`'s `ingest` action ever sets it),
// which also safely excludes pre-approval `staged`/`review` candidates
// from the other classification-based review queue above.
// ------------------------------------------------------------------ //

export type MailboxIngestionBucket = "in_progress" | "needs_attention" | "completed";

export const MAILBOX_INGESTION_GROUPS: readonly {
  readonly bucket: MailboxIngestionBucket;
  readonly label: string;
  readonly emptyMessage: string;
}[] = [
  { bucket: "in_progress", label: "In progress", emptyMessage: "No ingestion activity yet." },
  { bucket: "needs_attention", label: "Needs attention", emptyMessage: "Nothing needs attention." },
  { bucket: "completed", label: "Completed", emptyMessage: "Nothing ingested yet." },
];

/** Link target for every "duplicate detected" outcome -- the existing
 * Duplicates review queue, never a mailbox-specific view (approved gate
 * owner decision #4/#2). */
export const MAILBOX_DUPLICATES_HREF = "/duplicates";

/** Typed transient codes a `retry`/`ingest` review action may clear --
 * mirrors services/app-api/src/domain/mailbox-candidates.ts's own
 * TRANSIENT_MAILBOX_ERROR_CODES + PROCESSING_TRANSIENT_MAILBOX_ERROR_CODES
 * (frontend cannot import backend domain code, so this is a UI-local
 * display mirror, not a second source of authorization truth -- the
 * server re-validates retry eligibility on every call regardless). */
const MAILBOX_RETRYABLE_ERROR_CODES = new Set<string>([
  "GOOGLE_RATE_LIMITED",
  "GOOGLE_UNAVAILABLE",
  "OCR_EXTRACTION_FAILED",
  "MAILBOX_MATERIALIZE_FAILED",
]);

type IngestionCandidate = Pick<
  MailboxCandidateV1,
  "status" | "scope" | "errorCode" | "expenseId" | "ingestionProgress"
>;

/** True only for a candidate that has been approved for ingestion at
 * least once (see module comment above). */
export function isMailboxIngestionCandidate(candidate: Pick<MailboxCandidateV1, "status" | "scope">): boolean {
  return (
    candidate.scope !== null &&
    (candidate.status === "queued" ||
      candidate.status === "processed" ||
      candidate.status === "duplicate" ||
      candidate.status === "review" ||
      candidate.status === "failed")
  );
}

export function mailboxIngestionBucket(candidate: Pick<MailboxCandidateV1, "status">): MailboxIngestionBucket {
  if (candidate.status === "queued") return "in_progress";
  if (candidate.status === "processed") return "completed";
  return "needs_attention";
}

export type MailboxIngestionAction =
  | { readonly kind: "retry" }
  | { readonly kind: "retryIngest" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "viewExpense"; readonly expenseId: string }
  | { readonly kind: "viewDuplicate" };

export interface MailboxIngestionStatusDisplay {
  readonly label: string;
  readonly tone: MailboxStatusTone;
  readonly note: string;
  readonly action: MailboxIngestionAction | null;
  /** Fix round 1 (review finding #8) -- only an actively-progressing row
   * (materializing/processing attachments) gets `role="status"
   * aria-live="polite"` in the renderer; a plain "Queued" placeholder or
   * any needs-attention/completed row does not. */
  readonly active: boolean;
}

/**
 * Status text and action for one ingestion row -- status text only, per
 * the approved gate (no opaque ID here; IDs live in a separate "Support
 * details" disclosure the caller renders from the same candidate).
 * Never reads anything but status/errorCode/expenseId/ingestionProgress:
 * no message body/content field exists on the contract to leak in the
 * first place. `ingestionProgress` (fix round 1, review finding #1) is a
 * read-only, server-derived phase/count summary -- see
 * MailboxIngestionProgressV1Schema's own doc comment.
 */
export function mailboxIngestionStatusDisplay(candidate: IngestionCandidate): MailboxIngestionStatusDisplay {
  switch (candidate.status) {
    case "queued": {
      const progress = candidate.ingestionProgress;
      if (progress?.phase === "materializing") {
        return {
          label: "Materializing",
          tone: "warn",
          note: "Streaming attachment(s) to secure storage.",
          action: null,
          active: true,
        };
      }
      if (progress?.phase === "processing_attachments") {
        const { succeeded, total } = progress.attachments;
        return {
          label: "OCR in progress",
          tone: "warn",
          note: `Extracting receipt fields from the staged file${total > 0 ? ` (${succeeded}/${total} attachment(s) done)` : ""}. No message content is read.`,
          action: null,
          active: true,
        };
      }
      return {
        label: "Queued",
        tone: "warn",
        note: "Waiting to be ingested. No file created yet.",
        action: null,
        active: false,
      };
    }
    case "processed":
      return {
        label: "Ingested",
        tone: "ok",
        note: "Processing complete. Open the expense for full details.",
        action: candidate.expenseId ? { kind: "viewExpense", expenseId: candidate.expenseId } : null,
        active: false,
      };
    case "duplicate":
      return {
        label: "Duplicate detected",
        tone: "warn",
        note: "Matches an existing expense. Pending in the Duplicates queue -- no automatic merge.",
        action: { kind: "viewDuplicate" },
        active: false,
      };
    case "review":
      return {
        label: "Failed -- recoverable",
        tone: "bad",
        note: "A prior attempt failed and was cleared. Approve again to retry -- the same scope is reused.",
        action: { kind: "retryIngest" },
        active: false,
      };
    case "failed":
      if (candidate.errorCode && MAILBOX_RETRYABLE_ERROR_CODES.has(candidate.errorCode)) {
        return {
          label: "Failed -- transient error",
          tone: "bad",
          note: "Safe to retry -- the same idempotency key is reused, so retrying cannot create a duplicate expense.",
          action: { kind: "retry" },
          active: false,
        };
      }
      if (candidate.errorCode === "MALWARE_DETECTED") {
        return {
          label: "Malware scan blocked",
          tone: "bad",
          note: "Attachment failed the malware scan and was never stored. This is a dead end: no retry and no download -- the source message must be re-sent or handled outside Office.",
          action: { kind: "dismiss" },
          active: false,
        };
      }
      return {
        label: "Unsupported attachment",
        tone: "bad",
        note: "Attachment exceeded the size/type limit. Not eligible for retry.",
        action: null,
        active: false,
      };
    default:
      return { label: candidate.status, tone: "warn", note: "", action: null, active: false };
  }
}

/** Message for a `retry`/`ingest`-against-this-panel 409 (stale candidate
 * version) -- same inline-refresh handling as the candidate review panel
 * above and the Duplicates queue (approved gate owner decision #5). */
export function mailboxIngestionConflictMessage(status: number | undefined): string {
  return status === 409
    ? "Candidate changed while retrying -- status refreshed below. Confirm before retrying again."
    : "Action failed. Try again.";
}

/** Non-null only when the connection itself blocks ingestion-status
 * access (mirrors App API's authorizeCandidateAccess, which 403s every
 * candidate read once a connection is fully revoked -- "reauth_required"
 * is not included here; it only blocks new scanning, never review/
 * ingestion-status access, per the existing mailbox page's own
 * reauth-required handling). */
export function mailboxIngestionAccessMessage(connectionStatus: MailboxConnectionStatus): string | null {
  return connectionStatus === "revoked"
    ? "Mailbox disconnected. Already-ingested expenses are unaffected; no new ingestion activity will appear here."
    : null;
}
