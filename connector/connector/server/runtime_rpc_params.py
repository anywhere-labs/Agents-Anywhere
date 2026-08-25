from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    MAX_CONFIG_REVISION,
    RuntimeAttachment,
    RuntimeInstanceSpec,
    RuntimeInstancesUnsupportedError,
    RuntimeInvalidRequestError,
    RuntimeScope,
    legacy_runtime_scope,
)

_V2_RUNTIME_SCOPE_FIELDS = frozenset({"runtime", "runtimeId"})
_V2_RUNTIME_CONFIG_FIELDS = frozenset(
    {"runtime", "runtimeId", "name", "config", "configRevision"}
)


def require_only_fields(params: dict[str, Any], allowed: frozenset[str]) -> None:
    unsupported = sorted(set(params) - allowed)
    if unsupported:
        raise RuntimeInvalidRequestError(
            f"unsupported request field(s): {', '.join(unsupported)}"
        )


def required_runtime_id(params: dict[str, Any]) -> str:
    runtime_id = params.get("runtimeId")
    if not isinstance(runtime_id, str) or not runtime_id:
        raise ValueError("runtimeId is required")
    return runtime_id


def runtime_config(params: dict[str, Any]) -> dict[str, Any]:
    config = params.get("config")
    if not isinstance(config, dict):
        raise TypeError("config must be an object")
    return config


def optional_safe_int(
    params: dict[str, Any],
    key: str,
    *,
    minimum: int = 0,
) -> int | None:
    value = params.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{key} must be an integer")
    if not minimum <= value <= MAX_CONFIG_REVISION:
        raise ValueError(f"{key} must be between {minimum} and {MAX_CONFIG_REVISION}")
    return value


def required_safe_int(params: dict[str, Any], key: str) -> int:
    value = optional_safe_int(params, key)
    if value is None:
        raise ValueError(f"{key} is required")
    return value


def required_runtime_type(params: dict[str, Any]) -> str:
    runtime_type = params.get("runtime")
    if not isinstance(runtime_type, str) or not runtime_type:
        raise ValueError("runtime is required")
    return runtime_type


def required_name(params: dict[str, Any]) -> str:
    name = params.get("name")
    if not isinstance(name, str) or not name:
        raise ValueError("name is required")
    return name


def scoped_runtime(params: dict[str, Any]) -> RuntimeScope:
    runtime_type = required_runtime_type(params)
    runtime_id = params.get("runtimeId", runtime_type)
    if not isinstance(runtime_id, str) or not runtime_id:
        raise ValueError("runtimeId must be a non-empty string")
    return RuntimeScope(runtime_id=runtime_id, runtime_type=runtime_type)


def required_session_id(params: dict[str, Any]) -> str:
    session_id = params.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("sessionId is required")
    return session_id


def required_content(params: dict[str, Any]) -> str:
    content = params.get("content")
    if not isinstance(content, str):
        raise TypeError("content is required")
    return content


def required_command(params: dict[str, Any]) -> str:
    command = params.get("command")
    if not isinstance(command, str) or not command:
        raise ValueError("command is required")
    return command


def required_notice_id(params: dict[str, Any]) -> str:
    notice_id = params.get("noticeId")
    if not isinstance(notice_id, str) or not notice_id:
        raise ValueError("noticeId is required")
    return notice_id


def required_action_id(params: dict[str, Any]) -> str:
    action_id = params.get("actionId")
    if not isinstance(action_id, str) or not action_id:
        raise ValueError("actionId is required")
    return action_id


def optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def runtime_attachments(params: dict[str, Any]) -> tuple[RuntimeAttachment, ...]:
    raw_attachments = params.get("attachments") or ()
    if not isinstance(raw_attachments, list | tuple):
        raise TypeError("attachments must be a list")
    attachments: list[RuntimeAttachment] = []
    for raw in raw_attachments:
        if not isinstance(raw, dict):
            raise TypeError("attachment must be an object")
        has_inline_content = (
            raw.get("contentBase64") is not None
            or raw.get("content_base64") is not None
        )
        if has_inline_content:
            raise ValueError(
                "attachment content must be referenced by fileId, not sent as base64"
            )
        file_id = raw.get("fileId") or raw.get("file_id")
        if not isinstance(file_id, str) or not file_id:
            raise ValueError("attachment fileId is required")
        attachments.append(
            RuntimeAttachment(
                file_id=file_id,
                name=optional_string(raw.get("name")),
                media_type=optional_string(
                    raw.get("mediaType") or raw.get("media_type")
                ),
                size=raw.get("size") if isinstance(raw.get("size"), int) else None,
                sha256=optional_string(raw.get("sha256")),
            )
        )
    return tuple(attachments)


