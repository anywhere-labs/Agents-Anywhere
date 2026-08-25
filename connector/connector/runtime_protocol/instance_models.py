from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from connector.runtime_protocol.models import RuntimeConfigSchema

MAX_CONFIG_REVISION = 9_007_199_254_740_991
MAX_RUNTIME_TYPE_LENGTH = 64
MAX_RUNTIME_INSTANCE_ID_LENGTH = 128
MAX_RUNTIME_INSTANCE_NAME_LENGTH = 128

RuntimeInstancePolicy = Literal["single", "multiple"]
RuntimeInstanceLifecycleStatus = Literal[
    "stopped",
    "validating",
    "starting",
    "running",
    "stopping",
    "error",
    "unknown",
]
RuntimeResourceMode = Literal["exclusive"]

_NORMALIZED_KEY_RE = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_RUNTIME_INSTANCE_ID_RE = re.compile(
    rf"^rti_[A-Za-z0-9_-]{{1,{MAX_RUNTIME_INSTANCE_ID_LENGTH - 4}}}$"
)
_WHITESPACE_RE = re.compile(r"\s+")
_RESERVED_RUNTIME_TYPE_PREFIX = "rti_"
_INSTANCE_POLICIES = frozenset({"single", "multiple"})
_INSTANCE_LIFECYCLE_STATUSES = frozenset(
    {
        "stopped",
        "validating",
        "starting",
        "running",
        "stopping",
        "error",
        "unknown",
    }
)


def _require_non_blank(value: str, field_name: str) -> None:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if _contains_control_character(value):
        raise ValueError(f"{field_name} contains control characters")
    if not value.strip():
        raise ValueError(f"{field_name} must not be empty")


def _validate_runtime_type(value: str) -> None:
    _validate_normalized_key(
        value,
        field_name="runtime_type",
        max_length=MAX_RUNTIME_TYPE_LENGTH,
    )
    if value.startswith(_RESERVED_RUNTIME_TYPE_PREFIX):
        raise ValueError("runtime_type uses the reserved rti_ prefix")


def _validate_implementation_type(value: str) -> None:
    _validate_normalized_key(
        value,
        field_name="implementation_type",
        max_length=MAX_RUNTIME_TYPE_LENGTH,
    )


def _validate_runtime_id(value: str, *, runtime_type: str) -> None:
    _require_non_blank(value, "runtime_id")
    if value != value.strip() or any(character.isspace() for character in value):
        raise ValueError("runtime_id contains whitespace")
    if value == runtime_type:
        return
    if len(value) > MAX_RUNTIME_INSTANCE_ID_LENGTH:
        raise ValueError("runtime_id is too long")
    if not _RUNTIME_INSTANCE_ID_RE.fullmatch(value):
        raise ValueError("runtime_id must equal runtime_type or use the rti_ format")


def _validate_identity_pair(runtime_type: str, runtime_id: str) -> None:
    _validate_runtime_type(runtime_type)
    _validate_runtime_id(runtime_id, runtime_type=runtime_type)


def _validate_runtime_instance_name(value: str) -> None:
    _require_non_blank(value, "name")
    normalized = unicodedata.normalize("NFKC", value).strip()
    normalized = _WHITESPACE_RE.sub(" ", normalized)
    if value != normalized:
        raise ValueError(
            "name must already be NFKC-normalized, trimmed, and whitespace-collapsed"
        )
    if len(value) > MAX_RUNTIME_INSTANCE_NAME_LENGTH:
        raise ValueError("name is too long")


def _validate_normalized_key(
    value: str,
    *,
    field_name: str,
    max_length: int,
) -> None:
    _require_non_blank(value, field_name)
    if len(value) > max_length:
        raise ValueError(f"{field_name} is too long")
    if value != value.strip() or any(character.isspace() for character in value):
        raise ValueError(f"{field_name} contains whitespace")
    if value != value.casefold():
        raise ValueError(f"{field_name} must use unambiguous lowercase ASCII")
    if not _NORMALIZED_KEY_RE.fullmatch(value):
        raise ValueError(f"{field_name} is not a normalized key")


def _contains_control_character(value: str) -> bool:
    return any(
        unicodedata.category(character) in {"Cc", "Cf", "Cs"} for character in value
    )


