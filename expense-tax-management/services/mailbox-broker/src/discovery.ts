/**
 * Phase 3D-B Task 4 — Gmail fenced discovery and direct App staging.
 *
 * `createDiscoveryEngine` is the broker-side implementation of
 * `MailboxDiscoveryProviderAdapter.discover`: given only `scanRunId`
 * (`DiscoveryInput.connectionId` is part of the generic contract shape
 * but unused here -- the worker never knows a connectionId, by design;
 * see clients/mailbox-client.ts's `discoverPage` doc comment), it
 * re-reads the connection's current cursor fence from App API
 * (`loadScanBinding`), lists/fetches exactly one page of Gmail messages,
 * classifies them, and calls `stageCandidateMetadata` directly. Only the
 * opaque `DiscoveryPageV1` (scanRunId/pageSequence/candidateCount/
 * retryCount) crosses back to the worker -- never a cursor, history ID,
 * provider message ID, sender, subject, or attachment.
 *
 * Fix round 2 (review Critical #1, re-review: fix round 1's approach was
 * rejected) -- pre-fence + replay, per the spec's "Gmail Discovery and
 * Cursor Semantics": a full sync (initial, or a 404-recovery bounded full
 * sync) captures the current Gmail profile historyId *before* listing
 * (the "pre-sync fence"), stages the bounded lookback list across as many
 * pages as needed, and only then replays `history.list(preSyncFence)` to
 * catch messages that arrived during the full sync, before the final
 * (real) historyId is persisted. Fix round 1 carried this fence across
 * stateless broker calls by overloading the opaque `current_history_id`
 * column with a string-tag prefix; the re-review correctly rejected that
 * (a real opaque Gmail value could collide with the tag). This round
 * instead uses explicit, dedicated App-owned storage --
 * `MailboxBrokerScanBindingV1.preFenceHistoryId` (migration 019's new
 * `pre_fence_history_id` column, in-place edit since 019 is unreleased)
 * -- non-null for exactly as long as the full-sync/replay is in flight. A
 * crash between capturing it and finishing the replay is recoverable: the
 * next `discover()` call reads this same persisted value back (never
 * re-captures a newer, wrong fence).
 *
 * Fix round 2 (review Critical #2, re-review: fix round 1's internal
 * 20-page/100-id aggregation cap was itself new breakage -- it silently
 * truncated history and then advanced the cursor as if everything were
 * consumed) -- `GmailDiscoveryClientLike.listHistory` now returns exactly
 * one raw Gmail API page (`nextPageToken` surfaced, never aggregated
 * internally). The engine persists that token in
 * `MailboxBrokerScanBindingV1.historyPageToken` (migration 019's new
 * `history_page_token` column) and -- critically -- `nextHistoryId` is
 * only ever non-null (settling/advancing the cursor) on the page where
 * Gmail itself reports no further `nextPageToken`. Any page with more
 * history remaining never advances the cursor; the next `discover()` call
 * resumes Gmail's own pagination from exactly the stored token. The same
 * single-page-per-call discipline now applies uniformly to ordinary
 * incremental sync and to the pre-fence replay walk -- one `history.list`
 * call per `discover()` invocation, never more.
 *
 * Stateless-broker pagination for the bounded *list* (not history) phase
 * is unchanged: Gmail's own bounded `messages.list` results (capped at
 * the spec's own 100-message maximum, which is also the per-call request
 * cap, so one API call always returns the complete bounded set) are
 * re-fetched in full on every call and sliced by
 * `(pageSequence - 1) * pageSize`, rather than persisting a separate list
 * page token.
 *
 * Transient Gmail failures (429/5xx) are retried a bounded number of
 * times in-process (`withGoogleRetry`, honoring a Gmail `Retry-After`
 * hint when present); if retries are exhausted, the error propagates to
 * the caller (the broker's HTTP route), which maps it to a 429/503 the
 * worker's own activity retry policy (`activities/mailbox.ts`,
 * unmodified -- already retries `rate_limited`/`unavailable`) already
 * handles. `DiscoveryPageV1.retryCount` is therefore always 0 on a
 * successful return here: a page that could not complete throws instead
 * of returning a partial/degraded page, so no separate persisted
 * retry-count bookkeeping was invented beyond what migration 019's
 * `mailbox_scan_page_outcomes` already tracks at the DB layer once the
 * page is durably staged.
 *
 * An attachment whose Gmail-reported size exceeds `MAX_UPLOAD_BYTES` (25
 * MiB) is never downloaded (no partial parsing) and is excluded from the
 * manifest; its message is forced to at least `ambiguous` (never
 * auto-staged as `receipt`) with `attachment_oversize` evidence, per the
 * spec's "Exceeding a limit creates typed review/skip outcome, never
 * partial parsing."
 *
 * Fix round 2 item 3 -- classification now delegates to Task 5's
 * standalone, approved reason-code catalog (`classification.ts`'s
 * `classifyCandidateEvidence`) instead of this module's own ad hoc
 * keyword rule, so staged candidates carry the catalog's documented
 * reason codes as evidence.
 */
