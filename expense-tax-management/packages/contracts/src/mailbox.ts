/**
 * Phase 3D-A mailbox connection contracts (Task 1: contracts prerequisite).
 *
 * - MailboxScope is not a new shape: it aliases the existing canonical
 *   Scope/ScopeSchema from ./enrichment.js. Do not declare a second public
 *   scope union here; enrichment.ts states "do not create another public
 *   scope schema elsewhere" for exactly this reason.
 * - App API owns everything in this file: connection metadata, OAuth
 *   attempt state, reviewer grants, and the permanent operation-key ledger.
 *   The broker owns Google OAuth/provider calls and its own token vault;
 *   the provider I/O types below are the App<->broker boundary shapes.
 * - Public provider enum is "gmail" | "outlook"; only a Gmail adapter
 *   exists. Rejecting "outlook" is a domain-layer PROVIDER_UNSUPPORTED
 *   decision, not a schema-level restriction -- the schema accepts both.
 * - Spec authority: 2026-09-12-phase-3d-connected-mailbox-design.md
 */
import { z } from "zod";

import { ScopeSchema, type Scope } from "./enrichment.js";
import { TimestampSchema, VersionSchema } from "./expenses.js";

// ------------------------------------------------------------------ //
// Canonical scope alias
// ------------------------------------------------------------------ //

export const MailboxScopeSchema = ScopeSchema;
export type MailboxScope = Scope;

// ------------------------------------------------------------------ //
// Enums
// ------------------------------------------------------------------ //

export const MailboxProviderSchema = z.enum(["gmail", "outlook"]);
export type MailboxProvider = z.infer<typeof MailboxProviderSchema>;

export const MailboxConnectionStatusSchema = z.enum([
  "pending",
  "active",
  "paused",
  "reauth_required",
  "disconnecting",
  "revocation_pending",
  "revoked",
]);
export type MailboxConnectionStatus = z.infer<typeof MailboxConnectionStatusSchema>;

export const MailboxErrorCodeV1Schema = z.enum([
  "ENTITLEMENT_DISABLED",
  "SCOPE_ACCESS_DENIED",
  "CONNECTION_NOT_FOUND",
  "PROVIDER_UNSUPPORTED",
  "OAUTH_ATTEMPT_EXPIRED",
  "OAUTH_STATE_INVALID",
  "OAUTH_REPLAY",
  "OAUTH_SCOPE_MISMATCH",
  "GOOGLE_REAUTH_REQUIRED",
  "GOOGLE_RATE_LIMITED",
  "GOOGLE_UNAVAILABLE",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "REVOKE_PENDING",
]);
export type MailboxErrorCodeV1 = z.infer<typeof MailboxErrorCodeV1Schema>;

export const MailboxOAuthAttemptStatusSchema = z.enum([
  "pending",
  "consumed",
  "completed",
  "expired",
  "cancelled",
]);
export type MailboxOAuthAttemptStatus = z.infer<typeof MailboxOAuthAttemptStatusSchema>;

export const MailboxReviewerRoleSchema = z.enum(["reviewer", "manager"]);
export type MailboxReviewerRole = z.infer<typeof MailboxReviewerRoleSchema>;

const DigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Digest must be a 64-char lowercase hex SHA-256");

const LocalScanTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "localScanTime must be 24-hour HH:MM");

// ------------------------------------------------------------------ //
// MailboxConnection -- public fields shared by the public and the
// internal (App-persisted) record shapes.
// ------------------------------------------------------------------ //

const MailboxConnectionPublicFields = {
  schemaVersion: z.literal(1),
  id: z.uuid(),
  tenantId: z.uuid(),
  ownerUserId: z.uuid(),
  provider: MailboxProviderSchema,
  providerAccountId: z.string().trim().min(1).max(255),
  accountEmail: z.email().max(320),
  scope: MailboxScopeSchema,
  status: MailboxConnectionStatusSchema,
  grantedScopes: z.array(z.string().trim().min(1).max(255)),
  timezone: z.string().trim().min(1).max(100),
  localScanTime: LocalScanTimeSchema,
  scanEnabled: z.boolean(),
  lastScanAt: TimestampSchema.nullable(),
  nextScheduleAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
};

/**
 * Public connection shape -- safe to return to customer-facing routes.
 * Carries no vault pointer, no lease, no scan-run internals.
 */
export const MailboxConnectionV1Schema = z.strictObject(MailboxConnectionPublicFields);
export type MailboxConnectionV1 = z.infer<typeof MailboxConnectionV1Schema>;

/**
 * Internal (App-persisted) connection record -- adds the vault pointer,
 * token-generation CAS internals, and the active-scan lease pointer.
 * vaultReference is opaque to App: App owns which generation is active,
 * never the token itself.
 */
export const MailboxConnectionRecordV1Schema = z.strictObject({
  ...MailboxConnectionPublicFields,
  vaultReference: z.string().trim().min(1).max(500),
  tokenGeneration: z.number().int().positive(),
  connectionVersion: VersionSchema,
  tokenOperationLeaseId: z.uuid().nullable(),
  tokenOperationLeaseExpiresAt: TimestampSchema.nullable(),
  activeScanRunId: z.uuid().nullable(),
  activeScanLeaseExpiresAt: TimestampSchema.nullable(),
});
export type MailboxConnectionRecordV1 = z.infer<typeof MailboxConnectionRecordV1Schema>;

