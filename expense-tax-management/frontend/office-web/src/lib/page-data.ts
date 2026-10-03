import type { Scope } from "@expense-tax/contracts";

import { fetchAuthorizedBusinesses, fetchDuplicateMatches, fetchLedger, fetchMailboxConnection, fetchTags, fetchTaxReport } from "./api";
import type { ClerkGetToken } from "./clerk";
import type { OfficeSession } from "./session";

export function loadDashboard(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  return fetchLedger(session, getToken, organizationId);
}

export function loadExpenses(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  return fetchLedger(session, getToken, organizationId);
}

export function loadTax(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  taxYear: number,
) {
  return fetchTaxReport(session, taxYear, getToken, organizationId);
}

export function loadTaxForOffice(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  return loadTax(session, getToken, organizationId, 2025);
}

export function loadDuplicates(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  cursor?: string,
) {
  return fetchDuplicateMatches(session, getToken, organizationId, undefined, cursor);
}

export function loadTags(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  return fetchTags(session, getToken, organizationId);
}

/**
 * Fix round 1 (Important) -- the real connection-status read the Office
 * mailbox page needs instead of static scaffolding. `scope` is explicit
 * (fix round 2), not derived from `session.scope` -- see api.ts.
 */
export function loadMailboxConnection(
  session: OfficeSession,
  scope: Scope,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  return fetchMailboxConnection(session, scope, getToken, organizationId);
}

/**
 * Fix round 2 (Important) -- the authorized scope choices (Personal, when
 * known, plus every active business) for the mailbox-connect picker.
 */
export function loadAuthorizedBusinesses(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  return fetchAuthorizedBusinesses(session, getToken, organizationId);
}
