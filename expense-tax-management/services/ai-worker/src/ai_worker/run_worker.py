from __future__ import annotations

import asyncio
import os

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from ai_worker.activities import FoundationEchoActivities
from ai_worker.app_api_client import (
    app_api_client_from_env,
    enrichment_input_client_from_env,
    enrichment_result_client_from_env,
)
from ai_worker.config import worker_config_from_env
from ai_worker.constants import TASK_QUEUE
from ai_worker.enrichment_activities import EnrichmentActivities
from ai_worker.foundry_client import foundry_client_from_env
from ai_worker.ocr_activities import OcrReceiptActivities
from ai_worker.workflows import (
    ExpenseEnrichmentWorkflow,
    ForwardedReceiptWorkflow,
    FoundationEchoWorkflow,
    OcrReceiptWorkflow,
)


async def main() -> None:
    worker_config_from_env()
    address = os.environ.get("TEMPORAL_HOST", "127.0.0.1:7233")
    namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    task_queue = os.environ.get("AI_WORKER_TASK_QUEUE", TASK_QUEUE)

    client = await Client.connect(
        address,
        namespace=namespace,
        data_converter=pydantic_data_converter,
    )
    app_api = app_api_client_from_env()
    activities = FoundationEchoActivities(app_api)
    ocr = OcrReceiptActivities(app_api, foundry_client_from_env())
    enrichment = EnrichmentActivities(
        ocr_status_client=app_api,
        input_client=enrichment_input_client_from_env(),
        result_client=enrichment_result_client_from_env(),
    )
    worker = Worker(
        client,
        task_queue=task_queue,
        workflows=[
            FoundationEchoWorkflow,
            OcrReceiptWorkflow,
            ForwardedReceiptWorkflow,
            ExpenseEnrichmentWorkflow,
        ],
        activities=[
            activities.mark_running,
            activities.submit_echo_result,
            ocr.ocr_get_input,
            ocr.ocr_download_receipt,
            ocr.ocr_resolve_route,
            ocr.ocr_reserve,
            ocr.ocr_mark_call_started,
            ocr.ocr_run_extraction,
            ocr.ocr_record_accepted,
            ocr.ocr_release,
            ocr.ocr_submit_extraction,
            ocr.ocr_record_deduplication,
            ocr.ocr_submit_failed,
            ocr.ocr_mark_failed,
            enrichment.enrichment_mark_running,
            enrichment.enrichment_process,
            enrichment.enrichment_mark_failed,
        ],
    )
    print(
        f"ai-worker: polling task queue '{task_queue}' at {address} ({namespace})",
        flush=True,
    )
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
