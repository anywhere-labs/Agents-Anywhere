from __future__ import annotations

from copy import deepcopy
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


RuntimeName = Literal["codex", "claude", "opencode", "acp"]


class RuntimeConfigOption(BaseModel):
    value: str | bool
    label: str
    description: str | None = None


class RuntimeConfigField(BaseModel):
    key: str = Field(min_length=1)
    label: str = Field(min_length=1)
    type: Literal["string", "enum", "boolean", "object"] = "string"
    description: str | None = None
    options: list[RuntimeConfigOption] | None = None
    runtimeOptionsSource: str | None = None
    visibleWhen: dict[str, Any] | None = None
    allowSessionOverride: bool = False
    hidden: bool = False
    fields: list["RuntimeConfigField"] | None = None

    @model_validator(mode="after")
    def _validate_shape(self) -> "RuntimeConfigField":
        if self.type == "enum" and not self.options and not self.runtimeOptionsSource:
            raise ValueError(f"enum field {self.key!r} needs options or runtimeOptionsSource")
        if self.type == "object" and not self.fields:
            raise ValueError(f"object field {self.key!r} needs fields")
        return self


class RuntimeConfigSchema(BaseModel):
    runtime: RuntimeName
    schemaVersion: int = Field(ge=1)
    fields: list[RuntimeConfigField] = Field(min_length=1)

    @field_validator("runtime")
    @classmethod
    def _supported_runtime(cls, value: str) -> str:
        if value not in {"claude", "codex"}:
            raise ValueError("runtime config schema is only seeded for claude and codex")
        return value


