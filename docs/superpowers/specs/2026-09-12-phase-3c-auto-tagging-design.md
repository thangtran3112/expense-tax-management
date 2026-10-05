# Phase 3C Auto-Tagging and Categorization Design

**Date:** 2026-09-12  
**Status:** Approved; implementation not started; first remaining phase
**Depends on:** Phase 0C OCR, Phase 0J domain model, Phase 0K Foundry, Phase 0L Temporal worker, Phase 3B deduplication

## Objective

Enrich manual, OCR, and forwarded-email expenses with deterministic searchable
tags and reviewable historical category suggestions. Phase 3C does not make live
LLM calls. It preserves an extension point for a separately approved Foundry AI
phase without adding provider cost now.

## Product Decisions

- Deterministic rule tags may apply automatically.
- Historical and future AI outputs remain pending until a user accepts them.
- Manual user decisions always outrank automation.
- Spending-category suggestions never auto-apply.
- Business tax automation suggests only an active platform tax-category ID.
- Automation never chooses deductible percentage, filing treatment, or reviewed
  status.
- Tagging runs as a separate follow-up workflow after expense creation.
- A failed enrichment workflow never fails, archives, or rolls back an expense,
  OCR job, forwarded intake, or duplicate decision.

## Architecture

```text
Manual/OCR/forwarded expense transaction
  -> ready expense + enrichment job/outbox
  -> Temporal ExpenseEnrichmentWorkflow
  -> worker requests job-bound enrichment input from App API
  -> deterministic rule engine + tenant-history inference
  -> versioned worker result callback
  -> App API validates current scope/version/candidates
  -> auto-apply rule tags
  -> persist reviewable historical suggestions
  -> Office review/accept/reject
```

The separate workflow is required. Extending `OcrReceiptWorkflow` would exclude
manual expenses and would make optional enrichment failure contaminate successful
receipt processing. Running inference synchronously in App API requests would
increase latency and prevent durable retries.

App API remains sole owner and writer of customer data. Python receives only an
opaque job reference and job-bound minimized input through internal service APIs.
Python has no App or Foundry database credentials.

## Data Model

Add one migration after Phase 3B migration `015`.

### Tags

Add `app.tags`:

- `id` UUID primary key.
- `tenant_id` UUID with tenant cascade.
- `key` immutable normalized identifier, 1-100 characters.
- `name` user-facing label, 1-100 characters.
- `color` nullable validated display color.
- `origin`: `custom` or `rule`.
- `status`: `active` or `archived`.
- `version` positive integer.
- `created_by_user_id` nullable for system-created rule tags.
- `created_at`, `updated_at`.
- Unique `(tenant_id, key)` across active and archived rows. Reusing an archived
  key requires explicit unarchive; rule execution never silently reactivates it.

Rule keys are stable and namespaced:

```text
merchant:<slug>
timing:weekend
category:<template-key-or-normalized-category>
custom:<uuid>
```

Display names may change; immutable keys preserve deterministic matching and
idempotency.

### Applied expense tags

Add `app.expense_tags`:

- `id`, `tenant_id`, exactly one `personal_profile_id` or `business_id`.
- `expense_id`, `tag_id`.
- `source`: `manual`, `rule`, `historical`, or reserved `ai`.
- `confidence` numeric between 0 and 1.
- `rule_version` nullable positive integer.
- `suggestion_id` nullable.
- `status`: `active` or `removed`.
- `version` positive integer.
- `applied_by_user_id`, `removed_by_user_id`, `applied_at`, `removed_at`.
- Unique `(tenant_id, expense_id, tag_id)`.

Composite foreign keys and validation triggers require tag association, expense,
and exactly one Personal/business scope to agree. A removed row is retained so
unchanged rule evidence cannot immediately recreate a user-rejected tag. A later
rule version may propose it again only through a pending suggestion, never direct
auto-application.

One association row represents the current decision for an expense/tag pair.
Precedence is `manual` > accepted `historical` > `rule`. A manual apply or remove
updates row version/source/status and writes audit. Rules never change a manual
row. Accepted historical output may activate a rule row but never a removed/manual
row. Prior provenance remains in audit and terminal suggestion rows rather than
concurrent duplicate associations.

### Spending-category decisions

Add append-only `app.expense_spending_category_decisions`:

- `id`, tenant/scope/expense IDs.
- Nullable prior and new spending-category IDs.
- `source`: `manual`, `manual_baseline`, `historical`, or reserved `ai`.
- Actor user ID, expense version, suggestion ID, and timestamp.

