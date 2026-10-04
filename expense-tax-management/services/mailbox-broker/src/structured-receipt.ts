/**
 * Phase 3D-C Task 2 — bounded, deterministic structured-receipt parser.
 *
 * Reads a message's HTML body from a bounded byte stream, extracts
 * `<script type="application/ld+json">` blocks, and decodes them with a
 * hand-rolled, depth/node/deadline-bounded JSON parser -- never
 * `JSON.parse` (which has no depth limit and can itself be driven into
 * pathological stack/time use by hostile nesting) and never a DOM/HTML
 * parser library (which would need script execution disabled and is a
 * much larger trust surface than this module needs). `<script>` blocks
 * are only ever treated as opaque text to slice out and hand to the JSON
 * decoder below -- never evaluated.
 *
 * Hostile-input safety, by construction:
 * - No unbounded buffering: `readBoundedUtf8` counts bytes as they
 *   arrive and refuses (throws) the moment the running total exceeds the
 *   1 MiB decode budget, *before* ever calling `.toString("utf8")`.
 * - No unbounded string ops / ReDoS: HTML tag discovery uses plain
 *   `indexOf` scanning, never a regular expression -- `indexOf` is
 *   linear with no backtracking, so there is no pattern that can make it
 *   super-linear.
 * - Bounded JSON decode: the hand-rolled recursive-descent parser checks
 *   a node counter and a wall-clock deadline on every value, and a depth
 *   counter on every object/array descent, throwing before completing an
 *   over-budget parse (not after).
 * - No prototype pollution: JSON objects are built with
 *   `Object.create(null)`, so a `"__proto__"` key in the payload becomes
 *   an inert own property, never a prototype write.
 * - No external fetch, no script execution: the whole module is a pure
 *   string-in/data-out function; it never calls `fetch`, `eval`, `Function`,
 *   or any DOM API.
 */
import {
  CurrencySchema,
  DateOnlySchema,
  DecimalMoneySchema,
  mailboxIdempotencyKey,
  TimestampSchema,
  type MailboxErrorCodeV1,
  type MailboxMaterializationResultV1,
  type MailboxStructuredReceiptCallbackV1,
  type StructuredReceiptResultV1,
} from "@expense-tax/contracts";

export const STRUCTURED_RECEIPT_MAX_DECODED_BYTES = 1024 * 1024; // 1 MiB
export const STRUCTURED_RECEIPT_MAX_NODES = 20_000;
export const STRUCTURED_RECEIPT_MAX_DEPTH = 64;
export const STRUCTURED_RECEIPT_DEADLINE_MS = 2_000;

export interface StructuredReceiptMetadata {
  readonly candidateId: string;
  readonly connectionId: string;
  readonly candidateVersion: number;
}

export type StructuredReceiptOutcome =
  | StructuredReceiptResultV1
  | { readonly status: "review" | "skipped"; readonly errorCode: MailboxErrorCodeV1 };

class StructuredReceiptBoundError extends Error {}