def runtime_selections(params: dict[str, Any]) -> dict[str, str | None]:
    raw = params.get("selections") or {}
    if not isinstance(raw, dict):
        raise TypeError("selections must be an object")
    selections: dict[str, str | None] = {}
    for scope, selection_id in raw.items():
        if not isinstance(scope, str) or not scope:
            raise ValueError("selection scope must be a non-empty string")
        if selection_id is not None and not isinstance(selection_id, str):
            raise ValueError("selection id must be a string or null")
        selections[scope] = selection_id
    return selections


def optional_mapping(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise TypeError("inputData must be an object")
    return dict(value)


def int_param(params: dict[str, Any], key: str, default: int) -> int:
    value = params.get(key, default)
    if isinstance(value, bool):
        raise TypeError(f"{key} must be an integer")
    if isinstance(value, int):
        return value
    raise ValueError(f"{key} must be an integer")


def optional_int_param(params: dict[str, Any], key: str) -> int | None:
    value = params.get(key)
    if value is None:
        return None
    if isinstance(value, bool):
        raise TypeError(f"{key} must be an integer")
    if isinstance(value, int):
        return value
    raise ValueError(f"{key} must be an integer")


def string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list | tuple):
        raise TypeError("args must be a list")
    args: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise TypeError("args must contain only strings")
        args.append(item)
    return tuple(args)


@dataclass(frozen=True, slots=True)
class RuntimeIdParams:
    scope: RuntimeScope

    @property
    def runtime_id(self) -> str:
        return self.scope.runtime_id

    @property
    def runtime_type(self) -> str:
        return self.scope.runtime_type

    @classmethod
    def parse(
        cls,
        params: dict[str, Any],
        *,
        control_version: str = "1.0",
    ) -> RuntimeIdParams:
        if control_version == "2.0":
            require_only_fields(params, _V2_RUNTIME_SCOPE_FIELDS)
            return cls(scope=scoped_runtime(params))
        runtime_id = required_runtime_id(params)
        if runtime_id.startswith("rti_"):
            raise RuntimeInstancesUnsupportedError(
                "named runtime instances require Runtime Control 2.0"
            )
        runtime_type = params.get("runtime")
        if runtime_type is not None and runtime_type != runtime_id:
            raise RuntimeInvalidRequestError(
                "legacy runtime and runtimeId must identify the same provider type"
            )
        return cls(scope=legacy_runtime_scope(runtime_id))


@dataclass(frozen=True, slots=True)
class RuntimeConfigParams:
    instance: RuntimeInstanceSpec
    config: dict[str, Any]
    config_revision: int | None

    @property
    def runtime_id(self) -> str:
        return self.instance.runtime_id

    @property
    def runtime_type(self) -> str:
        return self.instance.runtime_type

    @classmethod
    def parse(
        cls,
        params: dict[str, Any],
        *,
        control_version: str = "1.0",
        display_name: str | None = None,
    ) -> RuntimeConfigParams:
        if control_version == "2.0":
            require_only_fields(params, _V2_RUNTIME_CONFIG_FIELDS)
            scope = scoped_runtime(params)
            instance = RuntimeInstanceSpec(
                runtime_id=scope.runtime_id,
                runtime_type=scope.runtime_type,
                name=required_name(params),
            )
            config_revision = required_safe_int(params, "configRevision")
        else:
            runtime_id = required_runtime_id(params)
            if runtime_id.startswith("rti_"):
                raise RuntimeInstancesUnsupportedError(
                    "named runtime instances require Runtime Control 2.0"
                )
            runtime_type = params.get("runtime")
            if runtime_type is not None and runtime_type != runtime_id:
                raise RuntimeInvalidRequestError(
                    "legacy runtime and runtimeId must identify the same provider type"
                )
            scope = legacy_runtime_scope(runtime_id)
            instance = RuntimeInstanceSpec(
                runtime_id=scope.runtime_id,
                runtime_type=scope.runtime_type,
                name=display_name or scope.runtime_type,
            )
            config_revision = optional_safe_int(
                params,
                "configRevision",
                minimum=1,
            )
        return cls(
            instance=instance,
            config=runtime_config(params),
            config_revision=config_revision,
        )


@dataclass(frozen=True, slots=True)
class RuntimeCatalogParams:
    query: str | None
    limit: int

    @classmethod
    def parse(cls, params: dict[str, Any]) -> RuntimeCatalogParams:
        return cls(
            query=optional_string(params.get("query")),
            limit=int_param(params, "limit", 100),
        )


@dataclass(frozen=True, slots=True)
class RuntimeCommandsParams:
    limit: int

    @classmethod
    def parse(cls, params: dict[str, Any]) -> RuntimeCommandsParams:
        return cls(limit=int_param(params, "limit", 100))


@dataclass(frozen=True, slots=True)
class SessionDiscoverParams:
    limit: int
    cursor: str | None
    force: bool

    @classmethod
    def parse(cls, params: dict[str, Any]) -> SessionDiscoverParams:
        return cls(
            limit=int_param(params, "limit", 100),
            cursor=optional_string(params.get("cursor")),
            force=bool(params.get("force", True)),
        )


