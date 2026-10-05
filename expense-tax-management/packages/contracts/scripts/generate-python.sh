#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
contracts_generated_root="${CONTRACTS_GENERATED_ROOT:-$repo_root/packages/contracts/generated}"
python_generated_root="${CONTRACTS_PYTHON_GENERATED_ROOT:-$repo_root/common/python/expense-contracts/src/expense_contracts/generated}"

mkdir -p "$python_generated_root"

# One (schema file, Pydantic class name, output module) triple per internal
# message. Kept as parallel arrays instead of a single associative array for
# bash 3.2 compatibility (macOS system bash).
schema_files=(
  "internal-messages.schema.json"
  "job-status-update-v1.schema.json"
  "job-result-submit-v1.schema.json"
  "ocr-extraction-result-v1.schema.json"
  "ocr-job-input-v1.schema.json"
  "expense-enrichment-input-v1.schema.json"
  "expense-enrichment-result-v1.schema.json"
)
class_names=(
  "JobReferenceV1"
  "JobStatusUpdateRequestV1"
  "JobResultSubmitRequestV1"
  "OcrExtractionResultV1"
  "OcrJobInputV1"
  "ExpenseEnrichmentInputV1"
  "ExpenseEnrichmentResultV1"
)
output_files=(
  "internal_messages.py"
  "job_status_update_v1.py"
  "job_result_submit_v1.py"
  "ocr_extraction_result_v1.py"
  "ocr_job_input_v1.py"
  "expense_enrichment_input_v1.py"
  "expense_enrichment_result_v1.py"
)

for i in "${!schema_files[@]}"; do
  uv run --project "$repo_root/common/python/expense-contracts" datamodel-codegen \
    --input "$contracts_generated_root/json-schema/${schema_files[$i]}" \
    --input-file-type jsonschema \
    --output "$python_generated_root/${output_files[$i]}" \
    --class-name "${class_names[$i]}" \
    --output-model-type pydantic_v2.BaseModel \
    --target-python-version 3.13 \
    --target-pydantic-version 2 \
    --disable-timestamp \
    --extra-fields forbid \
    --use-double-quotes \
    --use-standard-collections
done