import { createHash } from "node:crypto";

import {
  MAX_CANDIDATE_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
  type AttachmentManifestV1,
  type DiscoveryInput,
  type DiscoveryPageV1,
  type FileContentType,
  type MailboxBrokerDiscoveryAppClient,
  type MailboxBrokerScanBindingV1,
  type MailboxCandidateMetadataStagingV1,
} from "@expense-tax/contracts";

import { classifyCandidateEvidence } from "./classification.js";

type StagingMessage = MailboxCandidateMetadataStagingV1["messages"][number];

export const DEFAULT_LOOKBACK_DAYS = 30;
export const MAX_LOOKBACK_DAYS = 90;
export const MAX_INITIAL_SYNC_MESSAGES = 100;
export const DEFAULT_DISCOVERY_PAGE_SIZE = 10;

const ACCEPTED_ATTACHMENT_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

export type GmailApiErrorCode = "not_found" | "reauth_required" | "rate_limited" | "unavailable" | "unknown";

/**
 * Typed Gmail API failure. `not_found` drives 404 full-sync recovery;
 * `reauth_required` is never retried. Fix round 1 (review Important #6):
 * `unknown` replaces re-throwing a raw googleapis error object (which can
 * carry request URLs, headers, or other internals) -- every Gmail
 * failure is mapped to one of these five codes with a static, redacted
 * message, never the original error's message/body. `retryAfterMs`
 * carries Gmail's own `Retry-After` hint (seconds, converted to ms,
 * clamped) when present, for `withGoogleRetry` to honor.
 */
export class GmailApiError extends Error {
  readonly code: GmailApiErrorCode;
  readonly retryAfterMs: number | undefined;

