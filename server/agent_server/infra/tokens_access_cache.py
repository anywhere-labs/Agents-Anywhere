"""Short-lived Tokens Anywhere access tokens.

They never go to the database. With Redis they are kept there, sealed, so
every worker shares them; a single process without Redis keeps them in memory.
"""

from __future__ import annotations

import json
import time
from typing import Any

from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.secret_box import SecretBox


class TokensAccessCache:
    def __init__(self, redis: RedisCoordinator | None = None) -> None:
        self._redis = redis
        self._memory: dict[str, tuple[float, str]] = {}

    def _key(self, user_id: str) -> str:
        assert self._redis is not None
        return self._redis.key("tokens-access", user_id)

    def _distributed(self) -> bool:
        return self._redis is not None and self._redis.distributed

    async def get(
        self, user_id: str, box: SecretBox, *, linked_at: str | None = None
    ) -> str | None:
        value: str | None = None
        if self._distributed():
            sealed: Any = await self._redis.client.get(self._key(user_id))  # type: ignore[union-attr]
            value = (
                box.open(sealed, context=f"tokens-access:{user_id}") if sealed else None
            )
        else:
            entry = self._memory.get(user_id)
            if entry is None or entry[0] <= time.monotonic():
                self._memory.pop(user_id, None)
                return None
            value = entry[1]
        if value is None:
            return None
        if not value.startswith("{"):
            return value if linked_at is None else None
        payload = json.loads(value)
        if linked_at is not None and payload.get("linkedAt") != linked_at:
            return None
        token = payload.get("token")
        return token if isinstance(token, str) else None

    async def set(
        self,
        user_id: str,
        token: str,
        *,
        ttl_seconds: int,
        box: SecretBox,
        linked_at: str | None = None,
    ) -> None:
        if ttl_seconds <= 0:
            return
        value = (
            json.dumps({"token": token, "linkedAt": linked_at})
            if linked_at is not None
            else token
        )
        if self._distributed():
            sealed = box.seal(value, context=f"tokens-access:{user_id}")
            await self._redis.client.set(self._key(user_id), sealed, ex=ttl_seconds)  # type: ignore[union-attr]
            return
        self._memory[user_id] = (time.monotonic() + ttl_seconds, value)

    async def delete(self, user_id: str) -> None:
        self._memory.pop(user_id, None)
        if self._distributed():
            await self._redis.client.delete(self._key(user_id))  # type: ignore[union-attr]
