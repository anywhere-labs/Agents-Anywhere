from __future__ import annotations

import json
import re
from copy import deepcopy
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator


# Keep in sync with agent_server.core.models.RuntimeName.
RuntimeName = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=64,
        pattern=r"^[a-z][a-z0-9_]*$",
    ),
]

_RUNTIME_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")

CODEX_DEFAULT_MODEL = "gpt-5.6-sol"
CODEX_DEFAULT_EFFORT = "medium"


class PersistedRuntimeConfigError(ValueError):
    """Stored runtime configuration is corrupt or no longer decodable."""


class RuntimeConfigOption(BaseModel):
    value: str | bool
    label: str
    description: str | None = None
    # `isDefault` is deliberately optional-on-the-wire: older servers did not
    # expose it, while newer clients need a deterministic fallback when a
    # model switch invalidates the previous reasoning effort.
    isDefault: bool = False
    # None means the runtime did not describe per-model effort constraints and
    # the top-level effort field remains authoritative. An empty list means the
    # model explicitly does not support a reasoning-effort setting.
    efforts: list["RuntimeConfigOption"] | None = None


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
    # Empty fields allowed for ACP agents without a settings UI yet.
    fields: list[RuntimeConfigField] = Field(default_factory=list)

    @field_validator("runtime")
    @classmethod
    def _supported_runtime(cls, value: str) -> str:
        text = value.strip() if isinstance(value, str) else ""
        if not text or len(text) > 64 or not _RUNTIME_ID_RE.fullmatch(text):
            raise ValueError(
                "runtime must be a lowercase snake_case id (1–64 chars, e.g. gemini, grok_build)"
            )
        return text


