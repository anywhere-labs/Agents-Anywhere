from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import SessionNotice


@dataclass(slots=True)
class PendingClaudeApproval:
    approval_id: str
    future: asyncio.Future[str]
    input_data: dict[str, Any]
    notice: SessionNotice


@dataclass(slots=True)
class ClaudeSession:
    session_id: str
    external_session_id: str | None = None
    cwd: str | None = None
    active_task: asyncio.Task[None] | None = None
    active_turn_id: str | None = None
    client: Any | None = None
    selections: dict[str, str | None] = field(default_factory=dict)
    pending_approvals: dict[str, PendingClaudeApproval] = field(default_factory=dict)


async def maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value