export async function parseStructuredReceipt(
  stream: AsyncIterable<Buffer>,
  metadata: StructuredReceiptMetadata,
): Promise<StructuredReceiptOutcome> {
  const deadline = Date.now() + STRUCTURED_RECEIPT_DEADLINE_MS;

  let html: string;
  try {
    html = await readBoundedUtf8(stream, STRUCTURED_RECEIPT_MAX_DECODED_BYTES, deadline);
  } catch (error) {
    if (error instanceof StructuredReceiptBoundError) {
      return { status: "skipped", errorCode: "STRUCTURED_RECEIPT_BOUND_EXCEEDED" };
    }
    throw error;
  }

  const blocks = extractJsonLdBlocks(html);
  let sawReceiptType = false;

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = parseBoundedJson(block, {
        maxNodes: STRUCTURED_RECEIPT_MAX_NODES,
        maxDepth: STRUCTURED_RECEIPT_MAX_DEPTH,
        deadline,
      });
    } catch (error) {
      if (error instanceof StructuredReceiptBoundError) {
        return { status: "skipped", errorCode: "STRUCTURED_RECEIPT_BOUND_EXCEEDED" };
      }
      continue; // malformed JSON in this block -- try the next one
    }

    for (const node of flattenJsonLdNodes(parsed)) {
      const typeLabel = matchReceiptType(node);
      if (typeLabel === null) continue;
      sawReceiptType = true;
      const extracted = extractReceiptFields(node, typeLabel);
      if (extracted === null) continue;
      return {
        schemaVersion: 1,
        candidateId: metadata.candidateId,
        connectionId: metadata.connectionId,
        candidateVersion: metadata.candidateVersion,
        merchant: extracted.merchant,
        amount: extracted.amount,
        currency: extracted.currency,
        incurredOn: extracted.incurredOn,
        orderNumber: extracted.orderNumber,
        notes: null,
        evidence: extracted.evidence,
        idempotencyKey: mailboxIdempotencyKey(
          metadata.connectionId,
          "structured-receipt",
          metadata.candidateId,
          metadata.candidateVersion,
        ),
      };
    }
  }

  if (sawReceiptType) return { status: "review", errorCode: "STRUCTURED_RECEIPT_INCOMPLETE" };
  return { status: "skipped", errorCode: "STRUCTURED_RECEIPT_NOT_FOUND" };
}

// ------------------------------------------------------------------ //
// Bounded stream read -- refuses before decoding, never after.
// ------------------------------------------------------------------ //

async function readBoundedUtf8(stream: AsyncIterable<Buffer>, maxBytes: number, deadline: number): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (Date.now() > deadline) throw new StructuredReceiptBoundError("deadline exceeded while reading stream");
    total += chunk.length;
    if (total > maxBytes) throw new StructuredReceiptBoundError(`input exceeds ${maxBytes}-byte decode budget`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

// ------------------------------------------------------------------ //
// JSON-LD block extraction -- plain indexOf scanning only, no regex.
// ------------------------------------------------------------------ //

function extractJsonLdBlocks(html: string): string[] {
  const lower = html.toLowerCase();
  const blocks: string[] = [];
  let searchFrom = 0;

  while (true) {
    const tagStart = lower.indexOf("<script", searchFrom);
    if (tagStart === -1) break;
    const tagEnd = lower.indexOf(">", tagStart);
    if (tagEnd === -1) break;
    const closeIdx = lower.indexOf("</script>", tagEnd);
    if (closeIdx === -1) break;

    const tagAttrs = lower.slice(tagStart, tagEnd);
    if (tagAttrs.includes("application/ld+json")) {
      blocks.push(html.slice(tagEnd + 1, closeIdx));
    }
    searchFrom = closeIdx + "</script>".length;
  }

  return blocks;
}

// ------------------------------------------------------------------ //
// Hand-rolled bounded JSON parser -- depth/node/deadline checked on
// every value, objects built with a null prototype.
// ------------------------------------------------------------------ //

interface JsonParseState {
  readonly text: string;
  pos: number;
  nodes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
  readonly deadline: number;
}

function parseBoundedJson(
  text: string,
  options: { readonly maxNodes: number; readonly maxDepth: number; readonly deadline: number },
): unknown {
  const state: JsonParseState = {
    text,
    pos: 0,
    nodes: 0,
    maxNodes: options.maxNodes,
    maxDepth: options.maxDepth,
    deadline: options.deadline,
  };
  skipWhitespace(state);
  const value = parseValue(state, 0);
  skipWhitespace(state);
  if (state.pos !== state.text.length) throw new Error("trailing content after JSON value");
  return value;
}

function checkBudget(state: JsonParseState, depth: number): void {
  if (depth > state.maxDepth) throw new StructuredReceiptBoundError("JSON depth budget exceeded");
  state.nodes += 1;
  if (state.nodes > state.maxNodes) throw new StructuredReceiptBoundError("JSON node budget exceeded");
  if (Date.now() > state.deadline) throw new StructuredReceiptBoundError("JSON parse deadline exceeded");
}

function parseValue(state: JsonParseState, depth: number): unknown {
  checkBudget(state, depth);
  skipWhitespace(state);
  const ch = state.text[state.pos];
  if (ch === "{") return parseObject(state, depth);
  if (ch === "[") return parseArray(state, depth);
  if (ch === '"') return parseString(state);
  if (ch === "t" || ch === "f") return parseBoolean(state);
  if (ch === "n") return parseNull(state);
  if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) return parseNumber(state);
  throw new Error(`unexpected character at position ${state.pos}`);
}

