from __future__ import annotations

import asyncio

from agent_server.core.models import SessionRuntimeState


class SessionRuntimeStateCache:
    def __init__(self) -> None:
        self._states: dict[str, SessionRuntimeState] = {}
        self._lock = asyncio.Lock()

    async def put(self, state: SessionRuntimeState) -> None:
        """Store the latest runtime-owned state for this server process.

        Side effects:
        - updates the in-memory session runtime state cache.
        """

        async with self._lock:
            self._states[state.sessionId] = state

    async def get(self, session_id: str) -> SessionRuntimeState | None:
        async with self._lock:
            return self._states.get(session_id)

    async def discard(self, session_id: str) -> None:
        """Remove one cached runtime state.

        Side effects:
        - deletes an in-memory runtime state entry if present.
        """

        async with self._lock:
            self._states.pop(session_id, None)
