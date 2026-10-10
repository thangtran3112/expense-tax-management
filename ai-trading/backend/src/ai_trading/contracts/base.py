"""Base class for the generated strategy-spec models (scripts/generate-contracts.sh).

Pydantic must reject exactly what the Zod schema in ai-trading/contracts rejects:
- strict mode: "20" is not 20;
- allow_inf_nan=False: JSON 1e400 parses to infinity, which Zod rejects;
- no nulls: Zod's .optional() allows a missing key, never null;
- no booleans: spec v1 has no boolean field, and Python's True == 1 would pass Literal[1].
  A v1 field that needs a boolean must change this rule (the parity test will fail first).
"""

from typing import Any

from pydantic import BaseModel, ConfigDict, model_validator


class SpecModel(BaseModel):
    model_config = ConfigDict(strict=True, allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def _reject_null_and_bool(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key, value in data.items():
                if value is None or isinstance(value, bool):
                    raise ValueError(f"{key} must not be null or a boolean")
        return data