  constructor(code: GmailApiErrorCode, message = `Gmail API request failed: ${code}`, retryAfterMs?: number) {
    super(message);
    this.name = "GmailApiError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const RETRYABLE_GMAIL_ERROR_CODES = new Set<GmailApiErrorCode>(["rate_limited", "unavailable"]);

export interface GmailMessageId {
  readonly id: string;
  readonly threadId: string | null;
}

export interface GmailMessageAttachmentPart {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mimeType: string;
  /** Gmail-reported decoded size, checked against MAX_UPLOAD_BYTES before any download (review Important #5). */
  readonly sizeBytes: number;
}

export interface GmailMessageDetail {
  readonly id: string;
  readonly threadId: string | null;
  readonly receivedAt: string;
  readonly senderAddress: string;
  readonly subject: string;
  readonly attachments: readonly GmailMessageAttachmentPart[];
}

/**
 * Minimal, injectable surface this module needs from the Gmail API --
 * same narrowing convention as google-mailbox.ts's `OAuth2ClientLike`.
 * Tests substitute a fake; no real Google network access (per task
 * constraints). `listHistory` rejects with `GmailApiError("not_found")`
 * for Gmail's own HTTP 404 (history ID outside retained window).
 *
 * Fix round 2 (review Critical #2) -- `listHistory` returns exactly one
 * raw Gmail API page: `pageToken` (input, optional) resumes a prior
 * call's continuation; `nextPageToken` (output) is non-null exactly when
 * more history pages remain. No internal multi-page aggregation here --
 * the caller (discovery.ts) decides whether to continue, and never
 * advances the cursor while `nextPageToken` is present.
 */
export interface GmailDiscoveryClientLike {
  listMessageIds(input: { readonly query: string; readonly maxResults: number }): Promise<{
    readonly ids: readonly GmailMessageId[];
  }>;
  listHistory(input: {
    readonly startHistoryId: string;
    readonly maxResults: number;
    readonly pageToken?: string;
  }): Promise<{
    readonly historyId: string;
    readonly ids: readonly GmailMessageId[];
    readonly nextPageToken: string | null;
  }>;
  getMessage(id: string): Promise<GmailMessageDetail>;
  getAttachment(input: { readonly messageId: string; readonly attachmentId: string }): Promise<Buffer>;
  getProfileHistoryId(): Promise<string>;
}

/**
 * Fix round 2 item 3 -- no retailer-domain catalog exists anywhere in
 * 3D-B's scope (classification.ts's `senderDomainKnownRetailer` input is
 * an external signal it deliberately does not compute itself); always
 * `false` until a later task adds one. Does not change which messages
 * reach `review` vs `receipt` on its own -- it only ever adds supporting
 * evidence/sender-domain-unverified context within `ambiguous`.
 */
function senderDomainKnownRetailer(): boolean {
  return false;
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface RetryOptions {
  readonly retries?: number;
  readonly baseDelayMs?: number;
  readonly maxRetryAfterMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

/**
 * Bounded exponential backoff for 429/5xx only; every other GmailApiError
 * (not_found/reauth_required/unknown) rethrows immediately, uncounted.
 * Fix round 1 (review Important #6): when the error carries a Gmail
 * `Retry-After` hint, waits that long instead of the exponential delay
 * (clamped to `maxRetryAfterMs`, default 60s, so a malformed/huge header
 * value can never stall a page indefinitely).
 */
export async function withGoogleRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const sleep = options.sleep ?? defaultSleep;

  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof GmailApiError) || !RETRYABLE_GMAIL_ERROR_CODES.has(error.code)) {
        throw error;
      }
      attempt += 1;
      if (attempt > retries) throw error;
      const delayMs =
        error.retryAfterMs !== undefined
          ? Math.min(Math.max(error.retryAfterMs, 0), maxRetryAfterMs)
          : baseDelayMs * 2 ** (attempt - 1);
      await sleep(delayMs);
    }
  }
}

export interface DiscoveryEngineOptions {
  readonly appClient: MailboxBrokerDiscoveryAppClient;
  readonly getGmailClient: (connectionId: string) => Promise<GmailDiscoveryClientLike>;
  readonly pageSize?: number;
  readonly lookbackDays?: number;
  readonly now?: () => Date;
  readonly retry?: RetryOptions;
}

export interface DiscoveryEngine {
  discover(input: DiscoveryInput): Promise<DiscoveryPageV1>;
}

function boundedLookbackAfterSeconds(now: Date, lookbackDays: number): number {
  const clamped = Math.min(Math.max(lookbackDays, 1), MAX_LOOKBACK_DAYS);
  return Math.floor(now.getTime() / 1000) - clamped * 24 * 60 * 60;
}

/** This page's outcome before message detail/classification: what Gmail ids to fetch, and the connection-state fields to persist alongside them. */
interface HistoryWalkPage {
  readonly ids: readonly GmailMessageId[];
  readonly nextHistoryId: string | null;
  readonly nextPreFenceHistoryId: string | null;
  readonly nextHistoryPageToken: string | null;
}

