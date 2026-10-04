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
 * Stateless-broker pagination: Gmail's own list/history results are
 * re-fetched in full on every call (bounded to the spec's 100-message
 * cap, which is also Gmail's own default page size) and sliced by
 * `(pageSequence - 1) * pageSize`, rather than persisting a Gmail page
 * token anywhere. This is deliberately simple (ponytail: re-list instead
 * of inventing new persisted broker/App state) and has a useful side
 * effect for the initial-sync case: because the message-ID list is
 * re-queried fresh on every page, a message that arrives mid-scan is
 * already included by the time the last page runs, satisfying the
 * spec's "replay history.list from the pre-sync fence" step without a
 * separate replay pass.
 *
 * Transient Gmail failures (429/5xx) are retried a bounded number of
 * times in-process (`withGoogleRetry`); if retries are exhausted, the
 * error propagates to the caller (the broker's HTTP route), which maps
 * it to a 429/503 the worker's own activity retry policy (`activities/
 * mailbox.ts`, unmodified -- already retries `rate_limited`/
 * `unavailable`) already handles. `DiscoveryPageV1.retryCount` is
 * therefore always 0 on a successful return here: a page that could not
 * complete throws instead of returning a partial/degraded page, so no
 * separate persisted retry-count bookkeeping was invented beyond what
 * migration 019's `mailbox_scan_page_outcomes` already tracks at the DB
 * layer once the page is durably staged.
 */
import { createHash } from "node:crypto";

import {
  MAX_CANDIDATE_ATTACHMENTS,
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

/** Typed Gmail API failure. `not_found` drives 404 full-sync recovery; `reauth_required` is never retried. */
export class GmailApiError extends Error {
  readonly code: GmailApiErrorCode;

  constructor(code: GmailApiErrorCode, message = `Gmail API request failed: ${code}`) {
    super(message);
    this.name = "GmailApiError";
    this.code = code;
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
}): ClassificationResult {
  const subjectLower = input.subject.toLowerCase();
  const matchedKeyword = RECEIPT_SUBJECT_KEYWORDS.find((keyword) => subjectLower.includes(keyword));
  const hasAcceptedAttachment = input.attachmentManifest.length > 0;

  const evidence: string[] = [];
  if (matchedKeyword) evidence.push(`subject_keyword:${matchedKeyword}`);
  if (hasAcceptedAttachment) {
    evidence.push(`accepted_attachment:${input.attachmentManifest[0]?.mimeType}`);
  }

  if (matchedKeyword && hasAcceptedAttachment) {
    return { classification: "receipt", confidence: 0.9, evidence };
  }
  if (matchedKeyword || hasAcceptedAttachment) {
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
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded exponential backoff for 429/5xx only; every other GmailApiError (not_found/reauth_required/unknown) rethrows immediately, uncounted. */
export async function withGoogleRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
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
      await sleep(baseDelayMs * 2 ** (attempt - 1));
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

  return {
    async discover(input: DiscoveryInput): Promise<DiscoveryPageV1> {
      const binding = await options.appClient.loadScanBinding(input.scanRunId);
      const client = await options.getGmailClient(binding.connectionId);

      let allIds: readonly GmailMessageId[];
      // Resolves the historyId to persist once this turns out to be the
      // last page. Incremental sync already has Gmail's own updated
      // historyId from listHistory's response (no extra call needed);
      // initial sync and 404-recovery's bounded full sync have no such
      // value, so they read the current profile historyId instead.
      let resolveNextHistoryId = () => withGoogleRetry(() => client.getProfileHistoryId(), retry);

      if (binding.currentHistoryId === null) {
        allIds = await listBoundedFullSync(client);
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
          allIds = history.ids;
          resolveNextHistoryId = () => Promise.resolve(history.historyId);
        } catch (error) {
          if (!(error instanceof GmailApiError) || error.code !== "not_found") throw error;
          // Expired/unretained history ID: bounded 30-day (hard max
          // 90-day) full-sync recovery. Existing unique message IDs make
          // this idempotent (recordCandidateMetadata's onConflict skip).
          allIds = await listBoundedFullSync(client);
        }
      }

      const offset = (binding.nextPageSequence - 1) * pageSize;
      const pageIds = allIds.slice(offset, offset + pageSize);
      const isLastPage = offset + pageSize >= allIds.length;

      const messages: StagingMessage[] = [];

      for (const { id } of pageIds) {
        const detail = await withGoogleRetry(() => client.getMessage(id), retry);

        const attachmentManifest: AttachmentManifestV1[] = [];
        for (const part of detail.attachments) {
          if (attachmentManifest.length >= MAX_CANDIDATE_ATTACHMENTS) break;
          if (!ACCEPTED_ATTACHMENT_MIME_TYPES.has(part.mimeType)) continue;
          const bytes = await withGoogleRetry(
            () => client.getAttachment({ messageId: id, attachmentId: part.attachmentId }),
            retry,
          );
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

      const nextHistoryId = isLastPage ? await resolveNextHistoryId() : null;

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
