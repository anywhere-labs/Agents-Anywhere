"""Short-lived Tokens Anywhere access tokens.

They never go to the database. With Redis they are kept there, sealed, so
every worker shares them; a single process without Redis keeps them in memory.
"""

from __future__ import annotations

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

    async def get(self, user_id: str, box: SecretBox) -> str | None:
        if self._distributed():
            sealed: Any = await self._redis.client.get(self._key(user_id))  # type: ignore[union-attr]
            return box.open(sealed, context=f"tokens-access:{user_id}") if sealed else None
        entry = self._memory.get(user_id)
        if entry is None or entry[0] <= time.monotonic():
            self._memory.pop(user_id, None)
            return None
        return entry[1]

    async def set(self, user_id: str, token: str, *, ttl_seconds: int, box: SecretBox) -> None:
        if ttl_seconds <= 0:
            return
        if self._distributed():
            sealed = box.seal(token, context=f"tokens-access:{user_id}")
            await self._redis.client.set(self._key(user_id), sealed, ex=ttl_seconds)  # type: ignore[union-attr]
            return
        self._memory[user_id] = (time.monotonic() + ttl_seconds, token)

    async def delete(self, user_id: str) -> None:
        self._memory.pop(user_id, None)
        if self._distributed():
            await self._redis.client.delete(self._key(user_id))  # type: ignore[union-attr]
