from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol.instance_models import (
    RuntimeInstanceLifecycleStatus,
    RuntimeInstanceSpec,
    RuntimeResourceClaim,
)
from connector.runtime_protocol.models import RuntimeConfig
from connector.runtime_protocol.protocol import AgentRuntime
from connector.runtime_protocol.provider import RuntimeProvider

RuntimeLifecycleStatus = RuntimeInstanceLifecycleStatus

RuntimeStatusSink = Callable[
    [str, RuntimeLifecycleStatus, Mapping[str, Any] | None],
    Awaitable[None],
]


class Missing:
    pass


MISSING = Missing()


@dataclass(frozen=True, slots=True)
class RuntimeSupervisorEntry:
    instance: RuntimeInstanceSpec
    provider: RuntimeProvider
    runtime: AgentRuntime | None = None
    config: RuntimeConfig | None = None
    requested_values: Mapping[str, Any] | None = None
    resource_claims: tuple[RuntimeResourceClaim, ...] = ()
    status: RuntimeLifecycleStatus = "stopped"
    error: Mapping[str, Any] | None = None

    @property
    def runtime_id(self) -> str:
        return self.instance.runtime_id

    @property
    def runtime_type(self) -> str:
        return self.instance.runtime_type

    @property
    def name(self) -> str:
        return self.instance.name


def error_payload(exc: BaseException) -> dict[str, Any]:
    return {
        "code": getattr(exc, "code", None) or exc.__class__.__name__,
        "message": str(exc) or exc.__class__.__name__,
        "retryable": bool(getattr(exc, "retryable", False)),
    }


def same_effective_config(left: RuntimeConfig | None, right: RuntimeConfig) -> bool:
    if left is None:
        return False
    return left.runtime == right.runtime and dict(left.values) == dict(right.values)
