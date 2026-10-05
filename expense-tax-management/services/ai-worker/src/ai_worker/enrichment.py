"""Pure deterministic enrichment evaluator.

No network, database, Temporal, or Foundry imports. Given a validated
ExpenseEnrichmentInputV1 it returns a fully-formed ExpenseEnrichmentResultV1
with outcome=applied, rule-derived tag keys, and history-inferred suggestions.

Historical inference rules (per cross-task spec):
- At least 3 examples (exampleCount >= 3).
- Leading candidate ratio: count / exampleCount >= 0.80.
- No tie at the leading count (second-highest count < leading count).
- Candidate must be eligible (present in the corresponding eligible set).
- Emits source="historical", confidence=matchCount/exampleCount.
- Evidence hash: SHA-256 over {"kind","candidate","exampleCount","matchCount"}
  JSON (keys sorted, no spaces, ASCII).
- Personal expenses (eligibleTaxSnapshot=None) produce no tax suggestion.
- Tax suggestion carries the full snapshot + input expenseVersion.

Implementation note: the generated numbered classes Suggestions/Suggestions1/
Suggestions2 are internal generator artifacts. This module builds plain
strict dicts and validates once through the top-level
ExpenseEnrichmentResultV1.model_validate() so the generator naming stays
entirely internal and never leaks into production call sites.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from expense_contracts.generated import (
    ExpenseEnrichmentInputV1,
    ExpenseEnrichmentResultV1,
)
from expense_contracts.generated.expense_enrichment_input_v1 import (
    EligibleTaxSnapshot,
    History,
)

from ai_worker.constants import ENRICHMENT_RULES_VERSION

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_WEEKEND_ISOWEEKDAYS = frozenset({6, 7})  # Saturday=6, Sunday=7


# ---------------------------------------------------------------------------
# Evidence hash
# ---------------------------------------------------------------------------


def _evidence_hash(
    kind: str, candidate: str, example_count: int, match_count: int
) -> str:
    """Canonical SHA-256 over the aggregate evidence tuple."""
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
# Rule engine
# ---------------------------------------------------------------------------


def _deterministic_rule_tags(inp: ExpenseEnrichmentInputV1) -> list[str]:
    """Return eligible rule-derived tag keys for this expense."""
    eligible = {e.root for e in inp.eligibleTagKeys}
    tags: list[str] = []

    # Rule: merchant
    if inp.normalizedMerchant is not None:
        candidate = f"merchant:{inp.normalizedMerchant}"
        if candidate in eligible:
            tags.append(candidate)

    # Rule: weekend
    if (
        inp.incurredOn.isoweekday() in _WEEKEND_ISOWEEKDAYS
        and "timing:weekend" in eligible
    ):
        tags.append("timing:weekend")

    # Rule: selected_category
    if inp.spendingCategoryId is not None:
        candidate = f"category:{inp.spendingCategoryId}"
        if candidate in eligible:
            tags.append(candidate)

    return tags


# ---------------------------------------------------------------------------
# Historical inference helpers
# ---------------------------------------------------------------------------


def _leading_candidate[T](
    candidates: list[tuple[T, int]],
    example_count: int,
) -> tuple[T, int] | None:
    """
    Return (candidate, count) if:
    - example_count >= 3
    - leading count / example_count >= 0.80
    - no tie at the leading count (second count strictly less)
    Otherwise return None.
    """
    if example_count < 3:
        return None
    if not candidates:
        return None

    sorted_cands = sorted(candidates, key=lambda x: x[1], reverse=True)
    top_val, top_count = sorted_cands[0]

    # Ratio threshold
    if top_count / example_count < 0.80:
        return None

    # Tie check: second-highest must be strictly less
    if len(sorted_cands) > 1 and sorted_cands[1][1] == top_count:
        return None

    return top_val, top_count


def _aggregate_counts(example_count: int, match_count: int) -> dict[str, Any]:
    return {"exampleCount": example_count, "matchCount": match_count}


def _infer_tags(
    history: History, eligible_tag_keys: frozenset[str]
) -> list[dict[str, Any]]:
    # Filter by eligibility before passing to _leading_candidate.
    candidates = [
        (ck.key, ck.count)
        for ck in history.candidateTagKeys
        if ck.key in eligible_tag_keys
    ]
    result = _leading_candidate(candidates, history.exampleCount)
    if result is None:
        return []
    tag_key, match_count = result
    return [
        {
            "kind": "tag",
            "source": "historical",
            "tagKey": tag_key,
            "confidence": match_count / history.exampleCount,
            "aggregateCounts": _aggregate_counts(history.exampleCount, match_count),
            "evidenceHash": _evidence_hash(
                "tag", tag_key, history.exampleCount, match_count
            ),
        }
    ]


def _infer_spending_categories(
    history: History, eligible_cat_ids: frozenset[str]
) -> list[dict[str, Any]]:
    candidates = [
        (str(cc.id), cc.count)
        for cc in history.candidateSpendingCategoryIds
        if str(cc.id) in eligible_cat_ids
    ]
    result = _leading_candidate(candidates, history.exampleCount)
    if result is None:
        return []
    cat_id_str, match_count = result
    return [
        {
            "kind": "spending_category",
            "source": "historical",
            "spendingCategoryId": cat_id_str,
            "confidence": match_count / history.exampleCount,
            "aggregateCounts": _aggregate_counts(history.exampleCount, match_count),
            "evidenceHash": _evidence_hash(
                "spending_category", cat_id_str, history.exampleCount, match_count
            ),
        }
    ]


def _infer_tax_categories(
    history: History,
    eligible_tax_snapshot: EligibleTaxSnapshot,
    expense_version: int,
) -> list[dict[str, Any]]:
    active_tax_cat_ids = frozenset(
        str(tc.root) for tc in eligible_tax_snapshot.activeTaxCategoryIds
    )
    candidates = [
        (str(tc.id), tc.count)
        for tc in history.candidateTaxCategoryIds
        if str(tc.id) in active_tax_cat_ids
    ]
    result = _leading_candidate(candidates, history.exampleCount)
    if result is None:
        return []
    tax_cat_id_str, match_count = result
    return [
        {
            "kind": "tax_category",
            "source": "historical",
            "taxCategoryDefinitionId": tax_cat_id_str,
            "businessTaxProfileId": str(eligible_tax_snapshot.businessTaxProfileId),
            "businessTaxProfileVersion": eligible_tax_snapshot.businessTaxProfileVersion,
            "taxonomyVersionId": str(eligible_tax_snapshot.taxonomyVersionId),
            "taxYear": eligible_tax_snapshot.taxYear,
            "expenseVersion": expense_version,
            "confidence": match_count / history.exampleCount,
            "aggregateCounts": _aggregate_counts(history.exampleCount, match_count),
            "evidenceHash": _evidence_hash(
                "tax_category", tax_cat_id_str, history.exampleCount, match_count
            ),
        }
    ]


def _infer_history(
    history: History,
    eligible_tag_keys: frozenset[str],
    eligible_spending_category_ids: frozenset[str],
    eligible_tax_snapshot: EligibleTaxSnapshot | None,
    expense_version: int,
) -> list[dict[str, Any]]:
    suggestions: list[dict[str, Any]] = []
    suggestions.extend(_infer_tags(history, eligible_tag_keys))
    suggestions.extend(
        _infer_spending_categories(history, eligible_spending_category_ids)
    )
    if eligible_tax_snapshot is not None:
        suggestions.extend(
            _infer_tax_categories(history, eligible_tax_snapshot, expense_version)
        )
    return suggestions


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def evaluate(inp: ExpenseEnrichmentInputV1) -> ExpenseEnrichmentResultV1:
    """Evaluate enrichment rules and history for a single expense.

    Pure function: no I/O, no randomness, no side effects.
    Always returns outcome=applied; stale/skipped are upstream branches.

    Suggestions are built as plain strict dicts and validated once through
    ExpenseEnrichmentResultV1.model_validate(); the generated numbered variant
    classes (Suggestions/Suggestions1/Suggestions2) remain internal.
    """
    tag_strs = _deterministic_rule_tags(inp)

    eligible_tag_keys = frozenset(e.root for e in inp.eligibleTagKeys)
    eligible_cat_ids = frozenset(str(e.root) for e in inp.eligibleSpendingCategoryIds)

    suggestion_dicts = _infer_history(
        history=inp.history,
        eligible_tag_keys=eligible_tag_keys,
        eligible_spending_category_ids=eligible_cat_ids,
        eligible_tax_snapshot=inp.eligibleTaxSnapshot,
        expense_version=inp.expenseVersion,
    )

    return ExpenseEnrichmentResultV1.model_validate(
        {
            "schemaVersion": 1,
            "rulesVersion": ENRICHMENT_RULES_VERSION,
            "outcome": "applied",
            "ruleTagKeys": tag_strs,
            "suggestions": suggestion_dicts,
        }
    )