Backfill every existing non-null expense category as `manual_baseline`. All later
category changes write a decision row in the same transaction. Historical
inference trains only from `manual`, `manual_baseline`, and user-accepted
`historical` decisions; it never infers provenance from the current expense row
alone.

### Enrichment suggestions

Add `app.expense_enrichment_suggestions`:

- `id`, `tenant_id`, exactly one `personal_profile_id` or `business_id`.
- `expense_id` and `expense_version` used during inference.
- `kind`: `tag`, `spending_category`, or `tax_category`.
- Exactly one candidate reference matching `kind`:
  - `tag_id`;
  - `spending_category_id`;
  - `tax_category_definition_id`.
- Tax suggestions additionally bind `tax_profile_id`, `taxonomy_version_id`, and
  `tax_year`; these columns are null for other kinds.
- `source`: `historical` or reserved `ai`.
- `confidence` numeric between 0 and 1.
- `evidence` bounded JSONB containing aggregate facts, never raw receipt text.
- `evidence_hash` SHA-256 of canonical evidence.
- `status`: `pending`, `accepted`, `rejected`, or `superseded`.
- `version` positive integer.
- `idempotency_key`, `resolved_by_user_id`, `resolved_at`, `created_at`.

Constraints enforce candidate-kind consistency, exact tenant/scope agreement,
terminal resolution state, and one active suggestion for the same
expense/kind/candidate/evidence hash. Accepted/rejected states are immutable.
Tax constraints require Business scope and a profile/category/taxonomy/year tuple
valid when inferred. Resolution revalidates the complete tuple.

## Deterministic Rules

Rules run for every eligible expense and use a single versioned registry.
Phase 3C initially includes:

1. Nonblank normalized merchant creates or reuses `merchant:<slug>` and applies
   that tag with confidence `1.0`.
2. Saturday/Sunday incurred date applies `timing:weekend` with confidence `1.0`.
3. An already selected spending category applies
   `category:<template-key-or-normalized-category>` with confidence `1.0`.

Do not add a fixed "large purchase" rule. Amount thresholds without currency
conversion are misleading. Payment-method tags remain absent until payment method
is part of the canonical expense contract.

Rules do not override removed tags, archived tag definitions, manual tags, manual
spending categories, or tax treatments.

## Historical Inference

App API computes a bounded history summary and returns it as job-bound input. The
worker never queries customer tables directly.

History is constrained to:

- Same tenant.
- Same Personal profile or same Business.
- Same normalized merchant.
- Ready, non-archived expenses only.
- At most the 50 most recent expenses from the prior 24 months.
- Manual or user-accepted outcomes only; rule and future AI-only outcomes do not
  train themselves.

A historical candidate is emitted only when:

- At least 3 qualifying examples exist.
- The leading candidate appears in at least 80% of qualifying examples.
- No tie exists at the leading count.

The algorithm may suggest:

- Active tags frequently attached manually or through accepted suggestions.
- One active spending category.
- For Business only, one tax-category definition from the current active taxonomy
  and applicable tax year/profile.

Training projections are explicit:

- Tags: active manual associations and accepted historical tag suggestions.
- Spending category: latest append-only decision from a human/manual baseline or
  accepted historical suggestion.
- Tax category: treatment must have `review_status = 'reviewed'`, match active
  profile/taxonomy/tax year, and have been saved by a user. `unreviewed` and
  `excluded` treatments do not train.
- Removed tags, rejected/superseded suggestions, archived categories, and archived
  expenses never train.

If the taxonomy version changed, historical tax categories from older versions
are not mapped automatically. No tax suggestion is produced until examples exist
under the active version.

## Contracts and Job Boundary

Add canonical Zod contracts and regenerate TypeScript/OpenAPI/Python artifacts:

- `ExpenseEnrichmentInputV1`: job ID, expense ID/version, normalized fields,
  rules version, eligible tag/category identifiers, bounded history aggregates.
- `ExpenseEnrichmentResultV1`: rule tag keys and review suggestions with source,
  confidence, evidence hash, and candidate ID.
- Tag CRUD/merge contracts.
- Suggestion list/resolve/re-run contracts.
- Expense list tag filter.

Expense filtering is server-side and cursor-paginated. Repeated `tagId` query
parameters use AND semantics: every returned expense contains every requested
active tag. Filters persist across cursor pages.

Temporal history stores only the opaque `JobReferenceV1`. Activities fetch input
just in time. No raw OCR text, receipt bytes, tenant-selected IDs, or tax details
are embedded in workflow history.

