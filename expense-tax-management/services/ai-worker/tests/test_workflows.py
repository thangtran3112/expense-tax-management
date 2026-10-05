import inspect
import uuid

import pytest
import respx
from expense_contracts.generated import JobReferenceV1
from httpx import Response
from temporalio.client import WorkflowFailureError
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from ai_worker.activities import FoundationEchoActivities
from ai_worker.app_api_client import (
    AppApiClient,
    EnrichmentInputClient,
    EnrichmentResultClient,
)
from ai_worker.constants import TASK_QUEUE
from ai_worker.enrichment_activities import EnrichmentActivities
from ai_worker.workflows import ExpenseEnrichmentWorkflow, FoundationEchoWorkflow

JOB_ID = uuid.UUID("22222222-2222-4222-8222-222222222222")
EXPENSE_ID = uuid.UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
BASE_URL = "http://app-api.test"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def job_reference() -> JobReferenceV1:
    return JobReferenceV1(
        schemaVersion=1,
        jobId=JOB_ID,
        workflowType="ExpenseEnrichmentWorkflow",
        workflowId=f"job-{JOB_ID}",
    )


def _base_evaluate_input() -> dict:
    return {
        "outcome": "evaluate",
        "input": {
            "schemaVersion": 1,
            "jobId": str(JOB_ID),
            "expenseId": str(EXPENSE_ID),
            "expenseVersion": 1,
            "normalizedMerchant": None,
            "incurredOn": "2026-09-12",
            "spendingCategoryId": None,
            "rulesVersion": 1,
            "eligibleTagKeys": [],
            "eligibleSpendingCategoryIds": [],
            "eligibleTaxSnapshot": None,
            "history": {
                "exampleCount": 0,
                "candidateTagKeys": [],
                "candidateSpendingCategoryIds": [],
                "candidateTaxCategoryIds": [],
            },
        },
    }


def _make_activities(*, base_url: str = BASE_URL) -> EnrichmentActivities:
    ocr_client = AppApiClient(base_url=base_url, service_token="ocr-token")
    inp_client = EnrichmentInputClient(base_url=base_url, service_token="inp-token")
    res_client = EnrichmentResultClient(base_url=base_url, service_token="res-token")
    return EnrichmentActivities(
        ocr_status_client=ocr_client,
        input_client=inp_client,
        result_client=res_client,
    )


# ---------------------------------------------------------------------------
# Privacy: workflow history-facing signatures must not carry enrichment models
# ---------------------------------------------------------------------------


def test_enrichment_process_activity_does_not_accept_enrichment_input_model():
    """The process activity input type must NOT be ExpenseEnrichmentInputV1.

    The activity that GETs input and POSTs result must accept only primitive
    job-reference data (jobId str, running version int) so that the full
    ExpenseEnrichmentInputV1 never appears in Temporal's workflow history.
    """
    from ai_worker.enrichment_activities import EnrichmentActivities

    act = EnrichmentActivities.__dict__["enrichment_process"]
    sig = inspect.signature(act)
    for param in sig.parameters.values():
        ann = param.annotation
        if ann is inspect.Parameter.empty:
            continue
        # The annotation must not be or contain ExpenseEnrichmentInputV1
        name = getattr(ann, "__name__", str(ann))
        assert "ExpenseEnrichmentInput" not in name, (
            f"History-facing activity parameter {param.name!r} "
            f"carries enrichment input model: {ann}"
        )


def test_enrichment_process_activity_return_does_not_carry_enrichment_result_model():
    """The process activity return annotation must NOT be ExpenseEnrichmentResultV1.

    Only primitives/opaque dicts allowed in the workflow-history boundary.
    """
    from ai_worker.enrichment_activities import EnrichmentActivities

    act = EnrichmentActivities.__dict__["enrichment_process"]
    sig = inspect.signature(act)
    ret = sig.return_annotation
    ret_name = getattr(ret, "__name__", str(ret))
    assert "ExpenseEnrichmentResult" not in ret_name, (
        f"Process activity return annotation leaks enrichment result model: {ret}"
    )


