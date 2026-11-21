from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Protocol

from loguru import logger

from aa_control.infra.redis_store import RedisControlStore


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
    """Pluggable provider interface; real APNs/FCM senders plug in during T513."""

    async def send(self, envelope: PushDeliveryEnvelope) -> None: ...


class LoggingPushProvider:
    """Default headless provider that logs dispatches without exposing private bodies."""

    async def send(self, envelope: PushDeliveryEnvelope) -> None:
        logger.info(
            "push dispatched job={} platform={} client={} device={} event={} encrypted={}",
            envelope.job_id,
            envelope.platform,
            envelope.client_id,
            envelope.device_id,
            envelope.event_type,
            envelope.encrypted_device,
        )


class PushRetryWorker:
    """Drains Redis push queue and retries failed deliveries with exponential backoff."""

    def __init__(
        self,
        redis_store: RedisControlStore,
        provider: PushProvider,
        *,
        max_attempts: int = 5,
        base_backoff_seconds: float = 5.0,
    ) -> None:
        self._redis = redis_store
        self._provider = provider
        self._max_attempts = max_attempts
        self._base_backoff = base_backoff_seconds

    async def process_once(self, *, now_unix: float | None = None) -> bool:
        """Promote due retries and process a single ready job. Returns True if a job was processed."""
        now = now_unix if now_unix is not None else time.time()
        await self._redis.promote_due_push_retries(now_unix=now)
        job = await self._redis.pop_push_job(timeout=0.0)
        if job is None:
            return False
        await self._deliver_job(job, now_unix=now)
        return True

    async def _deliver_job(self, job: dict[str, Any], *, now_unix: float) -> None:
        attempt = int(job.get("attempt", 0)) + 1
        envelope = PushDeliveryEnvelope(
            job_id=str(job["job_id"]),
            client_id=str(job["client_id"]),
            platform=str(job["platform"]),
            push_token=str(job["push_token"]),
            device_id=str(job["device_id"]),
            event_type=str(job["event_type"]),
            encrypted_device=bool(job["encrypted_device"]),
            title=str(job["title"]),
            body=job.get("body"),
            session_id=job.get("session_id"),
            attempt=attempt,
        )
        try:
            await self._provider.send(envelope)
        except Exception as exc:  # noqa: BLE001
            job["attempt"] = attempt
            job["last_error"] = str(exc)
            if attempt >= self._max_attempts:
                logger.warning(
                    "push delivery exhausted retries job={} attempts={} err={}",
                    envelope.job_id,
                    attempt,
                    exc,
                )
                await self._redis.record_dead_push_job(job)
                return
            delay = self._base_backoff * (2 ** (attempt - 1))
            logger.warning(
                "push delivery failed; scheduling retry job={} attempt={} delay={}s err={}",
                envelope.job_id,
                attempt,
                delay,
                exc,
            )
            await self._redis.schedule_push_retry(job, deliver_at_unix=now_unix + delay)

    async def run_forever(self, *, poll_interval: float = 0.5) -> None:
        while True:
            try:
                processed = await self.process_once()
                if not processed:
                    await asyncio.sleep(poll_interval)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("push retry worker loop error")
                await asyncio.sleep(poll_interval)
