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
 * Fix round 1 (review Critical #1) -- pre-fence + replay, per the spec's
 * "Gmail Discovery and Cursor Semantics": a full sync (initial, or a
 * 404-recovery bounded full sync) captures the current Gmail profile
 * historyId *before* listing (the "pre-sync fence"), stages the bounded
 * lookback list across as many pages as needed, and only then replays
 * `history.list(preSyncFence)` -- staged as one additional page -- to
 * catch messages that arrived during the full sync, before the final
 * (real) historyId is persisted. Because the broker is stateless across
 * HTTP calls, the pre-sync fence is carried forward between pages inside
 * `app.mailbox_connections.current_history_id` itself (opaque to App --
 * migration 019's header: "App only compares them for fencing," and
 * recordCandidateMetadata never compares historyId for equality, only
 * stores whatever the broker reports) using a tagged-string marker
 * (`tagPendingReplay`/`parsePendingReplay`) that distinguishes "full
 * sync/replay in progress for this fence" from "settled, ordinary
 * incremental cursor." Once the replay page completes, the connection
 * holds Gmail's own real, untagged historyId and is a plain incremental
 * connection going forward.
 *
 * Fix round 1 (review Critical #2) -- `GmailDiscoveryClientLike.
 * listHistory` is specified (google-mailbox.ts's real implementation) to
 * fully exhaust Gmail's own `nextPageToken` internally before returning,
 * so this module never sees a partial history page.
 *
 * Stateless-broker pagination (unchanged from the original report):
 * Gmail's own bounded list results are re-fetched in full on every call
 * (bounded to the spec's 100-message cap) and sliced by
 * `(pageSequence - 1) * pageSize`, rather than persisting a Gmail list
 * page token anywhere.
 *
 * Transient Gmail failures (429/5xx) are retried a bounded number of
 * times in-process (`withGoogleRetry`, honoring a Gmail `Retry-After`
 * hint when present -- review Important #6); if retries are exhausted,
 * the error propagates to the caller (the broker's HTTP route), which
 * maps it to a 429/503 the worker's own activity retry policy
 * (`activities/mailbox.ts`, unmodified -- already retries
 * `rate_limited`/`unavailable`) already handles. `DiscoveryPageV1.
 * retryCount` is therefore always 0 on a successful return here: a page
 * that could not complete throws instead of returning a partial/degraded
 * page, so no separate persisted retry-count bookkeeping was invented
 * beyond what migration 019's `mailbox_scan_page_outcomes` already
 * tracks at the DB layer once the page is durably staged.
 *
 * Fix round 1 (review Important #5) -- an attachment whose Gmail-reported
 * size exceeds `MAX_UPLOAD_BYTES` (25 MiB) is never downloaded (no
 * partial parsing) and is excluded from the manifest; its message is
 * forced to at least `ambiguous` (never auto-staged as `receipt`) with
 * `attachment_oversize` evidence, per the spec's "Exceeding a limit
 * creates typed review/skip outcome, never partial parsing."
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
  type MailboxCandidateClassification,
  type MailboxCandidateMetadataStagingV1,
} from "@expense-tax/contracts";

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

const RECEIPT_SUBJECT_KEYWORDS = [
  "receipt",
  "invoice",
  "order confirmation",
  "payment confirmation",
  "purchase confirmation",
  "your order",
];

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
 */
export interface GmailDiscoveryClientLike {
  listMessageIds(input: { readonly query: string; readonly maxResults: number }): Promise<{
    readonly ids: readonly GmailMessageId[];
  }>;
  listHistory(input: { readonly startHistoryId: string; readonly maxResults: number }): Promise<{
    readonly historyId: string;
    readonly ids: readonly GmailMessageId[];
  }>;
  getMessage(id: string): Promise<GmailMessageDetail>;
  getAttachment(input: { readonly messageId: string; readonly attachmentId: string }): Promise<Buffer>;
  getProfileHistoryId(): Promise<string>;
}

export interface ClassificationResult {
  readonly classification: MailboxCandidateClassification;
  readonly confidence: number;
  readonly evidence: readonly string[];
}

/**
 * Deterministic, versioned classification rule (no LLM, per the plan's
 * global constraint). Own design: the brief's "deterministic classification"
 * language names the requirement, not the exact rule -- this is a simple,
 * explainable signal (subject/sender keyword + accepted-attachment
 * presence) that a later task can refine without changing this module's
 * shape. An accepted attachment and a keyword match together are the
 * only `receipt` (auto-stageable) outcome; either alone is `ambiguous`
 * (review); neither is `not_receipt` (discovered-only, never persisted
 * -- domain/mailbox-scans.ts already enforces that split).
 */
export function classifyMessage(input: {
  readonly subject: string;
  readonly senderAddress: string;
  readonly attachmentManifest: readonly { readonly mimeType: string }[];
  /** An attachment exceeded MAX_UPLOAD_BYTES and was excluded (review Important #5): never auto-stage, always at least `ambiguous`. */
  readonly hasOversizeAttachment?: boolean;
}): ClassificationResult {
  const subjectLower = input.subject.toLowerCase();
  const matchedKeyword = RECEIPT_SUBJECT_KEYWORDS.find((keyword) => subjectLower.includes(keyword));
  const hasAcceptedAttachment = input.attachmentManifest.length > 0;

  const evidence: string[] = [];
  if (matchedKeyword) evidence.push(`subject_keyword:${matchedKeyword}`);
  if (hasAcceptedAttachment) {
    evidence.push(`accepted_attachment:${input.attachmentManifest[0]?.mimeType}`);
  }
  if (input.hasOversizeAttachment) evidence.push("attachment_oversize");

  if (matchedKeyword && hasAcceptedAttachment && !input.hasOversizeAttachment) {
    return { classification: "receipt", confidence: 0.9, evidence };
  }
  if (matchedKeyword || hasAcceptedAttachment || input.hasOversizeAttachment) {
    return { classification: "ambiguous", confidence: 0.5, evidence };
  }
  return { classification: "not_receipt", confidence: 0.05, evidence: ["no_signal"] };
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

/**
 * Fix round 1 (review Critical #1) -- carries a captured pre-sync fence
 * across stateless broker calls inside the opaque `current_history_id`
 * column. `null`/unparseable values mean "no sync has ever started, or
 * this is a settled, ordinary incremental cursor" (handled by the
 * `discover` branches below); a tagged value means "full-sync listing or
 * its replay is still in progress for this fence."
 */
const PENDING_REPLAY_PREFIX = "pending-replay:";

function tagPendingReplay(preSyncHistoryId: string): string {
  return `${PENDING_REPLAY_PREFIX}${preSyncHistoryId}`;
}

function parsePendingReplay(value: string | null): string | null {
  if (value === null || !value.startsWith(PENDING_REPLAY_PREFIX)) return null;
  return value.slice(PENDING_REPLAY_PREFIX.length);
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
   * One page of the bounded-lookback backlog list, or -- once that list is
   * fully paged through (tracked purely by recomputing it and comparing
   * against `nextPageSequence`, no extra state needed) -- the replay step
   * itself: `history.list(preSyncHistoryId)` (already fully paginated
   * internally, Critical #2), staged as one final page, persisting the
   * real historyId it returns. Spec: "After durable staging, replay
   * users.history.list from pre-sync fence to catch messages arriving
   * during full sync... Persist post-replay history ID only after every
   * discovered message ID has a durable candidate or durable retry
   * record" -- the backlog pages (`nextHistoryId` still tagged) never
   * settle the cursor; only the replay page does.
   */
  async function fullSyncOrReplayPage(
    client: GmailDiscoveryClientLike,
    nextPageSequence: number,
    preSyncHistoryId: string,
  ): Promise<{ readonly ids: readonly GmailMessageId[]; readonly nextHistoryId: string }> {
    const backlogIds = await listBoundedFullSync(client);
    const offset = (nextPageSequence - 1) * pageSize;
    if (offset < backlogIds.length) {
      return {
        ids: backlogIds.slice(offset, offset + pageSize),
        nextHistoryId: tagPendingReplay(preSyncHistoryId),
      };
    }
    const replay = await withGoogleRetry(
      () => client.listHistory({ startHistoryId: preSyncHistoryId, maxResults: MAX_INITIAL_SYNC_MESSAGES }),
      retry,
    );
    return { ids: replay.ids, nextHistoryId: replay.historyId };
  }

  return {
    async discover(input: DiscoveryInput): Promise<DiscoveryPageV1> {
      const binding = await options.appClient.loadScanBinding(input.scanRunId);
      const client = await options.getGmailClient(binding.connectionId);

      const pendingFence = parsePendingReplay(binding.currentHistoryId);

      let pageIds: readonly GmailMessageId[];
      let nextHistoryId: string | null;

      if (binding.currentHistoryId === null || pendingFence !== null) {
        const preSyncHistoryId = pendingFence ?? (await withGoogleRetry(() => client.getProfileHistoryId(), retry));
        const page = await fullSyncOrReplayPage(client, binding.nextPageSequence, preSyncHistoryId);
        pageIds = page.ids;
        nextHistoryId = page.nextHistoryId;
      } else {
        try {
          const history = await withGoogleRetry(
            () =>
              client.listHistory({
                startHistoryId: binding.currentHistoryId as string,
                maxResults: MAX_INITIAL_SYNC_MESSAGES,
              }),
            retry,
          );
          const offset = (binding.nextPageSequence - 1) * pageSize;
          pageIds = history.ids.slice(offset, offset + pageSize);
          const isLastPage = offset + pageSize >= history.ids.length;
          nextHistoryId = isLastPage ? history.historyId : null;
        } catch (error) {
          if (!(error instanceof GmailApiError) || error.code !== "not_found") throw error;
          // Expired/unretained history ID: bounded full-sync recovery,
          // same pre-fence/full-sync/replay sequence as initial sync
          // (spec: "use same pre-fence/full-sync/replay sequence").
          // Existing unique message IDs make recovery idempotent
          // (recordCandidateMetadata's onConflict-mismatch-checked skip).
          const preSyncHistoryId = await withGoogleRetry(() => client.getProfileHistoryId(), retry);
          const page = await fullSyncOrReplayPage(client, binding.nextPageSequence, preSyncHistoryId);
          pageIds = page.ids;
          nextHistoryId = page.nextHistoryId;
        }
      }

      const messages: StagingMessage[] = [];

      for (const { id } of pageIds) {
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
        const { classification, confidence, evidence } = classifyMessage({
          subject: detail.subject,
          senderAddress: detail.senderAddress,
          attachmentManifest,
          hasOversizeAttachment,
        });

        messages.push({
          receivedAt: detail.receivedAt,
          senderAddress: detail.senderAddress,
          senderDomain,
          subject: detail.subject,
          contentHash: sha256Hex(`${detail.id}:${detail.subject}:${detail.receivedAt}`),
          attachmentManifest,
          classification,
          confidence,
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
        nextHistoryId,
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
