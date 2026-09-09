from __future__ import annotations

import asyncio
import math
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from loguru import logger
from redis.asyncio import Redis
from redis.exceptions import RedisError, ResponseError, WatchError

_MAX_LOCAL_LOCKS = 4096
_LOCAL_LOCK_IDLE_SECONDS = 900.0


@dataclass(slots=True)
class LockStats:
    """Counters that attribute lock cost without changing lock behavior.

    ``fence_conflicts`` counts WATCH aborts inside the token-checked
    primitives.  A non-zero value there is the signature of the renewal task
    touching a lock key while another fence is watching it.
    """

    acquisitions: int = 0
    wait_ms_total: float = 0.0
    wait_ms_max: float = 0.0
    hold_ms_total: float = 0.0
    hold_ms_max: float = 0.0
    timeouts: int = 0
    renewal_failures: int = 0
    release_mismatches: int = 0
    fence_conflicts: int = 0


# Token-checked mutations run as one EVALSHA instead of WATCH + GET + MULTI/EXEC.
# The script is atomic, so the ownership check and the mutation cannot be
# separated by the lease renewal task, which writes the same lock key.  A script
# returns -1 when the caller no longer owns the lock, which maps to the same
# RuntimeError the WATCH path raised.
_LOCK_TOKEN_GUARD = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return -1
end
"""

_INCRBY_WHILE_LOCK_OWNED = _LOCK_TOKEN_GUARD + """
return redis.call('INCRBY', KEYS[2], ARGV[2])
"""

_SET_MAX_WHILE_LOCK_OWNED = _LOCK_TOKEN_GUARD + """
local current = redis.call('GET', KEYS[2])
if current and tonumber(current) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
"""

_COMPARE_AND_APPLY = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
local action = ARGV[2]
if action == 'del' then
  redis.call('DEL', KEYS[1])
elseif action == 'set' then
  if ARGV[4] ~= '' then
    redis.call('SET', KEYS[1], ARGV[3], 'PX', tonumber(ARGV[4]))
  else
    redis.call('SET', KEYS[1], ARGV[3])
  end
else
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))
end
return 1
"""

_STORE_PENDING_WHILE_LOCK_OWNED = _LOCK_TOKEN_GUARD + """
if ARGV[2] ~= '' then
  redis.call('SET', KEYS[3], ARGV[2])
end
if ARGV[3] ~= '' then
  redis.call('HSET', KEYS[2], ARGV[3], ARGV[4])
end
if ARGV[5] == '1' then
  redis.call('SET', KEYS[4], '1')
end
redis.call('SADD', KEYS[5], ARGV[6])
return 1
"""

_PUBLISH_WHILE_LOCK_OWNED = _LOCK_TOKEN_GUARD + """
redis.call('PUBLISH', KEYS[2], ARGV[2])
return 1
"""