class RuntimeSettingsPatchRequest(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


class RuntimeSettingsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    connectorId: str | None = None
    sessionId: str | None = None
    runtime: RuntimeName
    settings: dict[str, Any]
    runtimeSettings: dict[str, Any] | None = None
    runtimeSettingsOverride: dict[str, Any] | None = None
    # Optional effective schema (may include ACP-discovered model options).
    configSchema: RuntimeConfigSchema | None = Field(
        default=None,
        serialization_alias="schema",
        validation_alias="schema",
    )
    schemaVersion: int
    serverTime: str


class RuntimeConfigSchemaResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    runtime: RuntimeName
    configSchema: RuntimeConfigSchema = Field(serialization_alias="schema", validation_alias="schema")
    serverTime: str


DEFAULT_RUNTIME_SETTINGS: dict[str, dict[str, Any]] = {
    "claude": {
        "permissionMode": "acceptEdits",
        "model": None,
        "effort": None,
    },
    "codex": {
        "permissionMode": "ask",
        "model": CODEX_DEFAULT_MODEL,
        "effort": CODEX_DEFAULT_EFFORT,
    },
    "gemini": {
        "permissionMode": None,
        "model": None,
        "effort": None,
    },
    "grok_build": {
        "permissionMode": None,
        "model": None,
        "effort": None,
    },
    "cursor": {
        "permissionMode": None,
        "model": None,
        "effort": None,
    },
    "codebuddy": {
        "permissionMode": "acceptEdits",
        "model": None,
        "effort": None,
    },
}


def _acp_model_schema(
    runtime: str,
    *,
    schema_version: int,
    models: list[tuple[str, str]],
    permission_modes: list[tuple[str, str]] | None = None,
) -> RuntimeConfigSchema:
    fields: list[RuntimeConfigField] = []
    if permission_modes:
        fields.append(
            RuntimeConfigField(
                key="permissionMode",
                label="Permission mode",
                type="enum",
                allowSessionOverride=True,
                options=[
                    RuntimeConfigOption(value=value, label=label) for value, label in permission_modes
                ],
            )
        )
    fields.append(
        RuntimeConfigField(
            key="model",
            label="Model",
            type="enum",
            allowSessionOverride=True,
            options=[RuntimeConfigOption(value=value, label=label) for value, label in models],
        )
    )
    return RuntimeConfigSchema(runtime=runtime, schemaVersion=schema_version, fields=fields)


DEFAULT_RUNTIME_CONFIG_SCHEMAS: dict[str, RuntimeConfigSchema] = {
    "gemini": _acp_model_schema(
        "gemini",
        schema_version=1,
        models=[
            ("auto", "Auto"),
            ("gemini-2.5-pro", "Gemini 2.5 Pro"),
            ("gemini-2.5-flash", "Gemini 2.5 Flash"),
            ("gemini-2.0-flash", "Gemini 2.0 Flash"),
        ],
    ),
    "grok_build": _acp_model_schema(
        "grok_build",
        schema_version=1,
        models=[
            ("auto", "Auto / default"),
            ("grok-4", "Grok 4"),
            ("grok-4.5", "Grok 4.5"),
            ("grok-code", "Grok Code"),
        ],
    ),
    "cursor": _acp_model_schema(
        "cursor",
        schema_version=1,
        models=[
            ("auto", "Auto"),
            ("default", "Default"),
        ],
        permission_modes=[
            ("agent", "Agent"),
            ("plan", "Plan"),
            ("ask", "Ask"),
        ],
    ),
    "codebuddy": _acp_model_schema(
        "codebuddy",
        schema_version=1,
        models=[
            ("default-model", "Default"),
            ("gemini-3.1-pro", "Gemini 3.1 Pro"),
            ("gemini-3.0-flash", "Gemini 3.0 Flash"),
            ("gemini-3.5-flash", "Gemini 3.5 Flash"),
            ("gemini-2.5-pro", "Gemini 2.5 Pro"),
            ("gemini-2.5-flash", "Gemini 2.5 Flash"),
            ("gpt-5.5", "GPT-5.5"),
            ("gpt-5.4", "GPT-5.4"),
            ("gpt-5.3-codex", "GPT-5.3 Codex"),
            ("deepseek-v3-2-volc", "DeepSeek V3.2"),
            ("glm-5.0", "GLM-5.0"),
            ("kimi-k2.5", "Kimi K2.5"),
        ],
        permission_modes=[
            ("default", "Ask permissions"),
            ("acceptEdits", "Accept edits"),
            ("plan", "Plan mode"),
            ("bypassPermissions", "Bypass permissions"),
            ("dontAsk", "Don't ask"),
            ("auto", "Auto"),
        ],
    ),
    "claude": RuntimeConfigSchema(
        runtime="claude",
        schemaVersion=4,
        fields=[
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
        schemaVersion=4,
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
                    RuntimeConfigOption(value="gpt-5.6-sol", label="GPT-5.6-Sol", isDefault=True),
                    RuntimeConfigOption(value="gpt-5.6-terra", label="GPT-5.6-Terra"),
                    RuntimeConfigOption(value="gpt-5.6-luna", label="GPT-5.6-Luna"),
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
                    RuntimeConfigOption(value="medium", label="Medium", isDefault=True),
                    RuntimeConfigOption(value="high", label="High"),
                    RuntimeConfigOption(value="xhigh", label="Extra high"),
                    RuntimeConfigOption(value="max", label="Max"),
                    RuntimeConfigOption(value="ultra", label="Ultra"),
                ],
            ),
        ],
    ),
}


def _rollback_safe_runtime_config_schemas() -> dict[str, RuntimeConfigSchema]:
    """Return the schema shape a pre-GPT-5.6 server can safely consume.

    The current service projects GPT-5.6 into memory, but startup seeds only
    this Codex v3 representation.  A rollback therefore sees its familiar
    catalog rather than rows it cannot validate.
    """
    result = deepcopy(DEFAULT_RUNTIME_CONFIG_SCHEMAS)
    codex = result["codex"]
    codex.schemaVersion = 3
    for field in codex.fields:
        if field.key == "model":
            field.options = [
                # v3 persistence deliberately carries no new-only default
                # metadata. The preceding server derives its own defaults.
                option.model_copy(update={"isDefault": False})
                for option in field.options or []
                if str(option.value) in {
                    "gpt-5.5",
                    "gpt-5.4",
                    "gpt-5.4-mini",
                    "gpt-5.3-codex",
                    "gpt-5.2",
                }
            ]
        elif field.key == "effort":
            field.options = [
                option.model_copy(update={"isDefault": False})
                for option in field.options or []
                if str(option.value) in {"low", "medium", "high", "xhigh"}
            ]
    return result


ROLLBACK_SAFE_RUNTIME_CONFIG_SCHEMAS = _rollback_safe_runtime_config_schemas()


def is_rollback_safe_codex_schema(schema: RuntimeConfigSchema) -> bool:
    return _schema_builtin_signature(schema) == _schema_builtin_signature(
        ROLLBACK_SAFE_RUNTIME_CONFIG_SCHEMAS["codex"]
    )


