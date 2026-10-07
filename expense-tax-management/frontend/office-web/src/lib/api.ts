import { createAppApiClient, type DuplicateResolutionAction, type MailboxCandidateClassification, type MailboxIngestionBucketV1, type Scope, type SuggestionResolveRequest } from "@expense-tax/contracts";
import type { OfficeSession } from "./session";
import { getAppAuthorization, type ClerkGetToken } from "./clerk";

type AppApiClient = ReturnType<typeof createAppApiClient>;
export const DUPLICATE_REVIEW_UPDATED_EVENT = "expense-tax:duplicate-review-updated";

// ------------------------------------------------------------------ //
// Error types
// ------------------------------------------------------------------ //

export class DuplicateReviewError extends Error {
  constructor(message: string, readonly status?: number) {
    super(status === 401 || status === 403 ? "Office authorization required" : message);
    this.name = "DuplicateReviewError";
  }
}

export class EnrichmentReviewError extends Error {
  constructor(message: string, readonly status?: number) {
    super(status === 401 || status === 403 ? "Office authorization required" : message);
    this.name = "EnrichmentReviewError";
  }
}

/**
 * Typed error for tag mutation operations (create/update/archive/unarchive/merge).
 * Callers detect 409 via `err.status === 409`, not message substring.
 */
export class TagMutationError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "TagMutationError";
  }
}

// ------------------------------------------------------------------ //
// State helpers
// ------------------------------------------------------------------ //

export type DuplicateReviewState = "loading" | "unauthorized" | "error" | "empty" | "pending" | "conflict";

export function getDuplicateReviewState(input: {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  organizationLoaded: boolean;
  hasSession: boolean;
  hasOrganization: boolean;
  items?: readonly unknown[];
  error?: string;
  conflict?: boolean;
}): DuplicateReviewState {
  if (!input.isLoaded || !input.organizationLoaded) return "loading";
  if (!input.isSignedIn || !input.hasSession || !input.hasOrganization) return "unauthorized";
  if (input.conflict) return "conflict";
  if (input.error) return "error";
  if (input.items === undefined) return "loading";
  return input.items.length === 0 ? "empty" : "pending";
}

export type EnrichmentReviewState = "loading" | "unauthorized" | "error" | "empty" | "pending" | "conflict" | "stale" | "success";

export function getEnrichmentReviewState(input: {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  hasSession: boolean;
  hasOrganization: boolean;
  suggestions?: readonly unknown[];
  error?: string;
  conflict?: boolean;
  stale?: boolean;
}): EnrichmentReviewState {
  if (!input.isLoaded) return "loading";
  if (!input.isSignedIn || !input.hasSession || !input.hasOrganization) return "unauthorized";
  if (input.conflict) return "conflict";
  if (input.stale) return "stale";
  if (input.error) return "error";
  if (input.suggestions === undefined) return "loading";
  return input.suggestions.length === 0 ? "empty" : "pending";
}

// ------------------------------------------------------------------ //
// Source label helpers
// ------------------------------------------------------------------ //

type SuggestionSource = "historical" | "ai" | "manual" | "manual_baseline";

export function getSuggestionSourceLabel(source: SuggestionSource): string {
  switch (source) {
    case "historical": return "Historical pattern";
    case "ai": return "AI suggestion";
    case "manual": return "Manual decision";
    case "manual_baseline": return "Baseline import";
  }
}

/**
 * Formats a suggestion kind enum value for display.
 * Replaces ALL underscores (not just the first) and capitalizes the first letter.
 * "tax_category" → "Tax category", "spending_category" → "Spending category", "tag" → "Tag".
 */
export function formatSuggestionKind(kind: string): string {
  const replaced = kind.replaceAll("_", " ");
  return replaced.charAt(0).toUpperCase() + replaced.slice(1);
}

