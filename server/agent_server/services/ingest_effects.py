from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class IngestEffect:
    session_id: str | None = None
    item: dict[str, Any] | None = None
    items: list[dict[str, Any]] | None = None
    timeline_reset: bool = False
    session_changed: bool = False
    approvals_changed: bool = False
    notices_changed: bool = False
    needs_refetch: bool = False
