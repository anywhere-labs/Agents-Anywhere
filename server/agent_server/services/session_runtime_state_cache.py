from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack, asynccontextmanager

from agent_server.core.models import SessionRuntimeState
from agent_server.infra.redis_coordinator import RedisCoordinator

# Runtime state is reconstructible from the runtime/persisted session status.
# Pending timeline writes use a different store and are never TTL-evicted here.
_STATE_TTL_SECONDS = 24 * 60 * 60
_PUT_STATE = """
local old = redis.call('GET', KEYS[1])
if old and tonumber(cjson.decode(old).updatedSeq) > tonumber(ARGV[2]) then
    return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
return 1
"""


class SessionRuntimeStateCache:
    def __init__(self, coordinator: RedisCoordinator | None = None) -> None:
        self._coordinator = coordinator or RedisCoordinator()
        self._states: dict[str, SessionRuntimeState] = {}
        self._lock = asyncio.Lock()
        self._put_script = None
        self._refreshing: set[str] = set()

    async def put(self, state: SessionRuntimeState) -> None:
        """Share runtime-owned state; reject older sequences, allow equal ones."""
        if self._coordinator.distributed:
            if self._put_script is None:
                self._put_script = self._coordinator.client.register_script(_PUT_STATE)
            await self._put_script(
                keys=[self._key(state.sessionId)],
                args=[state.model_dump_json(), state.updatedSeq, _STATE_TTL_SECONDS],
            )
            return
        async with self._lock:
            current = self._states.get(state.sessionId)
            if current is not None and current.updatedSeq > state.updatedSeq:
                return
            self._states[state.sessionId] = state

    async def get(self, session_id: str) -> SessionRuntimeState | None:
        return (await self.get_many([session_id])).get(session_id)

    async def get_many(self, session_ids: list[str]) -> dict[str, SessionRuntimeState]:
        if not session_ids:
            return {}
        ids = list(dict.fromkeys(session_ids))
        if self._coordinator.distributed:
            values = await self._coordinator.client.mget(
                [self._key(value) for value in ids]
            )
            return {
                session_id: SessionRuntimeState.model_validate_json(raw)
                for session_id, raw in zip(ids, values, strict=True)
                if raw is not None
            }
        async with self._lock:
            return {key: self._states[key] for key in ids if key in self._states}

    async def discard(self, session_id: str) -> None:
        """Remove one cached runtime state from the shared or local store."""
        if self._coordinator.distributed:
            await self._coordinator.client.delete(self._key(session_id))
            return
        async with self._lock:
            self._states.pop(session_id, None)

    def _key(self, session_id: str) -> str:
        return self._coordinator.key("session-runtime-state", session_id)

    @asynccontextmanager
    async def refresh_guard(self, session_id: str):
        """Skip duplicate background RPCs without holding a session write fence."""
        if self._coordinator.distributed:
            async with AsyncExitStack() as stack:
                try:
                    await stack.enter_async_context(
                        self._coordinator.lock(
                            f"runtime-state-refresh:{session_id}",
                            timeout_seconds=0,
                            lease_seconds=30,
                        )
                    )
                except TimeoutError:
                    yield False
                    return
                yield True
            return
        if session_id in self._refreshing:
            yield False
            return
        self._refreshing.add(session_id)
        try:
            yield True
        finally:
            self._refreshing.discard(session_id)
