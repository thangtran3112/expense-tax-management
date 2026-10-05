import uuid

import respx
from expense_contracts.generated import JobStatusUpdateRequestV1
from httpx import Response

from ai_worker.app_api_client import (
    AppApiClient,
    EnrichmentInputClient,
    EnrichmentResultClient,
    app_api_client_from_env,
    enrichment_input_client_from_env,
    enrichment_result_client_from_env,
)
from ai_worker.auth.client import CachedM2MTokenProvider
from ai_worker.foundry_client import FoundryClient, foundry_client_from_env
from ai_worker.ocr_activities import DeduplicationEvidenceV1


async def test_app_api_client_injects_token_provider():
    token_calls = 0

    async def token_provider() -> str:
        nonlocal token_calls
        token_calls += 1
        return "app-token"

    job_id = uuid.UUID("11111111-1111-4111-8111-111111111111")
    request = JobStatusUpdateRequestV1(
        schemaVersion=1,
        status="RUNNING",
        expectedJobVersion=1,
        idempotencyKey="key",
    )

    with respx.mock:
        route = respx.post(f"http://app.test/internal/v1/jobs/{job_id}/status").mock(
            return_value=Response(200, json={"version": 2})
        )
        client = AppApiClient(
            base_url="http://app.test",
            token_provider=token_provider,
        )
        assert await client.update_status(str(job_id), request) == 2

    assert token_calls == 1
    assert route.calls[0].request.headers["authorization"] == "Bearer app-token"


@respx.mock
async def test_app_api_client_records_deduplication_evidence_with_auth_and_strict_body():
    job_id = uuid.UUID("11111111-1111-4111-8111-111111111111")
    evidence = DeduplicationEvidenceV1(
        schemaVersion=1,
        jobId=job_id,
        sourceFileId=uuid.UUID("44444444-4444-4444-8444-444444444444"),
        merchant="Cafe",
        amount="12.30",
        currency="USD",
        incurredOn="2026-09-11",
        expectedJobVersion=5,
        idempotencyKey=f"{job_id}:ocr:dedup:v1",
    )
    route = respx.post(f"http://app.test/internal/v1/jobs/{job_id}/deduplication").mock(
        return_value=Response(200, json={"decision": "no_match", "matchIds": []})
    )

    client = AppApiClient(base_url="http://app.test", service_token="app-token")
    result = await client.record_deduplication_evidence(str(job_id), evidence)

    assert result == {"decision": "no_match", "matchIds": []}
    assert route.calls[0].request.headers["authorization"] == "Bearer app-token"
    assert route.calls[0].request.content == (
        b'{"schemaVersion":1,"jobId":"11111111-1111-4111-8111-111111111111",'
        b'"sourceFileId":"44444444-4444-4444-8444-444444444444","merchant":"Cafe",'
        b'"amount":"12.30","currency":"USD","incurredOn":"2026-09-11",'
        b'"expectedJobVersion":5,"idempotencyKey":"11111111-1111-4111-8111-111111111111:ocr:dedup:v1"}'
    )


async def test_foundry_client_injects_token_provider():
    async def token_provider() -> str:
        return "foundry-token"

    with respx.mock:
        route = respx.get("http://foundry.test/internal/v1/effective-route").mock(
            return_value=Response(200, json={"route": "fake"})
        )
        client = FoundryClient(
            base_url="http://foundry.test",
            token_provider=token_provider,
        )
        assert await client.get_effective_route("ocr", "default") == {"route": "fake"}

    assert route.calls[0].request.headers["authorization"] == "Bearer foundry-token"


def test_factories_use_explicit_legacy_service_tokens(monkeypatch):
    monkeypatch.setenv("APP_API_BASE_URL", "http://app.test")
    monkeypatch.setenv("APP_API_SERVICE_TOKEN", "app-token")
    monkeypatch.setenv("FOUNDRY_BASE_URL", "http://foundry.test")
    monkeypatch.setenv("FOUNDRY_SERVICE_TOKEN", "foundry-token")

    app_client = app_api_client_from_env()
    foundry_client = foundry_client_from_env()

    assert app_client._service_token == "app-token"
    assert app_client._token_provider is None
    assert foundry_client._service_token == "foundry-token"
    assert foundry_client._token_provider is None