def is_current_builtin_codex_schema(schema: RuntimeConfigSchema) -> bool:
    return _schema_builtin_signature(schema) == _schema_builtin_signature(
        DEFAULT_RUNTIME_CONFIG_SCHEMAS["codex"]
    )


def _schema_builtin_signature(schema: RuntimeConfigSchema) -> tuple[Any, ...]:
    def option_signature(option: RuntimeConfigOption) -> tuple[Any, ...]:
        return (
            option.value,
            option.label,
            option.description,
            option.isDefault,
            None
            if option.efforts is None
            else tuple(option_signature(effort) for effort in option.efforts),
        )

    def field_signature(field: RuntimeConfigField) -> tuple[Any, ...]:
        return (
            field.key,
            field.label,
            field.type,
            field.description,
            field.runtimeOptionsSource,
            json.dumps(field.visibleWhen, sort_keys=True, separators=(",", ":"))
            if field.visibleWhen is not None
            else None,
            field.allowSessionOverride,
            field.hidden,
            None
            if field.options is None
            else tuple(option_signature(option) for option in field.options),
            None
            if field.fields is None
            else tuple(field_signature(child) for child in field.fields),
        )

    return (
        schema.runtime,
        schema.schemaVersion,
        tuple(field_signature(field) for field in schema.fields),
    )

CLAUDE_NO_EFFORT_MODEL = "claude-haiku-4-5"
_CLAUDE_OPUS_48_47_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
_CLAUDE_OPUS_46_SONNET_46_EFFORTS = frozenset({"low", "medium", "high", "max"})
_CODEX_56_SOL_TERRA_EFFORTS = frozenset(
    {"low", "medium", "high", "xhigh", "max", "ultra"}
)
_CODEX_56_LUNA_EFFORTS = frozenset({"low", "medium", "high", "xhigh", "max"})
_CODEX_LEGACY_EFFORTS = frozenset({"low", "medium", "high", "xhigh"})


def runtime_schema_key(runtime: str) -> str:
    return f"runtime_config_schema:{runtime}"


def default_runtime_settings(runtime: str) -> dict[str, Any]:
    settings = DEFAULT_RUNTIME_SETTINGS.get(runtime)
    if settings is None:
        # ACP / unknown agents: empty defaults (no model/permission schema yet).
        return {}
    return deepcopy(settings)


def inherited_runtime_setting_keys(runtime: str, persisted: Any) -> set[str]:
    """Return Codex settings that still inherit the server default.

    A durable ``null`` means "use this server's default", rather than
    pinning a newly introduced model into a row read by an older server.  The
    caller supplies the persisted/raw value so an explicit user selection is
    never mistaken for inheritance.
    """
    if runtime != "codex":
        return set()
    raw = persisted if isinstance(persisted, dict) else {}
    return {key for key in ("model", "effort") if raw.get(key) is None}


def rollback_safe_inherited_runtime_settings(
    runtime: str,
    settings: dict[str, Any],
    *,
    inherited_keys: set[str],
) -> dict[str, Any]:
    """Persist inherited Codex model/effort as ``null`` values.

    This is intentionally provenance-driven, not value-driven: an explicit
    choice of the current default (for example Sol / Medium) remains durable.
    """
    result = deepcopy(settings)
    if runtime == "codex":
        for key in inherited_keys & {"model", "effort"}:
            result[key] = None
    return result


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


def filter_runtime_settings(
    settings: dict[str, Any],
    schema: RuntimeConfigSchema,
    *,
    session_override: bool,
) -> dict[str, Any]:
    allowed_paths = _field_paths(schema.fields, session_override=session_override)
    return {key: value for key, value in settings.items() if key in allowed_paths}


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
    if not isinstance(settings, dict):
        raise ValueError("settings must be an object")
    if runtime not in DEFAULT_RUNTIME_CONFIG_SCHEMAS and not schema.fields:
        # Unknown ACP runtime with empty schema: accept empty object only.
        if settings:
            raise ValueError(f"{runtime} does not accept settings yet")
        return {}
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
    schema: RuntimeConfigSchema | None = None,
) -> dict[str, Any]:
    result = _deep_merge(existing or {}, patch, overwrite_null=True)
    if runtime is not None:
        result = normalize_setting_constraints(
            runtime,
            result,
            explicit_keys=explicit_keys or set(patch),
            schema=schema,
        )
    return _prune_nulls(result) if prune_nulls else result