def _validate_optional_safe_integer(
    value: int | None,
    *,
    field_name: str,
    minimum: int,
) -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field_name} must be an integer or None")
    if not minimum <= value <= MAX_CONFIG_REVISION:
        raise ValueError(
            f"{field_name} must be between {minimum} and "
            f"{MAX_CONFIG_REVISION}, inclusive"
        )


def _validate_capabilities(capabilities: Mapping[str, bool]) -> None:
    if not isinstance(capabilities, Mapping):
        raise TypeError("capabilities must be a mapping")
    for key, value in capabilities.items():
        _require_non_blank(key, "capability key")
        if not isinstance(value, bool):
            raise TypeError("capability values must be booleans")


@dataclass(frozen=True, slots=True)
class RuntimeTypeDescriptor:
    """Provider-owned facts for one stable runtime type.

    ``runtime_type`` is the provider key, such as ``codex`` or ``dsh``. It must
    not be reused for an implementation or transport category. The optional
    ``implementation_type`` carries that non-identity category instead.
    """

    runtime_type: str
    display_name: str
    available: bool
    description: str | None = None
    implementation_type: str | None = None
    recommended: bool = False
    recommendation_rank: int | None = None
    capabilities: Mapping[str, bool] = field(default_factory=dict)
    reason: str | None = None
    config_schema: RuntimeConfigSchema | None = None
    instance_policy: RuntimeInstancePolicy = "single"
    max_instances: int | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        _validate_runtime_type(self.runtime_type)
        _require_non_blank(self.display_name, "display_name")
        if not isinstance(self.available, bool):
            raise TypeError("available must be a boolean")
        if self.reason is not None:
            _require_non_blank(self.reason, "reason")
        if not self.available and self.reason is None:
            raise ValueError("unavailable runtime types must include a reason")
        if self.implementation_type is not None:
            _validate_implementation_type(self.implementation_type)
        _validate_optional_safe_integer(
            self.recommendation_rank,
            field_name="recommendation_rank",
            minimum=0,
        )
        _validate_capabilities(self.capabilities)
        if self.config_schema is not None:
            if not isinstance(self.config_schema, RuntimeConfigSchema):
                raise TypeError("config_schema must be a RuntimeConfigSchema or None")
            if self.config_schema.runtime != self.runtime_type:
                raise ValueError("config_schema.runtime must equal runtime_type")
        if self.instance_policy not in _INSTANCE_POLICIES:
            raise ValueError(f"unsupported instance_policy: {self.instance_policy!r}")
        _validate_optional_safe_integer(
            self.max_instances,
            field_name="max_instances",
            minimum=1,
        )
        if self.instance_policy == "single" and self.max_instances not in (
            None,
            1,
        ):
            raise ValueError("single runtime types cannot exceed one instance")
        if self.instance_policy == "multiple" and self.max_instances == 1:
            raise ValueError("multiple runtime types must allow more than one instance")

    @property
    def effective_max_instances(self) -> int | None:
        if self.instance_policy == "single":
            return 1
        return self.max_instances


@dataclass(frozen=True, slots=True)
class RuntimeInstanceSpec:
    """Immutable identity and display-name specification for one instance.

    ``name`` is validated but never normalized. Callers must supply the same
    NFKC-normalized, trimmed, and whitespace-collapsed display value used by the
    Server.
    """

    runtime_id: str
    runtime_type: str
    name: str

    def __post_init__(self) -> None:
        _validate_identity_pair(self.runtime_type, self.runtime_id)
        _validate_runtime_instance_name(self.name)


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
        if self.lifecycle == "error":
            if self.error is None:
                raise ValueError("error lifecycle requires an error mapping")
            if not isinstance(self.error, Mapping):
                raise TypeError("error must be a mapping")
        elif self.error is not None:
            raise ValueError("non-error lifecycle cannot include an error mapping")

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
        _validate_identity_pair(self.runtime_type, self.runtime_id)

    @property
    def is_legacy(self) -> bool:
        return self.runtime_id == self.runtime_type


def legacy_runtime_scope(runtime_type: str) -> RuntimeScope:
    """Map a legacy provider key to its same-ID compatibility instance."""

    _validate_runtime_type(runtime_type)
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
