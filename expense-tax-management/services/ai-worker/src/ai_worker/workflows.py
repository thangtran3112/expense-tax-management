from __future__ import annotations

from datetime import timedelta

from temporalio import workflow
from temporalio.common import RetryPolicy

with workflow.unsafe.imports_passed_through():
    from expense_contracts.generated import JobReferenceV1

    from ai_worker.activities import (
        FoundationEchoActivities,
        MarkRunningInput,
        SubmitEchoResultInput,
    )
    from ai_worker.constants import DISPATCHED_JOB_VERSION
    from ai_worker.enrichment_activities import EnrichmentActivities
    from ai_worker.ocr_activities import (
        OcrCallStartedArgs,
        OcrDownloadArgs,
        OcrGetInputArgs,
        OcrMarkFailedArgs,
        OcrReceiptActivities,
        OcrRecordAcceptedArgs,
        OcrRecordDeduplicationArgs,
        OcrReleaseArgs,
        OcrReserveArgs,
        OcrResolveRouteArgs,
        OcrRunExtractionArgs,
        OcrSubmitExtractionArgs,
        OcrSubmitFailedArgs,
    )


@workflow.defn(name="FoundationEchoWorkflow")
class FoundationEchoWorkflow:
    @workflow.run
    async def run(self, job_reference: JobReferenceV1) -> None:
        new_version = await workflow.execute_activity(
            FoundationEchoActivities.mark_running,
            MarkRunningInput(
                job_reference=job_reference,
                expected_job_version=DISPATCHED_JOB_VERSION,
            ),
            start_to_close_timeout=timedelta(seconds=30),
        )
        await workflow.execute_activity(
            FoundationEchoActivities.submit_echo_result,
            SubmitEchoResultInput(
                job_reference=job_reference,
                expected_job_version=new_version,
            ),
            start_to_close_timeout=timedelta(seconds=30),
        )


@workflow.defn(name="OcrReceiptWorkflow")
class OcrReceiptWorkflow:
    """Receipt OCR pipeline. Linear, no exception-driven control flow:
    every fallible step returns a value the workflow branches on, and any
    UNEXPECTED exception (bug, outage past retry policy) lands in the
    terminal best-effort FAILED before returning -- a stuck-RUNNING job is
    the one outcome this workflow refuses to produce silently. (0L's echo
    workflow lacks this guard; it is test-only scaffolding, noted in the
    0C plan, deliberately not retrofitted.)

    Idempotency keys are fixed per (job, step), so Temporal replays and
    workflow-task retries re-execute safely against App API's replay
    semantics instead of duplicating work.
    """

    @workflow.run
    async def run(self, job_reference: JobReferenceV1) -> None:
        http_retry = RetryPolicy(maximum_attempts=5)
        quick_retry = RetryPolicy(maximum_attempts=2)

        async def fail(message: str, version: int) -> None:
            try:
                await workflow.execute_activity(
                    OcrReceiptActivities.ocr_mark_failed,
                    OcrMarkFailedArgs(
                        job_reference=job_reference,
                        expected_job_version=version,
                        message=message,
                    ),
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=http_retry,
                )
            except Exception:  # noqa: BLE001, S110 -- terminal FN mapping: every activity failure past retry policy lands a typed OCR_FAILED instead of a stuck-RUNNING job (see class docstring)
                pass

        version = await workflow.execute_activity(
            FoundationEchoActivities.mark_running,
            MarkRunningInput(
                job_reference=job_reference,
                expected_job_version=DISPATCHED_JOB_VERSION,
            ),
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=http_retry,
        )

        try:
            job_input = await workflow.execute_activity(
                OcrReceiptActivities.ocr_get_input,
                OcrGetInputArgs(job_reference=job_reference),
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=http_retry,
            )
        except Exception:  # noqa: BLE001 -- terminal FN mapping: every activity failure past retry policy lands a typed OCR_FAILED instead of a stuck-RUNNING job (see class docstring)
            await fail("OCR_FAILED: could not load job input", version)
            return

        try:
            receipt_bytes = await workflow.execute_activity(
                OcrReceiptActivities.ocr_download_receipt,
                OcrDownloadArgs(
                    job_reference=job_reference,
                    file_id=str(job_input.fileId),
                    expected_sha256=job_input.expectedSha256,
                ),
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=http_retry,
            )
        except Exception:  # noqa: BLE001 -- terminal FN mapping: every activity failure past retry policy lands a typed OCR_FAILED instead of a stuck-RUNNING job (see class docstring)
            await fail("OCR_FAILED: could not download receipt bytes", version)
            return

        try:
            route = await workflow.execute_activity(
                OcrReceiptActivities.ocr_resolve_route,
                OcrResolveRouteArgs(mode_key=str(job_input.modeKey)),
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=http_retry,
            )
        except Exception:  # noqa: BLE001 -- terminal FN mapping: every activity failure past retry policy lands a typed OCR_FAILED instead of a stuck-RUNNING job (see class docstring)
            await fail("OCR_FAILED: no active route for mode", version)
            return

        reservation_id: str | None = None
        try:
            reserve_result = await workflow.execute_activity(
                OcrReceiptActivities.ocr_reserve,
                OcrReserveArgs(
                    job_reference=job_reference,
                    tenant_id=str(job_input.tenantId),
                    ai_model_id=str(route["aiModelId"]),
                ),
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=http_retry,
            )
        except Exception:  # noqa: BLE001 -- terminal FN mapping: every activity failure past retry policy lands a typed OCR_FAILED instead of a stuck-RUNNING job (see class docstring)
            await fail("OCR_FAILED: quota reservation error", version)
            return

        if reserve_result.blocked:
            await workflow.execute_activity(
                OcrReceiptActivities.ocr_submit_failed,
                OcrSubmitFailedArgs(
                    job_reference=job_reference,
                    expected_job_version=version,
                    error="QUOTA_BLOCKED",
                    message=(
                        "QUOTA_BLOCKED: monthly RECEIPT_OCR allowance "
                        "exhausted for this tenant"
                    ),
                ),
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=http_retry,
            )
            return

        reservation_id = reserve_result.reservation_id
        assert reservation_id is not None

        try:
            await workflow.execute_activity(
                OcrReceiptActivities.ocr_mark_call_started,
                OcrCallStartedArgs(reservation_id=reservation_id),
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=http_retry,
            )
            extraction = await workflow.execute_activity(
                OcrReceiptActivities.ocr_run_extraction,
                OcrRunExtractionArgs(data=receipt_bytes),
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=quick_retry,
            )
            await workflow.execute_activity(
                OcrReceiptActivities.ocr_record_accepted,
                OcrRecordAcceptedArgs(reservation_id=reservation_id),
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=http_retry,
            )
            result_version = await workflow.execute_activity(
                OcrReceiptActivities.ocr_submit_extraction,
                OcrSubmitExtractionArgs(
                    job_reference=job_reference,
                    expected_job_version=version,
                    extraction=extraction,
                ),
                start_to_close_timeout=timedelta(seconds=30),
                retry_policy=http_retry,
            )
            version = result_version
        except Exception:  # noqa: BLE001 -- terminal FN mapping: every activity failure past retry policy lands a typed OCR_FAILED instead of a stuck-RUNNING job (see class docstring)
            try:
                await workflow.execute_activity(
                    OcrReceiptActivities.ocr_release,
                    OcrReleaseArgs(reservation_id=reservation_id),
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=quick_retry,
                )
            except Exception:  # noqa: BLE001, S110 -- terminal FN mapping: every activity failure past retry policy lands a typed OCR_FAILED instead of a stuck-RUNNING job (see class docstring)
                pass
            await fail("OCR_FAILED: extraction pipeline error", version)
            return

        # OCR result is already SUCCEEDED. Callback retries remain durable, but
        # callback failure must never attempt an illegal SUCCEEDED -> FAILED transition.
        await workflow.execute_activity(
            OcrReceiptActivities.ocr_record_deduplication,
            OcrRecordDeduplicationArgs(
                job_reference=job_reference,
                source_file_id=str(job_input.fileId),
                expected_job_version=result_version,
                extraction=extraction,
            ),
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=http_retry,
        )


