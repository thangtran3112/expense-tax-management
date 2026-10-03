/**
 * Mailbox broker base: re-exports the App<->broker boundary contracts
 * owned by @expense-tax/contracts (packages/contracts/src/mailbox.ts).
 *
 * The broker never redeclares these shapes -- MailboxProviderAdapter and
 * MailboxBrokerConnectionAppClient are the canonical interfaces the
 * Gmail adapter (later Phase 3D-A tasks) implements/consumes.
 */
export type {
  MailboxProvider,
  MailboxScope,
  OAuthStartInput,
  OAuthStartResult,
  OAuthCallbackInput,
  ConnectedAccount,
  RevokeConnectionInput,
  TokenOperationLeaseV1,
  AdvanceTokenGenerationInput,
  AdvanceTokenGenerationResult,
  MailboxBrokerConnectionAppClient,
  MailboxProviderAdapter,
} from "@expense-tax/contracts";

export { mailboxIdempotencyKey } from "@expense-tax/contracts";
