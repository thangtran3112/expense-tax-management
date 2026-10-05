"""Enrichment workflow activities.

Privacy boundary: NO ExpenseEnrichmentInputV1 or ExpenseEnrichmentResultV1
ever appear in activity signatures or return types. These models live entirely
inside enrichment_process's implementation; they never cross the
Temporal serialization (workflow history) boundary.

Activity names registered:
  - enrichment_mark_running  (separate from OCR's mark_running to avoid collision)
  - enrichment_process       (GET input + evaluate/bypass + POST result -- all in one)
  - enrichment_mark_failed   (terminal failure callback)

Exception sanitization contract:
  Every exception raised from these activities must have a FIXED message string
  -- no job IDs, URLs, response bodies, raw outcome strings, Pydantic input
  values, or any customer fact. Both `__cause__` and `__context__` must be None
  on every raised ApplicationError. `from None` alone is insufficient: it sets
  `__suppress_context__=True` (controls display only) but `__context__` still
  references the active exception Python captured at the raise site. To guarantee
  `__context__ is None`, sanitized errors are BUILT inside the except block and
  RAISED after the except scope exits -- at that point no exception is active
  and Python cannot set `__context__`. Callers identify the failure category
  via `ApplicationError.type`, not the message text.

Retry behaviour for enrichment_process:
  Both the GET (enrichment-input) and POST (enrichment-result) calls live
  inside the same activity execution. If the POST fails with a transient error,
  Temporal re-executes the entire activity from the top on the next attempt,
  including a fresh GET. Both operations are designed to be idempotent:
  - GET always returns the server's current state for the job.
  - POST carries a fixed idempotency key ({jobId}:enrichment:result:v1), so a
    replayed successful POST is treated as a no-op by the App API and returns
    the already-committed version. This means retries are safe even when the
    GET re-fetches data that has not changed.
"""

from __future__ import annotations

import httpx
from expense_contracts.generated import (
    ExpenseEnrichmentInputV1,
    JobStatusUpdateRequestV1,
)
from temporalio import activity
from temporalio.exceptions import ApplicationError

from ai_worker.app_api_client import (
    AppApiClient,
    EnrichmentInputClient,
    EnrichmentResultClient,
)
from ai_worker.enrichment import evaluate

# Fixed sanitized messages -- no runtime values ever interpolated.
_MSG_INPUT_GET_4XX = "enrichment input unavailable: permanent client error"
_MSG_INPUT_GET_TRANSPORT = "enrichment input unavailable: transient transport error"
_MSG_INPUT_MALFORMED = "enrichment input rejected: response failed schema validation"
_MSG_OUTCOME_UNEXPECTED = "enrichment input rejected: unrecognized outcome"
_MSG_EVALUATOR = "enrichment evaluation failed: internal evaluator error"
_MSG_RESULT_POST_4XX = "enrichment result rejected: permanent client error"
_MSG_RESULT_POST_TRANSPORT = "enrichment result failed: transient transport error"


