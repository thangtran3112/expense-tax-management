#!/bin/sh
# Regenerates the Pydantic models from ai-trading/contracts' JSON Schema.
# Usage: scripts/generate-contracts.sh [output-file]
set -eu
cd "$(dirname "$0")/.."
uv run datamodel-codegen \
  --input ../contracts/generated/strategy-spec-v1.schema.json \
  --input-file-type jsonschema \
  --output "${1:-src/ai_trading/contracts/strategy_spec_v1.py}" \
  --output-model-type pydantic_v2.BaseModel \
  --base-class ai_trading.contracts.base.SpecModel \
  --class-name StrategySpecV1 \
  --target-python-version 3.12 \
  --use-annotated \
  --field-constraints \
  --enum-field-as-literal all \
  --use-union-operator \
  --use-standard-collections \
  --collapse-root-models \
  --use-double-quotes \
  --disable-timestamp \
  --formatters builtin
