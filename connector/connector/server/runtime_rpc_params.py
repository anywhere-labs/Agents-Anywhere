from __future__ import annotations

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
                media_type=optional_string(raw.get("mediaType") or raw.get("media_type")),
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


def string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list | tuple):
        raise TypeError("args must be a list")
    args: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise TypeError("args must contain only strings")
        args.append(item)
    return tuple(args)
