from __future__ import annotations

import json
import re
from typing import Any, Literal

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from pydantic import BaseModel, ConfigDict, Field, field_validator


RuntimeStatus = Literal["stopped", "starting", "running", "stopping", "error", "unknown"]
_RUNTIME_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_MAX_SCHEMA_BYTES = 256 * 1024


class RuntimeInventoryItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runtimeId: str
    runtimeType: str = Field(min_length=1, max_length=64)
    displayName: str = Field(min_length=1, max_length=128)
    discovery: dict[str, Any] = Field(default_factory=dict)
    schema_: dict[str, Any] = Field(alias="schema")
    uiSchema: dict[str, Any] = Field(default_factory=dict)
    status: RuntimeStatus = "stopped"

    @field_validator("runtimeId")
    @classmethod
    def _validate_runtime_id(cls, value: str) -> str:
        if not _RUNTIME_ID_RE.fullmatch(value):
            raise ValueError("runtimeId contains unsupported characters")
        return value


class RuntimeInventory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runtimes: list[RuntimeInventoryItem] = Field(default_factory=list, max_length=64)


class DeviceRuntimeView(BaseModel):
    connectorId: str
    runtimeId: str
    runtimeType: str
    displayName: str
    present: bool
    configured: bool
    active: bool
    status: RuntimeStatus
    discovery: dict[str, Any]
    schema_: dict[str, Any] | None = Field(default=None, alias="schema")
    uiSchema: dict[str, Any]
    config: dict[str, Any] | None
    error: dict[str, Any] | None
    lastDiscoveredAt: str
    updatedAt: str

    model_config = ConfigDict(populate_by_name=True)


class DeviceRuntimeListResponse(BaseModel):
    connectorId: str
    runtimes: list[DeviceRuntimeView]
    serverTime: str


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
    errors = sorted(validator.iter_errors(config), key=lambda error: list(error.absolute_path))
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
            if key in {"$ref", "$dynamicRef"} and isinstance(nested, str):
                if not nested.startswith("#"):
                    raise ValueError("remote schema references are not supported")
            _reject_remote_refs(nested)
    elif isinstance(value, list):
        for nested in value:
            _reject_remote_refs(nested)


def _json_pointer(path: Any) -> str:
    parts = [str(part).replace("~", "~0").replace("/", "~1") for part in path]
    return "/" + "/".join(parts) if parts else ""
