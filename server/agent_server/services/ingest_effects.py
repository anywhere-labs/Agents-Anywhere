from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent_server.core.models import NoticeIn


@dataclass
class IngestEffect:
    session_id: str | None = None
    session_ids: list[str] | None = None
    item: dict[str, Any] | None = None
    items: list[dict[str, Any]] | None = None
    runtime_state: dict[str, Any] | None = None
    catalogs: dict[str, dict[str, Any]] | None = None
    notices: list[NoticeIn] | None = None
    timeline_reset: bool = False
    session_changed: bool = False
    protocol_changed: bool = False
    notices_changed: bool = False
    needs_refetch: bool = False
    timeline_pending: bool = False
