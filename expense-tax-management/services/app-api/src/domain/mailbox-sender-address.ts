/**
 * Fix round 6 — normalizes an RFC 5322 `From` header value into a bare
 * address-spec before it is ever persisted to
 * `app.mailbox_candidates.sender_address`.
 *
 * Root cause: the broker stores the raw `From` header verbatim
 * (`services/mailbox-broker/src/google-mailbox.ts`), so a display-name
 * form (`Display Name <user@example.com>`) lands in the column unchanged.
 * `MailboxCandidateV1Schema.senderAddress` (packages/contracts) validates
 * with `z.email()` on the way back OUT in the candidates list response --
 * a raw `Name <addr>` value fails that format check and
 * fastify-type-provider-zod turns the whole response into a 500
 * (ResponseSerializationError). This is the single write choke point
 * (`domain/mailbox-scans.ts`'s `recordCandidateMetadata`, the only INSERT
 * into this column) -- normalizing here guarantees every row is already
 * clean, regardless of how many broker/worker hops produced the string,
 * without touching either of those services.
 *
 * `sender_address` is `NOT NULL` (migration 019) with a
 * `CHECK (char_length(trim(sender_address)) BETWEEN 1 AND 320)` -- there
 * is no nullable fallback available. When nothing address-like can be
 * extracted, the original trimmed value is kept as-is (never normalized,
 * never null) so the row still satisfies that constraint.
 *
 * Fix round 1 (review Important) -- output was unbounded: an oversized
 * `From` header (garbage fallback OR a pathologically long address-like
 * value) could exceed that same 320-character CHECK and abort the whole
 * candidate page, not just one row. This field is display-only (never
 * parsed as a real address downstream -- office-web only renders it), so
 * the ruling is to always cap the stored value at the DB limit rather
 * than ever let one sender fail page staging.
 */

// Exact number from migration 019_mailbox_discovery.ts's
// `mailbox_candidates_sender_address_check` CHECK constraint above --
// keep these in sync if that constraint ever changes.
export const MAILBOX_SENDER_ADDRESS_DB_LIMIT = 320;

// Guards the regexes below against a pathological (multi-KB/MB) raw
// header: the address-spec we care about is always at the very end of
// the string (angle-bracket form) or short to begin with (a real address
// is well under this window), so scanning only the last few KB keeps this
// function O(n) and cheap regardless of how large `raw` is.
const PARSE_WINDOW = 4096;

// Matches a trailing `<...>` address-spec -- the common `Name <addr>` and
// bare `<addr>` forms. Anchored at the end (`$`) so a display name that
// itself contains angle-bracket-like text (e.g. a quoted `"Jane <Doe>"`)
// doesn't short-circuit the match: regex backtracking tries the next `<`
// occurrence until one's `>` reaches the end of the (trimmed) string.
const ANGLE_ADDRESS_PATTERN = /<([^<>]+)>\s*$/;

// Deliberately loose, not a full RFC 5322 validator: no embedded
// whitespace or angle brackets, exactly one `@`, non-empty on both sides.
// Good enough to tell "this looks like an address" from "this is a
// display name/garbage with no address at all" -- real format validation
// (and its failure mode) belongs to the response contract, not storage.
const ADDRESS_LIKE_PATTERN = /^[^\s<>@]+@[^\s<>@]+$/;

/**
 * Extracts and normalizes the bare address-spec from a raw `From` header
 * value. Returns the original, trimmed input unchanged when nothing
 * address-like can be extracted -- never throws, never returns an empty
 * string for a non-empty input. Always bounded to
 * `MAILBOX_SENDER_ADDRESS_DB_LIMIT` characters, regardless of path.
 */
export function normalizeMailboxSenderAddress(raw: string): string {
  const trimmed = raw.trim();
  const scanWindow = trimmed.length > PARSE_WINDOW ? trimmed.slice(-PARSE_WINDOW) : trimmed;
  const angleMatch = ANGLE_ADDRESS_PATTERN.exec(scanWindow);
  const candidate = (angleMatch?.[1] ?? scanWindow).trim();

  if (!ADDRESS_LIKE_PATTERN.test(candidate)) {
    return trimmed.slice(0, MAILBOX_SENDER_ADDRESS_DB_LIMIT);
  }

  const atIndex = candidate.lastIndexOf("@");
  const localPart = candidate.slice(0, atIndex);
  const domainPart = candidate.slice(atIndex + 1);
  return `${localPart}@${domainPart.toLowerCase()}`.slice(0, MAILBOX_SENDER_ADDRESS_DB_LIMIT);
}