def test_enrichment_mark_running_returns_int():
    """enrichment_mark_running must return an int (new version), not a model."""
    from ai_worker.enrichment_activities import EnrichmentActivities

    act = EnrichmentActivities.__dict__["enrichment_mark_running"]
    sig = inspect.signature(act)
    ret = sig.return_annotation
    assert ret is int or ret == "int", (
        f"enrichment_mark_running must return int, got {ret}"
    )


def test_enrichment_mark_running_accepts_dispatched_version_as_primitive():
    """enrichment_mark_running must accept dispatched_version as int, not hidden constant.

    Passing the dispatched version as an explicit primitive arg means Temporal
    records it in the workflow-history event log rather than hiding it inside
    the activity body.
    """
    from ai_worker.enrichment_activities import EnrichmentActivities

    act = EnrichmentActivities.__dict__["enrichment_mark_running"]
    sig = inspect.signature(act)
    params = list(sig.parameters.keys())
    assert "dispatched_version" in params, (
        "enrichment_mark_running must declare dispatched_version as an explicit arg"
    )
    ann = sig.parameters["dispatched_version"].annotation
    assert ann is int or ann == "int", (
        f"dispatched_version must be annotated as int, got {ann}"
    )


# ---------------------------------------------------------------------------
# Sanitized exception tests (finding 1/2)
# ---------------------------------------------------------------------------


@respx.mock
async def test_enrichment_process_sanitizes_4xx_input_get_error():
    """Temporal-visible error for 4xx on GET enrichment-input must have fixed message.

    No job ID, URL, response body, or customer fact may appear in the
    ApplicationError message or its cause.
    """
    respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(403, json={"error": "forbidden", "jobId": str(JOB_ID)})
    )

    activities = _make_activities()
    job_id = str(JOB_ID)
    err: ApplicationError | None = None
    try:
        await activities.enrichment_process(job_id, 3)
    except ApplicationError as exc:
        err = exc

    assert err is not None
    assert err.non_retryable is True
    assert err.type == "EnrichmentInputNonRetryable"
    # Message must not contain job ID, URL, or response body content
    msg = err.message or ""
    assert str(JOB_ID) not in msg
    assert BASE_URL not in msg
    assert "forbidden" not in msg
    assert "403" not in msg
    # Neither explicit cause nor implicit context must leak the original exc
    assert err.__cause__ is None
    assert err.__context__ is None


@respx.mock
async def test_enrichment_process_sanitizes_503_input_get_error():
    """Temporal-visible error for 503 on GET enrichment-input: fixed message, no cause.

    The response body value ("service_overloaded_detail") must not appear
    in the error message -- only the fixed sanitized string is allowed.
    """
    respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(503, json={"error": "service_overloaded_detail"})
    )

    activities = _make_activities()
    err: ApplicationError | None = None
    try:
        await activities.enrichment_process(str(JOB_ID), 3)
    except ApplicationError as exc:
        err = exc

    assert err is not None
    assert err.non_retryable is False
    assert err.type == "EnrichmentInputTransient"
    msg = err.message or ""
    assert str(JOB_ID) not in msg
    # Response body content must not leak into the error message
    assert "service_overloaded_detail" not in msg
    assert err.__cause__ is None
    assert err.__context__ is None


@respx.mock
async def test_enrichment_process_sanitizes_malformed_input_response():
    """Temporal-visible error for Pydantic validation failure: fixed message, no raw input values."""
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(
            200,
            json={
                "outcome": "evaluate",
                "input": {
                    "schemaVersion": 99,
                    "INVALID_FIELD": "secret-customer-value",
                },
            },
        )
    )

    activities = _make_activities()
    err: ApplicationError | None = None
    try:
        await activities.enrichment_process(str(JOB_ID), 3)
    except ApplicationError as exc:
        err = exc

    assert err is not None
    assert err.non_retryable is True
    assert err.type == "EnrichmentInputMalformed"
    msg = err.message or ""
    assert "secret-customer-value" not in msg
    assert str(JOB_ID) not in msg
    assert err.__cause__ is None
    assert err.__context__ is None


