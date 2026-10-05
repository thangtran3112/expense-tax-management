"""Injectable Clerk M2M JWT acquisition and in-memory reuse."""

from __future__ import annotations

import base64
import binascii
import json
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from typing import Any, Protocol

import httpx


class M2MTokenError(RuntimeError):
    """Raised when Clerk cannot provide a usable M2M token."""


class TokenIssuer(Protocol):
    async def issue(self) -> str: ...


def _decode_payload(token: str) -> Mapping[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise M2MTokenError("Clerk M2M response was not a JWT")
    try:
        padding = "=" * (-len(parts[1]) % 4)
        payload = json.loads(base64.urlsafe_b64decode(parts[1] + padding))
    except (ValueError, TypeError, binascii.Error, json.JSONDecodeError) as error:
        raise M2MTokenError("Clerk M2M response contained an invalid JWT") from error
    if not isinstance(payload, dict):
        raise M2MTokenError("Clerk M2M response contained an invalid JWT payload")
    return payload


def _decode_header(token: str) -> Mapping[str, Any]:
    part = token.split(".", 2)[0]
    try:
        padding = "=" * (-len(part) % 4)
        header = json.loads(base64.urlsafe_b64decode(part + padding))
    except (ValueError, TypeError, binascii.Error, json.JSONDecodeError) as error:
        raise M2MTokenError(
            "Clerk M2M response contained an invalid JWT header"
        ) from error
    if not isinstance(header, dict) or header.get("alg") != "RS256":
        raise M2MTokenError("Clerk M2M token has invalid algorithm")
    return header


def _validate_token(
    token: str,
    *,
    audience: str,
    scopes: Sequence[str],
    client_id: str,
    issuer: str,
    now: float,
) -> float:
    _decode_header(token)
    payload = _decode_payload(token)
    if payload.get("iss") != issuer:
        raise M2MTokenError("Clerk M2M token has wrong issuer")
    token_audience = payload.get("aud")
    if token_audience != [audience]:
        raise M2MTokenError("Clerk M2M token has wrong audience")

    scope_claim = payload.get("scope")
    token_scopes = scope_claim.split() if isinstance(scope_claim, str) else []
    if any(scope not in token_scopes for scope in scopes):
        raise M2MTokenError("Clerk M2M token is missing required scope")

    if payload.get("sub") != client_id:
        raise M2MTokenError("Clerk M2M token has wrong source subject")

    token_id = payload.get("jti")
    if not isinstance(token_id, str) or not token_id.strip():
        raise M2MTokenError("Clerk M2M token is missing token ID")

    not_before = payload.get("nbf")
    if "nbf" in payload and (
        not isinstance(not_before, (int, float))
        or isinstance(not_before, bool)
        or not_before > now + 30
    ):
        raise M2MTokenError("Clerk M2M token has invalid not-before")

    expiry = payload.get("exp")
    if (
        not isinstance(expiry, (int, float))
        or isinstance(expiry, bool)
        or expiry <= now
    ):
        raise M2MTokenError("Clerk M2M token is expired or has invalid expiry")
    return float(expiry)


class ClerkM2MTokenIssuer:
    """Mint one short-lived JWT from Clerk using a machine secret."""

    def __init__(
        self,
        *,
        machine_secret_key: str,
        audience: str,
        scopes: Sequence[str],
        source_machine_id: str,
        issuer: str,
        ttl_seconds: int = 300,
        timeout_seconds: float = 5,
        endpoint: str = "https://api.clerk.com/v1/m2m_tokens",
        client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
        now: Callable[[], float] = time.time,
    ) -> None:
        if not machine_secret_key.strip():
            raise M2MTokenError("Clerk machine secret is required")
        if ttl_seconds <= 0:
            raise ValueError("Clerk M2M token TTL must be positive")
        self._machine_secret_key = machine_secret_key
        self._audience = audience
        self._scopes = tuple(scopes)
        self._source_machine_id = source_machine_id
        self._issuer = issuer
        self._ttl_seconds = ttl_seconds
        self._timeout_seconds = timeout_seconds
        self._endpoint = endpoint
        self._client_factory = client_factory
        self._now = now

    async def issue(self) -> str:
        try:
            async with self._client_factory(timeout=self._timeout_seconds) as client:
                response = await client.post(
                    self._endpoint,
                    json={
                        "token_format": "jwt",
                        "seconds_until_expiration": self._ttl_seconds,
                        "claims": {
                            "scope": " ".join(self._scopes),
                        },
                    },
                    headers={"Authorization": f"Bearer {self._machine_secret_key}"},
                )
                response.raise_for_status()
                body = response.json()
                token = body.get("token") if isinstance(body, dict) else None
                if not isinstance(token, str) or not token:
                    raise M2MTokenError("Clerk M2M response did not contain a token")
                _validate_token(
                    token,
                    audience=self._audience,
                    scopes=self._scopes,
                    client_id=self._source_machine_id,
                    issuer=self._issuer,
                    now=self._now(),
                )
                return token
        except M2MTokenError:
            raise
        except (httpx.HTTPError, ValueError, TypeError, json.JSONDecodeError) as error:
            raise M2MTokenError("Clerk M2M token acquisition failed") from error


class CachedM2MTokenProvider:
    """Reuse a token in process, refreshing before its expiry."""

    def __init__(
        self,
        issuer: Callable[[], Awaitable[str]],
        *,
        audience: str,
        scopes: Sequence[str],
        source_machine_id: str,
        expected_issuer: str,
        refresh_skew_seconds: int = 30,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._expected_issuer = expected_issuer
        self._audience = audience
        self._scopes = tuple(scopes)
        self._source_machine_id = source_machine_id
        self._issuer = issuer
        self._refresh_skew_seconds = refresh_skew_seconds
        self._now = now
        self._token: str | None = None
        self._expires_at = 0.0

    async def get_token(self) -> str:
        if (
            self._token is not None
            and self._expires_at - self._refresh_skew_seconds > self._now()
        ):
            return self._token

        token = await self._issuer()
        expires_at = _validate_token(
            token,
            audience=self._audience,
            scopes=self._scopes,
            client_id=self._source_machine_id,
            issuer=self._expected_issuer,
            now=self._now(),
        )
        self._token = token
        self._expires_at = expires_at
        return token
