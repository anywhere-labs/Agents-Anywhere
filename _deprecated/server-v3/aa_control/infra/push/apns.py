"""APNs HTTP/2 provider API sender with token-based (ES256 ``.p8``) authentication."""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from typing import Any

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from loguru import logger

from aa_control.core.config import ApnsConfig
from aa_control.infra.push.base import (
    PushDeliveryEnvelope,
    PushPermanentError,
    PushRetryableError,
    PushTokenInvalidError,
)
from aa_control.infra.push.payload import build_apns_payload, build_notice

# Apple rejects provider tokens older than 60 minutes and throttles refreshes more
# frequent than every 20 minutes; refresh well inside that window.
APNS_JWT_REFRESH_SECONDS = 50 * 60

TOKEN_INVALID_REASONS = frozenset({"BadDeviceToken", "Unregistered"})
PROVIDER_TOKEN_EXPIRED_REASONS = frozenset({"ExpiredProviderToken"})
PROVIDER_TOKEN_INVALID_REASONS = frozenset({"InvalidProviderToken", "MissingProviderToken"})


def load_apns_signing_key(private_key_pem: str) -> ec.EllipticCurvePrivateKey:
    """Load and validate an APNs ``.p8`` auth key (PKCS#8 EC P-256). Errors never echo key bytes."""
    try:
        key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
    except (ValueError, TypeError):
        raise ValueError("APNs auth key is not a valid unencrypted PEM (.p8) private key") from None
    if not isinstance(key, ec.EllipticCurvePrivateKey) or not isinstance(key.curve, ec.SECP256R1):
        raise ValueError("APNs auth key must be an EC P-256 key (Apple .p8 file)")
    return key


class ApnsProviderToken:
    """Caches the ES256 provider JWT and re-signs it before Apple's 60-minute limit."""

    def __init__(
        self,
        *,
        key_id: str,
        team_id: str,
        private_key_pem: str,
        clock: Callable[[], float] = time.time,
        refresh_seconds: float = APNS_JWT_REFRESH_SECONDS,
    ) -> None:
        self._key_id = key_id
        self._team_id = team_id
        self._key = load_apns_signing_key(private_key_pem)
        self._clock = clock
        self._refresh_seconds = refresh_seconds
        self._token: str | None = None
        self._issued_at = 0.0

    def get(self) -> str:
        now = self._clock()
        if self._token is None or now - self._issued_at >= self._refresh_seconds:
            issued_at = int(now)
            self._token = jwt.encode(
                {"iss": self._team_id, "iat": issued_at},
                self._key,
                algorithm="ES256",
                headers={"kid": self._key_id, "typ": None},
            )
            self._issued_at = float(issued_at)
        return self._token

    def invalidate(self) -> None:
        self._token = None


def _reason(resp: httpx.Response) -> str:
    try:
        data = resp.json()
    except ValueError:
        return ""
    if isinstance(data, dict):
        reason = data.get("reason")
        if isinstance(reason, str):
            return reason
    return ""


def _retry_after(resp: httpx.Response) -> float | None:
    raw = resp.headers.get("retry-after")
    if raw is None:
        return None
    try:
        return max(0.0, float(raw))
    except ValueError:
        return None


class ApnsSender:
    """Sends alert notifications to iOS clients through the APNs provider API."""

    def __init__(
        self,
        config: ApnsConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._cfg = config
        self._clock = clock
        self._provider_token = ApnsProviderToken(
            key_id=config.key_id,
            team_id=config.team_id,
            private_key_pem=config.private_key_pem,
            clock=clock,
        )
        self._own_client = http_client is None
        self._http = http_client or httpx.AsyncClient(
            http2=True,
            timeout=config.request_timeout_seconds,
        )

    async def close(self) -> None:
        if self._own_client:
            await self._http.aclose()

    def build_request(self, envelope: PushDeliveryEnvelope) -> tuple[str, dict[str, str], dict[str, Any]]:
        notice = build_notice(envelope)
        headers = {
            "authorization": f"bearer {self._provider_token.get()}",
            "apns-topic": self._cfg.bundle_id,
            "apns-push-type": "alert",
            "apns-priority": "10" if notice.high_priority else "5",
            "apns-expiration": str(int(self._clock()) + notice.ttl_seconds),
            # Deterministic per job so retries of the same notice share an id in Apple's logs.
            "apns-id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"aa-push:{envelope.job_id}")),
        }
        if notice.collapse_key is not None:
            headers["apns-collapse-id"] = notice.collapse_key
        url = f"{self._cfg.host}/3/device/{envelope.push_token}"
        return url, headers, build_apns_payload(notice)

    async def send(self, envelope: PushDeliveryEnvelope) -> None:
        url, headers, payload = self.build_request(envelope)
        try:
            resp = await self._http.post(url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            # Never include the exception text: it may embed the request URL (device token).
            raise PushRetryableError(f"apns transport error: {type(exc).__name__}") from None
        self._classify(resp)

    def _classify(self, resp: httpx.Response) -> None:
        status = resp.status_code
        if status == 200:
            return
        reason = _reason(resp)
        detail = f"apns {status} {reason or 'no-reason'}"
        if status == 410 or reason in TOKEN_INVALID_REASONS:
            raise PushTokenInvalidError(detail)
        if reason in PROVIDER_TOKEN_EXPIRED_REASONS:
            self._provider_token.invalidate()
            raise PushRetryableError(detail)
        if reason in PROVIDER_TOKEN_INVALID_REASONS:
            self._provider_token.invalidate()
            logger.error(
                "APNs rejected the provider token ({}); check AA_CONTROL_APNS_KEY_ID / TEAM_ID / key file",
                reason,
            )
            raise PushPermanentError(detail)
        if status == 429 or status >= 500:
            raise PushRetryableError(detail, retry_after_seconds=_retry_after(resp))
        raise PushPermanentError(detail)