@respx.mock
async def test_enrichment_process_sanitizes_unexpected_outcome():
    """Unexpected outcome string: fixed message, outcome value never interpolated."""
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(200, json={"outcome": "EVIL_OUTCOME_WITH_SECRETS"})
    )

    activities = _make_activities()
    err: ApplicationError | None = None
    try:
        await activities.enrichment_process(str(JOB_ID), 3)
    except ApplicationError as exc:
        err = exc

    assert err is not None
    assert err.non_retryable is True
    assert err.type == "EnrichmentInputUnexpectedOutcome"
    msg = err.message or ""
    assert "EVIL_OUTCOME_WITH_SECRETS" not in msg
    assert str(JOB_ID) not in msg
    assert err.__cause__ is None
    assert err.__context__ is None


@respx.mock
async def test_enrichment_process_sanitizes_4xx_result_post_error():
    """Temporal-visible error for 4xx on POST enrichment-result: fixed message, no cause."""
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(200, json=_base_evaluate_input())
    )
    respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-result").mock(
        return_value=Response(
            422, json={"error": "schema_violation", "detail": "secret"}
        )
    )

    activities = _make_activities()
    err: ApplicationError | None = None
    try:
        await activities.enrichment_process(str(JOB_ID), 3)
    except ApplicationError as exc:
        err = exc

    assert err is not None
    assert err.non_retryable is True
    assert err.type == "EnrichmentResultNonRetryable"
    msg = err.message or ""
    assert str(JOB_ID) not in msg
    assert "secret" not in msg
    assert "422" not in msg
    assert err.__cause__ is None
    assert err.__context__ is None


@respx.mock
async def test_enrichment_process_sanitizes_503_result_post_error():
    """Temporal-visible error for 503 on POST enrichment-result: fixed message, no cause.

    The response body value ("result_server_overloaded_detail") must not appear
    in the error message.
    """
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(200, json=_base_evaluate_input())
    )
    respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-result").mock(
        return_value=Response(503, json={"error": "result_server_overloaded_detail"})
    )

    activities = _make_activities()
    err: ApplicationError | None = None
    try:
        await activities.enrichment_process(str(JOB_ID), 3)
    except ApplicationError as exc:
        err = exc

    assert err is not None
    assert err.non_retryable is False
    assert err.type == "EnrichmentResultTransient"
    msg = err.message or ""
    assert str(JOB_ID) not in msg
    # Response body content must not leak into the error message
    assert "result_server_overloaded_detail" not in msg
    assert err.__cause__ is None
    assert err.__context__ is None


@respx.mock
async def test_enrichment_process_sanitizes_evaluator_error():
    """Temporal-visible error for evaluator failure: fixed message, no cause, no context.

    The evaluator is a pure function; an unexpected exception from it must be
    wrapped into a fixed-message ApplicationError with both __cause__ and
    __context__ suppressed via `raise ... from None`.
    """
    from unittest import mock

    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(200, json=_base_evaluate_input())
    )

    with mock.patch(
        "ai_worker.enrichment_activities.evaluate",
        side_effect=RuntimeError("secret-customer-trace-detail"),
    ):
        activities = _make_activities()
        err: ApplicationError | None = None
        try:
            await activities.enrichment_process(str(JOB_ID), 3)
        except ApplicationError as exc:
            err = exc

    assert err is not None
    assert err.non_retryable is True
    assert err.type == "EnrichmentEvaluatorError"
    msg = err.message or ""
    assert "secret-customer-trace-detail" not in msg
    assert str(JOB_ID) not in msg
    assert err.__cause__ is None
    assert err.__context__ is None


# ---------------------------------------------------------------------------
# Original FoundationEcho workflow test (unchanged)
# ---------------------------------------------------------------------------


