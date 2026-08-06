from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import RuntimeAttachment


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
                content_base64=optional_string(
                    raw.get("contentBase64") or raw.get("content_base64")
                ),
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
    runtime_id: str

    @classmethod
    def parse(cls, params: dict[str, Any]) -> RuntimeIdParams:
        return cls(runtime_id=required_runtime_id(params))


@dataclass(frozen=True, slots=True)
class RuntimeConfigParams:
    runtime_id: str
    config: dict[str, Any]

    @classmethod
    def parse(cls, params: dict[str, Any]) -> RuntimeConfigParams:
        return cls(
            runtime_id=required_runtime_id(params),
            config=runtime_config(params),
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
    selections: dict[str, str | None]
    attachments: tuple[RuntimeAttachment, ...]
    client_message_id: str | None

    @classmethod
    def parse(cls, params: dict[str, Any]) -> TurnStartParams:
        return cls(
            session_id=required_session_id(params),
            external_session_id=optional_string(params.get("externalSessionId")),
            content=required_content(params),
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
class TurnInterruptParams:
    session_id: str
    external_session_id: str | None
    reason: str | None

    @classmethod
    def parse(cls, params: dict[str, Any]) -> TurnInterruptParams:
        return cls(
            session_id=required_session_id(params),
            external_session_id=optional_string(params.get("externalSessionId")),
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
