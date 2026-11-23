from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from loguru import logger


@dataclass(frozen=True)
class PushDeliveryEnvelope:
    """Payload handed to a platform push provider (APNs / FCM / WebPush)."""

    job_id: str
    client_id: str
    platform: str
    push_token: str
    device_id: str
    event_type: str
    encrypted_device: bool
    title: str
    body: str | None
    session_id: str | None
    attempt: int


class PushProvider(Protocol):
    """Pluggable provider interface.

    ``send`` returns normally on success. Failures are signalled with the exceptions
    below; any other exception is treated as retryable by :class:`PushRetryWorker`.
    Exception messages must never contain push tokens or notification content.
    """

    async def send(self, envelope: PushDeliveryEnvelope) -> None: ...


class PushTokenStore(Protocol):
    """Removes a client's push token after the platform reports it as dead."""

    async def clear_client_push_token(self, *, client_id: str, push_token: str) -> bool: ...


class PushDeliveryError(Exception):
    """Base class for classified delivery failures (message is safe to log)."""


class PushRetryableError(PushDeliveryError):
    """Transient failure (429, 5xx, network); retried with exponential backoff."""

    def __init__(self, message: str, *, retry_after_seconds: float | None = None) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class PushPermanentError(PushDeliveryError):
    """Request rejected for a reason a retry cannot fix; moved to the dead-letter queue."""


class PushTokenInvalidError(PushDeliveryError):
    """The platform says the token is unregistered or malformed; the token is removed."""


class LoggingPushProvider:
    """Headless provider that logs dispatches without exposing private bodies.

    Used for platforms without a configured sender (desktop, web, or iOS/Android when
    APNs/FCM credentials are absent): the notice is logged and dropped.
    """

    async def send(self, envelope: PushDeliveryEnvelope) -> None:
        logger.info(
            "push logged without platform delivery job={} platform={} client={} device={} event={} encrypted={}",
            envelope.job_id,
            envelope.platform,
            envelope.client_id,
            envelope.device_id,
            envelope.event_type,
            envelope.encrypted_device,
        )