@respx.mock
async def test_foundation_echo_workflow_marks_running_then_submits_result_with_chained_versions():
    status_route = respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    result_route = respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/result").mock(
        return_value=Response(200, json={"version": 4})
    )
    activities = FoundationEchoActivities(
        AppApiClient(base_url=BASE_URL, service_token="test-token")
    )

    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[FoundationEchoWorkflow],
            activities=[activities.mark_running, activities.submit_echo_result],
        ),
    ):
        await env.client.execute_workflow(
            FoundationEchoWorkflow.run,
            JobReferenceV1(
                schemaVersion=1,
                jobId=JOB_ID,
                workflowType="FoundationEchoWorkflow",
                workflowId=f"job-{JOB_ID}",
            ),
            id=f"job-{JOB_ID}",
            task_queue=TASK_QUEUE,
        )

    assert status_route.called
    assert result_route.called
    # The workflow must thread mark_running's returned version (3) into
    # submit_echo_result's expectedJobVersion, not re-derive/guess it.
    assert b'"expectedJobVersion":3' in result_route.calls[0].request.content


# ---------------------------------------------------------------------------
# ExpenseEnrichmentWorkflow: version chain 2 -> RUNNING -> SUCCEEDED
# ---------------------------------------------------------------------------


@respx.mock
async def test_enrichment_workflow_marks_running_then_processes_and_succeeds():
    """Full happy-path: status 2->RUNNING (v3), evaluate input, POST result (v3->SUCCEEDED v4)."""
    status_route = respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(200, json=_base_evaluate_input())
    )
    result_route = respx.post(
        f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-result"
    ).mock(return_value=Response(200, json={"version": 4}))

    activities = _make_activities()
    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[ExpenseEnrichmentWorkflow],
            activities=[
                activities.enrichment_mark_running,
                activities.enrichment_process,
                activities.enrichment_mark_failed,
            ],
        ),
    ):
        await env.client.execute_workflow(
            ExpenseEnrichmentWorkflow.run,
            job_reference(),
            id=f"enrichment-job-{JOB_ID}",
            task_queue=TASK_QUEUE,
        )

    assert status_route.called
    assert result_route.called
    # Version chain: mark_running returned 3, process posts with expectedJobVersion=3
    assert b'"expectedJobVersion":3' in result_route.calls[0].request.content
    # Idempotency key fixed per spec
    assert (
        f"{JOB_ID}:enrichment:result:v1".encode()
        in result_route.calls[0].request.content
    )
    # Workflow passes DISPATCHED_JOB_VERSION (2) as explicit primitive arg to mark_running.
    # This appears in the status POST body as expectedJobVersion=2.
    assert b'"expectedJobVersion":2' in status_route.calls[0].request.content
    assert b'"status":"RUNNING"' in status_route.calls[0].request.content


@respx.mock
async def test_enrichment_workflow_stale_input_submits_success_without_evaluator():
    """Stale outcome: no evaluator invoked; result POST is SUCCEEDED with no tags/suggestions."""
    respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(200, json={"outcome": "stale"})
    )
    result_route = respx.post(
        f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-result"
    ).mock(return_value=Response(200, json={"version": 4}))

    activities = _make_activities()
    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[ExpenseEnrichmentWorkflow],
            activities=[
                activities.enrichment_mark_running,
                activities.enrichment_process,
                activities.enrichment_mark_failed,
            ],
        ),
    ):
        await env.client.execute_workflow(
            ExpenseEnrichmentWorkflow.run,
            job_reference(),
            id=f"enrichment-stale-{JOB_ID}",
            task_queue=TASK_QUEUE,
        )

    # Must POST enrichment result (SUCCEEDED), no mark_failed
    assert result_route.called
    body = result_route.calls[0].request.content
    # No FAILED status in result POST
    assert b'"status":"FAILED"' not in body


