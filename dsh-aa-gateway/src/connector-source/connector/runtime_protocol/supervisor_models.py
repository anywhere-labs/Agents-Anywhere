from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from connector.runtime_protocol.models import RuntimeConfig
from connector.runtime_protocol.protocol import AgentRuntime
from connector.runtime_protocol.provider import RuntimeProvider

RuntimeLifecycleStatus = Literal[
    "stopped",
    "discovering",
    "available",
    "unavailable",
    "validating",
    "starting",
    "running",
    "stopping",
    "error",
]

RuntimeStatusSink = Callable[
    [str, RuntimeLifecycleStatus, Mapping[str, Any] | None],
    Awaitable[None],
]


class Missing:
    pass


MISSING = Missing()


@dataclass(frozen=True, slots=True)
class RuntimeSupervisorEntry:
    provider: RuntimeProvider
    runtime: AgentRuntime | None = None
    config: RuntimeConfig | None = None
    requested_values: Mapping[str, Any] | None = None
    status: RuntimeLifecycleStatus = "stopped"
    error: Mapping[str, Any] | None = None


def error_payload(exc: BaseException) -> dict[str, Any]:
    return {
        "code": getattr(exc, "code", None) or exc.__class__.__name__,
        "message": str(exc) or exc.__class__.__name__,
        "retryable": bool(getattr(exc, "retryable", False)),
    }


def same_effective_config(left: RuntimeConfig | None, right: RuntimeConfig) -> bool:
    if left is None:
        return False
    return (
        left.runtime == right.runtime
        and left.revision == right.revision
        and dict(left.values) == dict(right.values)
    )