class EnrichmentActivities:
    """Enrichment pipeline activities.

    Three clients with separate M2M scopes:
    - ocr_status_client  (jobs:write + files:read) -- for mark_running / mark_failed
    - input_client       (jobs:enrichment-input)   -- GET enrichment-input only
    - result_client      (jobs:enrichment-result)  -- POST enrichment-result only
    """

    def __init__(
        self,
        ocr_status_client: AppApiClient,
        input_client: EnrichmentInputClient,
        result_client: EnrichmentResultClient,
    ) -> None:
        self._ocr_status_client = ocr_status_client
        self._input_client = input_client
        self._result_client = result_client

    @activity.defn(name="enrichment_mark_running")
    async def enrichment_mark_running(
        self, job_id: str, dispatched_version: int
    ) -> int:
        """POST status=RUNNING for the enrichment job.

        Accepts dispatched_version as an explicit primitive arg so the
        hardcoded constant never hides inside the activity body; this
        keeps the workflow history self-describing (the arg appears in
        Temporal's event log) and makes future version changes safe.

        Uses the existing jobs:write client. Returns the new version so the
        workflow can chain expectedJobVersion into the process activity.
        """
        return await self._ocr_status_client.update_status(
            job_id,
            JobStatusUpdateRequestV1(
                schemaVersion=1,
                status="RUNNING",
                idempotencyKey=f"{job_id}:enrichment:status:running",
                expectedJobVersion=dispatched_version,
            ),
        )

    @activity.defn(name="enrichment_process")
    async def enrichment_process(self, job_id: str, running_version: int) -> str:
        """GET enrichment input, evaluate or bypass, POST result.

        ALL customer facts (ExpenseEnrichmentInputV1, ExpenseEnrichmentResultV1)
        are confined to this function body. The activity signature carries only
        primitive types (str, int) so Temporal never serialises the enrichment
        models to workflow history.

        Returns the outcome string ("applied", "stale", or "skipped") as an
        opaque token for the workflow.

        Retry behaviour: if the POST fails transiently, Temporal re-runs the
        full activity body (GET + evaluate + POST). The GET is idempotent
        (read-only), and the POST carries a fixed idempotency key so a
        replayed successful POST is a safe no-op. See module docstring.

        Exception contract: all raised ApplicationError instances carry FIXED
        messages -- no customer data, URLs, or response bodies. To ensure both
        `__cause__` and `__context__` are None, sanitized errors are built
        inside the except block but raised *after* the except scope exits, so
        Python never captures the original exception as `__context__`.
        `from None` alone is insufficient: it sets `__suppress_context__=True`
        for display purposes but `__context__` still references the original
        exception (Python always captures it on `raise inside except`).
        """
        # --- GET enrichment input -------------------------------------------
        _input_err: ApplicationError | None = None
        try:
            raw = await self._input_client.get_enrichment_input(job_id)
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if 400 <= status < 500 and status not in {408, 429}:
                _input_err = ApplicationError(
                    _MSG_INPUT_GET_4XX,
                    type="EnrichmentInputNonRetryable",
                    non_retryable=True,
                )
            else:
                _input_err = ApplicationError(
                    _MSG_INPUT_GET_TRANSPORT,
                    type="EnrichmentInputTransient",
                    non_retryable=False,
                )
        except httpx.HTTPError:
            _input_err = ApplicationError(
                _MSG_INPUT_GET_TRANSPORT,
                type="EnrichmentInputTransient",
                non_retryable=False,
            )
        if _input_err is not None:
            raise _input_err

        # --- Validate outcome and build result payload ----------------------
        outcome = raw.get("outcome")

        if outcome in {"stale", "skipped"}:
            # Bypass evaluator: construct empty successful result directly.
            result_payload = {
                "schemaVersion": 1,
                "rulesVersion": 1,
                "outcome": outcome,
                "ruleTagKeys": [],
                "suggestions": [],
            }
        elif outcome == "evaluate":
            # Parse the input through the generated model (stays here, never
            # serialised). Build sanitized error inside except, raise outside.
            _parse_err: ApplicationError | None = None
            try:
                inp = ExpenseEnrichmentInputV1.model_validate(raw.get("input") or {})
            except Exception:  # noqa: BLE001 -- covers ValidationError + any unexpected parse failure
                _parse_err = ApplicationError(
                    _MSG_INPUT_MALFORMED,
                    type="EnrichmentInputMalformed",
                    non_retryable=True,
                )
            if _parse_err is not None:
                raise _parse_err

            _eval_err: ApplicationError | None = None
            try:
                enrichment_result = evaluate(inp)
            except Exception:  # noqa: BLE001
                _eval_err = ApplicationError(
                    _MSG_EVALUATOR,
                    type="EnrichmentEvaluatorError",
                    non_retryable=True,
                )
            if _eval_err is not None:
                raise _eval_err

            result_payload = enrichment_result.model_dump(mode="json")
        else:
            # Unknown outcome -- fixed message, outcome value never interpolated.
            # Not inside an except block so no __context__ to suppress.
            raise ApplicationError(
                _MSG_OUTCOME_UNEXPECTED,
                type="EnrichmentInputUnexpectedOutcome",
                non_retryable=True,
            )

        # --- POST enrichment result -----------------------------------------
        idempotency_key = f"{job_id}:enrichment:result:v1"
        _result_err: ApplicationError | None = None
        try:
            await self._result_client.submit_enrichment_result(
                job_id=job_id,
                expected_job_version=running_version,
                idempotency_key=idempotency_key,
                result=result_payload,
            )
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if 400 <= status < 500 and status not in {408, 429}:
                _result_err = ApplicationError(
                    _MSG_RESULT_POST_4XX,
                    type="EnrichmentResultNonRetryable",
                    non_retryable=True,
                )
            else:
                _result_err = ApplicationError(
                    _MSG_RESULT_POST_TRANSPORT,
                    type="EnrichmentResultTransient",
                    non_retryable=False,
                )
        except httpx.HTTPError:
            _result_err = ApplicationError(
                _MSG_RESULT_POST_TRANSPORT,
                type="EnrichmentResultTransient",
                non_retryable=False,
            )
        if _result_err is not None:
            raise _result_err

        return str(outcome)

    @activity.defn(name="enrichment_mark_failed")
    async def enrichment_mark_failed(self, job_id: str, running_version: int) -> int:
        """POST status=FAILED for the enrichment job.

        Terminal best-effort callback. Uses the jobs:write client.
        Returns the new version (for symmetry with mark_running), but the
        workflow ignores it after a FAILED transition.
        """
        return await self._ocr_status_client.update_status(
            job_id,
            JobStatusUpdateRequestV1(
                schemaVersion=1,
                status="FAILED",
                idempotencyKey=f"{job_id}:enrichment:status:failed",
                expectedJobVersion=running_version,
                message="ENRICHMENT_FAILED: inference or transport error",
            ),
        )