function parseObject(state: JsonParseState, depth: number): Record<string, unknown> {
  const obj = Object.create(null) as Record<string, unknown>;
  state.pos += 1; // consume '{'
  skipWhitespace(state);
  if (state.text[state.pos] === "}") {
    state.pos += 1;
    return obj;
  }
  while (true) {
    skipWhitespace(state);
    if (state.text[state.pos] !== '"') throw new Error("expected string key");
    const key = parseString(state);
    skipWhitespace(state);
    if (state.text[state.pos] !== ":") throw new Error("expected ':'");
    state.pos += 1;
    const value = parseValue(state, depth + 1);
    obj[key] = value;
    skipWhitespace(state);
    const delim = state.text[state.pos];
    if (delim === ",") {
      state.pos += 1;
      continue;
    }
    if (delim === "}") {
      state.pos += 1;
      break;
    }
    throw new Error("expected ',' or '}'");
  }
  return obj;
}

function parseArray(state: JsonParseState, depth: number): unknown[] {
  const arr: unknown[] = [];
  state.pos += 1; // consume '['
  skipWhitespace(state);
  if (state.text[state.pos] === "]") {
    state.pos += 1;
    return arr;
  }
  while (true) {
    const value = parseValue(state, depth + 1);
    arr.push(value);
    skipWhitespace(state);
    const delim = state.text[state.pos];
    if (delim === ",") {
      state.pos += 1;
      continue;
    }
    if (delim === "]") {
      state.pos += 1;
      break;
    }
    throw new Error("expected ',' or ']'");
  }
  return arr;
}