# ---------------------------------------------------------------------------
# Enrichment input client
# ---------------------------------------------------------------------------


@respx.mock
async def test_enrichment_input_client_gets_evaluate_response():
    """GET /internal/v1/jobs/{jobId}/enrichment-input returns an evaluate response."""
    job_id = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    expense_id = uuid.UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
    route = respx.get(
        f"http://app.test/internal/v1/jobs/{job_id}/enrichment-input"
    ).mock(
        return_value=Response(
            200,
            json={
                "outcome": "evaluate",
                "input": {
                    "schemaVersion": 1,
                    "jobId": str(job_id),
                    "expenseId": str(expense_id),
                    "expenseVersion": 1,
                    "normalizedMerchant": "starbucks",
                    "incurredOn": "2026-09-12",
                    "spendingCategoryId": None,
                    "rulesVersion": 1,
                    "eligibleTagKeys": ["merchant:starbucks"],
                    "eligibleSpendingCategoryIds": [],
                    "eligibleTaxSnapshot": None,
                    "history": {
                        "exampleCount": 0,
                        "candidateTagKeys": [],
                        "candidateSpendingCategoryIds": [],
                        "candidateTaxCategoryIds": [],
                    },
                },
            },
        )
    )
    client = EnrichmentInputClient(
        base_url="http://app.test", service_token="inp-token"
    )
    response = await client.get_enrichment_input(str(job_id))

    assert route.called
    assert route.calls[0].request.headers["authorization"] == "Bearer inp-token"
    assert response["outcome"] == "evaluate"
    assert response["input"]["normalizedMerchant"] == "starbucks"


@respx.mock
async def test_enrichment_input_client_gets_stale_response():
    job_id = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    route = respx.get(
        f"http://app.test/internal/v1/jobs/{job_id}/enrichment-input"
    ).mock(return_value=Response(200, json={"outcome": "stale"}))
    client = EnrichmentInputClient(
        base_url="http://app.test", service_token="inp-token"
    )
    response = await client.get_enrichment_input(str(job_id))

    assert route.called
    assert response["outcome"] == "stale"


@respx.mock
async def test_enrichment_input_client_gets_skipped_response():
    job_id = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    route = respx.get(
        f"http://app.test/internal/v1/jobs/{job_id}/enrichment-input"
    ).mock(return_value=Response(200, json={"outcome": "skipped"}))
    client = EnrichmentInputClient(
        base_url="http://app.test", service_token="inp-token"
    )
    response = await client.get_enrichment_input(str(job_id))

    assert route.called
    assert response["outcome"] == "skipped"


# ---------------------------------------------------------------------------
# Enrichment result client
# ---------------------------------------------------------------------------


@respx.mock
async def test_enrichment_result_client_posts_result():
    """POST /internal/v1/jobs/{jobId}/enrichment-result with correct auth and body."""
    job_id = uuid.UUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    route = respx.post(
        f"http://app.test/internal/v1/jobs/{job_id}/enrichment-result"
    ).mock(return_value=Response(200, json={"version": 4}))

    client = EnrichmentResultClient(
        base_url="http://app.test", service_token="res-token"
    )
    version = await client.submit_enrichment_result(
        job_id=str(job_id),
        expected_job_version=3,
        idempotency_key=f"{job_id}:enrichment:result:v1",
        result={
            "outcome": "applied",
            "schemaVersion": 1,
            "rulesVersion": 1,
            "ruleTagKeys": [],
            "suggestions": [],
        },
    )

    assert route.called
    assert version == 4
    assert route.calls[0].request.headers["authorization"] == "Bearer res-token"
    body = route.calls[0].request.content
    assert b'"expectedJobVersion":3' in body
    assert (
        b'"idempotencyKey":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:enrichment:result:v1"'
        in body
    )


# ---------------------------------------------------------------------------
# Separate scope factories -- M2M provider path (finding 5)
# ---------------------------------------------------------------------------

