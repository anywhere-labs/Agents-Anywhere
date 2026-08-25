from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from connector.runtime_protocol.models import RuntimeConfigSchema

MAX_CONFIG_REVISION = 9_007_199_254_740_991

RuntimeInstancePolicy = Literal["singleton", "multiple"]
RuntimeInstanceLifecycleStatus = Literal[
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
RuntimeResourceMode = Literal["exclusive"]

_INSTANCE_POLICIES = frozenset({"singleton", "multiple"})
_INSTANCE_LIFECYCLE_STATUSES = frozenset(
    {
        "stopped",
        "discovering",
        "available",
        "unavailable",
        "validating",
        "starting",
        "running",
        "stopping",
        "error",
    }
)


def _require_non_blank(value: str, field_name: str) -> None:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if not value.strip():
        raise ValueError(f"{field_name} must not be empty")


def _validate_config_revision(revision: int) -> None:
    if isinstance(revision, bool) or not isinstance(revision, int):
        raise TypeError("config_revision must be an integer")
    if not 0 <= revision <= MAX_CONFIG_REVISION:
        raise ValueError(
            f"config_revision must be between 0 and {MAX_CONFIG_REVISION}, inclusive"
        )


@dataclass(frozen=True, slots=True)
class RuntimeTypeDescriptor:
    """Provider-owned facts for one stable runtime type.

    ``runtime_type`` is the provider key, such as ``codex`` or ``dsh``. It must
    not be reused for an implementation or transport category.
    """

    runtime_type: str
    display_name: str
    available: bool
    description: str | None = None
    recommended: bool = False
    recommendation_rank: int | None = None
    capabilities: Mapping[str, bool] = field(default_factory=dict)
    reason: str | None = None
    config_schema: RuntimeConfigSchema | None = None
    instance_policy: RuntimeInstancePolicy = "singleton"
    max_instances: int | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_non_blank(self.runtime_type, "runtime_type")
        _require_non_blank(self.display_name, "display_name")
        if self.instance_policy not in _INSTANCE_POLICIES:
            raise ValueError(f"unsupported instance_policy: {self.instance_policy!r}")
        if self.max_instances is not None:
            if isinstance(self.max_instances, bool) or not isinstance(
                self.max_instances, int
            ):
                raise TypeError("max_instances must be an integer or None")
            if self.max_instances < 1:
                raise ValueError("max_instances must be greater than zero")
        if self.instance_policy == "singleton" and self.max_instances not in (
            None,
            1,
        ):
            raise ValueError("singleton runtime types cannot exceed one instance")
        if self.instance_policy == "multiple" and self.max_instances == 1:
            raise ValueError("multiple runtime types must allow more than one instance")

    @property
    def effective_max_instances(self) -> int | None:
        if self.instance_policy == "singleton":
            return 1
        return self.max_instances


@dataclass(frozen=True, slots=True)
class RuntimeInstanceSpec:
    """Immutable snapshot of user-owned runtime instance configuration."""

    runtime_id: str
    runtime_type: str
    name: str
    config: Mapping[str, Any] = field(default_factory=dict)
    active: bool = False
    config_revision: int = 0

    def __post_init__(self) -> None:
        _require_non_blank(self.runtime_id, "runtime_id")
        _require_non_blank(self.runtime_type, "runtime_type")
        _require_non_blank(self.name, "name")
        if not isinstance(self.config, Mapping):
            raise TypeError("config must be a mapping")
        if not isinstance(self.active, bool):
            raise TypeError("active must be a boolean")
        _validate_config_revision(self.config_revision)


@dataclass(frozen=True, slots=True)
class RuntimeInstanceStatus:
    """Lifecycle snapshot associated with one instance specification."""

    spec: RuntimeInstanceSpec
    lifecycle: RuntimeInstanceLifecycleStatus
    runtime_version: str | None = None
    protocol_version: str | None = None
    error: Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        if self.lifecycle not in _INSTANCE_LIFECYCLE_STATUSES:
            raise ValueError(f"unsupported lifecycle: {self.lifecycle!r}")
        if self.runtime_version is not None:
            _require_non_blank(self.runtime_version, "runtime_version")
        if self.protocol_version is not None:
            _require_non_blank(self.protocol_version, "protocol_version")
        if self.error is not None and not isinstance(self.error, Mapping):
            raise TypeError("error must be a mapping or None")

    @property
    def runtime_id(self) -> str:
        return self.spec.runtime_id

    @property
    def runtime_type(self) -> str:
        return self.spec.runtime_type


@dataclass(frozen=True, slots=True)
class RuntimeScope:
    runtime_id: str
    runtime_type: str

    def __post_init__(self) -> None:
        _require_non_blank(self.runtime_id, "runtime_id")
        _require_non_blank(self.runtime_type, "runtime_type")

    @property
    def is_legacy(self) -> bool:
        return self.runtime_id == self.runtime_type


def legacy_runtime_scope(runtime_type: str) -> RuntimeScope:
    """Map a legacy provider key to its same-ID compatibility instance."""

    _require_non_blank(runtime_type, "runtime_type")
    return RuntimeScope(runtime_id=runtime_type, runtime_type=runtime_type)


@dataclass(frozen=True, slots=True)
class RuntimeSourceKey:
    """Stable, non-secret identity for a runtime's native session source.

    ``kind`` and ``key`` must be derived from durable source identity only. They
    must not use or embed authentication tokens, transient ports, process IDs,
    or user-editable instance names.
    """

    kind: str
    key: str

    def __post_init__(self) -> None:
        _require_non_blank(self.kind, "kind")
        _require_non_blank(self.key, "key")


@dataclass(frozen=True, slots=True)
class RuntimeResourceClaim:
    kind: str
    key: str
    label: str
    mode: RuntimeResourceMode = "exclusive"

    def __post_init__(self) -> None:
        _require_non_blank(self.kind, "kind")
        _require_non_blank(self.key, "key")
        _require_non_blank(self.label, "label")
        if self.mode != "exclusive":
            raise ValueError(f"unsupported resource claim mode: {self.mode!r}")
