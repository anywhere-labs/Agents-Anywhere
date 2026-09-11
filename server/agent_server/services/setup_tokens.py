from __future__ import annotations

import hmac
import json
import math
from datetime import UTC, datetime

from loguru import logger
from redis.exceptions import RedisError

from agent_server.core.setup_token import SetupToken
from agent_server.infra.redis_coordinator import RedisCoordinator

_LOCK = "setup-token"


def _serialize(value: str, expires_at: datetime) -> str:
    return json.dumps({"value": value, "expiresAt": expires_at.isoformat()})


class SetupTokenService:
    """Use one expiring bootstrap token across workers when Redis is configured."""

    def __init__(self, local: SetupToken, coordinator: RedisCoordinator) -> None:
        self._local = local
        self._coordinator = coordinator
        self._key = coordinator.key("setup-token")

    async def snapshot(self) -> tuple[str, datetime]:
        if not self._coordinator.distributed:
            return self._local.snapshot()
        async with self._coordinator.lock(_LOCK):
            raw = await self._coordinator.client.get(self._key)
            if raw:
                stored = json.loads(raw)
                expires_at = datetime.fromisoformat(stored["expiresAt"])
                if expires_at > datetime.now(UTC):
                    self._local.adopt(stored["value"], expires_at)
                    return stored["value"], expires_at
            # A process-local value may outlive a shared token that expired or
            # was consumed. Never republish that stale value into Redis.
            self._local.consume()
            value, expires_at = self._local.snapshot()
            ttl_ms = max(
                1, math.ceil((expires_at - datetime.now(UTC)).total_seconds() * 1000)
            )
            async with self._coordinator.pipeline_while_lock_owned(_LOCK) as pipeline:
                pipeline.set(self._key, _serialize(value, expires_at), px=ttl_ms)
            return value, expires_at

    async def current_expires_at_iso(self) -> str:
        _, expires_at = await self.snapshot()
        return expires_at.astimezone(UTC).isoformat().replace("+00:00", "Z")

    async def verify(self, candidate: str | None) -> bool:
        if not candidate:
            return False
        value, _ = await self.snapshot()
        return hmac.compare_digest(candidate.encode("utf-8"), value.encode("utf-8"))

    async def consume(self) -> None:
        value, expires_at = self._local.peek_state()
        self._local.consume()
        if not self._coordinator.distributed or value is None or expires_at is None:
            return
        try:
            await self._coordinator.delete_if_value(
                self._key, _serialize(value, expires_at)
            )
        except RedisError:
            # Admin creation has already committed. The database bootstrap
            # guard prevents reuse, and Redis will expire the remaining key.
            logger.warning(
                "Admin created; shared setup token cleanup will use its expiry"
            )
