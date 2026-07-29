from __future__ import annotations

import asyncio
import math
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import WatchError


class RedisCoordinator:
    def __init__(
        self,
        url: str | None = None,
        *,
        prefix: str = "agents-anywhere",
        client: Any | None = None,
    ) -> None:
        self.url = url
        self.prefix = prefix.strip(":") or "agents-anywhere"
        self._client = client or (
            Redis.from_url(url, encoding="utf-8", decode_responses=True)
            if url
            else None
        )
        self._owns_client = client is None and self._client is not None
        self._local_locks: dict[str, asyncio.Lock] = {}
        self._local_locks_guard = asyncio.Lock()

    @property
    def distributed(self) -> bool:
        return self._client is not None

    @property
    def client(self) -> Any:
        if self._client is None:
            raise RuntimeError("Redis is not configured")
        return self._client

    async def start(self) -> None:
        if self._client is not None:
            await self._client.ping()

    async def close(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()

    def key(self, *parts: str) -> str:
        return ":".join((self.prefix, *(str(part) for part in parts)))

    def channel(self, *parts: str) -> str:
        return self.key("channel", *parts)

    @asynccontextmanager
    async def lock(
        self,
        name: str,
        *,
        timeout_seconds: float = 300,
    ) -> AsyncIterator[None]:
        if self._client is None:
            lock = await self._local_lock(name)
            async with lock:
                yield
            return

        lock_key = self.key("lock", name)
        token = secrets.token_urlsafe(32)
        deadline = time.monotonic() + timeout_seconds
        ttl_ms = max(1, math.ceil(timeout_seconds * 1000))
        while not await self._client.set(lock_key, token, nx=True, px=ttl_ms):
            if time.monotonic() >= deadline:
                raise TimeoutError(f"timed out acquiring distributed lock: {name}")
            await asyncio.sleep(min(0.1, max(0, deadline - time.monotonic())))
        try:
            yield
        finally:
            await self._release_lock(lock_key, token)

    async def _release_lock(self, lock_key: str, token: str) -> None:
        while True:
            async with self.client.pipeline(transaction=True) as pipeline:
                try:
                    await pipeline.watch(lock_key)
                    if await pipeline.get(lock_key) != token:
                        raise RuntimeError(
                            f"distributed lock is no longer owned: {lock_key}"
                        )
                    pipeline.multi()
                    pipeline.delete(lock_key)
                    await pipeline.execute()
                    return
                except WatchError:
                    continue

    async def _local_lock(self, name: str) -> asyncio.Lock:
        async with self._local_locks_guard:
            lock = self._local_locks.get(name)
            if lock is None:
                lock = asyncio.Lock()
                self._local_locks[name] = lock
            return lock