def normalize_setting_constraints(
    runtime: str,
    settings: dict[str, Any],
    *,
    explicit_keys: set[str],
    schema: RuntimeConfigSchema | None = None,
) -> dict[str, Any]:
    schema_normalized = _normalize_model_effort_from_schema(
        settings,
        schema=schema,
        explicit_keys=explicit_keys,
    )
    if schema_normalized is not None:
        return schema_normalized
    if runtime != "claude":
        return settings
    return _normalize_claude_model_effort(settings, explicit_keys=explicit_keys)


def schema_with_user_agent_defaults(
    schema: RuntimeConfigSchema,
    defaults: dict[str, Any] | None,
) -> RuntimeConfigSchema:
    result = deepcopy(schema)
    if not defaults:
        _attach_default_model_efforts(result)
        return result

    models = defaults.get("models") or []
    if models:
        model_options = [_catalog_entry_to_option(entry, include_efforts=True) for entry in models]
        effort_options = _aggregate_effort_options(model_options)
        for field in result.fields:
            if field.key == "model":
                field.options = model_options
            elif field.key == "effort" and effort_options:
                field.options = effort_options
        return result

    _attach_default_model_efforts(result)
    return result


def merge_schema_with_agent_options(
    schema: RuntimeConfigSchema,
    *,
    model_options: list[dict[str, Any]] | None = None,
    mode_options: list[dict[str, Any]] | None = None,
    config_options: list[dict[str, Any]] | None = None,
) -> RuntimeConfigSchema:
    """Overlay live agent options (from ACP configOptions) onto a base schema.

    Prefer explicit modelOptions/modeOptions; otherwise parse ACP configOptions.
    """
    result = deepcopy(schema)
    models = list(model_options or [])
    modes = list(mode_options or [])
    if config_options and (not models or not modes):
        from_models, from_modes = _options_from_acp_config(config_options)
        if not models:
            models = from_models
        if not modes:
            modes = from_modes

    if models:
        model_field = next((field for field in result.fields if field.key == "model"), None)
        static_options = {
            str(option.value): option
            for option in (model_field.options if model_field is not None else []) or []
        }
        options = [
            option
            for item in models
            if isinstance(item, dict)
            for option in [_runtime_option_from_agent_option(item, static_options)]
            if option is not None
        ]
        if model_field is None and options:
            result.fields.append(
                RuntimeConfigField(
                    key="model",
                    label="Model",
                    type="enum",
                    allowSessionOverride=True,
                    options=options,
                )
            )
        elif model_field is not None and options:
            model_field.options = options

    if modes:
        mode_field = next((field for field in result.fields if field.key == "permissionMode"), None)
        options = [
            RuntimeConfigOption(
                value=str(item.get("value")),
                label=str(item.get("label") or item.get("name") or item.get("value")),
                isDefault=bool(item.get("isDefault", False)),
            )
            for item in modes
            if isinstance(item, dict) and item.get("value") is not None
        ]
        if mode_field is None and options:
            result.fields.append(
                RuntimeConfigField(
                    key="permissionMode",
                    label="Mode",
                    type="enum",
                    allowSessionOverride=True,
                    options=options,
                )
            )
        elif mode_field is not None and options:
            mode_field.options = options

    return result


def _runtime_option_from_agent_option(
    item: dict[str, Any],
    static_options: dict[str, RuntimeConfigOption],
) -> RuntimeConfigOption | None:
    """Normalize a device-discovered model while retaining static constraints.

    Codex emits `model` / `displayName` / `supportedReasoningEfforts`; ACP
    adapters historically emit `value` / `label`.  A live entry that omits
    nested efforts is not an assertion that effort is unsupported: retain the
    matching static option, or leave it as None so the global effort field is
    used.  An explicit empty array is the only "no effort" signal.
    """
    value = item.get("value")
    if value is None:
        value = item.get("model")
    if value is None:
        value = item.get("id")
    if not isinstance(value, (str, bool)) or value == "":
        return None
    if item.get("hidden") is True:
        return None
    key = str(value)
    static = static_options.get(key)
    label = item.get("label") or item.get("displayName") or item.get("name") or key
    raw_efforts = item.get("supportedReasoningEfforts")
    if raw_efforts is None and "efforts" in item:
        raw_efforts = item.get("efforts")
    efforts = _runtime_effort_options(
        raw_efforts,
        default=item.get("defaultReasoningEffort"),
    )
    if raw_efforts is None and static is not None:
        efforts = deepcopy(static.efforts)
    return RuntimeConfigOption(
        value=value,
        label=str(label),
        description=(
            item.get("description")
            if isinstance(item.get("description"), str)
            else (static.description if static is not None else None)
        ),
        isDefault=bool(item.get("isDefault", static.isDefault if static is not None else False)),
        efforts=efforts,
    )


