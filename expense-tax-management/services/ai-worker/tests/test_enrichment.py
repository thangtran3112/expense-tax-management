"""Tests for the pure enrichment evaluator (Task 5).

All tests are pure: no network, no DB, no Temporal imports.
"""

import hashlib
import importlib.util
import json
from datetime import date
from uuid import UUID, uuid4

import pytest
from expense_contracts.generated import (
    ExpenseEnrichmentInputV1,
    ExpenseEnrichmentResultV1,
)
from expense_contracts.generated.expense_enrichment_input_v1 import (
    CandidateSpendingCategoryId,
    CandidateTagKey,
    CandidateTaxCategoryId,
    EligibleSpendingCategoryId,
    EligibleTagKey,
    EligibleTaxSnapshot,
    History,
)

from ai_worker.constants import (
    ENRICHMENT_RULE_KEYS,
    ENRICHMENT_RULES_VERSION,
    EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION,
    EXPENSE_ENRICHMENT_WORKFLOW_TYPE,
)
from ai_worker.enrichment import evaluate

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

JOB_ID = UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
EXPENSE_ID = UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
CAT_ID_1 = UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
TAX_PROFILE_ID = UUID("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
TAXONOMY_VERSION_ID = UUID("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
TAX_CAT_ID = UUID("ffffffff-ffff-4fff-8fff-ffffffffffff")

SATURDAY = date(2026, 9, 19)  # Saturday
SUNDAY = date(2026, 9, 20)  # Sunday
MONDAY = date(2026, 9, 21)  # Monday (weekday)
WEDNESDAY = date(2026, 9, 16)  # Wednesday


def eligible_tag(key: str) -> EligibleTagKey:
    return EligibleTagKey(key)


def eligible_cat(id: UUID) -> EligibleSpendingCategoryId:
    return EligibleSpendingCategoryId(id)


def empty_history() -> History:
    return History(
        exampleCount=0,
        candidateTagKeys=[],
        candidateSpendingCategoryIds=[],
        candidateTaxCategoryIds=[],
    )


def build_tax_snapshot(
    tax_cat_ids: list[UUID] | None = None,
) -> EligibleTaxSnapshot:
    from expense_contracts.generated.expense_enrichment_input_v1 import (
        ActiveTaxCategoryId,
    )

    return EligibleTaxSnapshot(
        businessTaxProfileId=TAX_PROFILE_ID,
        businessTaxProfileVersion=1,
        taxonomyVersionId=TAXONOMY_VERSION_ID,
        taxYear=2026,
        activeTaxCategoryIds=[
            ActiveTaxCategoryId(id) for id in (tax_cat_ids or [TAX_CAT_ID])
        ],
    )


def base_input(
    *,
    normalized_merchant: str | None = None,
    incurred_on: date = WEDNESDAY,
    spending_category_id: UUID | None = None,
    eligible_tag_keys: list[str] | None = None,
    eligible_spending_category_ids: list[UUID] | None = None,
    eligible_tax_snapshot: EligibleTaxSnapshot | None = None,
    history: History | None = None,
) -> ExpenseEnrichmentInputV1:
    return ExpenseEnrichmentInputV1(
        schemaVersion=1,
        jobId=JOB_ID,
        expenseId=EXPENSE_ID,
        expenseVersion=1,
        rulesVersion=1,
        normalizedMerchant=normalized_merchant,
        incurredOn=incurred_on,
        spendingCategoryId=spending_category_id,
        eligibleTagKeys=[eligible_tag(k) for k in (eligible_tag_keys or [])],
        eligibleSpendingCategoryIds=[
            eligible_cat(id) for id in (eligible_spending_category_ids or [])
        ],
        eligibleTaxSnapshot=eligible_tax_snapshot,
        history=history or empty_history(),
    )


def sha256_evidence(
    kind: str, candidate: str, example_count: int, match_count: int
) -> str:
    payload = json.dumps(
        {
            "kind": kind,
            "candidate": candidate,
            "exampleCount": example_count,
            "matchCount": match_count,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Constants parity (mirrors TS side)
# ---------------------------------------------------------------------------


def test_constants_workflow_type_matches_typescript():
    assert EXPENSE_ENRICHMENT_WORKFLOW_TYPE == "ExpenseEnrichmentWorkflow"


def test_constants_result_schema_version_matches_typescript():
    assert EXPENSE_ENRICHMENT_RESULT_SCHEMA_VERSION == "expense-enrichment-v1"


def test_constants_rules_version_is_1():
    assert ENRICHMENT_RULES_VERSION == 1


def test_constants_rule_keys_exact():
    assert set(ENRICHMENT_RULE_KEYS) == {"merchant", "weekend", "selected_category"}


def test_constants_rule_keys_count():
    # Exactly 3, no duplicates
    assert len(ENRICHMENT_RULE_KEYS) == 3


# ---------------------------------------------------------------------------
# Outcome is always "applied"
# ---------------------------------------------------------------------------


def test_evaluate_returns_applied_outcome():
    result = evaluate(base_input())
    assert result.outcome.value == "applied"


def test_evaluate_returns_schema_version_1():
    result = evaluate(base_input())
    assert result.schemaVersion == 1


def test_evaluate_returns_rules_version_1():
    result = evaluate(base_input())
    assert result.rulesVersion == 1


# ---------------------------------------------------------------------------
# Rule: merchant tag
# ---------------------------------------------------------------------------


def test_merchant_rule_emits_tag_when_merchant_eligible():
    inp = base_input(
        normalized_merchant="starbucks",
        eligible_tag_keys=["merchant:starbucks", "timing:weekend"],
    )
    result = evaluate(inp)
    assert "merchant:starbucks" in [r.root for r in result.ruleTagKeys]


def test_merchant_rule_not_emitted_when_key_not_eligible():
    inp = base_input(
        normalized_merchant="starbucks",
        eligible_tag_keys=["timing:weekend"],  # no merchant:starbucks
    )
    result = evaluate(inp)
    assert not any(r.root.startswith("merchant:") for r in result.ruleTagKeys)


def test_merchant_rule_not_emitted_when_merchant_is_none():
    inp = base_input(
        normalized_merchant=None,
        eligible_tag_keys=["merchant:starbucks"],
    )
    result = evaluate(inp)
    assert not any(r.root.startswith("merchant:") for r in result.ruleTagKeys)


def test_merchant_rule_uses_normalized_merchant_verbatim():
    inp = base_input(
        normalized_merchant="whole-foods-market",
        eligible_tag_keys=["merchant:whole-foods-market"],
    )
    result = evaluate(inp)
    assert "merchant:whole-foods-market" in [r.root for r in result.ruleTagKeys]


def test_merchant_rule_no_spurious_tag_different_merchant():
    # eligible list contains a different merchant key
    inp = base_input(
        normalized_merchant="amazon",
        eligible_tag_keys=["merchant:target"],
    )
    result = evaluate(inp)
    assert not any(r.root.startswith("merchant:") for r in result.ruleTagKeys)


# ---------------------------------------------------------------------------
# Rule: weekend tag
# ---------------------------------------------------------------------------


def test_weekend_rule_emits_tag_on_saturday():
    inp = base_input(
        incurred_on=SATURDAY,
        eligible_tag_keys=["timing:weekend"],
    )
    result = evaluate(inp)
    assert "timing:weekend" in [r.root for r in result.ruleTagKeys]


def test_weekend_rule_emits_tag_on_sunday():
    inp = base_input(
        incurred_on=SUNDAY,
        eligible_tag_keys=["timing:weekend"],
    )
    result = evaluate(inp)
    assert "timing:weekend" in [r.root for r in result.ruleTagKeys]


def test_weekend_rule_not_emitted_on_monday():
    inp = base_input(
        incurred_on=MONDAY,
        eligible_tag_keys=["timing:weekend"],
    )
    result = evaluate(inp)
    assert "timing:weekend" not in [r.root for r in result.ruleTagKeys]


def test_weekend_rule_not_emitted_on_wednesday():
    inp = base_input(
        incurred_on=WEDNESDAY,
        eligible_tag_keys=["timing:weekend"],
    )
    result = evaluate(inp)
    assert "timing:weekend" not in [r.root for r in result.ruleTagKeys]


def test_weekend_rule_not_emitted_when_not_eligible():
    inp = base_input(
        incurred_on=SATURDAY,
        eligible_tag_keys=[],  # timing:weekend not in eligible
    )
    result = evaluate(inp)
    assert "timing:weekend" not in [r.root for r in result.ruleTagKeys]


# ---------------------------------------------------------------------------
# Rule: selected_category tag
# ---------------------------------------------------------------------------


def test_selected_category_emits_tag_when_category_set_and_eligible():
    tag_key = f"category:{CAT_ID_1}"
    inp = base_input(
        spending_category_id=CAT_ID_1,
        eligible_tag_keys=[tag_key],
    )
    result = evaluate(inp)
    assert tag_key in [r.root for r in result.ruleTagKeys]


def test_selected_category_not_emitted_when_spending_category_id_is_none():
    inp = base_input(
        spending_category_id=None,
        eligible_tag_keys=["category:some-id"],
    )
    result = evaluate(inp)
    assert not any(r.root.startswith("category:") for r in result.ruleTagKeys)


def test_selected_category_not_emitted_when_key_not_eligible():
    tag_key = f"category:{CAT_ID_1}"
    inp = base_input(
        spending_category_id=CAT_ID_1,
        eligible_tag_keys=["timing:weekend"],  # no category: key
    )
    result = evaluate(inp)
    assert tag_key not in [r.root for r in result.ruleTagKeys]


def test_selected_category_uses_stable_uuid_key():
    # Key format must be category:<spendingCategoryId> (lowercase UUID str)
    tag_key = f"category:{CAT_ID_1}"
    inp = base_input(
        spending_category_id=CAT_ID_1,
        eligible_tag_keys=[tag_key],
    )
    result = evaluate(inp)
    keys = [r.root for r in result.ruleTagKeys]
    assert tag_key in keys
    # Must not emit alternate formats
    assert not any(k.startswith("category:") and k != tag_key for k in keys)


# ---------------------------------------------------------------------------
# Rule tags: uniqueness and no extras
# ---------------------------------------------------------------------------


def test_rule_tag_keys_are_unique():
    # Both merchant and weekend apply; must not duplicate
    inp = base_input(
        normalized_merchant="starbucks",
        incurred_on=SATURDAY,
        eligible_tag_keys=["merchant:starbucks", "timing:weekend"],
    )
    result = evaluate(inp)
    keys = [r.root for r in result.ruleTagKeys]
    assert len(keys) == len(set(keys))


def test_no_rule_tags_when_nothing_matches():
    inp = base_input()
    result = evaluate(inp)
    assert result.ruleTagKeys == []


def test_result_is_valid_pydantic_model():
    inp = base_input(
        normalized_merchant="starbucks",
        incurred_on=SATURDAY,
        eligible_tag_keys=["merchant:starbucks", "timing:weekend"],
    )
    result = evaluate(inp)
    # Re-parse through top-level model; validates schema constraints
    raw = result.model_dump(mode="json")
    reparsed = ExpenseEnrichmentResultV1.model_validate(raw)
    assert reparsed == result


# ---------------------------------------------------------------------------
# History: tag suggestions
# ---------------------------------------------------------------------------


def _history_with_tag(key: str, match_count: int, example_count: int) -> History:
    return History(
        exampleCount=example_count,
        candidateTagKeys=[CandidateTagKey(key=key, count=match_count)],
        candidateSpendingCategoryIds=[],
        candidateTaxCategoryIds=[],
    )


def test_tag_suggestion_emitted_when_3_examples_80pct_no_tie():
    # 4/4 = 100% >= 80%, no tie, eligible
    inp = base_input(
        eligible_tag_keys=["food:coffee"],
        history=_history_with_tag("food:coffee", match_count=4, example_count=4),
    )
    result = evaluate(inp)
    tag_suggs = [s for s in result.suggestions if s.kind == "tag"]
    assert len(tag_suggs) == 1
    assert tag_suggs[0].tagKey == "food:coffee"
    assert tag_suggs[0].source == "historical"
    assert tag_suggs[0].confidence == pytest.approx(4 / 4)
    assert tag_suggs[0].aggregateCounts.exampleCount == 4
    assert tag_suggs[0].aggregateCounts.matchCount == 4


def test_tag_suggestion_emitted_at_exactly_3_examples_80pct():
    # 3 examples, 3/3 = 100% >= 80%
    inp = base_input(
        eligible_tag_keys=["food:coffee"],
        history=_history_with_tag("food:coffee", match_count=3, example_count=3),
    )
    result = evaluate(inp)
    tag_suggs = [s for s in result.suggestions if s.kind == "tag"]
    assert len(tag_suggs) == 1


def test_tag_suggestion_not_emitted_when_fewer_than_3_examples():
    # Only 2 examples
    inp = base_input(
        eligible_tag_keys=["food:coffee"],
        history=_history_with_tag("food:coffee", match_count=2, example_count=2),
    )
    result = evaluate(inp)
    tag_suggs = [s for s in result.suggestions if s.kind == "tag"]
    assert len(tag_suggs) == 0


def test_tag_suggestion_not_emitted_when_below_80pct():
    # 3 examples, 2/3 = 66.7% < 80%
    inp = base_input(
        eligible_tag_keys=["food:coffee"],
        history=_history_with_tag("food:coffee", match_count=2, example_count=3),
    )
    result = evaluate(inp)
    tag_suggs = [s for s in result.suggestions if s.kind == "tag"]
    assert len(tag_suggs) == 0


def test_tag_suggestion_not_emitted_when_key_not_eligible():
    # 5/5 = 100% but key not in eligible
    inp = base_input(
        eligible_tag_keys=[],  # nothing eligible
        history=_history_with_tag("food:coffee", match_count=5, example_count=5),
    )
    result = evaluate(inp)
    tag_suggs = [s for s in result.suggestions if s.kind == "tag"]
    assert len(tag_suggs) == 0


def test_tag_suggestion_evidence_hash_is_canonical_sha256():
    # Verify hash matches sha256(kind|candidate|exampleCount|matchCount)
    inp = base_input(
        eligible_tag_keys=["food:coffee"],
        history=_history_with_tag("food:coffee", match_count=5, example_count=5),
    )
    result = evaluate(inp)
    tag_suggs = [s for s in result.suggestions if s.kind == "tag"]
    assert len(tag_suggs) == 1
    expected_hash = sha256_evidence("tag", "food:coffee", 5, 5)
    assert tag_suggs[0].evidenceHash == expected_hash


def test_tag_suggestion_tie_not_emitted_when_two_candidates_equal_count():
    # Both keys have same count — tie, so no suggestion for either
    history = History(
        exampleCount=4,
        candidateTagKeys=[
            CandidateTagKey(key="food:coffee", count=4),
            CandidateTagKey(key="food:snack", count=4),
        ],
        candidateSpendingCategoryIds=[],
        candidateTaxCategoryIds=[],
    )
    inp = base_input(
        eligible_tag_keys=["food:coffee", "food:snack"],
        history=history,
    )
    result = evaluate(inp)
    tag_suggs = [s for s in result.suggestions if s.kind == "tag"]
    assert len(tag_suggs) == 0


def test_tag_suggestion_emitted_when_no_tie_leading_candidate():
    # food:coffee (5) is clear leader over food:snack (2) — emit only leader
    history = History(
        exampleCount=5,
        candidateTagKeys=[
            CandidateTagKey(key="food:coffee", count=5),
            CandidateTagKey(key="food:snack", count=2),
        ],
        candidateSpendingCategoryIds=[],
        candidateTaxCategoryIds=[],
    )
    inp = base_input(
        eligible_tag_keys=["food:coffee", "food:snack"],
        history=history,
    )
    result = evaluate(inp)
    tag_suggs = [s for s in result.suggestions if s.kind == "tag"]
    # Only the leader (food:coffee) is emitted
    assert len(tag_suggs) == 1
    assert tag_suggs[0].tagKey == "food:coffee"


# ---------------------------------------------------------------------------
# History: spending category suggestions
# ---------------------------------------------------------------------------


def _history_with_cat(cat_id: UUID, match_count: int, example_count: int) -> History:
    return History(
        exampleCount=example_count,
        candidateTagKeys=[],
        candidateSpendingCategoryIds=[
            CandidateSpendingCategoryId(id=cat_id, count=match_count)
        ],
        candidateTaxCategoryIds=[],
    )


def test_spending_category_suggestion_emitted_when_3_examples_80pct():
    inp = base_input(
        eligible_spending_category_ids=[CAT_ID_1],
        history=_history_with_cat(CAT_ID_1, match_count=4, example_count=4),
    )
    result = evaluate(inp)
    cat_suggs = [s for s in result.suggestions if s.kind == "spending_category"]
    assert len(cat_suggs) == 1
    assert cat_suggs[0].spendingCategoryId == CAT_ID_1
    assert cat_suggs[0].source == "historical"
    assert cat_suggs[0].confidence == pytest.approx(4 / 4)


def test_spending_category_suggestion_not_emitted_when_not_eligible():
    inp = base_input(
        eligible_spending_category_ids=[],  # CAT_ID_1 not eligible
        history=_history_with_cat(CAT_ID_1, match_count=5, example_count=5),
    )
    result = evaluate(inp)
    cat_suggs = [s for s in result.suggestions if s.kind == "spending_category"]
    assert len(cat_suggs) == 0


def test_spending_category_suggestion_not_emitted_fewer_than_3():
    inp = base_input(
        eligible_spending_category_ids=[CAT_ID_1],
        history=_history_with_cat(CAT_ID_1, match_count=2, example_count=2),
    )
    result = evaluate(inp)
    cat_suggs = [s for s in result.suggestions if s.kind == "spending_category"]
    assert len(cat_suggs) == 0


def test_spending_category_suggestion_tie_suppressed():
    cat2 = uuid4()
    history = History(
        exampleCount=4,
        candidateTagKeys=[],
        candidateSpendingCategoryIds=[
            CandidateSpendingCategoryId(id=CAT_ID_1, count=4),
            CandidateSpendingCategoryId(id=cat2, count=4),
        ],
        candidateTaxCategoryIds=[],
    )
    inp = base_input(
        eligible_spending_category_ids=[CAT_ID_1, cat2],
        history=history,
    )
    result = evaluate(inp)
    cat_suggs = [s for s in result.suggestions if s.kind == "spending_category"]
    assert len(cat_suggs) == 0


def test_spending_category_evidence_hash_canonical():
    inp = base_input(
        eligible_spending_category_ids=[CAT_ID_1],
        history=_history_with_cat(CAT_ID_1, match_count=5, example_count=5),
    )
    result = evaluate(inp)
    cat_suggs = [s for s in result.suggestions if s.kind == "spending_category"]
    assert len(cat_suggs) == 1
    expected = sha256_evidence("spending_category", str(CAT_ID_1), 5, 5)
    assert cat_suggs[0].evidenceHash == expected


# ---------------------------------------------------------------------------
# History: tax category suggestions
# ---------------------------------------------------------------------------


def _history_with_tax(
    tax_cat_id: UUID, match_count: int, example_count: int
) -> History:
    return History(
        exampleCount=example_count,
        candidateTagKeys=[],
        candidateSpendingCategoryIds=[],
        candidateTaxCategoryIds=[
            CandidateTaxCategoryId(id=tax_cat_id, count=match_count)
        ],
    )


def test_tax_suggestion_emitted_for_business_with_3_examples_80pct():
    snapshot = build_tax_snapshot(tax_cat_ids=[TAX_CAT_ID])
    inp = base_input(
        eligible_tax_snapshot=snapshot,
        history=_history_with_tax(TAX_CAT_ID, match_count=4, example_count=4),
    )
    result = evaluate(inp)
    tax_suggs = [s for s in result.suggestions if s.kind == "tax_category"]
    assert len(tax_suggs) == 1
    assert tax_suggs[0].taxCategoryDefinitionId == TAX_CAT_ID
    assert tax_suggs[0].source == "historical"
    assert tax_suggs[0].confidence == pytest.approx(4 / 4)
    # Carries full snapshot
    assert tax_suggs[0].businessTaxProfileId == TAX_PROFILE_ID
    assert tax_suggs[0].businessTaxProfileVersion == 1
    assert tax_suggs[0].taxonomyVersionId == TAXONOMY_VERSION_ID
    assert tax_suggs[0].taxYear == 2026
    # Carries input expenseVersion
    assert tax_suggs[0].expenseVersion == 1


def test_no_tax_suggestion_for_personal_expense():
    # Personal: eligibleTaxSnapshot=None — must emit no tax suggestion
    inp = base_input(
        eligible_tax_snapshot=None,
        history=_history_with_tax(TAX_CAT_ID, match_count=5, example_count=5),
    )
    result = evaluate(inp)
    tax_suggs = [s for s in result.suggestions if s.kind == "tax_category"]
    assert len(tax_suggs) == 0


def test_tax_suggestion_not_emitted_when_tax_cat_not_in_snapshot():
    other_tax_cat = uuid4()
    # snapshot only contains TAX_CAT_ID; history candidate is other_tax_cat
    snapshot = build_tax_snapshot(tax_cat_ids=[TAX_CAT_ID])
    inp = base_input(
        eligible_tax_snapshot=snapshot,
        history=_history_with_tax(other_tax_cat, match_count=5, example_count=5),
    )
    result = evaluate(inp)
    tax_suggs = [s for s in result.suggestions if s.kind == "tax_category"]
    assert len(tax_suggs) == 0


def test_tax_suggestion_not_emitted_below_80pct():
    snapshot = build_tax_snapshot(tax_cat_ids=[TAX_CAT_ID])
    inp = base_input(
        eligible_tax_snapshot=snapshot,
        history=_history_with_tax(TAX_CAT_ID, match_count=2, example_count=3),
    )
    result = evaluate(inp)
    tax_suggs = [s for s in result.suggestions if s.kind == "tax_category"]
    assert len(tax_suggs) == 0


def test_tax_suggestion_tie_suppressed():
    other_tax_cat = uuid4()
    snapshot = build_tax_snapshot(tax_cat_ids=[TAX_CAT_ID, other_tax_cat])
    history = History(
        exampleCount=4,
        candidateTagKeys=[],
        candidateSpendingCategoryIds=[],
        candidateTaxCategoryIds=[
            CandidateTaxCategoryId(id=TAX_CAT_ID, count=4),
            CandidateTaxCategoryId(id=other_tax_cat, count=4),
        ],
    )
    inp = base_input(
        eligible_tax_snapshot=snapshot,
        history=history,
    )
    result = evaluate(inp)
    tax_suggs = [s for s in result.suggestions if s.kind == "tax_category"]
    assert len(tax_suggs) == 0


def test_tax_evidence_hash_canonical():
    snapshot = build_tax_snapshot(tax_cat_ids=[TAX_CAT_ID])
    inp = base_input(
        eligible_tax_snapshot=snapshot,
        history=_history_with_tax(TAX_CAT_ID, match_count=5, example_count=5),
    )
    result = evaluate(inp)
    tax_suggs = [s for s in result.suggestions if s.kind == "tax_category"]
    assert len(tax_suggs) == 1
    expected = sha256_evidence("tax_category", str(TAX_CAT_ID), 5, 5)
    assert tax_suggs[0].evidenceHash == expected


# ---------------------------------------------------------------------------
# Suggestions uniqueness
# ---------------------------------------------------------------------------


def test_suggestions_are_unique_by_kind_and_candidate():
    # Full suite: 1 tag + 1 cat + 1 tax suggestion — all unique
    snapshot = build_tax_snapshot(tax_cat_ids=[TAX_CAT_ID])
    history = History(
        exampleCount=5,
        candidateTagKeys=[CandidateTagKey(key="food:coffee", count=5)],
        candidateSpendingCategoryIds=[
            CandidateSpendingCategoryId(id=CAT_ID_1, count=5)
        ],
        candidateTaxCategoryIds=[CandidateTaxCategoryId(id=TAX_CAT_ID, count=5)],
    )
    inp = base_input(
        eligible_tag_keys=["food:coffee"],
        eligible_spending_category_ids=[CAT_ID_1],
        eligible_tax_snapshot=snapshot,
        history=history,
    )
    result = evaluate(inp)
    assert len(result.suggestions) == 3
    kinds = [s.kind for s in result.suggestions]
    assert sorted(kinds) == ["spending_category", "tag", "tax_category"]


def test_result_passes_full_pydantic_validation_with_all_suggestion_kinds():
    # F6: strengthen — assert three suggestions survive round-trip, not just outcome.
    snapshot = build_tax_snapshot(tax_cat_ids=[TAX_CAT_ID])
    history = History(
        exampleCount=5,
        candidateTagKeys=[CandidateTagKey(key="food:coffee", count=5)],
        candidateSpendingCategoryIds=[
            CandidateSpendingCategoryId(id=CAT_ID_1, count=5)
        ],
        candidateTaxCategoryIds=[CandidateTaxCategoryId(id=TAX_CAT_ID, count=5)],
    )
    inp = base_input(
        normalized_merchant=None,
        incurred_on=SATURDAY,
        eligible_tag_keys=["food:coffee", "timing:weekend"],
        eligible_spending_category_ids=[CAT_ID_1],
        eligible_tax_snapshot=snapshot,
        history=history,
    )
    result = evaluate(inp)
    # Full round-trip through generated model
    raw = result.model_dump(mode="json")
    reparsed = ExpenseEnrichmentResultV1.model_validate(raw)
    assert reparsed.outcome.value == "applied"
    # F6: three suggestions (tag + spending_category + tax_category) all survive
    assert len(reparsed.suggestions) == 3
    reparsed_kinds = sorted(s.kind for s in reparsed.suggestions)
    assert reparsed_kinds == ["spending_category", "tag", "tax_category"]


# ---------------------------------------------------------------------------
# F2: hardcoded exact category-key (no f-string/UUID formatter in test)
# ---------------------------------------------------------------------------


def test_selected_category_key_is_exact_hardcoded_string():
    # CAT_ID_1 = UUID("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
    # Key must be exactly this literal — not a dynamic derivation.
    EXPECTED_KEY = "category:cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    inp = base_input(
        spending_category_id=CAT_ID_1,
        eligible_tag_keys=[EXPECTED_KEY],
    )
    result = evaluate(inp)
    keys = [r.root for r in result.ruleTagKeys]
    assert EXPECTED_KEY in keys
    # No other category: key emitted
    assert sum(1 for k in keys if k.startswith("category:")) == 1


# ---------------------------------------------------------------------------
# F3: eligibility-before-leading — ineligible leader, eligible follower at 80%
# ---------------------------------------------------------------------------


def test_tag_ineligible_leader_eligible_follower_at_80pct_emits_follower():
    # Leader "food:snack" count=5 is NOT eligible.
    # Follower "food:coffee" count=4, exampleCount=5 → 4/5=80%, eligible → emits.
    history = History(
        exampleCount=5,
        candidateTagKeys=[
            CandidateTagKey(key="food:snack", count=5),  # ineligible
            CandidateTagKey(key="food:coffee", count=4),  # eligible, 80%
        ],
        candidateSpendingCategoryIds=[],
        candidateTaxCategoryIds=[],
    )
    inp = base_input(
        eligible_tag_keys=["food:coffee"],  # food:snack excluded
        history=history,
    )
    result = evaluate(inp)
    tag_suggs = [s for s in result.suggestions if s.kind == "tag"]
    assert len(tag_suggs) == 1
    assert tag_suggs[0].tagKey == "food:coffee"
    assert tag_suggs[0].confidence == pytest.approx(4 / 5)


# ---------------------------------------------------------------------------
# F5: exampleCount=0 with non-empty candidate — no suggestion, no division error
# ---------------------------------------------------------------------------


def test_tag_no_suggestion_and_no_division_error_when_example_count_zero():
    # exampleCount=0 but a candidate is present — must return nothing, not divide by zero.
    history = History(
        exampleCount=0,
        candidateTagKeys=[CandidateTagKey(key="food:coffee", count=1)],
        candidateSpendingCategoryIds=[],
        candidateTaxCategoryIds=[],
    )
    inp = base_input(
        eligible_tag_keys=["food:coffee"],
        history=history,
    )
    result = evaluate(inp)
    assert result.suggestions == []


def test_spending_category_no_suggestion_when_example_count_zero_with_candidate():
    history = History(
        exampleCount=0,
        candidateTagKeys=[],
        candidateSpendingCategoryIds=[
            CandidateSpendingCategoryId(id=CAT_ID_1, count=1)
        ],
        candidateTaxCategoryIds=[],
    )
    inp = base_input(
        eligible_spending_category_ids=[CAT_ID_1],
        history=history,
    )
    result = evaluate(inp)
    assert result.suggestions == []


def test_tax_no_suggestion_when_example_count_zero_with_candidate():
    snapshot = build_tax_snapshot(tax_cat_ids=[TAX_CAT_ID])
    history = History(
        exampleCount=0,
        candidateTagKeys=[],
        candidateSpendingCategoryIds=[],
        candidateTaxCategoryIds=[CandidateTaxCategoryId(id=TAX_CAT_ID, count=1)],
    )
    inp = base_input(
        eligible_tax_snapshot=snapshot,
        history=history,
    )
    result = evaluate(inp)
    assert result.suggestions == []


# ---------------------------------------------------------------------------
# Purity: no forbidden imports in enrichment module
# ---------------------------------------------------------------------------


def test_enrichment_module_is_pure():
    spec = importlib.util.find_spec("ai_worker.enrichment")
    assert spec is not None

    src_file = spec.origin
    assert src_file is not None
    with open(src_file) as f:
        src = f.read()

    # F4: asyncio added to forbidden list
    forbidden = ["httpx", "temporalio", "sqlalchemy", "foundry", "asyncpg", "asyncio"]
    for lib in forbidden:
        assert lib not in src, f"Forbidden import found: {lib}"


# ---------------------------------------------------------------------------
# F1/NI1: no import from expense_enrichment_result_v1 in production source
# ---------------------------------------------------------------------------

# The forbidden import pattern — exact module path that can only appear as a
# Python import statement, never in docstring prose (which only names the
# top-level class or short variant names, not the full submodule path).
_RESULT_SUBMODULE_IMPORT = (
    "from expense_contracts.generated.expense_enrichment_result_v1 import"
)


def test_forbidden_import_pattern_catches_violation_on_synthetic_source():
    # TDD proof: confirm the assertion would catch a violating source string.
    # This test must pass unconditionally — it exercises only the pattern itself.
    synthetic_bad = "from expense_contracts.generated.expense_enrichment_result_v1 import Suggestions\n"
    assert _RESULT_SUBMODULE_IMPORT in synthetic_bad, (
        "Pattern must catch direct submodule import"
    )


def test_forbidden_import_pattern_does_not_false_positive_on_prose():
    # Docstrings and comments that mention the class name or variant names
    # must not trigger — they never contain the full submodule path.
    prose_samples = [
        "# ExpenseEnrichmentResultV1.model_validate()\n",
        '"""Suggestions/Suggestions1/Suggestions2 are generator-internal."""\n',
        "# see expense_contracts.generated for top-level exports\n",
        "ExpenseEnrichmentResultV1  # referenced by short name\n",
    ]
    for sample in prose_samples:
        assert _RESULT_SUBMODULE_IMPORT not in sample, (
            f"Pattern must not match prose: {sample!r}"
        )


def test_enrichment_module_does_not_import_from_result_submodule():
    # Stronger than checking construction sites: rejects any import from the
    # result submodule, covering Suggestions*/AggregateCounts/RuleTagKey/Outcome.
    # Production must import result types only via the top-level generated package.
    spec = importlib.util.find_spec("ai_worker.enrichment")
    assert spec is not None
    src_file = spec.origin
    assert src_file is not None
    with open(src_file) as f:
        src = f.read()

    assert _RESULT_SUBMODULE_IMPORT not in src, (
        "enrichment.py must not import directly from "
        "expense_enrichment_result_v1 submodule; "
        "use top-level ExpenseEnrichmentResultV1.model_validate() instead"
    )