export function getSourceBadge(matchType: "file_sha256" | "fingerprint" | "fuzzy_fields") {
  if (matchType === "file_sha256") return { label: "Source file", tone: "ok" as const };
  if (matchType === "fingerprint") return { label: "Expense fingerprint", tone: "ok" as const };
  return { label: "Matching fields", tone: "warn" as const };
}

// ------------------------------------------------------------------ //
// Stable idempotency keys
// ------------------------------------------------------------------ //

/**
 * Generates a stable idempotency key for a user action on a specific entity.
 * Key is deterministic so retrying the same action reuses the same key.
 */
export function makeStableIdempotencyKey(action: string, ...ids: string[]): string {
  return `${action}:${ids.join(":")}`;
}

// ------------------------------------------------------------------ //
// Misc helpers
// ------------------------------------------------------------------ //

export function formatPendingDuplicateCount(input: { items: readonly unknown[]; nextCursor: string | null }) {
  return input.nextCursor ? "50+" : String(input.items.length);
}

export function shouldApplyPendingDuplicateCount(active: boolean, requestSequence: number, currentSequence: number) {
  return active && requestSequence === currentSequence;
}

// ------------------------------------------------------------------ //
// Auth helpers
// ------------------------------------------------------------------ //

async function getDuplicateAuthorization(getToken: ClerkGetToken, organizationId: string | null | undefined) {
  try {
    return await getAppAuthorization(getToken, organizationId);
  } catch {
    throw new DuplicateReviewError("Office authorization required", 401);
  }
}

// ------------------------------------------------------------------ //
// Ledger API (Personal and Business scope)
// ------------------------------------------------------------------ //

export type LedgerQueryOptions = {
  tagId?: string[];
  cursor?: string;
  sort?: string;
  direction?: string;
  limit?: number;
};

export async function fetchLedger(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
  options?: LedgerQueryOptions,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getAppAuthorization(getToken, organizationId);
  const baseQuery = {
    sort: (options?.sort ?? "incurredOn") as "incurredOn" | "amount" | "merchant" | "createdAt",
    direction: (options?.direction ?? "desc") as "asc" | "desc",
    limit: options?.limit ?? 50,
    ...(options?.cursor ? { cursor: options.cursor } : {}),
    ...(options?.tagId?.length ? { tagId: options.tagId as string | string[] } : {}),
  };
  let result;
  if (session.scope.kind === "business") {
    result = await api.GET("/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId }, query: baseQuery },
      headers,
    });
  } else {
    result = await api.GET("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId }, query: baseQuery },
      headers,
    });
  }
  if (!result.data) throw new Error("Ledger unavailable");
  return result.data;
}

// ------------------------------------------------------------------ //
// Expense detail API (Personal and Business scope)
// ------------------------------------------------------------------ //

export async function fetchExpenseDetail(
  session: OfficeSession,
  expenseId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getAppAuthorization(getToken, organizationId);
  let result;
  if (session.scope.kind === "business") {
    result = await api.GET("/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, expenseId } },
      headers,
    });
  } else {
    result = await api.GET("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId, expenseId } },
      headers,
    });
  }
  if (!result.data) {
    const status = result.response?.status;
    if (status === 401 || status === 403) throw new EnrichmentReviewError("Office authorization required", status);
    throw new EnrichmentReviewError("Expense detail unavailable");
  }
  return result.data;
}

// ------------------------------------------------------------------ //
// Suggestions API (Personal and Business scope)
// ------------------------------------------------------------------ //

export async function fetchSuggestions(
  session: OfficeSession,
  expenseId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getAppAuthorization(getToken, organizationId);
  let result;
  if (session.scope.kind === "business") {
    result = await api.GET("/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, expenseId } },
      headers,
    });
  } else {
    result = await api.GET("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId, expenseId } },
      headers,
    });
  }
  if (!result.data) {
    const status = result.response?.status;
    if (status === 401 || status === 403) throw new EnrichmentReviewError("Office authorization required", status);
    throw new EnrichmentReviewError("Suggestions unavailable");
  }
  return result.data;
}