function parseString(state: JsonParseState): string {
  state.pos += 1; // consume opening quote
  let result = "";
  while (true) {
    if (state.pos >= state.text.length) throw new Error("unterminated string");
    const ch = state.text[state.pos];
    if (ch === '"') {
      state.pos += 1;
      return result;
    }
    if (ch === "\\") {
      state.pos += 1;
      const esc = state.text[state.pos];
      switch (esc) {
        case '"':
          result += '"';
          break;
        case "\\":
          result += "\\";
          break;
        case "/":
          result += "/";
          break;
        case "b":
          result += "\b";
          break;
        case "f":
          result += "\f";
          break;
        case "n":
          result += "\n";
          break;
        case "r":
          result += "\r";
          break;
        case "t":
          result += "\t";
          break;
        case "u": {
          const hex = state.text.slice(state.pos + 1, state.pos + 5);
          result += String.fromCharCode(Number.parseInt(hex, 16));
          state.pos += 4;
          break;
        }
        default:
          throw new Error("invalid escape sequence");
      }
      state.pos += 1;
      continue;
    }
    result += ch;
    state.pos += 1;
  }
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

/**
 * Fix round 1 (review Important #2) -- strict RFC 8259 JSON number
 * grammar: `number = [ "-" ] int [ frac ] [ exp ]`, `int = "0" / (digit1-9
 * *DIGIT)`. The previous version used `while(isDigit)` loops that accept
 * zero repetitions, so a bare "-", "1.", "01", or "1e" with no following
 * digit(s) all silently matched a truncated slice that `Number()` then
 * turned into `NaN` -- which `extractReceiptFields` would otherwise trust
 * as a real amount. Every branch below throws (treated as malformed JSON
 * in this block, same as any other syntax error) rather than accepting a
 * truncated literal.
 */
function parseNumber(state: JsonParseState): number {
  const start = state.pos;
  if (state.text[state.pos] === "-") state.pos += 1;

  if (state.text[state.pos] === "0") {
    state.pos += 1;
  } else if (isDigit(state.text[state.pos])) {
    while (isDigit(state.text[state.pos])) state.pos += 1;
  } else {
    throw new Error("invalid number literal");
  }

  if (state.text[state.pos] === ".") {
    state.pos += 1;
    if (!isDigit(state.text[state.pos])) throw new Error("invalid number literal: empty fraction");
    while (isDigit(state.text[state.pos])) state.pos += 1;
  }

  if (state.text[state.pos] === "e" || state.text[state.pos] === "E") {
    state.pos += 1;
    if (state.text[state.pos] === "+" || state.text[state.pos] === "-") state.pos += 1;
    if (!isDigit(state.text[state.pos])) throw new Error("invalid number literal: empty exponent");
    while (isDigit(state.text[state.pos])) state.pos += 1;
  }

  const value = Number(state.text.slice(start, state.pos));
  // A grammatically valid but astronomically large exponent (e.g.
  // "1e400") is still valid JSON that JS represents as Infinity --
  // reject it the same way as a malformed literal, never let it reach
  // callers as a non-finite "number".
  if (!Number.isFinite(value)) throw new Error("number literal out of range");
  return value;
}

function parseBoolean(state: JsonParseState): boolean {
  if (state.text.startsWith("true", state.pos)) {
    state.pos += 4;
    return true;
  }
  if (state.text.startsWith("false", state.pos)) {
    state.pos += 5;
    return false;
  }
  throw new Error("invalid literal");
}

function parseNull(state: JsonParseState): null {
  if (state.text.startsWith("null", state.pos)) {
    state.pos += 4;
    return null;
  }
  throw new Error("invalid literal");
}

const WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

function skipWhitespace(state: JsonParseState): void {
  while (state.pos < state.text.length && WHITESPACE.has(state.text[state.pos]!)) state.pos += 1;
}

// ------------------------------------------------------------------ //
// Receipt field extraction -- schema.org Order/Invoice/Receipt shape.
// ------------------------------------------------------------------ //

const RECEIPT_TYPES = new Set(["Order", "Invoice", "Receipt"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenJsonLdNodes(parsed: unknown): Record<string, unknown>[] {
  if (isRecord(parsed)) {
    const graph = parsed["@graph"];
    if (Array.isArray(graph)) return graph.filter(isRecord);
    return [parsed];
  }
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  return [];
}

function matchReceiptType(node: Record<string, unknown>): string | null {
  const type = node["@type"];
  if (typeof type === "string" && RECEIPT_TYPES.has(type)) return type;
  if (Array.isArray(type)) {
    for (const entry of type) {
      if (typeof entry === "string" && RECEIPT_TYPES.has(entry)) return entry;
    }
  }
  return null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getNestedName(value: unknown): string | null {
  const direct = getString(value);
  if (direct !== null) return direct;
  if (isRecord(value)) return getString(value["name"]);
  return null;
}

/**
 * Fix round 1 (review Important #2) -- reuses the repo's own canonical
 * money/currency/date schemas (`@expense-tax/contracts`, `expenses.ts`)
 * rather than inventing a parallel validation rule: `DecimalMoneySchema`
 * (positive, max-2-decimal-place decimal string), `CurrencySchema`
 * (3-letter ISO 4217 code), `DateOnlySchema` (strict `YYYY-MM-DD`). A
 * value that fails validation returns `null` -- the field is treated as
 * absent (never a trusted-looking but wrong "NaN"/"Infinity"/garbage
 * string), falling the whole node back to incomplete/not-found.
 */
function normalizeAmount(raw: unknown): string | null {
  let candidate: string;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    candidate = String(raw);
  } else if (typeof raw === "string" && raw.trim().length > 0) {
    candidate = raw.trim();
  } else {
    return null;
  }
  const result = DecimalMoneySchema.safeParse(candidate);
  return result.success ? result.data : null;
}

function normalizeCurrency(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const result = CurrencySchema.safeParse(raw.trim());
  return result.success ? result.data : null;
}

/**
 * Fix round 2 (re-review Important #2, round 1 NOT ADDRESSED) -- round 1
 * accepted a full ISO datetime by slicing the first 10 characters and
 * validating only that prefix, so any string merely *starting with* a
 * valid date (e.g. "2026-09-01garbage") slipped through with the
 * trailing garbage silently discarded. The fix validates the WHOLE
 * string as a real ISO datetime first (reusing the repo's own canonical
 * `TimestampSchema` -- `z.string().datetime({offset:true})`,
 * `expenses.ts` -- which already enforces a complete, valid time +
 * offset suffix with no trailing content), and only then extracts its
 * date portion; a date-shaped prefix followed by anything else is
 * rejected before ever reaching `.slice()`.
 */
function normalizeDateOnly(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const direct = DateOnlySchema.safeParse(trimmed);
  if (direct.success) return direct.data;
  if (!TimestampSchema.safeParse(trimmed).success) return null;
  // TimestampSchema just validated the entire string as a well-formed
  // ISO datetime (YYYY-MM-DDTHH:mm:ss[.sss](Z|+HH:MM|-HH:MM)) with no
  // trailing content of any kind, so its first 10 characters are always
  // exactly the date portion -- re-validated here rather than trusted
  // blindly, in case TimestampSchema's own format ever changes.
  const fromDatetime = DateOnlySchema.safeParse(trimmed.slice(0, 10));
  return fromDatetime.success ? fromDatetime.data : null;
}

interface ExtractedReceiptFields {
  readonly merchant: string;
  readonly amount: string;
  readonly currency: string;
  readonly incurredOn: string;
  readonly orderNumber: string | null;
  readonly evidence: readonly string[];
}

function extractReceiptFields(node: Record<string, unknown>, typeLabel: string): ExtractedReceiptFields | null {
  const merchant = getNestedName(node["seller"]) ?? getNestedName(node["merchant"]) ?? getNestedName(node["provider"]);
  const priceSpec = isRecord(node["priceSpecification"]) ? node["priceSpecification"] : null;
  const amount = normalizeAmount(node["totalPrice"] ?? node["price"] ?? priceSpec?.["price"]);
  const currency = normalizeCurrency(node["priceCurrency"] ?? (priceSpec ? priceSpec["priceCurrency"] : undefined));
  const incurredOn = normalizeDateOnly(node["orderDate"] ?? node["datePublished"] ?? node["dateCreated"]);
  const orderNumber = getNestedName(node["orderNumber"]);

  if (merchant === null || amount === null || currency === null || incurredOn === null) return null;

  const evidence = [`schema_type:${typeLabel}`, "field:merchant", "field:amount", "field:currency", "field:incurredOn"];
  if (orderNumber !== null) evidence.push("field:orderNumber");

  return { merchant, amount, currency, incurredOn, orderNumber, evidence };
}

/**
 * Phase 3D-C Task 5 — structured-result materialize glue: parses, then
 * (only on a complete match) submits directly to App. Returns null on
 * "review"/"skipped" -- nothing to submit; the candidate stays queued for
 * a later attachment-OCR materialization instead.
 *
 * Not yet called from ingestion.ts's materializeCandidate: no Gmail
 * client in this codebase exposes a message-body byte source (see that
 * function's own ruling) -- this is ready for whichever future change
 * adds one.
 */
export interface StructuredReceiptMaterializeDependencies {
  readonly submitStructuredResult: (
    input: MailboxStructuredReceiptCallbackV1,
  ) => Promise<MailboxMaterializationResultV1>;
}

export async function materializeStructuredReceipt(
  deps: StructuredReceiptMaterializeDependencies,
  stream: AsyncIterable<Buffer>,
  metadata: StructuredReceiptMetadata,
  idempotencyKey: string,
): Promise<MailboxMaterializationResultV1 | null> {
  const outcome = await parseStructuredReceipt(stream, metadata);
  if ("status" in outcome) return null;
  return deps.submitStructuredResult({ result: outcome, idempotencyKey });
}
