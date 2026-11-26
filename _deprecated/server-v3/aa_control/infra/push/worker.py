from __future__ import annotations

import asyncio
import time
from typing import Any

from loguru import logger

from aa_control.infra.push.base import (
    PushDeliveryEnvelope,
    PushPermanentError,
    PushProvider,
    PushRetryableError,
    PushTokenInvalidError,
    PushTokenStore,
)
from aa_control.infra.redis_store import RedisControlStore

MAX_RETRY_AFTER_SECONDS = 3600.0


class PushRetryWorker:
    """Drains Redis push queue and retries failed deliveries with exponential backoff.

    Outcome handling:
    - success: done;
    - :class:`PushTokenInvalidError`: the client's push token is removed, no retry;
    - :class:`PushPermanentError`: moved to the dead-letter queue, no retry;
    - :class:`PushRetryableError` or any other exception: retried with exponential
      backoff (honouring ``Retry-After`` when given) until ``max_attempts``.
    """

    def __init__(
        self,
        redis_store: RedisControlStore,
        provider: PushProvider,
        *,
        token_store: PushTokenStore | None = None,
        max_attempts: int = 5,
        base_backoff_seconds: float = 5.0,
    ) -> None:
        self._redis = redis_store
        self._provider = provider
        self._token_store = token_store
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
        except PushTokenInvalidError as exc:
            await self._remove_dead_token(envelope, exc)
        except PushPermanentError as exc:
            job["attempt"] = attempt
            job["last_error"] = str(exc)
            logger.warning(
                "push delivery failed permanently job={} platform={} client={} err={}",
                envelope.job_id,
                envelope.platform,
                envelope.client_id,
                exc,
            )
            await self._redis.record_dead_push_job(job)
        except Exception as exc:  # noqa: BLE001
            await self._handle_retryable(job, envelope, exc, now_unix=now_unix)

    async def _remove_dead_token(self, envelope: PushDeliveryEnvelope, exc: PushTokenInvalidError) -> None:
        removed = False
        if self._token_store is not None:
            removed = await self._token_store.clear_client_push_token(
                client_id=envelope.client_id,
                push_token=envelope.push_token,
            )
        logger.info(
            "push token rejected by platform; removed={} job={} platform={} client={} err={}",
            removed,
            envelope.job_id,
            envelope.platform,
            envelope.client_id,
            exc,
        )

    async def _handle_retryable(
        self,
        job: dict[str, Any],
        envelope: PushDeliveryEnvelope,
        exc: Exception,
        *,
        now_unix: float,
    ) -> None:
        attempt = envelope.attempt
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
        if isinstance(exc, PushRetryableError) and exc.retry_after_seconds is not None:
            delay = max(delay, min(exc.retry_after_seconds, MAX_RETRY_AFTER_SECONDS))
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