export async function resolveSuggestion(
  session: OfficeSession,
  expenseId: string,
  suggestionId: string,
  body: SuggestionResolveRequest,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getAppAuthorization(getToken, organizationId);
  let result;
  if (session.scope.kind === "business") {
    result = await api.POST("/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, expenseId, suggestionId } },
      headers,
      body,
    });
  } else {
    result = await api.POST("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId, expenseId, suggestionId } },
      headers,
      body,
    });
  }
  if (!result.data) {
    const status = result.response?.status;
    if (status === 409) throw new EnrichmentReviewError("This expense changed. Refresh to review latest state.", 409);
    if (status === 401 || status === 403) throw new EnrichmentReviewError("Office authorization required", status);
    throw new EnrichmentReviewError("Suggestion resolution unavailable");
  }
  return result.data;
}

// ------------------------------------------------------------------ //
// Duplicate matches API (Personal and Business scope)
// ------------------------------------------------------------------ //

export async function fetchDuplicateMatches(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
  cursor?: string,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getDuplicateAuthorization(getToken, organizationId);
  const query = { status: "pending" as const, limit: 50, ...(cursor ? { cursor } : {}) };
  let result;
  if (session.scope.kind === "business") {
    result = await api.GET("/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId }, query },
      headers,
    });
  } else {
    result = await api.GET("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId }, query },
      headers,
    });
  }
  if (!result.data) throw new DuplicateReviewError("Duplicate matches unavailable", result.response?.status);
  return result.data;
}

export function announceDuplicateReviewUpdated() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DUPLICATE_REVIEW_UPDATED_EVENT));
}

export async function resolveDuplicateMatch(
  session: OfficeSession,
  matchId: string,
  action: DuplicateResolutionAction,
  expectedMatchVersion: number,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getDuplicateAuthorization(getToken, organizationId);
  const body = { action, expectedMatchVersion, idempotencyKey: crypto.randomUUID() };
  let result;
  if (session.scope.kind === "business") {
    result = await api.POST("/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches/{matchId}/resolve", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, matchId } },
      headers,
      body,
    });
  } else {
    result = await api.POST("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches/{matchId}/resolve", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId, matchId } },
      headers,
      body,
    });
  }
  if (!result.data) {
    const status = result.response?.status;
    throw new DuplicateReviewError(status === 409 ? "This match changed. Refreshing review list." : "Resolution unavailable", status);
  }
  return result.data;
}

// ------------------------------------------------------------------ //
// Tax report API (Business scope only - callers must gate)
// ------------------------------------------------------------------ //

export async function fetchTaxReport(session: OfficeSession, taxYear: number, getToken: ClerkGetToken, organizationId: string | null | undefined, client?: AppApiClient) {
  if (session.scope.kind !== "business") throw new Error("Tax report requires business scope");
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/tax-reports/{taxYear}",
    { params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, taxYear } }, headers: await getAppAuthorization(getToken, organizationId) },
  );
  if (!result.data) throw new Error("Tax report unavailable");
  return result.data;
}

// ------------------------------------------------------------------ //
// Export API (Business scope only - callers must gate)
// ------------------------------------------------------------------ //

export async function createExport(session: OfficeSession, taxYear: number, getToken: ClerkGetToken, organizationId: string | null | undefined, includeUnresolved = false, client?: AppApiClient) {
  if (session.scope.kind !== "business") throw new Error("Exports require business scope");
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.POST(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/exports",
    {
      params: {
        path: { tenantId: session.tenantId, businessId: session.scope.businessId },
        header: { "idempotency-key": crypto.randomUUID() },
      },
      headers: await getAppAuthorization(getToken, organizationId),
      body: { taxYear, includeUnresolved },
    },
  );
  if (!result.data) throw new Error("Export unavailable");
  return result.data;
}

