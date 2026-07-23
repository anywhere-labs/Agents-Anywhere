from __future__ import annotations

import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from connector.logging import logger

_FIELD_ORDER = (
    "method",
    "runtime",
    "session_id",
    "turn_id",
    "connector_id",
    "outcome",
    "command",
)


def elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 1)


def log_stage(stage: str, elapsed_ms_value: float, *, level: str = "info", **fields: Any) -> None:
    parts = [f"stage={stage}", f"elapsed_ms={elapsed_ms_value:.1f}"]
    for key in _FIELD_ORDER:
        value = fields.pop(key, None)
        if value is None or value == "":
            continue
        parts.append(f"{key}={value}")
    for key, value in fields.items():
        if value is None or value == "":
            continue
        parts.append(f"{key}={value}")
    message = " ".join(parts)
    logger.log(level.upper(), message)


class StageTimer:
    """Wall-clock timer for agent invoke stages."""

    __slots__ = ("_started", "_first_timeline_logged")

    def __init__(self, started: float | None = None) -> None:
        self._started = time.perf_counter() if started is None else started
        self._first_timeline_logged = False

    def elapsed_ms(self) -> float:
        return elapsed_ms(self._started)

    def mark(self, stage: str, *, level: str = "info", **fields: Any) -> float:
        value = self.elapsed_ms()
        log_stage(stage, value, level=level, **fields)
        return value

    def mark_first_timeline(self, *, level: str = "info", **fields: Any) -> float | None:
        if self._first_timeline_logged:
            return None
        self._first_timeline_logged = True
        # Prefer explicit alias; default is first assistant text token (TTFB).
        stage = fields.pop("stage_alias", None) or "adapter.first_assistant_token"
        return self.mark(str(stage), level=level, **fields)

    def mark_turn_complete(
        self,
        *,
        outcome: str,
        level: str = "info",
        **fields: Any,
    ) -> float:
        return self.mark("adapter.turn_complete", level=level, outcome=outcome, **fields)

    @contextmanager
    def span(self, stage: str, *, level: str = "info", **fields: Any) -> Iterator[None]:
        started = time.perf_counter()
        try:
            yield
        finally:
            log_stage(stage, elapsed_ms(started), level=level, **fields)


@contextmanager
def span_stage(stage: str, *, level: str = "info", **fields: Any) -> Iterator[None]:
    started = time.perf_counter()
    try:
        yield
    finally:
        log_stage(stage, elapsed_ms(started), level=level, **fields)
