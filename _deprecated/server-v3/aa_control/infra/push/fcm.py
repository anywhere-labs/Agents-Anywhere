"""FCM HTTP v1 sender authenticated with a Google service account (OAuth2 JWT bearer grant)."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Any

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from loguru import logger

from aa_control.core.config import FcmConfig
from aa_control.infra.push.base import (
    PushDeliveryEnvelope,
    PushPermanentError,
    PushRetryableError,
    PushTokenInvalidError,
)
from aa_control.infra.push.payload import build_fcm_message, build_notice

FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"
ASSERTION_LIFETIME_SECONDS = 3600
# Refresh the cached access token this long before Google says it expires.
ACCESS_TOKEN_REFRESH_MARGIN_SECONDS = 300

FCM_ERROR_TYPE = "type.googleapis.com/google.firebase.fcm.v1.FcmError"
BAD_REQUEST_TYPE = "type.googleapis.com/google.rpc.BadRequest"
RETRYABLE_STATUSES = frozenset({"UNAVAILABLE", "INTERNAL", "QUOTA_EXCEEDED", "RESOURCE_EXHAUSTED"})


def load_service_account_key(private_key_pem: str) -> rsa.RSAPrivateKey:
    """Load the service-account RSA key. Errors never echo key bytes."""
    try:
        key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
    except (ValueError, TypeError):
        raise ValueError("FCM service account private_key is not a valid PEM private key") from None
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError("FCM service account private_key must be an RSA key")
    return key


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if raw is None:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        return None


class GoogleServiceAccountTokenSource:
    """Exchanges a signed RS256 assertion for an OAuth2 access token and caches it."""

    def __init__(
        self,
        config: FcmConfig,
        *,
        http_client: httpx.AsyncClient,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._cfg = config
        self._http = http_client
        self._clock = clock
        self._key = load_service_account_key(config.private_key_pem)
        self._access_token: str | None = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()

    def build_assertion(self) -> str:
        now = int(self._clock())
        headers: dict[str, str] = {}
        if self._cfg.private_key_id:
            headers["kid"] = self._cfg.private_key_id
        return jwt.encode(
            {
                "iss": self._cfg.client_email,
                "sub": self._cfg.client_email,
                "scope": FCM_SCOPE,
                "aud": self._cfg.token_uri,
                "iat": now,
                "exp": now + ASSERTION_LIFETIME_SECONDS,
            },
            self._key,
            algorithm="RS256",
            headers=headers,
        )

    def invalidate(self) -> None:
        self._access_token = None
        self._expires_at = 0.0

    async def get(self) -> str:
        if self._is_fresh():
            assert self._access_token is not None
            return self._access_token
        async with self._lock:
            if self._is_fresh():
                assert self._access_token is not None
                return self._access_token
            return await self._fetch()

    def _is_fresh(self) -> bool:
        return self._access_token is not None and self._clock() < self._expires_at

    async def _fetch(self) -> str:
        try:
            resp = await self._http.post(
                self._cfg.token_uri,
                data={"grant_type": JWT_BEARER_GRANT, "assertion": self.build_assertion()},
                headers={"Accept": "application/json"},
            )
        except httpx.HTTPError as exc:
            raise PushRetryableError(f"fcm oauth transport error: {type(exc).__name__}") from None
        if resp.status_code == 429 or resp.status_code >= 500:
            raise PushRetryableError(
                f"fcm oauth {resp.status_code}",
                retry_after_seconds=_retry_after(resp),
            )
        if resp.status_code != 200:
            logger.error(
                "Google OAuth rejected the FCM service account (HTTP {}); check AA_CONTROL_FCM_CREDENTIALS_*",
                resp.status_code,
            )
            raise PushPermanentError(f"fcm oauth {resp.status_code}")
        try:
            data = resp.json()
        except ValueError:
            raise PushRetryableError("fcm oauth returned non-JSON response") from None
        token = data.get("access_token") if isinstance(data, dict) else None
        if not isinstance(token, str) or not token:
            raise PushRetryableError("fcm oauth response missing access_token")
        expires_in = data.get("expires_in", 3600)
        try:
            lifetime = float(expires_in)
        except (TypeError, ValueError):
            lifetime = 3600.0
        self._access_token = token
        self._expires_at = self._clock() + max(0.0, lifetime - ACCESS_TOKEN_REFRESH_MARGIN_SECONDS)
        return token


def _error_parts(resp: httpx.Response) -> tuple[str, str | None, bool]:
    """Return (status, fcm_error_code, token_field_violation) from a Google API error body."""
    try:
        data = resp.json()
    except ValueError:
        return "", None, False
    error = data.get("error") if isinstance(data, dict) else None
    if not isinstance(error, dict):
        return "", None, False
    status = error.get("status") if isinstance(error.get("status"), str) else ""
    fcm_code: str | None = None
    token_violation = False
    details = error.get("details")
    if isinstance(details, list):
        for detail in details:
            if not isinstance(detail, dict):
                continue
            kind = detail.get("@type")
            if kind == FCM_ERROR_TYPE and isinstance(detail.get("errorCode"), str):
                fcm_code = detail["errorCode"]
            if kind == BAD_REQUEST_TYPE and isinstance(detail.get("fieldViolations"), list):
                for violation in detail["fieldViolations"]:
                    if isinstance(violation, dict) and violation.get("field") == "message.token":
                        token_violation = True
    message = error.get("message")
    if status == "INVALID_ARGUMENT" and isinstance(message, str) and "registration token" in message.lower():
        token_violation = True
    return status, fcm_code, token_violation


class FcmSender:
    """Sends notifications to Android clients through FCM HTTP v1 ``messages:send``."""

    def __init__(
        self,
        config: FcmConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._cfg = config
        self._own_client = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=config.request_timeout_seconds)
        self._tokens = GoogleServiceAccountTokenSource(config, http_client=self._http, clock=clock)

    @property
    def send_url(self) -> str:
        return f"{self._cfg.endpoint}/v1/projects/{self._cfg.project_id}/messages:send"

    async def close(self) -> None:
        if self._own_client:
            await self._http.aclose()

    def build_message(self, envelope: PushDeliveryEnvelope) -> dict[str, Any]:
        return build_fcm_message(build_notice(envelope), token=envelope.push_token)

    async def send(self, envelope: PushDeliveryEnvelope) -> None:
        message = self.build_message(envelope)
        access_token = await self._tokens.get()
        try:
            resp = await self._http.post(
                self.send_url,
                headers={"Authorization": f"Bearer {access_token}"},
                json=message,
            )
        except httpx.HTTPError as exc:
            raise PushRetryableError(f"fcm transport error: {type(exc).__name__}") from None
        self._classify(resp)

    def _classify(self, resp: httpx.Response) -> None:
        if resp.status_code == 200:
            return
        status, fcm_code, token_violation = _error_parts(resp)
        detail = f"fcm {resp.status_code} {fcm_code or status or 'no-status'}"
        if fcm_code == "UNREGISTERED" or (
            (status == "INVALID_ARGUMENT" or fcm_code == "INVALID_ARGUMENT") and token_violation
        ):
            raise PushTokenInvalidError(detail)
        if resp.status_code == 401 or status == "UNAUTHENTICATED":
            # Access token revoked or expired early: drop the cache and retry with a fresh one.
            self._tokens.invalidate()
            raise PushRetryableError(detail)
        if (
            resp.status_code == 429
            or resp.status_code >= 500
            or status in RETRYABLE_STATUSES
            or fcm_code in RETRYABLE_STATUSES
        ):
            raise PushRetryableError(detail, retry_after_seconds=_retry_after(resp))
        raise PushPermanentError(detail)