// ------------------------------------------------------------------ //
// Tags API (tenant-scoped, Personal and Business)
// ------------------------------------------------------------------ //
// NOTE: The generated /tenants/{tenantId}/tags GET endpoint has query?: never.
// No client-side filtering or pagination is claimed. fetchTags returns all tags
// as the server returns them. Tag write operations rely on server-side
// expectedVersion OCC (one-row-per-entity semantics). No idempotency-key is
// sent because the generated API routes do not expose an idempotency-key header
// for tag CRUD. Server enforces one active record per tag/expense pair at DB
// level.

export async function fetchTags(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET("/api/v1/tenants/{tenantId}/tags", {
    params: { path: { tenantId: session.tenantId } },
    headers: await getAppAuthorization(getToken, organizationId),
  });
  if (!result.data) throw new Error("Tags unavailable");
  return result.data;
}

/**
 * Creates a custom tag. No idempotency-key: server generates custom:<uuid> key
 * server-side and the endpoint does not expose an idempotency-key header.
 * Retry safety: duplicate creates will produce a new tag. Caller must not retry
 * without user intent.
 */
export async function createTag(
  session: OfficeSession,
  name: string,
  color: string | null | undefined,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.POST("/api/v1/tenants/{tenantId}/tags", {
    params: { path: { tenantId: session.tenantId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body: { name, ...(color !== undefined ? { color } : {}) },
  });
  if (!result.data) throw new TagMutationError("Tag creation unavailable", result.response?.status);
  return result.data;
}

/**
 * Updates a tag name/color. Uses expectedVersion for OCC conflict detection.
 * No idempotency-key: endpoint does not expose one. Stale version returns 409.
 */
export async function updateTag(
  session: OfficeSession,
  tagId: string,
  body: { expectedVersion: number; name?: string; color?: string | null },
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.PATCH("/api/v1/tenants/{tenantId}/tags/{tagId}", {
    params: { path: { tenantId: session.tenantId, tagId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body,
  });
  if (!result.data) {
    const status = result.response?.status;
    throw new TagMutationError(status === 409 ? "Tag version conflict. Refresh to see latest." : "Tag update unavailable", status);
  }
  return result.data;
}

/**
 * Archives a tag (soft-delete). Uses expectedVersion for OCC. No idempotency-key.
 * Idempotency guaranteed by server: re-archiving an already-archived tag returns 409.
 */
export async function archiveTag(
  session: OfficeSession,
  tagId: string,
  expectedVersion: number,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.DELETE("/api/v1/tenants/{tenantId}/tags/{tagId}", {
    params: { path: { tenantId: session.tenantId, tagId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body: { expectedVersion },
  });
  if (!result.data) {
    const status = result.response?.status;
    throw new TagMutationError(status === 409 ? "Tag version conflict. Refresh to see latest." : "Tag archive unavailable", status);
  }
  return result.data;
}

/**
 * Unarchives a tag explicitly. Uses expectedVersion for OCC. No idempotency-key.
 */
export async function unarchiveTag(
  session: OfficeSession,
  tagId: string,
  expectedVersion: number,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.POST("/api/v1/tenants/{tenantId}/tags/{tagId}/unarchive", {
    params: { path: { tenantId: session.tenantId, tagId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body: { expectedVersion },
  });
  if (!result.data) {
    const status = result.response?.status;
    throw new TagMutationError(status === 409 ? "Tag version conflict. Refresh to see latest." : "Tag unarchive unavailable", status);
  }
  return result.data;
}

/**
 * Merges source into target tag. Uses expectedSourceVersion/expectedTargetVersion
 * for OCC on both tags. Server returns 204 No Content on success.
 * No idempotency-key: endpoint does not expose one. Self-merge and archived-target
 * are rejected 409 by server.
 */
export async function mergeTags(
  session: OfficeSession,
  sourceTagId: string,
  targetTagId: string,
  expectedSourceVersion: number,
  expectedTargetVersion: number,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  // merge returns 204 No Content — treat missing data as success (not error)
  const result = await api.POST("/api/v1/tenants/{tenantId}/tags/{tagId}/merge", {
    params: { path: { tenantId: session.tenantId, tagId: sourceTagId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body: { sourceTagId, targetTagId, expectedSourceVersion, expectedTargetVersion },
  });
  // 204 No Content: result.data is undefined, result.response.status is 204
  const status = result.response?.status;
  if (status !== 204 && !result.data) {
    throw new TagMutationError(status === 409 ? "Tag version conflict during merge. Refresh to see latest." : "Tag merge unavailable", status);
  }
}

// ------------------------------------------------------------------ //
// Mailbox connection API (Personal and Business scope)
// ------------------------------------------------------------------ //

export class MailboxConnectionError extends Error {
  constructor(message: string, readonly status?: number) {
    super(status === 401 || status === 403 ? "Office authorization required" : message);
    this.name = "MailboxConnectionError";
  }
}

/**
 * Fix round 1 (Critical): no `sessionNonce` field. Office JavaScript cannot
 * securely bind the browser to this OAuth attempt via a cookie it sets
 * itself (host-only on the Office origin, never reaches the mailbox
 * broker's callback origin, and can't be `HttpOnly`). App API generates
 * the session nonce itself and hands the browser a link to the broker's
 * own `/oauth/google/begin`, where the broker's origin sets that cookie
 * before redirecting to Google.
 */
export interface StartMailboxConnectionInput {
  readonly redirectOrigin: string;
  readonly timezone: string;
  readonly localScanTime: string;
  readonly requestId: string;
}

/**
 * Fix round 2 (Important) -- `scope` is explicit, not derived from
 * `session.scope`: the approved mockup requires offering every scope the
 * user is authorized for (Personal and each authorized business), not
 * just whichever one the current Office session happens to be viewing.
 */
export async function startMailboxConnection(
  session: OfficeSession,
  scope: Scope,
  input: StartMailboxConnectionInput,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.POST("/api/v1/tenants/{tenantId}/mailbox-connections/google/start", {
    params: { path: { tenantId: session.tenantId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body: { scope, ...input },
  });
  if (!result.data) {
    throw new MailboxConnectionError("Mailbox connection unavailable", result.response?.status);
  }
  return result.data;
}

function mailboxScopeQuery(scope: Scope) {
  return scope.kind === "personal" ? { profileId: scope.profileId } : { businessId: scope.businessId };
}

/**
 * Fix round 1 (Important) -- the minimal authenticated, scope-authorized
 * read the Office mailbox page needs to render real connect/connected/
 * needs-attention/revoked states instead of static scaffolding. `scope` is
 * explicit (fix round 2) for the same reason as `startMailboxConnection`.
 */
export async function fetchMailboxConnection(
  session: OfficeSession,
  scope: Scope,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET("/api/v1/tenants/{tenantId}/mailbox-connections/google", {
    params: { path: { tenantId: session.tenantId }, query: mailboxScopeQuery(scope) },
    headers: await getAppAuthorization(getToken, organizationId),
  });
  if (!result.data) {
    throw new MailboxConnectionError("Mailbox connection status unavailable", result.response?.status);
  }
  return result.data.connection;
}

/**
 * Fix round 2 (Important) -- the authorized scope choices for the
 * mailbox-connect picker: every active business the user's current
 * session can see, via the same `GET .../businesses` route other
 * tenant-wide listings use. Archived businesses are excluded (not an
 * authorized choice for a new connection).
 */
export async function fetchAuthorizedBusinesses(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET("/api/v1/tenants/{tenantId}/businesses", {
    params: { path: { tenantId: session.tenantId } },
    headers: await getAppAuthorization(getToken, organizationId),
  });
  if (!result.data) {
    throw new MailboxConnectionError("Business list unavailable", result.response?.status);
  }
  return result.data.items.filter((business) => business.status === "active");
}

/**
 * Fix round 3 (Important) -- the caller's own Personal profile, so the
 * mailbox scope-picker can always offer it (not just when the current
 * Office session already happens to be Personal-scoped). `null` is a
 * normal response (no Personal-profile access in this tenant), not an
 * error. Scope-authorized server-side (`getOwnPersonalProfile`): tenant
 * role alone never grants it, and there is no way to request a different
 * member's profile.
 */
export async function fetchOwnPersonalProfile(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET("/api/v1/tenants/{tenantId}/personal-profiles/mine", {
    params: { path: { tenantId: session.tenantId } },
    headers: await getAppAuthorization(getToken, organizationId),
  });
  if (!result.data) {
    throw new MailboxConnectionError("Personal profile lookup unavailable", result.response?.status);
  }
  return result.data.profile;
}

/**
 * Web session wiring design (2026-10-06) -- the Settings scope picker's
 * authorized choices in one call: the caller's own personal profile (0 or
 * 1) and every active business they have a membership on.
 */
export async function fetchTenantScopes(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET("/api/v1/tenants/{tenantId}/scopes", {
    params: { path: { tenantId: session.tenantId } },
    headers: await getAppAuthorization(getToken, organizationId),
  });
  if (!result.data) {
    throw new MailboxConnectionError("Profile and business list unavailable", result.response?.status);
  }
  return result.data;
}

// ------------------------------------------------------------------ //
// Mailbox scan history + manual trigger (Phase 3D-B Task 5)
// ------------------------------------------------------------------ //

/**
 * Fetches recent scan runs for a connection (`GET .../scans`, already
 * built in Phase 3D-B Task 2/3 but never called from Office until this
 * task). Most-recent-first, server-capped at 50.
 */
export async function fetchMailboxScanRuns(
  session: OfficeSession,
  connectionId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET("/api/v1/tenants/{tenantId}/mailbox-connections/{connectionId}/scans", {
    params: { path: { tenantId: session.tenantId, connectionId } },
    headers: await getAppAuthorization(getToken, organizationId),
  });
  if (!result.data) {
    throw new MailboxConnectionError("Scan history unavailable", result.response?.status);
  }
  return result.data.items;
}

/**
 * Starts a manual scan (`POST .../scans`). A single-flight lease means an
 * overlapping scan returns HTTP 409 with the *existing* run's body -- the
 * generated client only exposes `.data` for the 2xx case, so a 409 here
 * is reported as `"skipped_overlap"` without needing the body: the caller
 * should re-fetch scan runs to see the run that is already active.
 */
export async function startMailboxScan(
  session: OfficeSession,
  connectionId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.POST("/api/v1/tenants/{tenantId}/mailbox-connections/{connectionId}/scans", {
    params: { path: { tenantId: session.tenantId, connectionId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body: { requestId: crypto.randomUUID() },
  });
  if (result.response?.status === 409) {
    return { status: "skipped_overlap" as const };
  }
  if (!result.data) {
    throw new MailboxConnectionError("Could not start scan", result.response?.status);
  }
  return result.data;
}

// ------------------------------------------------------------------ //
// Mailbox candidate review queue (Phase 3D-B Task 5)
// ------------------------------------------------------------------ //

export class MailboxCandidateError extends Error {
  constructor(message: string, readonly status?: number) {
    super(status === 401 || status === 403 ? "Office authorization required" : message);
    this.name = "MailboxCandidateError";
  }
}

export type MailboxCandidateReviewAction = "ingest" | "skip" | "not_receipt" | "retry";

export interface FetchMailboxCandidatesOptions {
  readonly classification?: MailboxCandidateClassification;
  /** Fix round 1 (review finding #4) -- Office ingestion-status board
   * section, independent of `classification`. */
  readonly bucket?: MailboxIngestionBucketV1;
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * Lists a connection's candidates, one classification group (candidate
 * review) or one ingestion bucket (ingestion status) at a time (mockup
 * decision: each group maintains its own cursor/"Load more" -- see
 * plans/mockups/office-mailbox-review/NOTES.md and
 * plans/mockups/office-mailbox-ingestion/NOTES.md). `totalCount` is
 * present only when `bucket` was requested.
 */
export async function fetchMailboxCandidates(
  session: OfficeSession,
  connectionId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  options: FetchMailboxCandidatesOptions = {},
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET(
    "/api/v1/tenants/{tenantId}/mailbox-connections/{connectionId}/candidates",
    {
      params: {
        path: { tenantId: session.tenantId, connectionId },
        query: {
          ...(options.classification === undefined ? {} : { classification: options.classification }),
          ...(options.bucket === undefined ? {} : { bucket: options.bucket }),
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        },
      },
      headers: await getAppAuthorization(getToken, organizationId),
    },
  );
  if (!result.data) {
    throw new MailboxCandidateError("Mailbox candidates unavailable", result.response?.status);
  }
  return result.data;
}

/**
 * Resolves a candidate review action. `scope` is required by the server
 * only for `action: "ingest"`; omit it for skip/not_receipt/retry.
 */
export async function resolveMailboxCandidate(
  session: OfficeSession,
  connectionId: string,
  candidateId: string,
  action: MailboxCandidateReviewAction,
  expectedCandidateVersion: number,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  scope?: Scope,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.POST(
    "/api/v1/tenants/{tenantId}/mailbox-connections/{connectionId}/candidates/{candidateId}/resolve",
    {
      params: { path: { tenantId: session.tenantId, connectionId, candidateId } },
      headers: await getAppAuthorization(getToken, organizationId),
      body: {
        action,
        ...(scope ? { scope } : {}),
        expectedCandidateVersion,
        requestId: crypto.randomUUID(),
      },
    },
  );
  if (!result.data) {
    const status = result.response?.status;
    throw new MailboxCandidateError(
      status === 409 ? "This candidate changed. Refreshing review list." : "Resolution unavailable",
      status,
    );
  }
  return result.data;
}

// ------------------------------------------------------------------ //
// Identity / Membership API
// ------------------------------------------------------------------ //

export type TenantRole = "owner" | "admin" | "member";

/**
 * Fetches the authenticated user's identity from the API.
 * Used to resolve the userId before fetching membership.
 */
export async function fetchCurrentUser(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET("/api/v1/users/me", {
    headers: await getAppAuthorization(getToken, organizationId),
  });
  if (!result.data) throw new Error("Current user unavailable");
  return result.data;
}

/**
 * Fetches the current user's tenant membership role.
 * Returns the role ("owner" | "admin" | "member") or null if not a member.
 * Backend is authoritative; the role controls tag management UI gate only.
 *
 * The generated /tenants/{tenantId}/memberships route is NOT paginated:
 * it returns { items: [...] } with no nextCursor. This is verified against
 * the generated TypeScript paths type. A single GET retrieves the complete
 * member list. If the response is missing or malformed, we throw rather than
 * silently returning null (which could grant unintended access).
 */
export async function fetchTenantMembership(
  session: OfficeSession,
  userId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
): Promise<TenantRole | null> {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET("/api/v1/tenants/{tenantId}/memberships", {
    params: { path: { tenantId: session.tenantId } },
    headers: await getAppAuthorization(getToken, organizationId),
  });
  // The generated route has no nextCursor — this single request is the complete list.
  // Throw if response is missing so callers can detect failure vs. genuine non-membership.
  if (!result.data) throw new Error("Membership unavailable");
  // Runtime assertion: response must be a plain items array (no pagination cursor).
  // If a cursor ever appears, something changed in the API contract.
  const data = result.data as { items: typeof result.data.items; nextCursor?: unknown };
  if (data.nextCursor !== undefined && data.nextCursor !== null) {
    // Surface this as an error: we would need to walk pages but cannot with current contract.
    throw new Error("Membership list unexpectedly paginated — cannot guarantee complete role scan");
  }
  const membership = result.data.items.find((m) => m.userId === userId);
  if (!membership || membership.status !== "active") return null;
  return membership.role as TenantRole;
}
