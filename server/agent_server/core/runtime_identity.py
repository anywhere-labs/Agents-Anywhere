"""Stable runtime identity primitives.

``runtime_type`` identifies a provider such as ``codex`` or ``dsh``.
``runtime_id`` identifies one configured instance of that provider.
``ImplementationCategory`` describes how a provider is implemented and is not
part of either identity. Legacy ``sessions.runtime`` values remain runtime
types; they are never inferred to be instance IDs.
"""

from __future__ import annotations

import re
import secrets
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from typing import NewType, Self

RuntimeTypeId = NewType("RuntimeTypeId", str)
RuntimeInstanceId = NewType("RuntimeInstanceId", str)
ImplementationCategory = NewType("ImplementationCategory", str)

KNOWN_RUNTIME_TYPES = frozenset({"codex", "claude", "opencode", "acp", "dsh"})
MAX_RUNTIME_TYPE_LENGTH = 64
MAX_RUNTIME_INSTANCE_ID_LENGTH = 128
MAX_RUNTIME_INSTANCE_NAME_LENGTH = 128

_NORMALIZED_KEY_RE = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_RUNTIME_INSTANCE_ID_RE = re.compile(
    rf"^rti_[A-Za-z0-9_-]{{1,{MAX_RUNTIME_INSTANCE_ID_LENGTH - 4}}}$"
)
_WHITESPACE_RE = re.compile(r"\s+")
_RESERVED_RUNTIME_TYPE_PREFIX = "rti_"


class RuntimeIdentityError(ValueError):
    """Raised when a runtime identity value is not canonical or valid."""


class SessionRuntimeBindingError(ValueError):
    """Raised when a Connector response conflicts with its bound session."""


def validate_runtime_type(value: str) -> RuntimeTypeId:
    """Validate a canonical provider key without changing its identity."""

    normalized = _validate_normalized_key(
        value,
        label="runtime type",
        max_length=MAX_RUNTIME_TYPE_LENGTH,
    )
    if normalized.startswith(_RESERVED_RUNTIME_TYPE_PREFIX):
        raise RuntimeIdentityError("runtime type uses the reserved rti_ prefix")
    return RuntimeTypeId(normalized)


def validate_implementation_category(value: str) -> ImplementationCategory:
    """Validate non-identity implementation metadata such as local-service."""

    return ImplementationCategory(
        _validate_normalized_key(
            value,
            label="implementation category",
            max_length=MAX_RUNTIME_TYPE_LENGTH,
        )
    )


def validate_runtime_instance_id(
    value: str,
    *,
    runtime_type: str,
) -> RuntimeInstanceId:
    """Validate a type-equal legacy ID or an opaque ``rti_*`` instance ID."""

    validated_type = validate_runtime_type(runtime_type)
    _require_string(value, label="runtime instance ID")
    if _contains_control_character(value):
        raise RuntimeIdentityError("runtime instance ID contains control characters")
    if value != value.strip() or any(character.isspace() for character in value):
        raise RuntimeIdentityError("runtime instance ID contains whitespace")
    if value == validated_type:
        return RuntimeInstanceId(value)
    if len(value) > MAX_RUNTIME_INSTANCE_ID_LENGTH:
        raise RuntimeIdentityError("runtime instance ID is too long")
    if not _RUNTIME_INSTANCE_ID_RE.fullmatch(value):
        raise RuntimeIdentityError(
            "runtime instance ID must equal runtime type or use the rti_ format"
        )
    return RuntimeInstanceId(value)


def generate_runtime_instance_id() -> RuntimeInstanceId:
    """Generate an opaque instance ID with no provider or display-name input."""

    return RuntimeInstanceId(f"rti_{secrets.token_urlsafe(12)}")


def normalize_runtime_instance_name(value: str) -> str:
    """Return the canonical display form of a user-provided instance name."""

    _require_string(value, label="runtime instance name")
    if _contains_control_character(value):
        raise RuntimeIdentityError("runtime instance name contains control characters")
    normalized = unicodedata.normalize("NFKC", value).strip()
    normalized = _WHITESPACE_RE.sub(" ", normalized)
    if not normalized:
        raise RuntimeIdentityError("runtime instance name is required")
    if _contains_control_character(normalized):
        raise RuntimeIdentityError("runtime instance name contains control characters")
    if len(normalized) > MAX_RUNTIME_INSTANCE_NAME_LENGTH:
        raise RuntimeIdentityError("runtime instance name is too long")
    return normalized


def runtime_instance_name_key(value: str) -> str:
    """Return a stable, Unicode-aware key for name uniqueness checks."""

    return normalize_runtime_instance_name(value).casefold()