def _runtime_effort_options(raw: Any, *, default: Any) -> list[RuntimeConfigOption] | None:
    if raw is None:
        return None
    if not isinstance(raw, list):
        # A malformed live constraint must not be reinterpreted as an explicit
        # empty list (which would silently disable a valid setting).
        return None
    default_key = default if isinstance(default, str) else None
    result: list[RuntimeConfigOption] = []
    seen: set[str] = set()
    for item in raw:
        if isinstance(item, str):
            value = item
            label = item.replace("xhigh", "Extra high").replace("_", " ").title()
            is_default = value == default_key
        elif isinstance(item, dict):
            value = item.get("value") or item.get("effort") or item.get("key")
            if not isinstance(value, str) or not value:
                continue
            label = item.get("label") or item.get("displayName") or item.get("name") or value
            is_default = bool(item.get("isDefault", value == default_key))
        else:
            continue
        if value in seen:
            continue
        seen.add(value)
        result.append(RuntimeConfigOption(value=value, label=str(label), isDefault=is_default))
    return result


def _options_from_acp_config(
    config_options: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    models: list[dict[str, Any]] = []
    modes: list[dict[str, Any]] = []
    for opt in config_options:
        if not isinstance(opt, dict):
            continue
        category = str(opt.get("category") or "")
        option_id = str(opt.get("id") or "").lower()
        values = opt.get("options") if isinstance(opt.get("options"), list) else []
        parsed = [
            {
                **entry,
                "value": str(entry.get("value")),
                "label": str(entry.get("name") or entry.get("label") or entry.get("value")),
            }
            for entry in values
            if isinstance(entry, dict) and entry.get("value") is not None
        ]
        if not parsed:
            continue
        if category == "model" or option_id in {"model", "llm", "models"}:
            models = parsed
        elif category == "mode" or option_id in {"mode", "permission", "permissionmode"}:
            modes = parsed
    return models, modes


def claude_efforts_for_model(model: Any) -> frozenset[str]:
    key = model if isinstance(model, str) else ""
    if key == CLAUDE_NO_EFFORT_MODEL:
        return frozenset()
    if key.startswith("claude-opus-4-8") or key.startswith("claude-opus-4-7"):
        return _CLAUDE_OPUS_48_47_EFFORTS
    if key.startswith("claude-opus-4-6") or key.startswith("claude-sonnet-4-6"):
        return _CLAUDE_OPUS_46_SONNET_46_EFFORTS
    return _CLAUDE_OPUS_46_SONNET_46_EFFORTS


def codex_efforts_for_model(model: Any) -> frozenset[str]:
    key = model if isinstance(model, str) else ""
    if key in {"gpt-5.6-sol", "gpt-5.6-terra"}:
        return _CODEX_56_SOL_TERRA_EFFORTS
    if key == "gpt-5.6-luna":
        return _CODEX_56_LUNA_EFFORTS
    return _CODEX_LEGACY_EFFORTS


def _normalize_model_effort_from_schema(
    settings: dict[str, Any],
    *,
    schema: RuntimeConfigSchema | None,
    explicit_keys: set[str],
) -> dict[str, Any] | None:
    if schema is None:
        return None
    field_map = {field.key: field for field in schema.fields}
    model_field = field_map.get("model")
    effort_field = field_map.get("effort")
    if model_field is None or effort_field is None:
        return None

    result = deepcopy(settings)
    model = result.get("model")
    effort = result.get("effort")
    model_options = model_field.options or []
    if schema.runtime == "codex" and isinstance(model, str) and model and not any(
        option.value == model for option in model_options
    ):
        if "model" in explicit_keys:
            raise ValueError(f"model has unsupported value: {model}")
        if model_options:
            model = _default_schema_model(model_options)
            result["model"] = model
    allowed = _schema_efforts_for_model(model_field, effort_field, model)
    if allowed is None:
        return None
    if not allowed:
        if effort is not None and "effort" in explicit_keys:
            raise ValueError(f"effort is not supported by {model}")
        result["effort"] = None
        return result
    if effort is not None and effort not in allowed:
        if "effort" in explicit_keys:
            raise ValueError(f"effort {effort} is not supported by {model}")
        result["effort"] = (
            _default_schema_effort_for_model(model_field, model)
            if schema.runtime == "codex"
            else None
        )
    return result


def _default_schema_model(model_options: list[RuntimeConfigOption]) -> str | bool:
    selected = next((option for option in model_options if option.isDefault), model_options[0])
    return selected.value


def _default_schema_effort_for_model(
    model_field: RuntimeConfigField,
    model: Any,
) -> str | None:
    selected = next(
        (
            option
            for option in model_field.options or []
            if isinstance(model, str) and model and option.value == model
        ),
        None,
    )
    if selected is None or selected.efforts is None or not selected.efforts:
        return None
    effort = next((option for option in selected.efforts if option.isDefault), selected.efforts[0])
    return str(effort.value)


def _schema_efforts_for_model(
    model_field: RuntimeConfigField,
    effort_field: RuntimeConfigField,
    model: Any,
) -> set[str] | None:
    model_options = model_field.options or []
    if model_options and any(option.efforts is not None for option in model_options):
        selected = next(
            (
                option
                for option in model_options
                if isinstance(model, str) and model and option.value == model
            ),
            _default_schema_option(model_options) if not isinstance(model, str) or not model else None,
        )
        if selected is None:
            return None
        if selected.efforts is None:
            return {str(option.value) for option in (effort_field.options or [])}
        return {str(effort.value) for effort in selected.efforts}
    if isinstance(model, str) and model:
        for option in model_options:
            if option.value == model:
                return None
        return None
    if effort_field.options:
        return {str(option.value) for option in effort_field.options}
    return None


def _default_schema_option(options: list[RuntimeConfigOption]) -> RuntimeConfigOption | None:
    if not options:
        return None
    return next((option for option in options if option.isDefault), options[0])


def _attach_default_model_efforts(schema: RuntimeConfigSchema) -> None:
    field_map = {field.key: field for field in schema.fields}
    model_field = field_map.get("model")
    effort_field = field_map.get("effort")
    if model_field is None or effort_field is None:
        return
    effort_options = effort_field.options or []
    if not effort_options:
        return
    model_options: list[RuntimeConfigOption] = []
    for option in model_field.options or []:
        efforts = _default_effort_options_for_model(schema.runtime, option.value, effort_options)
        model_options.append(option.model_copy(update={"efforts": efforts}))
    model_field.options = model_options


def _default_effort_options_for_model(
    runtime: str,
    model: Any,
    effort_options: list[RuntimeConfigOption],
) -> list[RuntimeConfigOption]:
    if runtime == "claude":
        allowed = claude_efforts_for_model(model)
    elif runtime == "codex":
        allowed = codex_efforts_for_model(model)
    else:
        return deepcopy(effort_options)
    return [deepcopy(option) for option in effort_options if str(option.value) in allowed]


def _catalog_entry_to_option(entry: Any, *, include_efforts: bool) -> RuntimeConfigOption:
    key = _entry_value(entry, "key")
    label = _entry_value(entry, "displayLabel") or key
    description = _entry_value(entry, "description")
    efforts = _entry_value(entry, "efforts")
    return RuntimeConfigOption(
        value=key,
        label=label,
        description=description if isinstance(description, str) else None,
        isDefault=bool(_entry_value(entry, "isDefault")),
        efforts=[
            _catalog_entry_to_option(effort, include_efforts=False)
            for effort in (efforts if include_efforts and isinstance(efforts, list) else [])
        ] if include_efforts else None,
    )


def _aggregate_effort_options(model_options: list[RuntimeConfigOption]) -> list[RuntimeConfigOption]:
    result: list[RuntimeConfigOption] = []
    seen: set[str] = set()
    for model in model_options:
        for effort in model.efforts or []:
            key = str(effort.value)
            if key in seen:
                if effort.isDefault:
                    result = [
                        item.model_copy(update={"isDefault": True}) if str(item.value) == key else item
                        for item in result
                    ]
                continue
            seen.add(key)
            result.append(effort.model_copy(update={"efforts": None}))
    return result


def _entry_value(entry: Any, key: str) -> Any:
    if isinstance(entry, dict):
        return entry.get(key)
    return getattr(entry, key, None)


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
