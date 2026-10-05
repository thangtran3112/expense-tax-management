"""Legacy Python worker identifiers retained during the TypeScript cutover.

Workflow names and schema versions remain aligned with packages/contracts.
The task queue intentionally stays on the legacy queue so Python and
TypeScript workers never poll the same queue during migration.
"""

TASK_QUEUE = "expense-tax-ai-worker"
FOUNDATION_ECHO_WORKFLOW_TYPE = "FoundationEchoWorkflow"
OCR_RECEIPT_WORKFLOW_TYPE = "OcrReceiptWorkflow"
FORWARDED_RECEIPT_WORKFLOW_TYPE = "ForwardedReceiptWorkflow"
OCR_EXTRACTION_RESULT_SCHEMA_VERSION = "ocr-extraction-v1"

# Enrichment workflow constants mirror exact TS literals in task-queues.ts.
EXPENSE_ENRICHMENT_WORKFLOW_TYPE = "ExpenseEnrichmentWorkflow"
EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION = "expense-enrichment-v1"

# Evaluator constants — mirror TS ENRICHMENT_RULES_VERSION / ENRICHMENT_RULE_KEYS.
ENRICHMENT_RULES_VERSION: int = 1
ENRICHMENT_RULE_KEYS: tuple[str, ...] = ("merchant", "weekend", "selected_category")

# Dispatcher version: dispatchPendingJobs always bumps the job from version 1
# (createJob) to version 2 before the workflow starts. Defined here so
# workflows, activities, and tests can all import without circular deps.
DISPATCHED_JOB_VERSION: int = 2