_M2M_ENV = {
    "APP_API_BASE_URL": "http://app.test",
    "CLERK_APP_SERVICE_AUDIENCE": "mch_audience",
    "CLERK_APP_MACHINE_SECRET_KEY": "ak_test_machine_secret",
    "CLERK_ISSUER_URL": "https://clerk.test",
    "CLERK_APP_SERVICE_SUBJECT": "mch_subject",
}


def _provider_from(client) -> CachedM2MTokenProvider:
    """Unwrap the bound-method token_provider to the CachedM2MTokenProvider."""
    assert client._token_provider is not None, (
        "Expected M2M provider path, got service-token"
    )
    return client._token_provider.__self__


def test_ocr_client_m2m_provider_scopes_exactly_jobs_write_and_files_read(monkeypatch):
    """OCR/status factory (M2M path) must produce scopes=(jobs:write, files:read) only."""
    for k, v in _M2M_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("APP_API_SERVICE_TOKEN", raising=False)

    client = app_api_client_from_env()
    provider = _provider_from(client)

    assert isinstance(provider, CachedM2MTokenProvider)
    assert set(provider._scopes) == {"jobs:write", "files:read"}
    assert "jobs:enrichment-input" not in provider._scopes
    assert "jobs:enrichment-result" not in provider._scopes


def test_enrichment_input_client_m2m_provider_scope_is_enrichment_input_only(
    monkeypatch,
):
    """Enrichment input factory (M2M path) must produce scopes=(jobs:enrichment-input,) only."""
    for k, v in _M2M_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("APP_API_SERVICE_TOKEN", raising=False)

    client = enrichment_input_client_from_env()
    provider = _provider_from(client)

    assert isinstance(provider, CachedM2MTokenProvider)
    assert set(provider._scopes) == {"jobs:enrichment-input"}
    assert "jobs:write" not in provider._scopes
    assert "files:read" not in provider._scopes
    assert "jobs:enrichment-result" not in provider._scopes


def test_enrichment_result_client_m2m_provider_scope_is_enrichment_result_only(
    monkeypatch,
):
    """Enrichment result factory (M2M path) must produce scopes=(jobs:enrichment-result,) only."""
    for k, v in _M2M_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("APP_API_SERVICE_TOKEN", raising=False)

    client = enrichment_result_client_from_env()
    provider = _provider_from(client)

    assert isinstance(provider, CachedM2MTokenProvider)
    assert set(provider._scopes) == {"jobs:enrichment-result"}
    assert "jobs:write" not in provider._scopes
    assert "files:read" not in provider._scopes
    assert "jobs:enrichment-input" not in provider._scopes


def test_three_m2m_providers_are_independent_instances(monkeypatch):
    """Each factory must create a separate CachedM2MTokenProvider instance.

    All three share CLERK_APP_MACHINE_SECRET_KEY and CLERK_APP_SERVICE_SUBJECT
    (one Clerk App machine credential) but must NOT share a provider instance
    so their token caches and scope tuples remain fully independent.
    """
    for k, v in _M2M_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("APP_API_SERVICE_TOKEN", raising=False)

    ocr_client = app_api_client_from_env()
    inp_client = enrichment_input_client_from_env()
    res_client = enrichment_result_client_from_env()

    ocr_prov = _provider_from(ocr_client)
    inp_prov = _provider_from(inp_client)
    res_prov = _provider_from(res_client)

    # Three distinct provider instances
    assert ocr_prov is not inp_prov
    assert ocr_prov is not res_prov
    assert inp_prov is not res_prov

    # All share same audience and subject (one Clerk App machine credential)
    assert ocr_prov._audience == inp_prov._audience == res_prov._audience
    assert (
        ocr_prov._source_machine_id
        == inp_prov._source_machine_id
        == res_prov._source_machine_id
    )

    # Each carries only its own scope
    assert set(ocr_prov._scopes) == {"jobs:write", "files:read"}
    assert set(inp_prov._scopes) == {"jobs:enrichment-input"}
    assert set(res_prov._scopes) == {"jobs:enrichment-result"}
