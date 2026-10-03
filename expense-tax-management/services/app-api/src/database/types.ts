import type { ColumnType, Generated } from "kysely";

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ServiceMetadataTable {
  readonly key: string;
  readonly value: JsonValue;
  readonly updated_at: Generated<Date>;
}

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type NullableText = ColumnType<
  string | null,
  string | null | undefined,
  string | null
>;
type NullableDate = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type MoneyAmount = ColumnType<string, string | number, string>;

export interface UserTable {
  readonly id: string;
  clerk_user_id: NullableText;
  primary_email: string;
  display_name: string;
  status: "active" | "disabled";
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AuthIdentityTable {
  readonly id: string;
  readonly user_id: string;
  issuer: string;
  subject: string;
  verified_email: string;
  email_verified: boolean;
  last_authenticated_at: GeneratedTimestamp;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TenantTable {
  readonly id: string;
  clerk_org_id: NullableText;
  name: string;
  readonly slug: string;
  status: "active" | "archived";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  archived_at: NullableTimestamp;
}

export interface TenantMembershipTable {
  readonly tenant_id: string;
  readonly user_id: string;
  role: "owner" | "admin" | "member";
  status: "active" | "inactive";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PersonalProfileTable {
  readonly id: string;
  readonly tenant_id: string;
  name: string;
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PersonalMembershipTable {
  readonly personal_profile_id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "inactive";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TenantInvitationTable {
  readonly id: string;
  readonly tenant_id: string;
  normalized_email: string;
  tenant_role: "owner" | "admin" | "member";
  personal_profile_id: string | null;
  personal_role: "owner" | "editor" | "viewer" | null;
  business_id: NullableText;
  business_role: ColumnType<
    "owner" | "editor" | "viewer" | null,
    "owner" | "editor" | "viewer" | null | undefined,
    "owner" | "editor" | "viewer" | null
  >;
  readonly token_hash: string;
  expires_at: Timestamp;
  accepted_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  readonly created_by_user_id: string;
  accepted_by_user_id: string | null;
  readonly created_at: GeneratedTimestamp;
}

export interface BusinessIndustryTable {
  readonly code: string;
  name: string;
  status: "active" | "inactive";
  readonly created_at: GeneratedTimestamp;
}

export interface SpendingCategoryTemplateTable {
  readonly template_key: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  readonly created_at: GeneratedTimestamp;
}

export interface IndustrySpendingCategoryTemplateTable {
  readonly industry_code: string;
  readonly template_key: string;
  sort_order: number;
}

export interface BusinessTable {
  readonly id: string;
  readonly tenant_id: string;
  name: string;
  industry_code: string;
  timezone: string;
  base_currency: string;
  status: "active" | "archived";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  archived_at: NullableTimestamp;
}

export interface BusinessMembershipTable {
  readonly business_id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "inactive";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface SpendingCategoryTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly template_key: NullableText;
  name: string;
  description: NullableText;
  color: string;
  icon: string;
  status: "active" | "archived";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  archived_at: NullableTimestamp;
}

export interface ProjectTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly business_id: string;
  name: string;
  client_name: NullableText;
  description: NullableText;
  status: "active" | "completed" | "archived";
  starts_on: NullableDate;
  ends_on: NullableDate;
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  archived_at: NullableTimestamp;
}

export interface TaxonomyVersionTable {
  readonly id: string;
  readonly jurisdiction_code: "US-FEDERAL";
  readonly tax_year: number;
  readonly code: string;
  name: string;
  status: "active" | "superseded";
  source_url: string;
  source_revision: string;
  source_checksum: string;
  readonly created_at: GeneratedTimestamp;
}

export interface TaxCategoryDefinitionTable {
  readonly id: string;
  readonly taxonomy_version_id: string;
  code: string;
  name: string;
  description: NullableText;
  official_form: NullableText;
  official_line: NullableText;
  status: "active" | "inactive";
  sort_order: number;
}

export interface ExpenseTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly created_by_user_id: string;
  personal_profile_id: NullableText;
  business_id: NullableText;
  project_id: NullableText;
  spending_category_id: NullableText;
  merchant: string;
  description: NullableText;
  amount: MoneyAmount;
  currency: string;
  incurred_on: NullableDate;
  readonly tax_year: Generated<number>;
  source: "manual" | "ocr" | "forwarded_email";
  status: "draft" | "ready" | "archived";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  archived_at: NullableTimestamp;
}

export interface BusinessTaxProfileTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly business_id: string;
  tax_year: number;
  taxonomy_version_id: string;
  tax_form: "schedule_c";
  accounting_method: "cash" | "accrual";
  status: "draft" | "active" | "closed";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ExpenseTaxTreatmentTable {
  readonly expense_id: string;
  readonly tenant_id: string;
  readonly business_id: string;
  readonly tax_year: number;
  business_tax_profile_id: string;
  taxonomy_version_id: string;
  tax_category_definition_id: string;
  deductible_percent: MoneyAmount;
  review_status: "unreviewed" | "reviewed" | "excluded";
  note: NullableText;
  version: Generated<number>;
  readonly created_by_user_id: string;
  updated_by_user_id: string;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AppAuditEventTable {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly actor_user_id: string | null;
  readonly actor_service_principal: string | null;
  readonly action: string;
  readonly outcome: "success" | "denied" | "failure";
  readonly resource_type: string;
  readonly resource_id: string | null;
  readonly request_id: string;
  readonly metadata: Generated<JsonValue>;
  readonly created_at: GeneratedTimestamp;
}

export interface IdempotencyRecordTable {
  readonly id: string;
  readonly actor_key: string;
  readonly operation_key: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly response_status: number;
  readonly response_body: JsonValue;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly expires_at: Timestamp;
  readonly created_at: GeneratedTimestamp;
}

export interface ClerkWebhookEventTable {
  readonly id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly processed_at: Timestamp;
  readonly created_at: GeneratedTimestamp;
}

export interface PlanTable {
  readonly id: string;
  readonly key: string;
  name: string;
  description: NullableText;
  is_active: Generated<boolean>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PlanVersionTable {
  readonly id: string;
  readonly plan_id: string;
  readonly version_number: number;
  effective_at: GeneratedTimestamp;
  is_current: Generated<boolean>;
  readonly created_at: GeneratedTimestamp;
}

export interface FeatureDefinitionTable {
  readonly id: string;
  readonly key: string;
  name: string;
  description: NullableText;
  readonly created_at: GeneratedTimestamp;
}

export interface PlanEntitlementTable {
  readonly plan_version_id: string;
  readonly feature_definition_id: string;
  is_enabled: boolean;
  limit_value: number | null;
  limit_period: "monthly" | "unlimited" | null;
}

export interface TenantSubscriptionTable {
  readonly tenant_id: string;
  plan_version_id: string;
  status: "trialing" | "active" | "canceled";
  current_entitlement_version: Generated<number>;
  readonly started_at: GeneratedTimestamp;
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TenantAddonTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly feature_definition_id: string;
  enabled: Generated<boolean>;
  granted_by: string;
  expires_at: NullableTimestamp;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TenantFeatureOverrideTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly feature_definition_id: string;
  override_enabled: boolean;
  reason: string;
  granted_by: string;
  expires_at: NullableTimestamp;
  readonly created_at: GeneratedTimestamp;
}

export interface FeatureUsageEventTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly feature_definition_id: string;
  readonly initiating_user_id: string;
  occurred_at: GeneratedTimestamp;
  quantity: Generated<number>;
  metadata: JsonValue | null;
}

export interface ProcessingJobTable {
  readonly id: string;
  readonly tenant_id: string;
  personal_profile_id: NullableText;
  business_id: NullableText;
  workflow_type: string;
  readonly workflow_id: string;
  task_queue: string;
  run_id: NullableText;
  status: "PENDING" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  target_aggregate_type: NullableText;
  target_aggregate_id: NullableText;
  expected_aggregate_version: ColumnType<number | null, number | null | undefined, number | null>;
  requested_by_user_id: NullableText;
  source_file_id: NullableText;
  input_params: ColumnType<JsonValue, JsonValue | undefined, JsonValue>;
  allowed_result_schema_version: string;
  result: ColumnType<JsonValue | null, JsonValue | null | undefined, JsonValue | null>;
  error_message: NullableText;
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  dispatched_at: NullableTimestamp;
  completed_at: NullableTimestamp;
  dispatch_generation: Generated<number>;
  dispatch_namespace: Generated<string>;
}

/**
 * Singleton row (app.temporal_dispatch_routing). Runtime role has
 * SELECT-only grants on this table; only the migrator/owner role (used by
 * the `advance` operator command) may UPDATE it.
 */
export interface TemporalDispatchRoutingTable {
  readonly singleton: Generated<boolean>;
  readonly generation: number;
  readonly temporal_namespace: string;
  readonly task_queue: string;
  readonly updated_at: GeneratedTimestamp;
}

export interface ProcessingJobDispatchOutboxTable {
  readonly id: string;
  readonly processing_job_id: string;
  readonly job_reference: JsonValue;
  status: "PENDING" | "DISPATCHED" | "FAILED";
  attempts: Generated<number>;
  last_error: NullableText;
  readonly created_at: GeneratedTimestamp;
  dispatched_at: NullableTimestamp;
}

export interface ExpenseFileTable {
  readonly id: string;
  readonly tenant_id: string;
  personal_profile_id: NullableText;
  business_id: NullableText;
  expense_id: NullableText;
  original_filename: string;
  content_type: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  size_bytes: ColumnType<number | null, number | null | undefined, number | null>;
  sha256_hex: NullableText;
  readonly storage_key: string;
  thumbnail_storage_key: NullableText;
  thumbnail_status: "pending" | "ready" | "skipped" | "failed";
  status: "PENDING" | "READY" | "FAILED" | "DELETED";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface UploadSessionTable {
  readonly id: string;
  readonly expense_file_id: string;
  status: "PENDING" | "CONFIRMED" | "EXPIRED";
  expires_at: Timestamp;
  confirmed_at: NullableTimestamp;
  readonly created_at: GeneratedTimestamp;
}

export interface ExportBundleTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly business_id: string;
  readonly tax_year: number;
  readonly taxonomy_version_id: string;
  readonly profile_id: string;
  readonly profile_status: string;
  readonly filters: JsonValue;
  readonly manifest: JsonValue;
  readonly csv_storage_key: string;
  readonly manifest_storage_key: string;
  readonly mapping_storage_key: string;
  readonly expense_count: number;
  readonly created_by_user_id: string;
  readonly created_at: GeneratedTimestamp;
}

export interface VerifiedEmailSenderTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly personal_profile_id: string | null;
  readonly business_id: string | null;
  readonly email: string;
  status: "pending" | "verified" | "revoked";
  challenge_hash: NullableText;
  challenge_expires_at: NullableTimestamp;
  verified_at: NullableTimestamp;
  readonly created_by_user_id: string;
  readonly created_at: GeneratedTimestamp;
}

export interface InboundRoutingTokenTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly personal_profile_id: string | null;
  readonly business_id: string | null;
  readonly token_hash: string;
  status: "active" | "revoked";
  readonly created_by_user_id: string;
  readonly created_at: GeneratedTimestamp;
  revoked_at: NullableTimestamp;
}

export interface InboundEmailTable {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly personal_profile_id: string | null;
  readonly business_id: string | null;
  readonly routing_token_id: string | null;
  readonly provider_message_id: string;
  readonly sender_email: string;
  readonly recipient_address: string;
  readonly subject: string | null;
  readonly content_hash: string;
  readonly auth_results: JsonValue;
  status: "ACCEPTED" | "QUARANTINED" | "DISMISSED";
  quarantine_reason: string | null;
  readonly attachment_count: number;
  readonly total_bytes: number;
  readonly created_at: GeneratedTimestamp;
  processed_at: NullableTimestamp;
}

export interface InboundEmailAttachmentTable {
  readonly id: string;
  readonly inbound_email_id: string;
  expense_file_id: NullableText;
  readonly original_filename: string;
  readonly content_type: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  readonly size_bytes: number;
  readonly sha256_hex: string;
  readonly created_at: GeneratedTimestamp;
}

export interface InboundEmailQuarantineEventTable {
  readonly id: string;
  readonly inbound_email_id: string;
  readonly reason: string;
  readonly actor_user_id: string | null;
  readonly action: "QUARANTINED" | "DISMISSED";
  readonly created_at: GeneratedTimestamp;
}

export interface ExpenseSourceTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly personal_profile_id: string | null;
  readonly business_id: string | null;
  readonly expense_id: string;
  readonly source_type: "manual_upload" | "forwarded_email";
  readonly source_file_id: string | null;
  readonly inbound_email_id: string | null;
  readonly metadata: JsonValue;
  readonly created_at: GeneratedTimestamp;
}

export interface ExpenseDedupFingerprintTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly personal_profile_id: string | null;
  readonly business_id: string | null;
  readonly expense_id: string;
  readonly fingerprint_version: number;
  readonly normalized_merchant: string;
  readonly amount_minor_units: number;
  readonly currency: string;
  readonly incurred_on: Date;
  readonly fingerprint_hash: string;
  readonly created_at: GeneratedTimestamp;
}

export interface ExpenseDuplicateMatchTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly personal_profile_id: string | null;
  readonly business_id: string | null;
  readonly existing_expense_id: string;
  readonly candidate_expense_id: string;
  readonly match_type: "file_sha256" | "fingerprint" | "fuzzy_fields";
  readonly confidence: MoneyAmount;
  readonly evidence: JsonValue;
  status: "pending" | "merged" | "separate" | "dismissed";
  version: Generated<number>;
  resolved_by: string | null;
  resolved_at: NullableTimestamp;
  resolution_idempotency_key: string | null;
  readonly idempotency_key: string;
  readonly created_at: GeneratedTimestamp;
}

export interface EntitlementSnapshotOutboxTable {
  readonly outbox_sequence: Generated<string>;
  readonly tenant_id: string;
  readonly entitlement_version: number;
  readonly payload: JsonValue;
  readonly created_at: GeneratedTimestamp;
}

export interface TagTable {
  readonly id: string;
  readonly tenant_id: string;
  key: string;
  name: string;
  color: NullableText;
  origin: "custom" | "rule";
  status: "active" | "archived";
  version: Generated<number>;
  created_by_user_id: string | null;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ExpenseTagTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly personal_profile_id: string | null;
  readonly business_id: string | null;
  readonly expense_id: string;
  readonly tag_id: string;
  source: "manual" | "rule" | "historical" | "ai";
  confidence: string;
  rule_version: number | null;
  suggestion_id: string | null;
  status: "active" | "removed";
  version: Generated<number>;
  applied_by_user_id: string | null;
  removed_by_user_id: string | null;
  applied_at: NullableTimestamp;
  removed_at: NullableTimestamp;
  readonly created_at: GeneratedTimestamp;
}

export interface ExpenseSpendingCategoryDecisionTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly personal_profile_id: string | null;
  readonly business_id: string | null;
  readonly expense_id: string;
  prior_spending_category_id: string | null;
  new_spending_category_id: string | null;
  source: "manual" | "manual_baseline" | "historical" | "ai";
  actor_user_id: string | null;
  expense_version: number;
  suggestion_id: string | null;
  readonly created_at: GeneratedTimestamp;
}

export interface ExpenseEnrichmentSuggestionTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly personal_profile_id: string | null;
  readonly business_id: string | null;
  readonly expense_id: string;
  readonly job_id: string;
  readonly kind: "tag" | "spending_category" | "tax_category";
  tag_id: string | null;
  spending_category_id: string | null;
  tax_category_definition_id: string | null;
  business_tax_profile_id: string | null;
  business_tax_profile_version: number | null;
  taxonomy_version_id: string | null;
  tax_year: number | null;
  source: "historical" | "ai";
  confidence: string;
  evidence: ColumnType<JsonValue, JsonValue | undefined, JsonValue>;
  evidence_hash: string;
  status: "pending" | "accepted" | "rejected" | "superseded";
  version: Generated<number>;
  expense_version: number;
  idempotency_key: string;
  resolved_by_user_id: string | null;
  resolved_at: NullableTimestamp;
  readonly created_at: GeneratedTimestamp;
}

export interface EnrichmentOperationKeyTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly job_id: string;
  readonly expense_id: string;
  readonly kind: "tag" | "spending_category" | "tax_category" | "result";
  readonly candidate_id: string | null;
  readonly evidence_hash: string;
  readonly operation_key: string;
  readonly payload_hash: string;
  response_json: ColumnType<JsonValue | null, JsonValue | null | undefined, JsonValue | null>;
  readonly created_at: GeneratedTimestamp;
}

export interface AppDatabase {
  readonly "app.service_metadata": ServiceMetadataTable;
  readonly "app.users": UserTable;
  readonly "app.auth_identities": AuthIdentityTable;
  readonly "app.tenants": TenantTable;
  readonly "app.tenant_memberships": TenantMembershipTable;
  readonly "app.personal_profiles": PersonalProfileTable;
  readonly "app.personal_memberships": PersonalMembershipTable;
  readonly "app.tenant_invitations": TenantInvitationTable;
  readonly "app.business_industries": BusinessIndustryTable;
  readonly "app.spending_category_templates": SpendingCategoryTemplateTable;
  readonly "app.industry_spending_category_templates": IndustrySpendingCategoryTemplateTable;
  readonly "app.businesses": BusinessTable;
  readonly "app.business_memberships": BusinessMembershipTable;
  readonly "app.spending_categories": SpendingCategoryTable;
  readonly "app.projects": ProjectTable;
  readonly "app.taxonomy_versions": TaxonomyVersionTable;
  readonly "app.tax_category_definitions": TaxCategoryDefinitionTable;
  readonly "app.expenses": ExpenseTable;
  readonly "app.business_tax_profiles": BusinessTaxProfileTable;
  readonly "app.expense_tax_treatments": ExpenseTaxTreatmentTable;
  readonly "app.app_audit_events": AppAuditEventTable;
  readonly "app.idempotency_records": IdempotencyRecordTable;
  readonly "app.clerk_webhook_events": ClerkWebhookEventTable;
  readonly "app.plans": PlanTable;
  readonly "app.plan_versions": PlanVersionTable;
  readonly "app.feature_definitions": FeatureDefinitionTable;
  readonly "app.plan_entitlements": PlanEntitlementTable;
  readonly "app.tenant_subscriptions": TenantSubscriptionTable;
  readonly "app.tenant_addons": TenantAddonTable;
  readonly "app.tenant_feature_overrides": TenantFeatureOverrideTable;
  readonly "app.feature_usage_events": FeatureUsageEventTable;
  readonly "app.entitlement_snapshot_outbox": EntitlementSnapshotOutboxTable;
  readonly "app.processing_jobs": ProcessingJobTable;
  readonly "app.processing_job_dispatch_outbox": ProcessingJobDispatchOutboxTable;
  readonly "app.temporal_dispatch_routing": TemporalDispatchRoutingTable;
  readonly "app.expense_files": ExpenseFileTable;
  readonly "app.upload_sessions": UploadSessionTable;
  readonly "app.export_bundles": ExportBundleTable;
  readonly "app.verified_email_senders": VerifiedEmailSenderTable;
  readonly "app.inbound_routing_tokens": InboundRoutingTokenTable;
  readonly "app.inbound_emails": InboundEmailTable;
  readonly "app.inbound_email_attachments": InboundEmailAttachmentTable;
  readonly "app.inbound_email_quarantine_events": InboundEmailQuarantineEventTable;
  readonly "app.expense_sources": ExpenseSourceTable;
  readonly "app.expense_dedup_fingerprints": ExpenseDedupFingerprintTable;
  readonly "app.expense_duplicate_matches": ExpenseDuplicateMatchTable;
  readonly "app.tags": TagTable;
  readonly "app.expense_tags": ExpenseTagTable;
  readonly "app.expense_spending_category_decisions": ExpenseSpendingCategoryDecisionTable;
  readonly "app.expense_enrichment_suggestions": ExpenseEnrichmentSuggestionTable;
  readonly "app.enrichment_operation_keys": EnrichmentOperationKeyTable;
}