// ------------------------------------------------------------------ //
// MailboxOAuthAttempt
// ------------------------------------------------------------------ //

const oAuthAttemptStateRefine = (value: {
  status: MailboxOAuthAttemptStatus;
  consumedAt: string | null;
  completedAt: string | null;
}) =>
  (value.status === "pending" && value.consumedAt === null && value.completedAt === null) ||
  (value.status === "consumed" && value.consumedAt !== null && value.completedAt === null) ||
  (value.status === "completed" && value.consumedAt !== null && value.completedAt !== null) ||
  (value.status === "expired" && value.consumedAt === null && value.completedAt === null) ||
  (value.status === "cancelled" && value.completedAt === null);

export const MailboxOAuthAttemptV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    connectionId: z.uuid(),
    tenantId: z.uuid(),
    actorUserId: z.uuid(),
    stateDigest: DigestSchema,
    sessionNonceDigest: DigestSchema,
    redirectOrigin: z.string().trim().min(1).max(2048),
    expiresAt: TimestampSchema,
    status: MailboxOAuthAttemptStatusSchema,
    createdAt: TimestampSchema,
    consumedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
  })
  .refine(oAuthAttemptStateRefine, {
    message: "OAuth attempt consumed/completed timestamps must match status",
  });
export type MailboxOAuthAttemptV1 = z.infer<typeof MailboxOAuthAttemptV1Schema>;

// ------------------------------------------------------------------ //
// MailboxReviewerGrant
// ------------------------------------------------------------------ //

export const MailboxReviewerGrantV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  connectionId: z.uuid(),
  tenantId: z.uuid(),
  userId: z.uuid(),
  role: MailboxReviewerRoleSchema,
  version: VersionSchema,
  revokedAt: TimestampSchema.nullable(),
});
export type MailboxReviewerGrantV1 = z.infer<typeof MailboxReviewerGrantV1Schema>;

// ------------------------------------------------------------------ //
// Permanent idempotency key
// ------------------------------------------------------------------ //

export function mailboxIdempotencyKey(
  connectionId: string,
  operation: string,
  reference: string,
  version: number,
): string {
  return `${connectionId}:${operation}:${reference}:${version}`;
}

// ------------------------------------------------------------------ //
// Provider I/O types -- the App<->broker boundary. Not Zod-validated
// here: these are internal service-to-service wire shapes transported
// over Clerk-M2M-authenticated calls, validated by the broker/App
// domain layers implemented in later Phase 3D-A tasks.
// ------------------------------------------------------------------ //

export interface OAuthStartInput {
  connectionId: string;
  attemptId: string;
  sessionNonce: string;
  redirectOrigin: string;
}

export interface OAuthStartResult {
  authorizationUrl: string;
  stateDigest: string;
  expiresAt: string;
}

export interface OAuthCallbackInput {
  code: string;
  state: string;
  requestOrigin: string;
}

export interface ConnectedAccount {
  providerAccountId: string;
  email: string;
  grantedScopes: readonly string[];
  initialHistoryId: string;
  vaultReference: string;
  tokenGeneration: number;
}

export interface RevokeConnectionInput {
  connectionId: string;
  operationId: string;
}

export interface TokenOperationLeaseV1 {
  readonly connectionId: string;
  readonly leaseId: string;
  readonly expiresAt: string;
  readonly expectedConnectionVersion: number;
  readonly currentTokenGeneration: number;
}

export interface AdvanceTokenGenerationInput {
  readonly connectionId: string;
  readonly leaseId: string;
  readonly expectedConnectionVersion: number;
  readonly newGeneration: number;
  readonly vaultReference: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface AdvanceTokenGenerationResult {
  readonly connectionVersion: number;
  readonly tokenGeneration: number;
  readonly vaultReference: string;
}

export interface MailboxBrokerConnectionAppClient {
  consumeOAuthAttempt(input: {
    connectionId: string;
    attemptId: string;
    stateDigest: string;
    sessionNonceDigest: string;
  }): Promise<{ status: "consumed"; connectionVersion: number }>;
  completeConnection(
    input: ConnectedAccount & {
      connectionId: string;
      attemptId: string;
    },
  ): Promise<MailboxConnectionV1>;
  acquireTokenOperationLease(input: {
    connectionId: string;
    operationId: string;
    ttlSeconds: number;
  }): Promise<TokenOperationLeaseV1>;
  advanceTokenGeneration(
    input: AdvanceTokenGenerationInput,
  ): Promise<AdvanceTokenGenerationResult>;
  releaseTokenOperationLease(input: { connectionId: string; leaseId: string }): Promise<void>;
  recordRevocation(input: {
    connectionId: string;
    operationId: string;
    status: "revoked" | "revocation_pending";
  }): Promise<MailboxConnectionV1>;
}

export interface MailboxProviderAdapter {
  createAuthorizationUrl(input: OAuthStartInput): Promise<OAuthStartResult>;
  exchangeAuthorizationCode(input: OAuthCallbackInput): Promise<ConnectedAccount>;
  revoke(input: RevokeConnectionInput): Promise<void>;
}