Add workflow type `ExpenseEnrichmentWorkflow` and result schema
`expense-enrichment-v1`. Job creation binds tenant, exact scope, expense ID, and
expected expense version server-side.

Add `createEnrichmentJobInTransaction(transaction, expenseBinding)` beside generic
processing-job creation. Call it from both current transaction boundaries:

- Manual expense insertion through `insertExpenseInTransaction`.
- OCR/forwarded materialization through `applyOcrExtraction`.

The helper creates processing job version 1 and dispatch outbox atomically with
the expense. Dispatcher moves it to `DISPATCHED` version 2 and stores workflow ID.
Worker marks `RUNNING` and receives returned version before reading input.
Successful result application marks `SUCCEEDED`; exhausted inference failure marks
only the enrichment job `FAILED`. Target expense remains ready.

## Processing Flow

1. Manual expense creation or successful OCR result creates the ready expense.
2. In the same App transaction, create an enrichment processing job and dispatch
   outbox bound to expense ID/version and exact scope.
3. Dispatcher starts `ExpenseEnrichmentWorkflow` with the opaque job reference.
4. Worker marks job running with expected dispatched version 2, then requests
   enrichment input from App API. App API revalidates job state,
   expense state/version, scope, membership-independent service authorization,
   candidate activity, and bounded history.
5. Worker evaluates deterministic rules and historical thresholds.
6. Worker submits `ExpenseEnrichmentResultV1` with expected job version and a
   deterministic per-job result idempotency key.
7. App API validates every returned key/candidate against job-bound eligible data.
8. App API transactionally applies rule tags, persists pending suggestions, marks
   job successful, and writes audit/provenance records.
9. Office users accept/reject suggestions through scope-authorized APIs.

If expense version changed before result application, App API marks the job result
stale, creates no tags/suggestions, and allows explicit re-run. Enrichment never
overwrites the newer expense.

Internal input/result routes require exact configured worker M2M subject and
route-specific scopes. App API accepts only job ID, expected job version,
versioned result, and idempotency key. It verifies workflow type, allowed result
schema, stored workflow ID, target expense, tenant, scope, and expected aggregate
version from the job row. Worker cannot submit tenant/profile/business or target
expense selectors. App API recomputes deterministic rule output before automatic
application; worker assertions are not authority.

Worker identity may process any enrichment job assigned to its queue by design,
but cannot redirect a job to another customer resource. Workflow run ID binding
is deferred until dispatcher persists Temporal run IDs consistently for all
existing workflows; Phase 3C does not invent weaker one-off semantics.

## Suggestion Resolution

Only pending suggestions resolve. Every request includes expected suggestion
version, expected expense version, and idempotency key.

- Tag accept: activate/create the expense-tag association with source
  `historical`; supersede competing pending tag suggestions only for the same tag.
- Spending-category accept: versioned expense update; supersede other pending
  spending-category suggestions.
- Tax-category accept: require the human request to supply the applicable tax
  profile and deductible percentage. Use existing tax-treatment validation and
  save as `unreviewed`. Automation supplies only the candidate category.
- Reject: mark terminal `rejected`; retain evidence to prevent unchanged history
  from immediately recreating it.

Manual expense/category/treatment edits supersede stale pending suggestions. A
manual tag removal creates/retains a removed association instead of hard-deleting
the decision.

Suggestion and applied-tag replay protection does not rely on generic 24-hour
HTTP idempotency retention. Store a permanent canonical operation key scoped by
tenant/expense/job/kind/candidate/evidence hash. Identical replay returns original
result; same key with different normalized payload returns conflict. Terminal job
and result state plus database uniqueness remain authoritative after HTTP
idempotency rows expire.

Tax-category acceptance fails stale if profile, taxonomy version, tax year,
category activity, expense version, or Business scope changed after inference.

## App API Surface

Tenant tag configuration:

- `GET /api/v1/tenants/:tenantId/tags`
- `POST /api/v1/tenants/:tenantId/tags`
- `PATCH /api/v1/tenants/:tenantId/tags/:tagId`
- `POST /api/v1/tenants/:tenantId/tags/:tagId/merge`

Scope-owned expense enrichment:

- `GET .../expenses/:expenseId/tags`
- `PUT .../expenses/:expenseId/tags/:tagId`
- `DELETE .../expenses/:expenseId/tags/:tagId`
- `GET .../expenses/:expenseId/enrichment-suggestions`
- `POST .../enrichment-suggestions/:suggestionId/resolve`
- `POST .../expenses/:expenseId/enrichment-runs`