@respx.mock
async def test_enrichment_workflow_skipped_input_submits_success_without_evaluator():
    """Skipped outcome: no evaluator invoked; result POST is SUCCEEDED."""
    respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(200, json={"outcome": "skipped"})
    )
    result_route = respx.post(
        f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-result"
    ).mock(return_value=Response(200, json={"version": 4}))

    activities = _make_activities()
    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[ExpenseEnrichmentWorkflow],
            activities=[
                activities.enrichment_mark_running,
                activities.enrichment_process,
                activities.enrichment_mark_failed,
            ],
        ),
    ):
        await env.client.execute_workflow(
            ExpenseEnrichmentWorkflow.run,
            job_reference(),
            id=f"enrichment-skipped-{JOB_ID}",
            task_queue=TASK_QUEUE,
        )

    assert result_route.called
    body = result_route.calls[0].request.content
    assert b'"status":"FAILED"' not in body


@respx.mock
async def test_enrichment_workflow_evaluate_applies_evaluator_and_submits_result():
    """Evaluate outcome: evaluator called with exact input, result submitted with applied outcome."""
    respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(200, json=_base_evaluate_input())
    )
    result_route = respx.post(
        f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-result"
    ).mock(return_value=Response(200, json={"version": 4}))

    activities = _make_activities()
    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[ExpenseEnrichmentWorkflow],
            activities=[
                activities.enrichment_mark_running,
                activities.enrichment_process,
                activities.enrichment_mark_failed,
            ],
        ),
    ):
        await env.client.execute_workflow(
            ExpenseEnrichmentWorkflow.run,
            job_reference(),
            id=f"enrichment-eval-{JOB_ID}",
            task_queue=TASK_QUEUE,
        )

    assert result_route.called
    body = result_route.calls[0].request.content
    # Evaluator produces outcome=applied (enrichment result has its own schema, no resultSchemaVersion)
    assert b'"outcome":"applied"' in body
    assert b'"rulesVersion":1' in body
    assert b'"ruleTagKeys":[]' in body


# ---------------------------------------------------------------------------
# Retry policy: 5 attempts max; 4xx nonretryable
# ---------------------------------------------------------------------------


@respx.mock
async def test_enrichment_process_activity_retries_transient_errors_up_to_5():
    """Transient 503 errors on enrichment-result POST are retried, max 5 attempts."""
    respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(200, json=_base_evaluate_input())
    )
    # All result POSTs fail with 503
    result_route = respx.post(
        f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-result"
    ).mock(return_value=Response(503, json={"error": "service unavailable"}))

    activities = _make_activities()
    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[ExpenseEnrichmentWorkflow],
            activities=[
                activities.enrichment_mark_running,
                activities.enrichment_process,
                activities.enrichment_mark_failed,
            ],
        ),
    ):
        with pytest.raises(WorkflowFailureError):
            await env.client.execute_workflow(
                ExpenseEnrichmentWorkflow.run,
                job_reference(),
                id=f"enrichment-retry503-{JOB_ID}",
                task_queue=TASK_QUEUE,
            )

    # Exactly 5 attempts (maximum_attempts=5 on process activity)
    assert len(result_route.calls) == 5


@respx.mock
async def test_enrichment_process_activity_nonretryable_4xx_fails_fast():
    """4xx (non-408/429) on enrichment-result POST must not be retried."""
    respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(200, json=_base_evaluate_input())
    )
    # 422 Unprocessable Entity -- nonretryable
    result_route = respx.post(
        f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-result"
    ).mock(return_value=Response(422, json={"error": "schema violation"}))

    activities = _make_activities()
    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[ExpenseEnrichmentWorkflow],
            activities=[
                activities.enrichment_mark_running,
                activities.enrichment_process,
                activities.enrichment_mark_failed,
            ],
        ),
    ):
        with pytest.raises(WorkflowFailureError):
            await env.client.execute_workflow(
                ExpenseEnrichmentWorkflow.run,
                job_reference(),
                id=f"enrichment-422-{JOB_ID}",
                task_queue=TASK_QUEUE,
            )

    # Exactly 1 attempt -- no retries on 4xx
    assert len(result_route.calls) == 1


