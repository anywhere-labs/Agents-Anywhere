from __future__ import annotations

import json
from typing import Any, Literal

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from pydantic import BaseModel, ConfigDict, Field, field_validator

from agent_server.core.runtime_identity import (
    RuntimeId,
    RuntimeTypeId,
    normalize_runtime_instance_name,
)

RuntimeStatus = Literal[
    "stopped",
    "discovering",
    "available",
    "unavailable",
    "validating",
    "starting",
    "running",
    "stopping",
    "error",
    "unknown",
]
_MAX_SCHEMA_BYTES = 256 * 1024


class RuntimeTypeDescriptor(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runtimeType: RuntimeTypeId
    displayName: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=1024)
    recommended: bool = False
    recommendationRank: int | None = Field(default=None, ge=0)
    discovery: dict[str, Any] = Field(default_factory=dict)
    schema_: dict[str, Any] | None = Field(default=None, alias="schema")
    uiSchema: dict[str, Any] | None = None
    defaults: dict[str, Any] = Field(default_factory=dict)
    capabilities: dict[str, bool] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("discovery")
    @classmethod
    def _validate_discovery(cls, value: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(value.get("available"), bool):
            raise ValueError(  # noqa: TRY004 - Pydantic validators require ValueError.
                "runtime type discovery.available must be a boolean"
            )
        return value

    @property
    def available(self) -> bool:
        return bool(self.discovery["available"])


class RuntimeTypeCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runtimeTypes: list[RuntimeTypeDescriptor] = Field(default_factory=list, max_length=64)


class RuntimeTypeView(BaseModel):
    connectorId: str
    runtimeType: RuntimeTypeId
    displayName: str
    description: str | None
    available: bool
    recommended: bool
    recommendationRank: int | None
    discovery: dict[str, Any]
    schema_: dict[str, Any] | None = Field(default=None, alias="schema")
    uiSchema: dict[str, Any]
    defaults: dict[str, Any]
    capabilities: dict[str, bool]
    metadata: dict[str, Any]
    lastDiscoveredAt: str
    updatedAt: str

    model_config = ConfigDict(populate_by_name=True)


class RuntimeTypeListResponse(BaseModel):
    connectorId: str
    runtimeTypes: list[RuntimeTypeView]
    serverTime: str


class DeviceRuntimeView(BaseModel):
    connectorId: str
    runtimeId: RuntimeId
    runtimeType: RuntimeTypeId
    name: str
    # Temporary mobile compatibility alias. New clients should use name.
    displayName: str
    typeDisplayName: str
    configured: bool
    active: bool
    status: RuntimeStatus
    config: dict[str, Any] | None
    error: dict[str, Any] | None
    available: bool
    schema_: dict[str, Any] | None = Field(default=None, alias="schema")
    uiSchema: dict[str, Any]
    defaults: dict[str, Any]
    capabilities: dict[str, bool]
    createdAt: str
    updatedAt: str

    model_config = ConfigDict(populate_by_name=True)


class DeviceRuntimeListResponse(BaseModel):
    connectorId: str
    runtimes: list[DeviceRuntimeView]
    serverTime: str


class RuntimeInstanceCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runtimeType: RuntimeTypeId
    name: str = Field(min_length=1, max_length=128)
    config: dict[str, Any] = Field(default_factory=dict)
    active: bool = True

    @field_validator("name")
    @classmethod
    def _normalize_name(cls, value: str) -> str:
        return normalize_runtime_instance_name(value)


class RuntimeInstancePatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=128)

    @field_validator("name")
    @classmethod
    def _normalize_name(cls, value: str) -> str:
        return normalize_runtime_instance_name(value)


class RuntimeConfigPutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    config: dict[str, Any] = Field(default_factory=dict)


class RuntimeActivePutRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    active: bool


class RuntimeConfigIssue(BaseModel):
    path: str
    message: str
    validator: str | None = None


class RuntimeConfigValidationError(ValueError):
    def __init__(self, issues: list[RuntimeConfigIssue]) -> None:
        super().__init__(issues[0].message if issues else "runtime config is invalid")
        self.issues = issues


def validate_config_schema(raw: dict[str, Any]) -> dict[str, Any]:
    encoded = json.dumps(raw, ensure_ascii=False, separators=(",", ":")).encode()
    if len(encoded) > _MAX_SCHEMA_BYTES:
        raise ValueError("runtime config schema is too large")
    if raw.get("type") != "object":
        raise ValueError("runtime config schema root type must be object")
    _reject_remote_refs(raw)
    try:
        Draft202012Validator.check_schema(raw)
    except SchemaError as exc:
        raise ValueError(f"invalid runtime config schema: {exc.message}") from exc
    return raw


def validate_config(config: dict[str, Any], schema: dict[str, Any]) -> None:
    validator = Draft202012Validator(schema)
    errors = sorted(
        validator.iter_errors(config), key=lambda error: list(error.absolute_path)
    )
    if not errors:
        return
    issues = [
        RuntimeConfigIssue(
            path=_json_pointer(error.absolute_path),
            message=error.message,
            validator=str(error.validator) if error.validator is not None else None,
        )
        for error in errors
    ]
    raise RuntimeConfigValidationError(issues)


def _reject_remote_refs(value: Any) -> None:
    if isinstance(value, dict):
        for key, nested in value.items():
            if (
                key in {"$ref", "$dynamicRef"}
                and isinstance(nested, str)
                and not nested.startswith("#")
            ):
                raise ValueError("remote schema references are not supported")
            _reject_remote_refs(nested)
    elif isinstance(value, list):
        for nested in value:
            _reject_remote_refs(nested)


def _json_pointer(path: Any) -> str:
    parts = [str(part).replace("~", "~0").replace("/", "~1") for part in path]
    return "/" + "/".join(parts) if parts else ""
