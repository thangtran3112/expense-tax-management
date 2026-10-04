import type { MailboxCandidateClassification, Scope } from "@expense-tax/contracts";

import { fetchAuthorizedBusinesses, fetchDuplicateMatches, fetchLedger, fetchMailboxCandidates, fetchMailboxConnection, fetchMailboxScanRuns, fetchOwnPersonalProfile, fetchTags, fetchTaxReport } from "./api";
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

/**
 * Fix round 3 (Important) -- always offer the caller's own Personal
 * profile in the mailbox scope-picker, even under a business-scoped
 * Office session (previously omitted -- see fix round 2's Ruling, now
 * closed by App API's new scope-authorized lookup).
 */
export function loadOwnPersonalProfile(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  return fetchOwnPersonalProfile(session, getToken, organizationId);
}

/**
 * Phase 3D-B Task 5 -- scan history for the connection's "Scan schedule"
 * panel (routes already existed from Task 2/3; this is the first Office
 * caller).
 */
export function loadMailboxScanRuns(
  session: OfficeSession,
  connectionId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
) {
  return fetchMailboxScanRuns(session, connectionId, getToken, organizationId);
}

/**
 * Phase 3D-B Task 5 -- one classification group's page of candidates.
 */
export function loadMailboxCandidates(
  session: OfficeSession,
  connectionId: string,
  classification: MailboxCandidateClassification,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  cursor?: string,
) {
  return fetchMailboxCandidates(session, connectionId, getToken, organizationId, {
    classification,
    ...(cursor ? { cursor } : {}),
  });
}