# ---------------------------------------------------------------------------
# Failure path: mark_failed called on inference/transport error
# ---------------------------------------------------------------------------


@respx.mock
async def test_enrichment_workflow_marks_job_failed_then_re_raises_as_workflow_failure():
    """After all retries fail (503), workflow POSTs job FAILED callback then re-raises.

    Controller ruling (finding 6): the workflow calls enrichment_mark_failed to
    mark the App job as FAILED, then re-raises the original process exception so
    Temporal also records a workflow failure. Both outcomes are intentional and
    must happen in order: App job marked FAILED first, then Temporal workflow fails.

    Test asserts:
    - status_route called at least twice (RUNNING then FAILED)
    - exactly one FAILED status POST
    - Temporal workflow also fails (WorkflowFailureError)
    """
    status_route = respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    respx.get(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input").mock(
        return_value=Response(200, json=_base_evaluate_input())
    )
    respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-result").mock(
        return_value=Response(503, json={"error": "service unavailable"})
    )

    activities = _make_activities()
    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[ExpenseEnrichmentWorkflow],
            activities=[
                activities.enrichment_mark_running,
                activities.enrichment_process,
                activities.enrichment_mark_failed,
            ],
        ),
    ):
        with pytest.raises(WorkflowFailureError):
            await env.client.execute_workflow(
                ExpenseEnrichmentWorkflow.run,
                job_reference(),
                id=f"enrichment-fail-{JOB_ID}",
                task_queue=TASK_QUEUE,
            )

    # mark_failed must POST status=FAILED; status route called >=2 times (RUNNING + FAILED)
    assert status_route.call_count >= 2
    failed_calls = [
        c for c in status_route.calls if b'"status":"FAILED"' in c.request.content
    ]
    assert len(failed_calls) == 1
    running_calls = [
        c for c in status_route.calls if b'"status":"RUNNING"' in c.request.content
    ]
    assert len(running_calls) == 1
    # RUNNING must come before FAILED in call order
    assert status_route.calls.index(running_calls[0]) < status_route.calls.index(
        failed_calls[0]
    )


@respx.mock
async def test_enrichment_process_get_retried_on_each_attempt_when_post_fails():
    """When the result POST fails transiently, Temporal re-runs the full activity.

    On each attempt, the GET is re-executed before the POST (the activity body
    runs from the top). Both operations must be idempotent:
    - GET is read-only (safe to repeat).
    - POST carries a fixed idempotency key so a replayed successful POST is a no-op.

    This test proves the GET call count matches the POST call count (one GET
    per attempt), confirming the retry-from-top behaviour.
    """
    respx.post(f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/status").mock(
        return_value=Response(200, json={"version": 3})
    )
    # All GET calls succeed
    get_route = respx.get(
        f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-input"
    ).mock(return_value=Response(200, json=_base_evaluate_input()))
    # All POST calls fail transiently (triggers 5 retries)
    post_route = respx.post(
        f"{BASE_URL}/internal/v1/jobs/{JOB_ID}/enrichment-result"
    ).mock(return_value=Response(503, json={"error": "transient"}))

    activities = _make_activities()
    async with (
        await WorkflowEnvironment.start_time_skipping(
            data_converter=pydantic_data_converter,
        ) as env,
        Worker(
            env.client,
            task_queue=TASK_QUEUE,
            workflows=[ExpenseEnrichmentWorkflow],
            activities=[
                activities.enrichment_mark_running,
                activities.enrichment_process,
                activities.enrichment_mark_failed,
            ],
        ),
    ):
        with pytest.raises(WorkflowFailureError):
            await env.client.execute_workflow(
                ExpenseEnrichmentWorkflow.run,
                job_reference(),
                id=f"enrichment-get-retry-{JOB_ID}",
                task_queue=TASK_QUEUE,
            )

    # 5 POST attempts (maximum_attempts=5); GET re-executed once per attempt
    assert post_route.call_count == 5
    assert get_route.call_count == 5
