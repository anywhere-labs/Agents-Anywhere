from __future__ import annotations

import math
import os
from dataclasses import dataclass


def _integer(name: str, default: int, minimum: int) -> int:
    value = int(os.environ.get(name, str(default)))
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


MIN_MALLOC_TRIM_INTERVAL_SECONDS = 30.0


def _malloc_trim_interval(name: str) -> float:
    """0 (the default) disables trimming; anything else must be >= 30 seconds."""

    raw = os.environ.get(name, "").strip()
    value = float(raw) if raw else 0.0
    if value != 0 and not (
        math.isfinite(value) and value >= MIN_MALLOC_TRIM_INTERVAL_SECONDS
    ):
        raise ValueError(
            f"{name} must be 0 (disabled) or at least "
            f"{MIN_MALLOC_TRIM_INTERVAL_SECONDS:g} seconds"
        )
    return value


@dataclass(frozen=True, slots=True)
class ProcessSettings:
    workers: int
    event_workers: int
    single_instance: bool
    host: str
    port: int
    malloc_trim_interval_seconds: float = 0.0

    @classmethod
    def from_environment(cls) -> ProcessSettings:
        return cls(
            workers=_integer("AGENT_SERVER_WORKERS", 1, 1),
            event_workers=_integer("AGENT_SERVER_EVENT_WORKERS", 2, 0),
            single_instance=os.environ.get(
                "AGENT_SERVER_TIMELINE_SINGLE_INSTANCE",
                "",
            )
            .strip()
            .lower()
            in {"1", "true", "yes"},
            host=os.environ.get("AGENT_SERVER_HOST", "127.0.0.1"),
            port=_integer("AGENT_SERVER_PORT", 8000, 1),
            malloc_trim_interval_seconds=_malloc_trim_interval(
                "AGENT_SERVER_MALLOC_TRIM_INTERVAL_SECONDS"
            ),
        )

    def validate_shared_state(self, *, redis_configured: bool) -> None:
        if self.workers > 1 and not redis_configured:
            raise ValueError("AGENT_SERVER_WORKERS > 1 requires AGENT_SERVER_REDIS_URL")
        if self.workers > 1 and self.single_instance:
            raise ValueError(
                "AGENT_SERVER_TIMELINE_SINGLE_INSTANCE cannot be used with multiple workers"
            )

    def instance_id(self) -> str | None:
        configured = os.environ.get("AGENT_SERVER_INSTANCE_ID")
        if configured and self.workers > 1:
            return f"{configured}-{os.getpid()}"
        return configured