The `...` prefix is the existing explicit Personal-profile or Business route. No
tenant-only expense suggestion route exists.

Tag definition reads require tenant membership. Tag mutation/merge requires
owner/admin. Expense associations and suggestions require exact Personal/business
membership with existing read/editor rules.

## Office Web

- Extend current Business-only Office session shape to a discriminated
  Personal-or-Business scope using existing membership endpoints. Every customer
  request carries selected explicit scope.
- Expense list renders active tag chips and supports multi-tag filtering.
- Expense list uses server cursor pagination with filters preserved across pages.
- Expense detail/review surface shows applied tags and pending suggestions.
- Suggestions display candidate, confidence, aggregate evidence, and source
  `History`; future `AI` remains visually distinct.
- Tax-category acceptance requires human deductible-percentage input and displays
  `unreviewed` status.
- Settings includes tag create, rename, archive/unarchive, and merge.
- Loading, empty, stale-version, unauthorized, retry, success, and conflict states
  are explicit and accessible.

Tag merge transaction:

1. Lock source and target tags in sorted UUID order.
2. Reject cross-tenant, archived-target, self-merge, and stale versions.
3. Move source associations to target. On conflict, preserve stronger decision:
   manual, then accepted historical, then rule. Explicit removed/manual decision
   beats automatic active state.
4. Supersede pending suggestions targeting source. Terminal suggestions retain
   original source reference for audit.
5. Archive source, increment target version, and write one audit event with moved
   association/suggestion counts.

Capture Web may display applied tags after refresh, but management and suggestion
review remain Office-only. Foundry receives no customer tags, categories, receipt
content, or tax details.

## Failure and Retry Behavior

- Rules are pure and deterministic for a fixed rules version.
- Worker HTTP activities use bounded retries; nonretryable 4xx results fail fast.
- Enrichment job failure is visible but does not change expense `ready` status.
- Stale expense version produces typed stale outcome, not a retry loop.
- Expense archived before dispatch/input/result produces terminal skipped/stale
  enrichment job and no associations.
- Re-running an expense creates a new job; prior terminal suggestions remain
  audit history and equivalent pending suggestions remain idempotent.
- Tag merge locks source/target and affected associations in deterministic order.
- No user request waits for Temporal completion.

## Deferred AI Extension

No Foundry catalog operation, provider route, quota, prompt, or paid model call is
created in this phase. Reserved `ai` source values prevent a later migration of
provenance semantics, but they are never emitted by Phase 3C.

A future AI extension requires separate approval covering:

- Foundry operation and aggregate quota.
- Provider/model route and cost estimate.
- Prompt/input minimization.
- Offline precision/recall evaluation.
- Confidence threshold and review-only rollout.
- Receipt-content privacy and retention.

## Verification

- Rule outputs are identical for repeated input and rules version.
- Rule tags auto-apply; historical candidates remain pending.
- Same merchant in a different Personal profile/Business produces no history.
- Fewer than 3 examples or less than 80% agreement produces no suggestion.
- Archived expenses, automated-only outcomes, and old taxonomies do not train.
- Manual expense creation and OCR/forwarded materialization atomically create one
  enrichment job/outbox each.
- Manual/accepted decisions outrank rule/history and are not overwritten.
- Removed/rejected evidence is not recreated unchanged.
- Stale expense versions apply nothing and return typed conflict/stale outcomes.
- Worker cannot choose tenant, scope, expense, or ineligible candidate IDs.
- Tax automation never writes deductible percentage or reviewed status.
- Tax acceptance fails after profile/taxonomy/tax-year/category invalidation.
- Spending-category archival or expense/category version changes supersede
  pending suggestions.
- Retry after generic HTTP idempotency expiry remains deduplicated by permanent
  operation uniqueness.
- Archived tag key collision requires explicit unarchive and never creates a
  second tag.
- Cross-scope internal callbacks cannot redirect job-bound target.
- Enrichment failure leaves expense/OCR/dedup state unchanged.
- Tag merge preserves associations, decisions, versions, and audit records.
- Generated contract artifacts are clean.
- App API, worker, Office, PostgreSQL integration, and zero-skip regression suites
  pass.

## Non-Goals

- No live LLM, embedding, or paid provider call.
- No direct Python database access.
- No automatic spending-category or tax-treatment mutation.
- No deductible-percentage suggestion.
- No taxonomy-version remapping.
- No currency-conversion or fixed cross-currency amount tags.
- No changes to transitional `expense-service` or `frontend/web`.
