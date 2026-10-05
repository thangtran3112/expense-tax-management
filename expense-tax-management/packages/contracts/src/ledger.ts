import { z } from "zod";

import {
  DateOnlySchema,
  DecimalMoneySchema,
  ExpenseListSchema,
  ExpenseStatusSchema,
} from "./expenses.js";
import { TaxTreatmentReviewStatusSchema } from "./tax-treatments.js";

export const LedgerSortSchema = z.enum([
  "incurredOn",
  "amount",
  "merchant",
  "createdAt",
]);
export type LedgerSort = z.infer<typeof LedgerSortSchema>;

export const LedgerDirectionSchema = z.enum(["asc", "desc"]);
export type LedgerDirection = z.infer<typeof LedgerDirectionSchema>;

export const LedgerCursorSchema = z.string().trim().min(1).max(4_096);
export type LedgerCursor = z.infer<typeof LedgerCursorSchema>;

/**
 * Raw query object before tagId normalization. Fastify passes repeated
 * query params as a string or array of strings; transform normalizes to
 * canonical sorted unique `tagIds`.
 */
const LedgerQueryRawSchema = z.strictObject({
  incurredFrom: DateOnlySchema.optional(),
  incurredTo: DateOnlySchema.optional(),
  amountMin: DecimalMoneySchema.optional(),
  amountMax: DecimalMoneySchema.optional(),
  status: ExpenseStatusSchema.optional(),
  spendingCategoryId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  taxReviewStatus: TaxTreatmentReviewStatusSchema.optional(),
  sort: LedgerSortSchema.default("incurredOn"),
  direction: LedgerDirectionSchema.default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: LedgerCursorSchema.optional(),
  /**
   * Repeated query parameter: `?tagId=<uuid>&tagId=<uuid>`.
   * Each value must be a valid UUID. The route sends one or more tagId params.
   * After transform, the canonical `tagIds` field holds deduplicated sorted UUIDs.
   */
  tagId: z.union([z.uuid(), z.array(z.uuid())]).optional(),
});

export const LedgerQuerySchema = LedgerQueryRawSchema.transform((raw) => {
  // Normalise tagId → tagIds: deduplicate and sort ascending
  const rawTagIds = raw.tagId === undefined
    ? []
    : Array.isArray(raw.tagId)
      ? raw.tagId
      : [raw.tagId];
  const tagIds = [...new Set(rawTagIds)].sort();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tagId: _tagId, ...rest } = raw;
  return { ...rest, tagIds };
}).refine(
  (value) =>
    value.incurredFrom === undefined ||
    value.incurredTo === undefined ||
    value.incurredFrom <= value.incurredTo,
  { message: "incurredFrom must not exceed incurredTo" },
).refine(
  (value) =>
    value.amountMin === undefined ||
    value.amountMax === undefined ||
    Number(value.amountMin) <= Number(value.amountMax),
  { message: "amountMin must not exceed amountMax" },
);
export type LedgerQuery = z.infer<typeof LedgerQuerySchema>;

export const LedgerListResponseSchema = ExpenseListSchema;
export type LedgerListResponse = z.infer<typeof LedgerListResponseSchema>;
