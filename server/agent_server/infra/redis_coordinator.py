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
        connect_timeout_seconds: float = 5.0,
        health_check_interval_seconds: float = 30.0,
    ) -> None:
        self.url = url
        self.prefix = prefix.strip(":") or "agents-anywhere"
        self._client = client or (
            Redis.from_url(
                url,
                encoding="utf-8",
                decode_responses=True,
                socket_connect_timeout=connect_timeout_seconds,
                health_check_interval=health_check_interval_seconds,
            )
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
            await self.ping()

    async def ping(self, *, timeout_seconds: float = 2.0) -> None:
        if self._client is None:
            return
        await asyncio.wait_for(self._client.ping(), timeout=timeout_seconds)

    async def close(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()

    def key(self, *parts: str) -> str:
        return ":".join((self.prefix, *(str(part) for part in parts)))

    def channel(self, *parts: str) -> str:
        return self.key("channel", *parts)

    async def claim(self, key: str, value: str, *, ttl_seconds: float) -> bool:
        if self._client is None:
            raise RuntimeError("Redis is not configured")
        ttl_ms = max(1, math.ceil(ttl_seconds * 1000))
        return bool(await self._client.set(key, value, nx=True, px=ttl_ms))

    async def refresh_if_value(
        self,
        key: str,
        value: str,
        *,
        ttl_seconds: float,
    ) -> bool:
        ttl_ms = max(1, math.ceil(ttl_seconds * 1000))
        return await self._compare_and_apply(key, value, expire_ms=ttl_ms)

    async def replace_if_value(
        self,
        key: str,
        expected_value: str,
        replacement_value: str,
        *,
        ttl_seconds: float,
    ) -> bool:
        ttl_ms = max(1, math.ceil(ttl_seconds * 1000))
        return await self._compare_and_apply(
            key,
            expected_value,
            replacement_value=replacement_value,
            expire_ms=ttl_ms,
        )

    async def delete_if_value(self, key: str, value: str) -> bool:
        return await self._compare_and_apply(key, value, delete=True)

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
        if not await self.delete_if_value(lock_key, token):
            raise RuntimeError(f"distributed lock is no longer owned: {lock_key}")

    async def _compare_and_apply(
        self,
        key: str,
        expected_value: str,
        *,
        replacement_value: str | None = None,
        expire_ms: int | None = None,
        delete: bool = False,
    ) -> bool:
        while True:
            async with self.client.pipeline(transaction=True) as pipeline:
                try:
                    await pipeline.watch(key)
                    if await pipeline.get(key) != expected_value:
                        return False
                    pipeline.multi()
                    if delete:
                        pipeline.delete(key)
                    elif replacement_value is not None and expire_ms is not None:
                        pipeline.set(key, replacement_value, px=expire_ms)
                    elif expire_ms is not None:
                        pipeline.pexpire(key, expire_ms)
                    else:
                        raise ValueError("compare operation requires an action")
                    await pipeline.execute()
                    return True
                except WatchError:
                    continue

    async def _local_lock(self, name: str) -> asyncio.Lock:
        async with self._local_locks_guard:
            lock = self._local_locks.get(name)
            if lock is None:
                lock = asyncio.Lock()
                self._local_locks[name] = lock
            return lock
