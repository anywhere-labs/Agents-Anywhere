from __future__ import annotations

import asyncio
import hashlib
import time
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
    active_turn_started_at_monotonic: float | None = None
    active_task: asyncio.Task[None] | None = None
    client: Any = None

    def start_active_turn(self, turn_id: str) -> None:
        self.active_turn_id = turn_id
        self.active_turn_started_at_monotonic = time.monotonic()

    def clear_active_turn(self, turn_id: str | None = None) -> None:
        if turn_id is not None and self.active_turn_id != turn_id:
            return
        self.active_turn_id = None
        self.active_turn_started_at_monotonic = None


def stable_session_id(connector_id: str, external_session_id: str) -> str:
    digest = hashlib.sha256(
        f"{connector_id}:claude:{external_session_id}".encode("utf-8")
    ).hexdigest()[:24]
    return f"sess_claude_{digest}"
