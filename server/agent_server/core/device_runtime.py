from __future__ import annotations

import json
from typing import Any, Literal

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from agent_server.core.model_connection import (
    Maturity,
    ModelConnectionCapability,
    connection_status,
)
from agent_server.core.runtime_identity import (
    RuntimeIdentityError,
    normalize_runtime_instance_name,
    validate_implementation_category,
    validate_runtime_type,
)
from agent_server.core.secret_fields import (
    redact_config,
    scrub,
    secret_paths,
    secret_values,
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
MAX_JAVASCRIPT_SAFE_INTEGER = 9_007_199_254_740_991


class RuntimeConfigSchemaDescriptor(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, strict=True)

    revision: int = Field(ge=0, le=MAX_JAVASCRIPT_SAFE_INTEGER)
    schema_: dict[str, Any] = Field(alias="schema")
    uiSchema: dict[str, Any] | None
    defaults: dict[str, Any]
    metadata: dict[str, Any]

    @field_validator("schema_")
    @classmethod
    def _validate_schema(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_config_schema(value)


class RuntimeTypeDescriptor(BaseModel):
    """Runtime Control 2.0 provider-owned discovery facts."""

    model_config = ConfigDict(extra="forbid", strict=True)

    runtimeType: str
    displayName: str = Field(min_length=1, max_length=128)
    description: str | None = Field(max_length=1024)
    available: bool
    reason: str | None = Field(min_length=1, max_length=1024)
    recommended: bool
    recommendationRank: int | None = Field(
        ge=0,
        le=MAX_JAVASCRIPT_SAFE_INTEGER,
    )
    implementationType: str | None
    configSchema: RuntimeConfigSchemaDescriptor | None
    capabilities: dict[str, bool]
    metadata: dict[str, Any]
    instancePolicy: Literal["single", "multiple"]
    maxInstances: int | None = Field(
        ge=1,
        le=MAX_JAVASCRIPT_SAFE_INTEGER,
    )
    # Absent from older Connectors; a runtime without it is stable.
    maturity: Maturity | None = None
    # Absent when the runtime takes no model connection.
    modelConnection: ModelConnectionCapability | None = None

    @field_validator("runtimeType")
    @classmethod
    def _validate_runtime_type(cls, value: str) -> str:
        try:
            return str(validate_runtime_type(value))
        except RuntimeIdentityError as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("implementationType")
    @classmethod
    def _validate_implementation_type(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            return str(validate_implementation_category(value))
        except RuntimeIdentityError as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("capabilities")
    @classmethod
    def _validate_capabilities(cls, value: dict[str, bool]) -> dict[str, bool]:
        if any(not key for key in value):
            raise ValueError("runtime capability keys must not be empty")
        return value

    @model_validator(mode="after")
    def _validate_descriptor_invariants(self) -> RuntimeTypeDescriptor:
        if not self.available and self.reason is None:
            raise ValueError("unavailable runtime types must include a reason")
        if self.instancePolicy == "single" and self.maxInstances != 1:
            raise ValueError("single runtime types must set maxInstances to 1")
        if self.instancePolicy == "multiple" and self.maxInstances == 1:
            raise ValueError("multiple runtime types must allow at least two instances")
        return self


class RuntimeDiscoveryResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    runtimeTypes: list[RuntimeTypeDescriptor] = Field(max_length=64)

    @model_validator(mode="after")
    def _validate_unique_runtime_types(self) -> RuntimeDiscoveryResponse:
        runtime_types = [descriptor.runtimeType for descriptor in self.runtimeTypes]
        if len(runtime_types) != len(set(runtime_types)):
            raise ValueError("runtime discovery contains duplicate runtime types")
        return self


class RuntimeTypeView(BaseModel):
    connectorId: str
    runtimeType: str
    implementationType: str | None
    displayName: str
    description: str | None
    present: bool
    available: bool
    reason: str | None
    recommended: bool
    recommendationRank: int | None
    discovery: dict[str, Any]
    configSchema: RuntimeConfigSchemaDescriptor | None = None
    schema_: dict[str, Any] | None = Field(default=None, alias="schema")
    uiSchema: dict[str, Any]
    defaults: dict[str, Any]
    capabilities: dict[str, bool]
    metadata: dict[str, Any]
    instancePolicy: Literal["single", "multiple"]
    maxInstances: int | None
    maturity: str | None = None
    modelConnection: dict[str, Any] | None = None
    lastDiscoveredAt: str
    createdAt: str
    updatedAt: str

    model_config = ConfigDict(populate_by_name=True)


class RuntimeTypeListResponse(BaseModel):
    connectorId: str
    runtimeTypes: list[RuntimeTypeView]
    serverTime: str


class DeviceRuntimeView(BaseModel):
    connectorId: str
    runtimeId: str
    runtimeType: str
    name: str
    # Temporary compatibility alias used by current Web and Android clients.
    displayName: str
    typeDisplayName: str
    present: bool
    available: bool
    reason: str | None
    configured: bool
    active: bool
    status: RuntimeStatus
    discovery: dict[str, Any]
    metadata: dict[str, Any] = Field(default_factory=dict)
    schema_: dict[str, Any] | None = Field(default=None, alias="schema")
    uiSchema: dict[str, Any]
    defaults: dict[str, Any]
    capabilities: dict[str, bool]
    config: dict[str, Any] | None
    # Write-only fields left out of ``config``, e.g.
    # {"modelGateway.apiKey": {"set": true, "hint": "sk-a1b2…wxyz"}}.
    secretFields: dict[str, dict[str, Any]] = Field(default_factory=dict)
    # The runtime type's maturity and model connection capability.
    maturity: str | None = None
    modelConnection: dict[str, Any] | None = None
    # The adapter's last report, with the digest it was started with. Kept by
    # the Server; clients get ``modelConnectionStatus`` instead.
    modelConnectionReport: dict[str, Any] | None = None
    modelConnectionStatus: dict[str, Any] | None = None
    error: dict[str, Any] | None
    # Step inside a non-error status, e.g. {"code": "syncing", ...} while
    # starting. Informational only; status decides usability.
    phase: dict[str, Any] | None = None
    lastDiscoveredAt: str
    createdAt: str
    updatedAt: str

    model_config = ConfigDict(populate_by_name=True)


def public_runtime_view(view: DeviceRuntimeView) -> DeviceRuntimeView:
    """The runtime as a client may see it: no secret values anywhere."""
    status = connection_status(
        capability=view.modelConnection,
        config=view.config,
        report=view.modelConnectionReport,
    )
    update: dict[str, Any] = {
        "modelConnectionReport": None,
        "modelConnectionStatus": status,
    }
    paths = secret_paths(view.schema_, view.uiSchema)
    if paths:
        config, described = redact_config(view.config, paths)
        secrets = secret_values(view.config, paths)
        update.update(
            config=config,
            secretFields=described,
            error=_scrub_value(view.error, secrets) if view.error else view.error,
        )
    return view.model_copy(update=update)


def _scrub_value(value: Any, secrets: list[str]) -> Any:
    if isinstance(value, str):
        return scrub(value, secrets)
    if isinstance(value, dict):
        return {key: _scrub_value(item, secrets) for key, item in value.items()}
    if isinstance(value, list):
        return [_scrub_value(item, secrets) for item in value]
    return value


class DeviceRuntimeListResponse(BaseModel):
    connectorId: str
    runtimes: list[DeviceRuntimeView]
    serverTime: str


class RuntimeInstanceCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    runtimeType: str
    name: str
    config: dict[str, Any]
    active: bool = False

    @field_validator("runtimeType")
    @classmethod
    def _validate_runtime_type(cls, value: str) -> str:
        try:
            return str(validate_runtime_type(value))
        except RuntimeIdentityError as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("name")
    @classmethod
    def _normalize_name(cls, value: str) -> str:
        try:
            return normalize_runtime_instance_name(value)
        except RuntimeIdentityError as exc:
            raise ValueError(str(exc)) from exc

class RuntimeInstancePatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str

    @field_validator("name")
    @classmethod
    def _normalize_name(cls, value: str) -> str:
        try:
            return normalize_runtime_instance_name(value)
        except RuntimeIdentityError as exc:
            raise ValueError(str(exc)) from exc


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


def validate_config(
    config: dict[str, Any],
    schema: dict[str, Any],
    *,
    secrets: list[str] | None = None,
) -> None:
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(config), key=lambda error: list(error.absolute_path))
    if not errors:
        return
    issues = [
        RuntimeConfigIssue(
            path=_json_pointer(error.absolute_path),
            # jsonschema quotes the offending value, which may be a secret.
            message=scrub(error.message, secrets or []),
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