@dataclass(frozen=True, slots=True)
class RuntimeIdentity:
    """Immutable provider and instance identity pair."""

    runtime_type: RuntimeTypeId
    runtime_id: RuntimeInstanceId

    def __post_init__(self) -> None:
        runtime_type, runtime_id = _validate_identity_pair(
            str(self.runtime_type),
            str(self.runtime_id),
        )
        object.__setattr__(self, "runtime_type", runtime_type)
        object.__setattr__(self, "runtime_id", runtime_id)

    @classmethod
    def create(cls, *, runtime_type: str, runtime_id: str) -> Self:
        validated_type, validated_id = _validate_identity_pair(
            runtime_type,
            runtime_id,
        )
        return cls(runtime_type=validated_type, runtime_id=validated_id)

    @property
    def is_legacy(self) -> bool:
        return self.runtime_id == self.runtime_type

    def scope(self) -> RuntimeScope:
        return RuntimeScope(
            runtime_type=self.runtime_type,
            runtime_id=self.runtime_id,
        )


@dataclass(frozen=True, slots=True)
class RuntimeScope:
    """Immutable runtime routing scope carried across service boundaries."""

    runtime_type: RuntimeTypeId
    runtime_id: RuntimeInstanceId

    def __post_init__(self) -> None:
        runtime_type, runtime_id = _validate_identity_pair(
            str(self.runtime_type),
            str(self.runtime_id),
        )
        object.__setattr__(self, "runtime_type", runtime_type)
        object.__setattr__(self, "runtime_id", runtime_id)

    @classmethod
    def create(cls, *, runtime_type: str, runtime_id: str) -> Self:
        validated_type, validated_id = _validate_identity_pair(
            runtime_type,
            runtime_id,
        )
        return cls(runtime_type=validated_type, runtime_id=validated_id)

    @classmethod
    def from_identity(cls, identity: RuntimeIdentity) -> Self:
        return cls(
            runtime_type=identity.runtime_type,
            runtime_id=identity.runtime_id,
        )


def legacy_runtime_identity(runtime_type: str) -> RuntimeIdentity:
    """Map legacy ``sessions.runtime`` as a type to its type-equal instance."""

    validated_type = validate_runtime_type(runtime_type)
    return RuntimeIdentity(
        runtime_type=validated_type,
        runtime_id=RuntimeInstanceId(validated_type),
    )


def resolve_session_runtime_binding(
    payload: Mapping[str, object],
    *,
    session_id: str,
    runtime_type: str,
    runtime_id: str,
) -> tuple[str, str, str]:
    """Validate explicit wire identity and fill only fields that are absent."""

    identity = RuntimeIdentity.create(
        runtime_type=runtime_type,
        runtime_id=runtime_id,
    )
    expected = {
        "sessionId": session_id,
        "runtime": str(identity.runtime_type),
        "runtimeId": str(identity.runtime_id),
    }
    for field, expected_value in expected.items():
        if field in payload and payload[field] != expected_value:
            raise SessionRuntimeBindingError(
                f"connector returned {field} that does not match the session binding"
            )
    return expected["sessionId"], expected["runtime"], expected["runtimeId"]


def _validate_identity_pair(
    runtime_type: str,
    runtime_id: str,
) -> tuple[RuntimeTypeId, RuntimeInstanceId]:
    validated_type = validate_runtime_type(runtime_type)
    validated_id = validate_runtime_instance_id(
        runtime_id,
        runtime_type=validated_type,
    )
    return validated_type, validated_id


def _validate_normalized_key(value: str, *, label: str, max_length: int) -> str:
    _require_string(value, label=label)
    if _contains_control_character(value):
        raise RuntimeIdentityError(f"{label} contains control characters")
    if not value:
        raise RuntimeIdentityError(f"{label} is required")
    if len(value) > max_length:
        raise RuntimeIdentityError(f"{label} is too long")
    if value != value.strip() or any(character.isspace() for character in value):
        raise RuntimeIdentityError(f"{label} contains whitespace")
    if value != value.casefold():
        raise RuntimeIdentityError(f"{label} must use unambiguous lowercase ASCII")
    if not _NORMALIZED_KEY_RE.fullmatch(value):
        raise RuntimeIdentityError(f"{label} is not a normalized provider key")
    return value


def _require_string(value: object, *, label: str) -> None:
    if not isinstance(value, str):
        raise RuntimeIdentityError(f"{label} must be a string")


def _contains_control_character(value: str) -> bool:
    return any(
        unicodedata.category(character) in {"Cc", "Cf", "Cs"} for character in value
    )
