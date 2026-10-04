import { z } from "zod";

export const TimestampSchema = z.string().datetime({ offset: true });
export const DateOnlySchema = z.iso.date();
export const VersionSchema = z.number().int().positive();
export const TaxYearSchema = z.number().int().min(1_900).max(9_999);
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const DecimalMoneySchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  .refine((value) => Number(value) > 0, "Amount must be positive");

export const ExpenseStatusSchema = z.enum(["draft", "ready", "archived"]);
export type ExpenseStatus = z.infer<typeof ExpenseStatusSchema>;

/**
 * Lightweight tag chip included on expense responses. Carries only
 * the fields needed to render a chip (id, name, optional color).
 * Only active associations + active tag definitions are projected.
 */
export const ExpenseTagChipSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(100),
  color: z.string().nullable(),
});
export type ExpenseTagChip = z.infer<typeof ExpenseTagChipSchema>;

// Phase 3D-C Task 3: connected-mailbox-sourced expenses (attachment OCR or
// structured-HTML extraction) get their own source value -- distinct from
// "ocr"/"forwarded_email" so the coarse expense.source categorization
// doesn't misattribute provenance; the authoritative connected-mailbox
// marker is app.expense_sources.source_type='connected_mailbox' plus
// mailbox_candidate_id (migration 020), this is the lighter-weight sibling
// column. Migration 021 widens the DB CHECK constraint to match.
export const ExpenseSourceSchema = z.enum([
  "manual",
  "ocr",
  "forwarded_email",
  "connected_mailbox",
]);
export type ExpenseSource = z.infer<typeof ExpenseSourceSchema>;

/**
 * Phase 3D-C Task 6 fix round 1 (review finding #6) -- connected-mailbox
 * provenance for the Office expense-detail "Source" block. Metadata
 * only: sender address, received date, the mailbox account it arrived
 * through, and whether it is still pending Phase 3B duplicate review --
 * never message body/attachment bytes/other provider content. Present
 * (non-null) only when `source === "connected_mailbox"`.
 */
export const ExpenseMailboxProvenanceV1Schema = z.strictObject({
  senderAddress: z.email().max(320),
  receivedAt: TimestampSchema,
  mailboxAccountEmail: z.email().max(320),
  pendingDuplicateReview: z.boolean(),
});
export type ExpenseMailboxProvenanceV1 = z.infer<typeof ExpenseMailboxProvenanceV1Schema>;

const ExpenseScopeFields = {
  personalProfileId: z.uuid().nullable().optional(),
  businessId: z.uuid().nullable().optional(),
  projectId: z.uuid().nullable().optional(),
  spendingCategoryId: z.uuid().nullable().optional(),
};

function validExpenseScope(value: {
  personalProfileId?: string | null | undefined;
  businessId?: string | null | undefined;
  projectId?: string | null | undefined;
}): boolean {
  const personal = value.personalProfileId != null;
  const business = value.businessId != null;
  return personal !== business && (!personal || value.projectId == null);
}

const ExpenseFields = {
  merchant: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).nullable().optional(),
  amount: DecimalMoneySchema,
  currency: CurrencySchema,
  incurredOn: DateOnlySchema,
};

export const ExpenseCreateRequestSchema = z
  .strictObject({ ...ExpenseScopeFields, ...ExpenseFields })
  .refine(validExpenseScope, {
    message: "Expense must target exactly one Personal profile or business",
  });
export type ExpenseCreateRequest = z.infer<typeof ExpenseCreateRequestSchema>;

export const ExpenseSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  createdByUserId: z.uuid(),
  personalProfileId: z.uuid().nullable(),
  businessId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  spendingCategoryId: z.uuid().nullable(),
  merchant: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable(),
  amount: DecimalMoneySchema,
  currency: CurrencySchema,
  incurredOn: DateOnlySchema,
  taxYear: z.number().int().min(1_900).max(9_999),
  source: ExpenseSourceSchema,
  mailboxProvenance: ExpenseMailboxProvenanceV1Schema.nullable(),
  status: ExpenseStatusSchema,
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** Active tag chips attached to this expense (sorted by name asc, id asc). */
  tags: z.array(ExpenseTagChipSchema).default([]),
});
export type Expense = z.infer<typeof ExpenseSchema>;

export const ExpenseUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    merchant: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2_000).nullable().optional(),
    amount: DecimalMoneySchema.optional(),
    currency: CurrencySchema.optional(),
    incurredOn: DateOnlySchema.optional(),
    projectId: z.uuid().nullable().optional(),
    spendingCategoryId: z.uuid().nullable().optional(),
    status: z.enum(["draft", "ready"]).optional(),
  })
  .refine(
    (value) =>
      value.merchant !== undefined ||
      value.description !== undefined ||
      value.amount !== undefined ||
      value.currency !== undefined ||
      value.incurredOn !== undefined ||
      value.projectId !== undefined ||
      value.spendingCategoryId !== undefined ||
      value.status !== undefined,
    { message: "At least one expense change is required" },
  );
export type ExpenseUpdateRequest = z.infer<typeof ExpenseUpdateRequestSchema>;

export const ExpenseArchiveRequestSchema = z.strictObject({
  expectedVersion: VersionSchema,
});
export type ExpenseArchiveRequest = z.infer<typeof ExpenseArchiveRequestSchema>;

export const PersonalExpenseCollectionParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  profileId: z.uuid(),
});
export type PersonalExpenseCollectionParams = z.infer<
  typeof PersonalExpenseCollectionParamsSchema
>;

export const BusinessExpenseCollectionParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
});
export type BusinessExpenseCollectionParams = z.infer<
  typeof BusinessExpenseCollectionParamsSchema
>;

export const PersonalExpenseParamsSchema = PersonalExpenseCollectionParamsSchema.extend({
  expenseId: z.uuid(),
});
export type PersonalExpenseParams = z.infer<typeof PersonalExpenseParamsSchema>;

export const BusinessExpenseParamsSchema = BusinessExpenseCollectionParamsSchema.extend({
  expenseId: z.uuid(),
});
export type BusinessExpenseParams = z.infer<typeof BusinessExpenseParamsSchema>;

export const ExpenseListSchema = z.strictObject({
  items: z.array(ExpenseSchema),
  nextCursor: z.string().nullable(),
});
export type ExpenseList = z.infer<typeof ExpenseListSchema>;