class RedisCoordinator:
    def __init__(
        self,
        url: str | None = None,
        *,
        prefix: str = "agents-anywhere",
        client: Any | None = None,
        connect_timeout_seconds: float = 5.0,
        health_check_interval_seconds: float = 30.0,
        slow_lock_ms: float = 0.0,
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
        self._local_lock_used: dict[str, float] = {}
        self._held_lock_tokens: ContextVar[dict[str, str] | None] = ContextVar(
            f"redis-coordinator-locks-{id(self)}",
            default=None,
        )
        self.stats = LockStats()
        self._slow_lock_ms = slow_lock_ms
        self._scripts: dict[str, Any] = {}

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
                self.stats.fence_conflicts += 1
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

        token = self._held_token(name)
        result = await self._script(
            "set_max", _SET_MAX_WHILE_LOCK_OWNED
        )(
            keys=[self.key("lock", name), key],
            args=[token, value],
        )
        self._raise_if_lock_lost(name, result)

    async def store_pending_while_lock_owned(
        self,
        name: str,
        *,
        items_key: str,
        source_key: str,
        mark_read_key: str,
        dirty_key: str,
        session_id: str,
        source_observed_at: str | None = None,
        item_id: str | None = None,
        raw_item: str | None = None,
        mark_read_on_change: bool = False,
    ) -> None:
        """Stage one pending timeline projection in a single fenced script."""

        token = self._held_token(name)
        result = await self._script(
            "store_pending", _STORE_PENDING_WHILE_LOCK_OWNED
        )(
            keys=[
                self.key("lock", name),
                items_key,
                source_key,
                mark_read_key,
                dirty_key,
            ],
            args=[
                token,
                source_observed_at or "",
                item_id or "",
                raw_item or "",
                "1" if mark_read_on_change else "0",
                session_id,
            ],
        )
        self._raise_if_lock_lost(name, result)

    async def publish_while_lock_owned(
        self,
        name: str,
        channel: str,
        message: str,
    ) -> None:
        """Publish a live envelope in the same round trip as its fence check."""

        token = self._held_token(name)
        result = await self._script(
            "publish", _PUBLISH_WHILE_LOCK_OWNED
        )(
            keys=[self.key("lock", name), channel],
            args=[token, message],
        )
        self._raise_if_lock_lost(name, result)

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
                    self.stats.fence_conflicts += 1
                    continue

    async def incrby_while_lock_owned(
        self,
        name: str,
        key: str,
        amount: int,
    ) -> int:
        """Increment a counter only if the current task still owns the lock."""

        token = self._held_token(name)
        result = await self._script(
            "incrby", _INCRBY_WHILE_LOCK_OWNED
        )(
            keys=[self.key("lock", name), key],
            args=[token, amount],
        )
        self._raise_if_lock_lost(name, result)
        return int(result)

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
        started_at = time.monotonic()
        deadline = started_at + timeout_seconds
        effective_lease_seconds = lease_seconds or timeout_seconds
        ttl_ms = max(1, math.ceil(effective_lease_seconds * 1000))
        while not await self._client.set(lock_key, token, nx=True, px=ttl_ms):
            if time.monotonic() >= deadline:
                self.stats.timeouts += 1
                raise TimeoutError(f"timed out acquiring distributed lock: {name}")
            await asyncio.sleep(min(0.1, max(0, deadline - time.monotonic())))
        acquired_at = time.monotonic()
        self._record_lock_wait(acquired_at - started_at, name)
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
                        self.stats.renewal_failures += 1
                        if critical_section_active and owner_task is not None:
                            owner_task.cancel()
                        return
            except asyncio.CancelledError:
                raise
            except (OSError, RedisError) as exc:
                renewal_error = exc
                self.stats.renewal_failures += 1
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
                self._record_lock_hold(time.monotonic() - acquired_at, name)
                self._held_lock_tokens.reset(held_locks_token)
        if renewal_error is not None:
            raise RuntimeError(
                f"failed to renew distributed lock: {lock_key}"
            ) from renewal_error
        if release_error is not None:
            raise release_error

    async def _release_lock(self, lock_key: str, token: str) -> None:
        if not await self.delete_if_value(lock_key, token):
            self.stats.release_mismatches += 1
            raise RuntimeError(f"distributed lock is no longer owned: {lock_key}")

    def _record_lock_wait(self, seconds: float, name: str) -> None:
        elapsed_ms = seconds * 1000.0
        self.stats.acquisitions += 1
        self.stats.wait_ms_total += elapsed_ms
        self.stats.wait_ms_max = max(self.stats.wait_ms_max, elapsed_ms)
        if self._slow_lock_ms and elapsed_ms >= self._slow_lock_ms:
            logger.warning(
                "slow lock acquire name={} wait_ms={:.1f}",
                name,
                elapsed_ms,
            )

    def _record_lock_hold(self, seconds: float, name: str) -> None:
        elapsed_ms = seconds * 1000.0
        self.stats.hold_ms_total += elapsed_ms
        self.stats.hold_ms_max = max(self.stats.hold_ms_max, elapsed_ms)
        if self._slow_lock_ms and elapsed_ms >= self._slow_lock_ms:
            logger.warning(
                "slow lock hold name={} hold_ms={:.1f}",
                name,
                elapsed_ms,
            )

    async def _compare_and_apply(
        self,
        key: str,
        expected_value: str,
        *,
        replacement_value: str | None = None,
        expire_ms: int | None = None,
        delete: bool = False,
    ) -> bool:
        if delete:
            action = "del"
        elif replacement_value is not None and expire_ms is not None:
            action = "set"
        elif expire_ms is not None:
            action = "expire"
        else:
            raise ValueError("compare operation requires an action")
        result = await self._script("compare_and_apply", _COMPARE_AND_APPLY)(
            keys=[key],
            args=[
                expected_value,
                action,
                replacement_value or "",
                "" if expire_ms is None else expire_ms,
            ],
        )
        return int(result) == 1

    def _held_token(self, name: str) -> str:
        if self._client is None:
            raise RuntimeError("Redis is not configured")
        token = (self._held_lock_tokens.get() or {}).get(name)
        if token is None:
            raise RuntimeError(f"distributed lock is not held: {name}")
        return token

    def _script(self, name: str, source: str) -> Any:
        script = self._scripts.get(name)
        if script is None:
            script = self.client.register_script(source)
            self._scripts[name] = script
        return script

    def _raise_if_lock_lost(self, name: str, result: Any) -> None:
        if int(result) < 0:
            lock_key = self.key("lock", name)
            self.stats.release_mismatches += 1
            raise RuntimeError(f"distributed lock is no longer owned: {lock_key}")

    async def _local_lock(self, name: str) -> asyncio.Lock:
        async with self._local_locks_guard:
            lock = self._local_locks.get(name)
            if lock is None:
                lock = asyncio.Lock()
                self._local_locks[name] = lock
            self._local_lock_used[name] = time.monotonic()
            if len(self._local_locks) > _MAX_LOCAL_LOCKS:
                self._evict_local_locks_locked()
            return lock

    def _evict_local_locks_locked(self) -> None:
        cutoff = time.monotonic() - _LOCAL_LOCK_IDLE_SECONDS
        removable = [
            name
            for name, lock in self._local_locks.items()
            if not lock.locked() and self._local_lock_used.get(name, 0.0) <= cutoff
        ]
        if not removable:
            removable = [
                name
                for name, lock in self._local_locks.items()
                if not lock.locked()
            ]
        for name in removable:
            self._local_locks.pop(name, None)
            self._local_lock_used.pop(name, None)