@workflow.defn(name="ForwardedReceiptWorkflow")
class ForwardedReceiptWorkflow:
    """Trusted forwarded attachments use the standard OCR pipeline after
    App API trust validation. No raw MIME/provider secrets enter history;
    only the opaque JobReferenceV1 does."""

    @workflow.run
    async def run(self, job_reference: JobReferenceV1) -> None:
        await OcrReceiptWorkflow().run(job_reference)


@workflow.defn(name="ExpenseEnrichmentWorkflow")
class ExpenseEnrichmentWorkflow:
    """Expense enrichment pipeline.

    Privacy model: workflow history contains ONLY the input JobReferenceV1,
    activity names, primitive args (job_id str, version int), and the opaque
    outcome string. ExpenseEnrichmentInputV1 and ExpenseEnrichmentResultV1
    never appear in history -- they live entirely inside enrichment_process.

    Sequence:
      1. enrichment_mark_running (jobs:write) -> RUNNING; returns running_version.
      2. enrichment_process (jobs:enrichment-input + jobs:enrichment-result)
           - internally GETs input, evaluates or bypasses, POSTs result.
           - RetryPolicy(maximum_attempts=5); nonretryable 4xx fails fast.
           - Returns opaque outcome string.
      3. On process failure: enrichment_mark_failed (jobs:write) -> FAILED.

    All outcomes (applied/stale/skipped) end the workflow as SUCCEEDED in
    Temporal. Only uncaught inference/transport errors trigger mark_failed.
    """

    @workflow.run
    async def run(self, job_reference: JobReferenceV1) -> None:
        http_retry = RetryPolicy(maximum_attempts=5)
        job_id = str(job_reference.jobId)

        # Pass DISPATCHED_JOB_VERSION as an explicit primitive arg so the
        # constant is visible in Temporal's workflow-history event log rather
        # than hidden inside the activity implementation.
        running_version = await workflow.execute_activity(
            EnrichmentActivities.enrichment_mark_running,
            args=[job_id, DISPATCHED_JOB_VERSION],
            start_to_close_timeout=timedelta(seconds=30),
            retry_policy=http_retry,
        )

        try:
            await workflow.execute_activity(
                EnrichmentActivities.enrichment_process,
                args=[job_id, running_version],
                start_to_close_timeout=timedelta(seconds=60),
                retry_policy=http_retry,
            )
        except Exception:
            try:
                await workflow.execute_activity(
                    EnrichmentActivities.enrichment_mark_failed,
                    args=[job_id, running_version],
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=http_retry,
                )
            except Exception:  # noqa: BLE001, S110 -- best-effort; never shadow the original process failure
                pass
            raise
