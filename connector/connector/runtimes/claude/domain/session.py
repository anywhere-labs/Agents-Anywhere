from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class ClaudeSession:
    session_id: str
    external_session_id: str | None = None
    cwd: str | None = None
    selections: dict[str, str | None] = field(default_factory=dict)
    active_turn_id: str | None = None
    active_task: asyncio.Task[None] | None = None
    client: Any = None