class RuntimeSettingsPatchRequest(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


class RuntimeSettingsResponse(BaseModel):
    connectorId: str | None = None
    sessionId: str | None = None
    runtime: RuntimeName
    settings: dict[str, Any]
    runtimeSettings: dict[str, Any] | None = None
    runtimeSettingsOverride: dict[str, Any] | None = None
    effectiveRunMode: Literal["chat", "terminal"] | None = None
    defaultRunModeConfigured: bool = False
    schemaVersion: int
    serverTime: str


class RuntimeConfigSchemaResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    runtime: RuntimeName
    configSchema: RuntimeConfigSchema = Field(serialization_alias="schema", validation_alias="schema")
    serverTime: str


DEFAULT_RUNTIME_SETTINGS: dict[str, dict[str, Any]] = {
    "claude": {
        "runMode": "chat",
        "permissionMode": "acceptEdits",
        "model": None,
        "effort": None,
    },
    "codex": {
        "permissionMode": "ask",
        "model": None,
        "effort": None,
    },
}


DEFAULT_RUNTIME_CONFIG_SCHEMAS: dict[str, RuntimeConfigSchema] = {
    "claude": RuntimeConfigSchema(
        runtime="claude",
        schemaVersion=3,
        fields=[
            RuntimeConfigField(
                key="runMode",
                label="Run mode",
                type="enum",
                allowSessionOverride=False,
                options=[
                    RuntimeConfigOption(value="chat", label="Chat"),
                    RuntimeConfigOption(value="terminal", label="Terminal"),
                ],
            ),
            RuntimeConfigField(
                key="permissionMode",
                label="Permission mode",
                type="enum",
                allowSessionOverride=True,
                options=[
                    RuntimeConfigOption(value="default", label="Ask permissions"),
                    RuntimeConfigOption(value="acceptEdits", label="Accept edits"),
                    RuntimeConfigOption(value="plan", label="Plan mode"),
                    RuntimeConfigOption(value="bypassPermissions", label="Bypass permissions"),
                ],
            ),
            RuntimeConfigField(
                key="model",
                label="Model",
                type="enum",
                allowSessionOverride=True,
                options=[
                    RuntimeConfigOption(value="claude-opus-4-8", label="Opus 4.8"),
                    RuntimeConfigOption(value="claude-opus-4-8[1M]", label="Opus 4.8 1M"),
                    RuntimeConfigOption(value="claude-opus-4-7", label="Opus 4.7"),
                    RuntimeConfigOption(value="claude-opus-4-7[1M]", label="Opus 4.7 1M"),
                    RuntimeConfigOption(value="claude-opus-4-6", label="Opus 4.6"),
                    RuntimeConfigOption(value="claude-opus-4-6[1M]", label="Opus 4.6 1M"),
                    RuntimeConfigOption(value="claude-sonnet-4-6", label="Sonnet 4.6"),
                    RuntimeConfigOption(value="claude-sonnet-4-6[1M]", label="Sonnet 4.6 1M"),
                    RuntimeConfigOption(value="claude-haiku-4-5", label="Haiku 4.5"),
                ],
            ),
            RuntimeConfigField(
                key="effort",
                label="Effort",
                type="enum",
                allowSessionOverride=True,
                options=[
                    RuntimeConfigOption(value="low", label="Low"),
                    RuntimeConfigOption(value="medium", label="Medium"),
                    RuntimeConfigOption(value="high", label="High"),
                    RuntimeConfigOption(value="xhigh", label="Extra high"),
                    RuntimeConfigOption(value="max", label="Max"),
                ],
            ),
        ],
    ),
    "codex": RuntimeConfigSchema(
        runtime="codex",
        schemaVersion=3,
        fields=[
            RuntimeConfigField(
                key="permissionMode",
                label="Permission mode",
                type="enum",
                allowSessionOverride=True,
                options=[
                    RuntimeConfigOption(
                        value="ask",
                        label="Ask for approval",
                        description="Always ask to edit external files and use the internet",
                    ),
                    RuntimeConfigOption(
                        value="auto",
                        label="Approve for me",
                        description="Only ask for actions detected as potentially unsafe",
                    ),
                    RuntimeConfigOption(
                        value="fullAccess",
                        label="Full access",
                        description="Unrestricted access to the internet and any file on your computer",
                    ),
                ],
            ),
            RuntimeConfigField(
                key="model",
                label="Model",
                type="enum",
                allowSessionOverride=True,
                options=[
                    RuntimeConfigOption(value="gpt-5.5", label="GPT-5.5"),
                    RuntimeConfigOption(value="gpt-5.4", label="GPT-5.4"),
                    RuntimeConfigOption(value="gpt-5.4-mini", label="GPT-5.4 Mini"),
                    RuntimeConfigOption(value="gpt-5.3-codex", label="GPT-5.3 Codex"),
                    RuntimeConfigOption(value="gpt-5.2", label="GPT-5.2"),
                ],
            ),
            RuntimeConfigField(
                key="effort",
                label="Effort",
                type="enum",
                allowSessionOverride=True,
                options=[
                    RuntimeConfigOption(value="low", label="Low"),
                    RuntimeConfigOption(value="medium", label="Medium"),
                    RuntimeConfigOption(value="high", label="High"),
                    RuntimeConfigOption(value="xhigh", label="Extra high"),
                ],
            ),
        ],
    ),
}

CLAUDE_NO_EFFORT_MODEL = "claude-haiku-4-5"
_CLAUDE_OPUS_48_47_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
_CLAUDE_OPUS_46_SONNET_46_EFFORTS = frozenset({"low", "medium", "high", "max"})


def runtime_schema_key(runtime: str) -> str:
    return f"runtime_config_schema:{runtime}"


def default_runtime_settings(runtime: str) -> dict[str, Any]:
    settings = DEFAULT_RUNTIME_SETTINGS.get(runtime)
    if settings is None:
        raise ValueError(f"unsupported runtime: {runtime}")
    return deepcopy(settings)


def normalize_runtime_settings(runtime: str, settings: dict[str, Any]) -> dict[str, Any]:
    if runtime != "codex":
        return settings
    result = deepcopy(settings)
    if result.get("permissionMode") is None:
        approval_policy = result.get("approvalPolicy")
        approvals_reviewer = result.get("approvalsReviewer")
        sandbox_policy = result.get("sandboxPolicy")
        sandbox_type = sandbox_policy.get("type") if isinstance(sandbox_policy, dict) else None
        if approval_policy == "never" and sandbox_type == "dangerFullAccess":
            result["permissionMode"] = "fullAccess"
        elif approval_policy == "on-request" and approvals_reviewer == "auto_review":
            result["permissionMode"] = "auto"
        elif approval_policy is not None or sandbox_type is not None:
            result["permissionMode"] = "ask"
    for key in ("approvalPolicy", "approvalsReviewer", "sandboxPolicy"):
        result.pop(key, None)
    return result


def validate_runtime_schema(runtime: str, raw: Any) -> RuntimeConfigSchema:
    schema = RuntimeConfigSchema.model_validate(raw)
    if schema.runtime != runtime:
        raise ValueError("schema runtime does not match path runtime")
    return schema


def validate_runtime_settings(
    runtime: str,
    settings: dict[str, Any],
    schema: RuntimeConfigSchema,
    *,
    session_override: bool,
) -> dict[str, Any]:
    if runtime not in DEFAULT_RUNTIME_CONFIG_SCHEMAS:
        raise ValueError(f"unsupported runtime: {runtime}")
    if not isinstance(settings, dict):
        raise ValueError("settings must be an object")
    allowed_paths = _field_paths(schema.fields, session_override=session_override)
    normalized: dict[str, Any] = {}
    for key, value in settings.items():
        if key not in allowed_paths:
            raise ValueError(f"{key} is not configurable here")
        field = allowed_paths[key]
        normalized[key] = _validate_field_value(key, value, field)
    return normalized


def merge_settings(*settings: dict[str, Any] | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for item in settings:
        if not item:
            continue
        result = _deep_merge(result, item, overwrite_null=False)
    return result


def apply_settings_patch(
    existing: dict[str, Any] | None,
    patch: dict[str, Any],
    *,
    prune_nulls: bool = False,
    runtime: str | None = None,
    explicit_keys: set[str] | None = None,
) -> dict[str, Any]:
    result = _deep_merge(existing or {}, patch, overwrite_null=True)
    if runtime is not None:
        result = normalize_setting_constraints(
            runtime,
            result,
            explicit_keys=explicit_keys or set(patch),
        )
    return _prune_nulls(result) if prune_nulls else result


def normalize_setting_constraints(
    runtime: str,
    settings: dict[str, Any],
    *,
    explicit_keys: set[str],
) -> dict[str, Any]:
    if runtime != "claude":
        return settings
    return _normalize_claude_model_effort(settings, explicit_keys=explicit_keys)


def claude_efforts_for_model(model: Any) -> frozenset[str]:
    key = model if isinstance(model, str) else ""
    if key == CLAUDE_NO_EFFORT_MODEL:
        return frozenset()
    if key.startswith("claude-opus-4-8") or key.startswith("claude-opus-4-7"):
        return _CLAUDE_OPUS_48_47_EFFORTS
    if key.startswith("claude-opus-4-6") or key.startswith("claude-sonnet-4-6"):
        return _CLAUDE_OPUS_46_SONNET_46_EFFORTS
    return _CLAUDE_OPUS_46_SONNET_46_EFFORTS


def _normalize_claude_model_effort(
    settings: dict[str, Any],
    *,
    explicit_keys: set[str],
) -> dict[str, Any]:
    result = deepcopy(settings)
    model = result.get("model")
    effort = result.get("effort")
    allowed = claude_efforts_for_model(model)

    if not allowed:
        if effort is not None and "effort" in explicit_keys:
            raise ValueError(f"effort is not supported by {model}")
        result["effort"] = None
        return result

    if effort is not None and effort not in allowed:
        if "effort" in explicit_keys:
            raise ValueError(f"effort {effort} is not supported by {model}")
        result["effort"] = None
    return result


def serialize_runtime_params(
    *,
    runtime: str,
    settings: dict[str, Any],
    cwd: str | None = None,
) -> dict[str, Any]:
    if runtime == "claude":
        result: dict[str, Any] = {}
        if settings.get("permissionMode") is not None:
            result["permissionMode"] = settings.get("permissionMode")
        if settings.get("model") is not None:
            result["model"] = settings.get("model")
        if settings.get("effort") is not None:
            result["effort"] = settings.get("effort")
        return result

    if runtime == "codex":
        result = {}
        result.update(serialize_codex_permission_mode(settings.get("permissionMode"), cwd=cwd))
        if settings.get("model") is not None:
            result["model"] = settings.get("model")
        if settings.get("effort") is not None:
            result["effort"] = settings.get("effort")
        return result

    return {}


def serialize_codex_permission_mode(mode: Any, *, cwd: str | None) -> dict[str, Any]:
    if mode == "fullAccess":
        return {
            "approvalPolicy": "never",
            "sandboxPolicy": {"type": "dangerFullAccess"},
        }
    if mode == "auto":
        return {
            "approvalPolicy": "on-request",
            "approvalsReviewer": "auto_review",
            "sandboxPolicy": serialize_codex_sandbox_policy(
                {"type": "workspaceWrite", "networkAccess": False},
                cwd=cwd,
            ),
        }
    return {
        "approvalPolicy": "on-request",
        "sandboxPolicy": serialize_codex_sandbox_policy(
            {"type": "workspaceWrite", "networkAccess": False},
            cwd=cwd,
        ),
    }


def serialize_codex_sandbox_policy(policy: dict[str, Any], *, cwd: str | None) -> dict[str, Any]:
    policy_type = policy.get("type") or "workspaceWrite"
    if policy_type == "dangerFullAccess":
        return {"type": "dangerFullAccess"}
    network_access = bool(policy.get("networkAccess", False))
    if policy_type == "readOnly":
        return {"type": "readOnly", "networkAccess": network_access}
    if policy_type == "workspaceWrite":
        serialized: dict[str, Any] = {
            "type": "workspaceWrite",
            "writableRoots": [cwd] if cwd else [],
            "networkAccess": network_access,
            "excludeTmpdirEnvVar": True,
            "excludeSlashTmp": True,
        }
        return serialized
    raise ValueError(f"unsupported Codex sandboxPolicy.type: {policy_type}")


def _deep_merge(
    base: dict[str, Any],
    override: dict[str, Any],
    *,
    overwrite_null: bool,
) -> dict[str, Any]:
    result = deepcopy(base)
    for key, value in override.items():
        if value is None and not overwrite_null:
            if key not in result:
                result[key] = None
            continue
        if (
            isinstance(value, dict)
            and isinstance(result.get(key), dict)
        ):
            result[key] = _deep_merge(
                result[key],
                value,
                overwrite_null=overwrite_null,
            )
        else:
            result[key] = deepcopy(value)
    return result


def _prune_nulls(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, item in value.items():
        if item is None:
            continue
        if isinstance(item, dict):
            nested = _prune_nulls(item)
            if nested:
                result[key] = nested
            continue
        result[key] = item
    return result


def _field_paths(
    fields: list[RuntimeConfigField],
    *,
    session_override: bool,
) -> dict[str, RuntimeConfigField]:
    result: dict[str, RuntimeConfigField] = {}
    for field in fields:
        if session_override and not field.allowSessionOverride:
            continue
        result[field.key] = field
    return result


def _validate_field_value(key: str, value: Any, field: RuntimeConfigField) -> Any:
    if value is None:
        return None
    if field.type == "boolean":
        if not isinstance(value, bool):
            raise ValueError(f"{key} must be a boolean")
        return value
    if field.type == "enum":
        if not isinstance(value, str):
            raise ValueError(f"{key} must be a string")
        options = field.options or []
        allowed = {option.value for option in options}
        if allowed and value not in allowed:
            raise ValueError(f"{key} has unsupported value: {value}")
        return value
    if field.type == "object":
        if not isinstance(value, dict):
            raise ValueError(f"{key} must be an object")
        child_fields = {child.key: child for child in field.fields or []}
        normalized: dict[str, Any] = {}
        for child_key, child_value in value.items():
            child = child_fields.get(child_key)
            if child is None:
                raise ValueError(f"{key}.{child_key} is not configurable")
            normalized[child_key] = _validate_field_value(
                f"{key}.{child_key}",
                child_value,
                child,
            )
        return normalized
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    return value
