import type { ColumnType } from "kysely";

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type GeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;

export interface TokenVaultTable {
  readonly connection_id: string;
  readonly generation: number;
  readonly key_id: string;
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly auth_tag: Buffer;
  readonly disabled_at: NullableTimestamp;
  readonly created_at: GeneratedTimestamp;
}

export type TokenOperationStatus = "pending" | "confirmed" | "rejected";

export interface TokenOperationTable {
  readonly operation_id: string;
  readonly connection_id: string;
  readonly idempotency_key: string;
  readonly lease_id: string;
  readonly expected_connection_version: number;
  readonly from_generation: number;
  readonly to_generation: number;
  readonly vault_reference: string;
  readonly request_id: string;
  readonly advance_requested_at: NullableTimestamp;
  readonly status: TokenOperationStatus;
  readonly created_at: GeneratedTimestamp;
  readonly resolved_at: NullableTimestamp;
}

export interface VaultDatabase {
  readonly token_vault: TokenVaultTable;
  readonly token_operations: TokenOperationTable;
}

// Re-exported so callers importing only database/types.ts don't need a
// second import for the shared timestamp helper type.
export type { Timestamp };
