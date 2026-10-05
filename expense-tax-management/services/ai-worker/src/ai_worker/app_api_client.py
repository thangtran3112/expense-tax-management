"""Thin HTTP client for the App API worker-callback routes."""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from datetime import date
from typing import Literal
from uuid import UUID

import httpx
from expense_contracts.generated import (
    JobResultSubmitRequestV1,
    JobStatusUpdateRequestV1,
    OcrJobInputV1,
)
from pydantic import BaseModel, ConfigDict

from ai_worker.auth.client import CachedM2MTokenProvider, ClerkM2MTokenIssuer

TokenProvider = Callable[[], Awaitable[str]]


class DeduplicationEvidenceV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1]
    jobId: UUID
    sourceFileId: UUID
    merchant: str | None = None
    amount: str | None = None
    currency: str | None = None
    incurredOn: date | None = None
    orderNumber: str | None = None
    expectedJobVersion: int
    idempotencyKey: str


class AppApiClient:
    def __init__(
        self,
        base_url: str,
        service_token: str | None = None,
        token_provider: TokenProvider | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_token = service_token
        self._token_provider = token_provider

    async def _headers(self) -> dict[str, str]:
        token = (
            await self._token_provider()
            if self._token_provider is not None
            else self._service_token
        )
        if not token:
            raise RuntimeError("App API service token provider is required")
        return {"Authorization": f"Bearer {token}"}

    async def update_status(
        self, job_id: str, request: JobStatusUpdateRequestV1
    ) -> int:
        """Returns the ProcessingJob's new version so the caller can chain
        the next callback's expectedJobVersion without a separate read
        (the worker has no GET-job scope, only write scopes)."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/jobs/{job_id}/status",
                # exclude_none: Pydantic serializes an unset Optional field as
                # explicit JSON `null`; the Zod contract's `.optional()` only
                # accepts an *absent* key, not `null` (it would need
                # `.nullable()` too for that) -- omitting None fields entirely
                # is what actually round-trips against a z.strictObject with
                # plain `.optional()` fields.
                json=request.model_dump(mode="json", exclude_none=True),
                headers=await self._headers(),
            )
            response.raise_for_status()
            return int(response.json()["version"])

    async def submit_result(
        self, job_id: str, request: JobResultSubmitRequestV1
    ) -> int:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/jobs/{job_id}/result",
                json=request.model_dump(mode="json", exclude_none=True),
                headers=await self._headers(),
            )
            response.raise_for_status()
            return int(response.json()["version"])

    async def record_deduplication_evidence(
        self, job_id: str, evidence: DeduplicationEvidenceV1
    ) -> dict[str, object]:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/jobs/{job_id}/deduplication",
                json=evidence.model_dump(mode="json", exclude_none=True),
                headers=await self._headers(),
            )
            response.raise_for_status()
            return dict(response.json())

    async def get_ocr_input(self, job_id: str) -> OcrJobInputV1:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self._base_url}/internal/v1/jobs/{job_id}/ocr-input",
                headers=await self._headers(),
            )
            response.raise_for_status()
            return OcrJobInputV1(**response.json())

    async def issue_file_read_url(self, file_id: str) -> str:
        """Worker read-url route returns a bearer-free signed URL; the
        caller GETs it separately (kept as two steps so tests can assert
        each hop)."""
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/files/{file_id}/read-url",
                headers=await self._headers(),
            )
            response.raise_for_status()
            return str(response.json()["url"])

    async def download_file(self, file_id: str) -> bytes:
        """Resolve the worker read URL for a file, then fetch its bytes.

        Callers pass the file id threaded out of the job-bound ocr-input
        response (server-resolved binding), never a client-supplied value.
        """
        url = await self.issue_file_read_url(file_id)
        async with httpx.AsyncClient() as client:
            response = await client.get(url)
            response.raise_for_status()
            return response.content


def app_api_client_from_env() -> AppApiClient:
    """OCR/status client. Scopes: jobs:write + files:read. Subject: ai-worker-app-machine."""
    base_url = os.environ["APP_API_BASE_URL"]
    service_token = os.environ.get("APP_API_SERVICE_TOKEN")
    if service_token:
        return AppApiClient(base_url=base_url, service_token=service_token)

    audience = os.environ["CLERK_APP_SERVICE_AUDIENCE"]
    scopes = ("jobs:write", "files:read")
    issuer = ClerkM2MTokenIssuer(
        machine_secret_key=os.environ["CLERK_APP_MACHINE_SECRET_KEY"],
        issuer=os.environ["CLERK_ISSUER_URL"],
        audience=audience,
        scopes=scopes,
        source_machine_id=os.environ["CLERK_APP_SERVICE_SUBJECT"],
    )
    provider = CachedM2MTokenProvider(
        issuer.issue,
        expected_issuer=os.environ["CLERK_ISSUER_URL"],
        audience=audience,
        scopes=scopes,
        source_machine_id=os.environ["CLERK_APP_SERVICE_SUBJECT"],
    )
    return AppApiClient(base_url=base_url, token_provider=provider.get_token)


# ---------------------------------------------------------------------------
# Enrichment input client -- scope: jobs:enrichment-input only
# ---------------------------------------------------------------------------


class EnrichmentInputClient:
    """Thin client for GET enrichment-input. Separate M2M client; scope jobs:enrichment-input."""

    def __init__(
        self,
        base_url: str,
        service_token: str | None = None,
        token_provider: TokenProvider | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_token = service_token
        self._token_provider = token_provider

    async def _headers(self) -> dict[str, str]:
        token = (
            await self._token_provider()
            if self._token_provider is not None
            else self._service_token
        )
        if not token:
            raise RuntimeError("Enrichment input client token provider is required")
        return {"Authorization": f"Bearer {token}"}

    async def get_enrichment_input(self, job_id: str) -> dict:
        """GET /internal/v1/jobs/{jobId}/enrichment-input.

        Returns a plain dict with outcome in {"evaluate","stale","skipped"}.
        When outcome=="evaluate" the dict also contains an "input" sub-dict
        (raw JSON matching ExpenseEnrichmentInputV1 schema). The caller is
        responsible for parsing to the Pydantic model; this client stays
        transport-only so the model never crosses the HTTP boundary explicitly.
        """
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"{self._base_url}/internal/v1/jobs/{job_id}/enrichment-input",
                headers=await self._headers(),
            )
            response.raise_for_status()
            return dict(response.json())


def enrichment_input_client_from_env() -> EnrichmentInputClient:
    """Enrichment input client.

    Scope: jobs:enrichment-input only.
    Same machine credential (CLERK_APP_MACHINE_SECRET_KEY) and subject
    (CLERK_APP_SERVICE_SUBJECT) as the OCR client; a separate
    CachedM2MTokenProvider instance is created so the token cache and
    scope tuple stay fully independent.
    """
    base_url = os.environ["APP_API_BASE_URL"]
    service_token = os.environ.get("APP_API_SERVICE_TOKEN")
    if service_token:
        return EnrichmentInputClient(base_url=base_url, service_token=service_token)

    audience = os.environ["CLERK_APP_SERVICE_AUDIENCE"]
    scopes = ("jobs:enrichment-input",)
    subject = os.environ["CLERK_APP_SERVICE_SUBJECT"]
    issuer = ClerkM2MTokenIssuer(
        machine_secret_key=os.environ["CLERK_APP_MACHINE_SECRET_KEY"],
        issuer=os.environ["CLERK_ISSUER_URL"],
        audience=audience,
        scopes=scopes,
        source_machine_id=subject,
    )
    provider = CachedM2MTokenProvider(
        issuer.issue,
        expected_issuer=os.environ["CLERK_ISSUER_URL"],
        audience=audience,
        scopes=scopes,
        source_machine_id=subject,
    )
    return EnrichmentInputClient(base_url=base_url, token_provider=provider.get_token)


# ---------------------------------------------------------------------------
# Enrichment result client -- scope: jobs:enrichment-result only
# ---------------------------------------------------------------------------


class EnrichmentResultClient:
    """Thin client for POST enrichment-result. Separate M2M client; scope jobs:enrichment-result."""

    def __init__(
        self,
        base_url: str,
        service_token: str | None = None,
        token_provider: TokenProvider | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._service_token = service_token
        self._token_provider = token_provider

    async def _headers(self) -> dict[str, str]:
        token = (
            await self._token_provider()
            if self._token_provider is not None
            else self._service_token
        )
        if not token:
            raise RuntimeError("Enrichment result client token provider is required")
        return {"Authorization": f"Bearer {token}"}

    async def submit_enrichment_result(
        self,
        job_id: str,
        expected_job_version: int,
        idempotency_key: str,
        result: dict,
    ) -> int:
        """POST /internal/v1/jobs/{jobId}/enrichment-result.

        Returns the ProcessingJob's new version.
        """
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self._base_url}/internal/v1/jobs/{job_id}/enrichment-result",
                json={
                    "schemaVersion": 1,
                    "expectedJobVersion": expected_job_version,
                    "idempotencyKey": idempotency_key,
                    "result": result,
                },
                headers=await self._headers(),
            )
            response.raise_for_status()
            return int(response.json()["version"])


def enrichment_result_client_from_env() -> EnrichmentResultClient:
    """Enrichment result client.

    Scope: jobs:enrichment-result only.
    Same machine credential (CLERK_APP_MACHINE_SECRET_KEY) and subject
    (CLERK_APP_SERVICE_SUBJECT) as the OCR client; a separate
    CachedM2MTokenProvider instance is created so the token cache and
    scope tuple stay fully independent.
    """
    base_url = os.environ["APP_API_BASE_URL"]
    service_token = os.environ.get("APP_API_SERVICE_TOKEN")
    if service_token:
        return EnrichmentResultClient(base_url=base_url, service_token=service_token)

    audience = os.environ["CLERK_APP_SERVICE_AUDIENCE"]
    scopes = ("jobs:enrichment-result",)
    subject = os.environ["CLERK_APP_SERVICE_SUBJECT"]
    issuer = ClerkM2MTokenIssuer(
        machine_secret_key=os.environ["CLERK_APP_MACHINE_SECRET_KEY"],
        issuer=os.environ["CLERK_ISSUER_URL"],
        audience=audience,
        scopes=scopes,
        source_machine_id=subject,
    )
    provider = CachedM2MTokenProvider(
        issuer.issue,
        expected_issuer=os.environ["CLERK_ISSUER_URL"],
        audience=audience,
        scopes=scopes,
        source_machine_id=subject,
    )
    return EnrichmentResultClient(base_url=base_url, token_provider=provider.get_token)
