import base64
import json

import httpx
import pytest

from ai_worker.auth.client import (
    CachedM2MTokenProvider,
    ClerkM2MTokenIssuer,
    M2MTokenError,
)


def jwt_with_claims(claims: dict[str, object]) -> str:
    def encode(value: object) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{encode({'alg': 'RS256', 'typ': 'JWT'})}.{encode(claims)}.signature"


@pytest.fixture
def valid_token() -> str:
    return jwt_with_claims(
        {
            "iss": "https://clerk.test",
            "aud": ["app-api-machine"],
            "scope": "jobs:write files:read",
            "sub": "ai-worker-app-machine",
            "jti": "jti-123",
            "nbf": 800,
            "exp": 1_000,
        }
    )


async def test_issuer_creates_short_lived_jwt_with_machine_secret(valid_token):
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"token": valid_token})

    transport = httpx.MockTransport(handler)
    issuer = ClerkM2MTokenIssuer(
        machine_secret_key="ak_test_secret",
        audience="app-api-machine",
        scopes=("jobs:write", "files:read"),
        source_machine_id="ai-worker-app-machine",
        issuer="https://clerk.test",
        ttl_seconds=300,
        timeout_seconds=2,
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=transport, **kwargs
        ),
        now=lambda: 900,
    )

    assert await issuer.issue() == valid_token
    assert requests[0].headers["authorization"] == "Bearer ak_test_secret"
    assert str(requests[0].url.params) == ""
    assert json.loads(requests[0].content) == {
        "token_format": "jwt",
        "seconds_until_expiration": 300,
        "claims": {"scope": "jobs:write files:read"},
    }


async def test_issuer_accepts_clerk_m2m_jwt_without_not_before():
    token = jwt_with_claims(
        {
            "iss": "https://clerk.test",
            "aud": ["app-api-machine"],
            "scope": "jobs:write",
            "scopes": ["jobs:write"],
            "sub": "ai-worker-app-machine",
            "jti": "jti-123",
            "iat": 800,
            "exp": 1_000,
        }
    )

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={"token": token})

    issuer = ClerkM2MTokenIssuer(
        machine_secret_key="ak_dev_secret",
        audience="app-api-machine",
        scopes=("jobs:write",),
        source_machine_id="ai-worker-app-machine",
        issuer="https://clerk.test",
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), **kwargs
        ),
        now=lambda: 900,
    )

    assert await issuer.issue() == token


async def test_provider_reuses_cached_token_until_refresh_window(valid_token):
    calls = 0

    async def issue() -> str:
        nonlocal calls
        calls += 1
        return valid_token

    provider = CachedM2MTokenProvider(
        issue,
        audience="app-api-machine",
        scopes=("jobs:write", "files:read"),
        source_machine_id="ai-worker-app-machine",
        expected_issuer="https://clerk.test",
        refresh_skew_seconds=50,
        now=lambda: 900,
    )

    assert await provider.get_token() == valid_token
    assert await provider.get_token() == valid_token
    assert calls == 1


async def test_provider_refreshes_token_inside_expiry_window():
    tokens = [
        jwt_with_claims(
            {
                "iss": "https://clerk.test",
                "aud": ["app-api-machine"],
                "scope": "jobs:write",
                "sub": "ai-worker-app-machine",
                "jti": "jti-1",
                "nbf": 50,
                "exp": 100,
            }
        ),
        jwt_with_claims(
            {
                "iss": "https://clerk.test",
                "aud": ["app-api-machine"],
                "scope": "jobs:write",
                "sub": "ai-worker-app-machine",
                "jti": "jti-2",
                "nbf": 50,
                "exp": 200,
            }
        ),
    ]
    now = 60

    async def issue() -> str:
        return tokens.pop(0)

    provider = CachedM2MTokenProvider(
        issue,
        audience="app-api-machine",
        scopes=("jobs:write",),
        source_machine_id="ai-worker-app-machine",
        expected_issuer="https://clerk.test",
        refresh_skew_seconds=50,
        now=lambda: now,
    )

    first = await provider.get_token()
    now = 70
    second = await provider.get_token()

    assert first != second


