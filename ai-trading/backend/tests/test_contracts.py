import subprocess
import tempfile
from pathlib import Path

import pytest
from pydantic import ValidationError

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1

BACKEND = Path(__file__).resolve().parents[1]
CONTRACTS = BACKEND.parent / "contracts"
FIXTURES = CONTRACTS / "fixtures" / "strategy-spec-v1"


def _files(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.json"))


VALID = _files(FIXTURES / "valid") + _files(CONTRACTS / "templates")
INVALID = _files(FIXTURES / "invalid")


def test_fixture_folders_are_not_empty():
    assert len(_files(FIXTURES / "valid")) >= 3 and len(INVALID) >= 20


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_accepts_what_zod_accepts(path: Path):
    StrategySpecV1.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_rejects_what_zod_rejects(path: Path):
    with pytest.raises(ValidationError):
        StrategySpecV1.model_validate_json(path.read_text())


def test_round_trip_keeps_the_stored_shape():
    raw = (FIXTURES / "valid" / "all-paper-order-and-limit-fields.json").read_text()
    spec = StrategySpecV1.model_validate_json(raw)
    again = StrategySpecV1.model_validate(spec.model_dump(by_alias=True, exclude_none=True))
    assert again == spec


def test_generated_models_are_current():
    """Fails when the JSON Schema changed without scripts/generate-contracts.sh."""
    # Generate inside the backend: the formatter reads its line length from pyproject.toml.
    with tempfile.TemporaryDirectory(dir=BACKEND) as directory:
        output = Path(directory) / "strategy_spec_v1.py"
        subprocess.run([str(BACKEND / "scripts" / "generate-contracts.sh"), str(output)], check=True)
        checked_in = BACKEND / "src" / "ai_trading" / "contracts" / "strategy_spec_v1.py"
        assert output.read_text() == checked_in.read_text()