@dataclass(frozen=True, slots=True)
class SessionReadParams:
    session_id: str
    external_session_id: str | None
    limit: int | None

    @classmethod
    def parse(cls, params: dict[str, Any]) -> SessionReadParams:
        return cls(
            session_id=required_session_id(params),
            external_session_id=optional_string(params.get("externalSessionId")),
            limit=optional_int_param(params, "limit"),
        )


@dataclass(frozen=True, slots=True)
class SessionCapabilityParams:
    session_id: str
    external_session_id: str | None

    @classmethod
    def parse(cls, params: dict[str, Any]) -> SessionCapabilityParams:
        return cls(
            session_id=required_session_id(params),
            external_session_id=optional_string(params.get("externalSessionId")),
        )


@dataclass(frozen=True, slots=True)
class SessionSelectionUpdateParams:
    session_id: str
    external_session_id: str | None
    selections: dict[str, str | None]

    @classmethod
    def parse(cls, params: dict[str, Any]) -> SessionSelectionUpdateParams:
        return cls(
            session_id=required_session_id(params),
            external_session_id=optional_string(params.get("externalSessionId")),
            selections=runtime_selections(params),
        )


@dataclass(frozen=True, slots=True)
class SessionCreateParams:
    session_id: str
    content: str
    title: str | None
    cwd: str | None
    selections: dict[str, str | None]
    attachments: tuple[RuntimeAttachment, ...]
    client_message_id: str | None

    @classmethod
    def parse(cls, params: dict[str, Any]) -> SessionCreateParams:
        return cls(
            session_id=required_session_id(params),
            content=required_content(params),
            title=optional_string(params.get("title")),
            cwd=optional_string(params.get("cwd")),
            selections=runtime_selections(params),
            attachments=runtime_attachments(params),
            client_message_id=optional_string(params.get("clientMessageId")),
        )


@dataclass(frozen=True, slots=True)
class TurnStartParams:
    session_id: str
    external_session_id: str | None
    content: str
    cwd: str | None
    selections: dict[str, str | None]
    attachments: tuple[RuntimeAttachment, ...]
    client_message_id: str | None

    @classmethod
    def parse(cls, params: dict[str, Any]) -> TurnStartParams:
        return cls(
            session_id=required_session_id(params),
            external_session_id=optional_string(params.get("externalSessionId")),
            content=required_content(params),
            cwd=optional_string(params.get("cwd")),
            selections=runtime_selections(params),
            attachments=runtime_attachments(params),
            client_message_id=optional_string(params.get("clientMessageId")),
        )


@dataclass(frozen=True, slots=True)
class TurnSteerParams:
    session_id: str
    external_session_id: str | None
    content: str
    attachments: tuple[RuntimeAttachment, ...]
    client_message_id: str | None

    @classmethod
    def parse(cls, params: dict[str, Any]) -> TurnSteerParams:
        return cls(
            session_id=required_session_id(params),
            external_session_id=optional_string(params.get("externalSessionId")),
            content=required_content(params),
            attachments=runtime_attachments(params),
            client_message_id=optional_string(params.get("clientMessageId")),
        )


@dataclass(frozen=True, slots=True)
class SessionInterruptParams:
    session_id: str
    reason: str | None

    @classmethod
    def parse(cls, params: dict[str, Any]) -> SessionInterruptParams:
        return cls(
            session_id=required_session_id(params),
            reason=optional_string(params.get("reason")),
        )


@dataclass(frozen=True, slots=True)
class SessionCommandsParams:
    session_id: str
    external_session_id: str | None
    query: str | None
    limit: int

    @classmethod
    def parse(cls, params: dict[str, Any]) -> SessionCommandsParams:
        return cls(
            session_id=required_session_id(params),
            external_session_id=optional_string(params.get("externalSessionId")),
            query=optional_string(params.get("query")),
            limit=int_param(params, "limit", 50),
        )


@dataclass(frozen=True, slots=True)
class CommandExecuteParams:
    session_id: str
    external_session_id: str | None
    command: str
    raw: str | None
    args: tuple[str, ...]

    @classmethod
    def parse(cls, params: dict[str, Any]) -> CommandExecuteParams:
        return cls(
            session_id=required_session_id(params),
            external_session_id=optional_string(params.get("externalSessionId")),
            command=required_command(params),
            raw=optional_string(params.get("raw")),
            args=string_tuple(params.get("args") or ()),
        )


@dataclass(frozen=True, slots=True)
class InteractionRespondParams:
    session_id: str
    notice_id: str
    action_id: str
    input_data: dict[str, Any] | None

    @classmethod
    def parse(cls, params: dict[str, Any]) -> InteractionRespondParams:
        return cls(
            session_id=required_session_id(params),
            notice_id=required_notice_id(params),
            action_id=required_action_id(params),
            input_data=optional_mapping(params.get("inputData")),
        )
