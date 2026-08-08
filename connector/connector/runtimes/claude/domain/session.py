from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem


@dataclass(slots=True)
class ClaudeSession:
    session_id: str
    external_session_id: str | None = None
    title: str | None = None
    cwd: str | None = None
    ordering_time: str | None = None
    selections: dict[str, str | None] = field(default_factory=dict)
    timeline_items: dict[str, RuntimeTimelineItem] = field(default_factory=dict)
    timeline_revision: int = 0
    synced_revision: int = 0
    active_turn_id: str | None = None
    active_task: asyncio.Task[None] | None = None
    client: Any = None
