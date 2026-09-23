from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.domain.session import ClaudeSession

KEY = "claude/scheduled/sessions"


@dataclass(slots=True)
class ClaudeScheduledSessions:
    """Remember which AA connections to reopen; Claude owns the actual tasks."""

    host: RuntimeHostClient
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def read(self) -> dict[str, Any]:
        value = await self.host.sync_state_read(KEY)
        return dict(value.get("sessions", {})) if value else {}

    async def save(self, session: ClaudeSession, task_ids: set[str]) -> None:
        if session.external_session_id is None:
            return
        async with self.lock:
            sessions = await self.read()
            if task_ids:
                sessions[session.session_id] = {
                    "externalSessionId": session.external_session_id,
                    "cwd": session.cwd,
                    "selections": dict(session.selections),
                    "taskIds": sorted(task_ids),
                }
            else:
                sessions.pop(session.session_id, None)
            await self.host.sync_state_write(KEY, {"sessions": sessions})