@pytest.mark.parametrize(
    "claims, message",
    [
        (
            {
                "iss": "https://clerk.test",
                "aud": ["wrong-audience"],
                "scope": "jobs:write",
                "sub": "ai-worker-app-machine",
                "jti": "jti",
                "nbf": 800,
                "exp": 1_000,
            },
            "audience",
        ),
        (
            {
                "iss": "https://clerk.test",
                "aud": ["app-api-machine"],
                "scope": "other:scope",
                "sub": "ai-worker-app-machine",
                "jti": "jti",
                "nbf": 800,
                "exp": 1_000,
            },
            "scope",
        ),
        (
            {
                "iss": "https://clerk.test",
                "aud": ["app-api-machine"],
                "scope": "jobs:write",
                "sub": "ai-worker-app-machine",
                "jti": "jti",
                "nbf": 700,
                "exp": 800,
            },
            "expired",
        ),
        (
            {
                "iss": "https://clerk.test",
                "aud": ["app-api-machine"],
                "scope": "jobs:write",
                "jti": "jti",
                "nbf": 800,
                "exp": 1_000,
            },
            "subject",
        ),
        (
            {
                "iss": "https://clerk.test",
                "aud": ["app-api-machine"],
                "scope": "jobs:write",
                "sub": "other-machine",
                "jti": "jti",
                "nbf": 800,
                "exp": 1_000,
            },
            "subject",
        ),
        (
            {
                "iss": "https://clerk.test",
                "aud": ["app-api-machine", "other-machine"],
                "scope": "jobs:write",
                "sub": "ai-worker-app-machine",
                "jti": "jti",
                "nbf": 800,
                "exp": 1_000,
            },
            "audience",
        ),
    ],
)
async def test_issuer_rejects_invalid_claims(claims, message):
    token = jwt_with_claims(claims)

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"token": token})

    issuer = ClerkM2MTokenIssuer(
        machine_secret_key="ak_test_secret",
        audience="app-api-machine",
        scopes=("jobs:write",),
        source_machine_id="ai-worker-app-machine",
        issuer="https://clerk.test",
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), **kwargs
        ),
        now=lambda: 900,
    )

    with pytest.raises(M2MTokenError, match=message):
        await issuer.issue()


async def test_issuer_ignores_client_id_claim_when_source_subject_is_valid():
    token = jwt_with_claims(
        {
            "iss": "https://clerk.test",
            "aud": ["app-api-machine"],
            "scope": "jobs:write",
            "sub": "ai-worker-app-machine",
            "jti": "jti-123",
            "nbf": 800,
            "client_id": "other-machine",
            "exp": 1_000,
        }
    )

    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"token": token})

    issuer = ClerkM2MTokenIssuer(
        machine_secret_key="ak_test_secret",
        audience="app-api-machine",
        scopes=("jobs:write",),
        source_machine_id="ai-worker-app-machine",
        issuer="https://clerk.test",
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), **kwargs
        ),
        now=lambda: 900,
    )

    assert await issuer.issue() == token


@pytest.mark.parametrize(
    "claims, message",
    [
        (
            {
                "aud": ["app-api-machine"],
                "scope": "jobs:write",
                "sub": "ai-worker-app-machine",
                "jti": "jti",
                "nbf": 800,
                "exp": 1_000,
            },
            "issuer",
        ),
        (
            {
                "iss": "https://other.test",
                "aud": ["app-api-machine"],
                "scope": "jobs:write",
                "sub": "ai-worker-app-machine",
                "jti": "jti",
                "nbf": 800,
                "exp": 1_000,
            },
            "issuer",
        ),
        (
            {
                "iss": "https://clerk.test",
                "aud": ["app-api-machine"],
                "scope": "jobs:write",
                "sub": "ai-worker-app-machine",
                "nbf": 800,
                "exp": 1_000,
            },
            "token ID",
        ),
        (
            {
                "iss": "https://clerk.test",
                "aud": ["app-api-machine"],
                "scope": "jobs:write",
                "sub": "ai-worker-app-machine",
                "jti": "jti",
                "nbf": 1_001,
                "exp": 1_200,
            },
            "not-before",
        ),
    ],
)
async def test_issuer_rejects_missing_or_invalid_strict_clerk_claims(claims, message):
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"token": jwt_with_claims(claims)})

    issuer = ClerkM2MTokenIssuer(
        machine_secret_key="ak_test_secret",
        audience="app-api-machine",
        scopes=("jobs:write",),
        source_machine_id="ai-worker-app-machine",
        issuer="https://clerk.test",
        client_factory=lambda **kwargs: httpx.AsyncClient(
            transport=httpx.MockTransport(handler), **kwargs
        ),
        now=lambda: 900,
    )

    with pytest.raises(M2MTokenError, match=message):
        await issuer.issue()


async def test_issuer_requires_machine_secret_without_logging_it():
    with pytest.raises(M2MTokenError, match="machine secret") as raised:
        ClerkM2MTokenIssuer(
            machine_secret_key=" ",
            audience="app-api-machine",
            scopes=("jobs:write",),
            source_machine_id="ai-worker-app-machine",
            issuer="https://clerk.test",
        )

    assert "ak_test" not in str(raised.value)
