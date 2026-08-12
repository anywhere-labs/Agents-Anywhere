from __future__ import annotations

import asyncio
import hashlib
import time
from dataclasses import dataclass, field

from connector.runtime_protocol import RuntimeTimelineItem


@dataclass(slots=True)
class ClaudeExecution:
    turn_id: str
    started_at_monotonic: float = field(default_factory=time.monotonic)
    task: asyncio.Task[None] | None = None
    client: object | None = None
    interrupt_source: str | None = None
    interrupt_reason: str | None = None
    finalization_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    finished: asyncio.Event = field(default_factory=asyncio.Event)


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
    execution: ClaudeExecution | None = None
    execution_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def active_turn_id(self) -> str | None:
        execution = self.execution
        return execution.turn_id if execution is not None else None

    @property
    def active_turn_started_at_monotonic(self) -> float | None:
        execution = self.execution
        return execution.started_at_monotonic if execution is not None else None

    @property
    def active_task(self) -> asyncio.Task[None] | None:
        execution = self.execution
        return execution.task if execution is not None else None


def stable_session_id(connector_id: str, external_session_id: str) -> str:
    digest = hashlib.sha256(
        f"{connector_id}:claude:{external_session_id}".encode()
    ).hexdigest()[:24]
    return f"sess_claude_{digest}"
