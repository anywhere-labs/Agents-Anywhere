from __future__ import annotations

import asyncio
import math
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from contextvars import ContextVar
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import RedisError, ResponseError, WatchError


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
        self._held_lock_tokens: ContextVar[dict[str, str] | None] = ContextVar(
            f"redis-coordinator-locks-{id(self)}",
            default=None,
        )

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

    async def server_epoch(self) -> str:
        """Return the Redis process identity used to detect stale AOF recovery."""

        if self._client is None:
            return "local"
        try:
            info = await self._client.info(section="server")
        except ResponseError:
            if type(self._client).__module__.startswith("fakeredis"):
                return f"fakeredis:{id(self._client)}"
            raise
        run_id = info.get("run_id") if isinstance(info, dict) else None
        if not isinstance(run_id, str) or not run_id:
            raise RuntimeError("Redis server INFO did not include run_id")
        return run_id

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

    def holds_lock(self, name: str) -> bool:
        """Return whether the current task entered this coordinator lock."""

        return name in (self._held_lock_tokens.get() or {})

    def lock_fence(self, name: str) -> tuple[str, str]:
        """Return the Redis lock key and token owned by the current task."""

        token = (self._held_lock_tokens.get() or {}).get(name)
        if token is None:
            raise RuntimeError(f"distributed lock is not held: {name}")
        return self.key("lock", name), token

    @asynccontextmanager
    async def pipeline_while_lock_owned(
        self,
        name: str,
    ) -> AsyncIterator[Any]:
        """Queue a Redis transaction fenced by the current lock token.

        Watching the lock key and executing the queued commands in ``MULTI``
        prevents a stale owner from mutating pending state or publishing after
        Redis failover lets a new owner acquire the same logical lock.
        """

        if self._client is None:
            raise RuntimeError("Redis is not configured")
        token = (self._held_lock_tokens.get() or {}).get(name)
        if token is None:
            raise RuntimeError(f"distributed lock is not held: {name}")
        lock_key = self.key("lock", name)
        async with self.client.pipeline(transaction=True) as pipeline:
            try:
                await pipeline.watch(lock_key)
                current_token = await pipeline.get(lock_key)
                if isinstance(current_token, bytes):
                    current_token = current_token.decode("utf-8")
                if current_token != token:
                    raise RuntimeError(
                        f"distributed lock is no longer owned: {lock_key}"
                    )
                pipeline.multi()
                yield pipeline
                await pipeline.execute()
            except WatchError as exc:
                raise RuntimeError(
                    f"distributed lock changed during transaction: {lock_key}"
                ) from exc

    async def set_max_while_lock_owned(
        self,
        name: str,
        key: str,
        value: int,
    ) -> None:
        """Atomically raise an integer watermark while the lock is still held."""

        if self._client is None:
            raise RuntimeError("Redis is not configured")
        token = (self._held_lock_tokens.get() or {}).get(name)
        if token is None:
            raise RuntimeError(f"distributed lock is not held: {name}")
        lock_key = self.key("lock", name)
        while True:
            async with self.client.pipeline(transaction=True) as pipeline:
                try:
                    await pipeline.watch(lock_key, key)
                    current_token = await pipeline.get(lock_key)
                    if isinstance(current_token, bytes):
                        current_token = current_token.decode("utf-8")
                    if current_token != token:
                        raise RuntimeError(
                            f"distributed lock is no longer owned: {lock_key}"
                        )
                    current_value = await pipeline.get(key)
                    if current_value is not None and int(current_value) >= value:
                        await pipeline.unwatch()
                        return
                    pipeline.multi()
                    pipeline.set(key, value)
                    await pipeline.execute()
                    return
                except WatchError:
                    continue

    async def seal_counter_range_while_lock_owned(
        self,
        name: str,
        *,
        head_key: str,
        end_key: str,
        epoch_key: str,
        floor: int,
        epoch: str,
    ) -> int:
        """Atomically retire a counter range while fencing a stale owner."""

        if self._client is None:
            raise RuntimeError("Redis is not configured")
        token = (self._held_lock_tokens.get() or {}).get(name)
        if token is None:
            raise RuntimeError(f"distributed lock is not held: {name}")
        if floor < 0:
            raise ValueError("counter range floor must not be negative")
        lock_key = self.key("lock", name)
        while True:
            async with self.client.pipeline(transaction=True) as pipeline:
                try:
                    await pipeline.watch(lock_key, head_key, end_key, epoch_key)
                    current_token = await pipeline.get(lock_key)
                    if isinstance(current_token, bytes):
                        current_token = current_token.decode("utf-8")
                    if current_token != token:
                        raise RuntimeError(
                            f"distributed lock is no longer owned: {lock_key}"
                        )
                    raw_head, raw_end, raw_epoch = await pipeline.mget(
                        head_key,
                        end_key,
                        epoch_key,
                    )
                    counters = [floor]
                    stored_epoch = (
                        raw_epoch.decode("utf-8")
                        if isinstance(raw_epoch, bytes)
                        else raw_epoch
                    )
                    if stored_epoch == epoch:
                        for raw_value in (raw_head, raw_end):
                            if raw_value is None:
                                continue
                            value = int(raw_value)
                            if value < 0:
                                raise RuntimeError("negative Redis counter range value")
                            counters.append(value)
                    sealed = max(counters)
                    pipeline.multi()
                    pipeline.set(head_key, sealed)
                    pipeline.set(end_key, sealed)
                    pipeline.set(epoch_key, epoch)
                    await pipeline.execute()
                    return sealed
                except WatchError:
                    continue

    async def incrby_while_lock_owned(
        self,
        name: str,
        key: str,
        amount: int,
    ) -> int:
        """Increment a counter only if the current task still owns the lock."""

        if self._client is None:
            raise RuntimeError("Redis is not configured")
        token = (self._held_lock_tokens.get() or {}).get(name)
        if token is None:
            raise RuntimeError(f"distributed lock is not held: {name}")
        lock_key = self.key("lock", name)
        while True:
            async with self.client.pipeline(transaction=True) as pipeline:
                try:
                    await pipeline.watch(lock_key)
                    current_token = await pipeline.get(lock_key)
                    if isinstance(current_token, bytes):
                        current_token = current_token.decode("utf-8")
                    if current_token != token:
                        raise RuntimeError(
                            f"distributed lock is no longer owned: {lock_key}"
                        )
                    pipeline.multi()
                    pipeline.incrby(key, amount)
                    result = await pipeline.execute()
                    return int(result[0])
                except WatchError:
                    continue

    @asynccontextmanager
    async def lock(
        self,
        name: str,
        *,
        timeout_seconds: float = 300,
        lease_seconds: float | None = None,
    ) -> AsyncIterator[None]:
        if self._client is None:
            lock = await self._local_lock(name)
            async with lock:
                yield
            return

        lock_key = self.key("lock", name)
        token = secrets.token_urlsafe(32)
        deadline = time.monotonic() + timeout_seconds
        effective_lease_seconds = lease_seconds or timeout_seconds
        ttl_ms = max(1, math.ceil(effective_lease_seconds * 1000))
        while not await self._client.set(lock_key, token, nx=True, px=ttl_ms):
            if time.monotonic() >= deadline:
                raise TimeoutError(f"timed out acquiring distributed lock: {name}")
            await asyncio.sleep(min(0.1, max(0, deadline - time.monotonic())))
        renewal_error: BaseException | None = None
        owner_task = asyncio.current_task()
        critical_section_active = True

        async def renew() -> None:
            nonlocal renewal_error
            interval = max(0.05, min(effective_lease_seconds / 3, 10.0))
            try:
                while True:
                    await asyncio.sleep(interval)
                    if not await self.refresh_if_value(
                        lock_key,
                        token,
                        ttl_seconds=effective_lease_seconds,
                    ):
                        renewal_error = RuntimeError(
                            f"distributed lock is no longer owned: {lock_key}"
                        )
                        if critical_section_active and owner_task is not None:
                            owner_task.cancel()
                        return
            except asyncio.CancelledError:
                raise
            except (OSError, RedisError) as exc:
                renewal_error = exc
                if critical_section_active and owner_task is not None:
                    owner_task.cancel()

        renewal_task = asyncio.create_task(renew(), name=f"redis-lock-renew:{name}")
        held_locks_token = self._held_lock_tokens.set(
            {**(self._held_lock_tokens.get() or {}), name: token}
        )
        release_error: Exception | None = None
        try:
            try:
                yield
            except asyncio.CancelledError:
                if renewal_error is None:
                    raise
        finally:
            critical_section_active = False
            renewal_task.cancel()
            with suppress(asyncio.CancelledError):
                await renewal_task
            try:
                await self._release_lock(lock_key, token)
            except Exception as exc:  # noqa: BLE001 - report renewal cause first
                release_error = exc
            finally:
                self._held_lock_tokens.reset(held_locks_token)
        if renewal_error is not None:
            raise RuntimeError(
                f"failed to renew distributed lock: {lock_key}"
            ) from renewal_error
        if release_error is not None:
            raise release_error

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
