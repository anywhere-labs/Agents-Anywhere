"""Runtime-neutral planning observations. Native request references stay local."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

PlanningMode = Literal["plan", "normal", "unknown"]


@dataclass(frozen=True, slots=True)
class PlanningObservation:
    session_id: str
    kind: Literal[
        "mode",
        "draft",
        "proposal",
        "review_closed",
        "interrupted",
        "execution",
        "progress",
    ]
    native_id: str = ""
    text: str = ""
    append: bool = False
    mode: PlanningMode = "unknown"
    external_session_id: str | None = None
    native_review: Mapping[str, Any] | None = None
    source_turn_id: str | None = None
    expected_revision: int | None = None
    progress: Mapping[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class NativePlanningResult:
    outcome: Literal["applied", "pending", "rejected", "unknown"] = "applied"
    code: str | None = None
    message: str | None = None
    mode: PlanningMode | None = None
    execution: Literal[
        "not_requested", "accepted", "started", "rejected", "unknown"
    ] = "not_requested"
    data: Mapping[str, Any] = field(default_factory=dict)