export function createDiscoveryEngine(options: DiscoveryEngineOptions): DiscoveryEngine {
  const pageSize = options.pageSize ?? DEFAULT_DISCOVERY_PAGE_SIZE;
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const retry = options.retry ?? {};

  async function listBoundedFullSync(client: GmailDiscoveryClientLike): Promise<readonly GmailMessageId[]> {
    const afterSeconds = boundedLookbackAfterSeconds(options.now?.() ?? new Date(), lookbackDays);
    const listed = await withGoogleRetry(
      () => client.listMessageIds({ query: `after:${afterSeconds}`, maxResults: MAX_INITIAL_SYNC_MESSAGES }),
      retry,
    );
    return listed.ids.slice(0, MAX_INITIAL_SYNC_MESSAGES);
  }

  /**
   * One raw `history.list` page, resuming from `pageToken` when given.
   * Fix round 2 (review Critical #2): never aggregates multiple Gmail
   * pages -- `nextHistoryId`/settling only happens on the page where
   * Gmail itself reports no further `nextPageToken`; otherwise the
   * caller persists the returned token and the cursor stays put.
   */
  async function historyWalkPage(
    client: GmailDiscoveryClientLike,
    startHistoryId: string,
    pageToken: string | null,
  ): Promise<{ readonly ids: readonly GmailMessageId[]; readonly historyId: string; readonly nextPageToken: string | null }> {
    const page = await withGoogleRetry(
      () =>
        client.listHistory({
          startHistoryId,
          maxResults: MAX_INITIAL_SYNC_MESSAGES,
          ...(pageToken !== null ? { pageToken } : {}),
        }),
      retry,
    );
    return page;
  }

  /**
   * One page of the bounded-lookback backlog list, or -- once that list is
   * fully paged through (tracked purely by recomputing it and comparing
   * against `nextPageSequence`, no extra state needed) -- one page of the
   * replay step itself: `history.list(preSyncHistoryId)`, resuming from
   * `historyPageToken` when a prior replay page left one. Spec: "After
   * durable staging, replay users.history.list from pre-sync fence to
   * catch messages arriving during full sync... Persist post-replay
   * history ID only after every discovered message ID has a durable
   * candidate or durable retry record" -- the backlog pages (and any
   * non-final replay page) never settle the cursor; only the replay's
   * final page (no `nextPageToken`) does.
   */
  async function fullSyncOrReplayPage(
    client: GmailDiscoveryClientLike,
    binding: Pick<MailboxBrokerScanBindingV1, "nextPageSequence" | "historyPageToken">,
    preSyncHistoryId: string,
  ): Promise<HistoryWalkPage> {
    const backlogIds = await listBoundedFullSync(client);
    const offset = (binding.nextPageSequence - 1) * pageSize;
    if (offset < backlogIds.length) {
      return {
        ids: backlogIds.slice(offset, offset + pageSize),
        nextHistoryId: null,
        nextPreFenceHistoryId: preSyncHistoryId, // still pending -- backlog not yet exhausted
        nextHistoryPageToken: null, // replay walk hasn't started yet
      };
    }
    const replay = await historyWalkPage(client, preSyncHistoryId, binding.historyPageToken);
    if (replay.nextPageToken !== null) {
      return {
        ids: replay.ids,
        nextHistoryId: null, // more replay pages remain -- never settle yet
        nextPreFenceHistoryId: preSyncHistoryId,
        nextHistoryPageToken: replay.nextPageToken,
      };
    }
    return {
      ids: replay.ids,
      nextHistoryId: replay.historyId, // replay fully exhausted -- settle for real
      nextPreFenceHistoryId: null,
      nextHistoryPageToken: null,
    };
  }

  return {
    async discover(input: DiscoveryInput): Promise<DiscoveryPageV1> {
      const binding = await options.appClient.loadScanBinding(input.scanRunId);
      const client = await options.getGmailClient(binding.connectionId);

      let page: HistoryWalkPage;

      if (binding.currentHistoryId === null || binding.preFenceHistoryId !== null) {
        // A full sync (initial, or an in-progress 404 recovery) is
        // underway for this connection. `preFenceHistoryId`, once
        // captured, is durable App-owned state (migration 019's
        // pre_fence_history_id) -- read it back rather than re-capturing
        // a newer value, so a crash between capture and replay completion
        // resumes correctly from the ORIGINAL fence.
        const preSyncHistoryId =
          binding.preFenceHistoryId ?? (await withGoogleRetry(() => client.getProfileHistoryId(), retry));
        page = await fullSyncOrReplayPage(client, binding, preSyncHistoryId);
      } else {
        try {
          const history = await historyWalkPage(client, binding.currentHistoryId, binding.historyPageToken);
          page =
            history.nextPageToken !== null
              ? {
                  ids: history.ids,
                  nextHistoryId: null, // more history remains -- cursor must not advance (review Critical #2)
                  nextPreFenceHistoryId: null,
                  nextHistoryPageToken: history.nextPageToken,
                }
              : {
                  ids: history.ids,
                  nextHistoryId: history.historyId,
                  nextPreFenceHistoryId: null,
                  nextHistoryPageToken: null,
                };
        } catch (error) {
          if (!(error instanceof GmailApiError) || error.code !== "not_found") throw error;
          // Expired/unretained history ID: bounded full-sync recovery,
          // same pre-fence/full-sync/replay sequence as initial sync
          // (spec: "use same pre-fence/full-sync/replay sequence").
          // Existing unique message IDs make recovery idempotent
          // (recordCandidateMetadata's onConflict-mismatch-checked skip).
          const preSyncHistoryId = await withGoogleRetry(() => client.getProfileHistoryId(), retry);
          page = await fullSyncOrReplayPage(client, binding, preSyncHistoryId);
        }
      }

      const messages: StagingMessage[] = [];

      for (const { id } of page.ids) {
        const detail = await withGoogleRetry(() => client.getMessage(id), retry);

        const attachmentManifest: AttachmentManifestV1[] = [];
        let hasOversizeAttachment = false;
        for (const part of detail.attachments) {
          if (attachmentManifest.length >= MAX_CANDIDATE_ATTACHMENTS) break;
          if (!ACCEPTED_ATTACHMENT_MIME_TYPES.has(part.mimeType)) continue;
          if (part.sizeBytes > MAX_UPLOAD_BYTES) {
            // Never download an oversize attachment -- no partial parsing
            // (spec: "Exceeding a limit creates typed review/skip
            // outcome, never partial parsing").
            hasOversizeAttachment = true;
            continue;
          }
          const bytes = await withGoogleRetry(
            () => client.getAttachment({ messageId: id, attachmentId: part.attachmentId }),
            retry,
          );
          if (bytes.length > MAX_UPLOAD_BYTES) {
            // Defense in depth: Gmail's reported size was wrong/stale.
            hasOversizeAttachment = true;
            continue;
          }
          attachmentManifest.push({
            name: part.filename,
            mimeType: part.mimeType as FileContentType,
            sizeBytes: bytes.length,
            sha256: sha256Hex(bytes),
          });
        }

        const senderDomain = detail.senderAddress.split("@")[1]?.toLowerCase() ?? "";
        // Fix round 2 item 3 -- Task 5's approved reason-code catalog,
        // not this module's own ad hoc keyword rule.
        const catalogResult = classifyCandidateEvidence({
          subject: detail.subject,
          hasAcceptedAttachment: attachmentManifest.length > 0,
          senderDomainKnownRetailer: senderDomainKnownRetailer(),
        });
        const evidence: string[] = hasOversizeAttachment
          ? [...catalogResult.evidence, "attachment_oversize"]
          : [...catalogResult.evidence];
        // An oversize attachment is never auto-stageable, regardless of
        // what other evidence the message carries (review Important #5).
        const classification = hasOversizeAttachment && catalogResult.classification === "receipt"
          ? "ambiguous"
          : catalogResult.classification;

        messages.push({
          receivedAt: detail.receivedAt,
          senderAddress: detail.senderAddress,
          senderDomain,
          subject: detail.subject,
          contentHash: sha256Hex(`${detail.id}:${detail.subject}:${detail.receivedAt}`),
          attachmentManifest,
          classification,
          confidence: catalogResult.confidence,
          evidence,
          providerMessageId: detail.id,
          providerThreadId: detail.threadId,
        });
      }

      const staged = await options.appClient.stageCandidateMetadata({
        schemaVersion: 1,
        scanRunId: input.scanRunId,
        connectionId: binding.connectionId,
        expectedConnectionVersion: binding.expectedConnectionVersion,
        cursorBeforeDigest: binding.currentCursorDigest,
        preFenceToken: binding.preFenceToken,
        pageSequence: binding.nextPageSequence,
        nextHistoryId: page.nextHistoryId,
        nextPreFenceHistoryId: page.nextPreFenceHistoryId,
        nextHistoryPageToken: page.nextHistoryPageToken,
        messages,
        idempotencyKey: `${binding.connectionId}:discover-page:${input.scanRunId}:${binding.nextPageSequence}`,
      });

      return {
        scanRunId: input.scanRunId,
        pageSequence: staged.pageSequence,
        candidateCount: messages.length,
        retryCount: 0,
      };
    },
  };
}
