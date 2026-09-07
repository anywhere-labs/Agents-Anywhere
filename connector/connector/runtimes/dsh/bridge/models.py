from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from connector.runtime_protocol import (
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeReasoningItem,
    RuntimeTimelineItem,
    SessionMeta,
    SessionNotice,
    SessionState,
    timeline_content_hash,
)
from connector.runtime_protocol.models import RuntimeStatus

_STATUSES = {
    "idle",
    "waiting",
    "pending",
    "running",
    "stopping",
    "waiting_approval",
    "blocked",
    "error",
    "disconnected",
}


def capability_set(value: Any, *, connector_id: str) -> RuntimeCapabilitySet:
    data = _mapping(value, "capability set")
    runtime = _runtime(data)
    session_id = _optional_string(data.get("sessionId"))
    capabilities: list[RuntimeCapability] = []
    for raw in _list(data.get("capabilities"), "capabilities"):
        item = _mapping(raw, "capability")
        scope = item.get("scope", "session" if session_id else "runtime")
        if scope not in {"runtime", "session"}:
            raise ValueError("DSH capability scope is invalid")
        capabilities.append(
            RuntimeCapability(
                capability_id=_required_string(
                    item.get("capabilityId"), "capabilityId"
                ),
                scope=scope,
                runtime=runtime,
                version=str(item.get("version") or "1"),
                session_id=_optional_string(item.get("sessionId")) or session_id,
                connector_id=connector_id,
                supported=_boolean(item.get("supported"), True),
                available=_boolean(item.get("available"), True),
                allowed=_boolean(item.get("allowed"), True),
                unavailable_reason=_optional_string(item.get("unavailableReason")),
                metadata=_dict(item.get("metadata")),
            )
        )
    return RuntimeCapabilitySet(
        runtime=runtime,
        revision=_revision(data.get("revision")),
        capabilities=tuple(capabilities),
        session_id=session_id,
        connector_id=connector_id,
        metadata=_dict(data.get("metadata")),
    )


def model_catalog(value: Any) -> RuntimeModelCatalog:
    data = _mapping(value, "model catalog")
    models: list[RuntimeModelItem] = []
    for raw in _list(data.get("models"), "models"):
        item = _mapping(raw, "model")
        reasoning: list[RuntimeReasoningItem] = []
        for raw_effort in _list(item.get("reasoningItems", []), "reasoningItems"):
            effort = _mapping(raw_effort, "reasoning item")
            reasoning.append(
                RuntimeReasoningItem(
                    id=_required_string(effort.get("id"), "reasoning id"),
                    title=_required_string(effort.get("title"), "reasoning title"),
                    selection_id=_required_string(
                        effort.get("selectionId"), "reasoning selectionId"
                    ),
                    description=_optional_string(effort.get("description")),
                    enabled=_boolean(effort.get("enabled"), True),
                    disabled_reason=_optional_string(effort.get("disabledReason")),
                    metadata=_dict(effort.get("metadata")),
                )
            )
        models.append(
            RuntimeModelItem(
                id=_required_string(item.get("id"), "model id"),
                title=_required_string(item.get("title"), "model title"),
                selection_id=_optional_string(item.get("selectionId")),
                description=_optional_string(item.get("description")),
                reasoning_items=tuple(reasoning),
                enabled=_boolean(item.get("enabled"), True),
                disabled_reason=_optional_string(item.get("disabledReason")),
                metadata=_dict(item.get("metadata")),
            )
        )
    return RuntimeModelCatalog(
        runtime=_runtime(data),
        revision=_revision(data.get("revision")),
        models=tuple(models),
    )


def permission_catalog(value: Any) -> RuntimePermissionCatalog:
    data = _mapping(value, "permission catalog")
    permissions: list[RuntimePermissionItem] = []
    for raw in _list(data.get("permissions"), "permissions"):
        item = _mapping(raw, "permission")
        permissions.append(
            RuntimePermissionItem(
                id=_required_string(item.get("id"), "permission id"),
                title=_required_string(item.get("title"), "permission title"),
                selection_id=_required_string(
                    item.get("selectionId"), "permission selectionId"
                ),
                description=_optional_string(item.get("description")),
                enabled=_boolean(item.get("enabled"), True),
                disabled_reason=_optional_string(item.get("disabledReason")),
                metadata=_dict(item.get("metadata")),
            )
        )
    return RuntimePermissionCatalog(
        runtime=_runtime(data),
        revision=_revision(data.get("revision")),
        permissions=tuple(permissions),
    )


def session_meta(value: Any, *, session_id: str | None = None) -> SessionMeta:
    data = _mapping(value, "session meta")
    return SessionMeta(
        session_id=session_id or _required_string(data.get("sessionId"), "sessionId"),
        external_session_id=_required_string(
            data.get("externalSessionId"), "externalSessionId"
        ),
        runtime=_runtime(data),
        title=_optional_string(data.get("title")),
        cwd=_optional_string(data.get("cwd")),
        ordering_time=_optional_string(
            data.get("orderingTime") or data.get("lastActivityAt")
        ),
        metadata=_dict(data.get("metadata")),
    )


def session_state(value: Any) -> SessionState:
    data = _mapping(value, "session state")
    raw_status = data.get("status")
    if raw_status not in _STATUSES:
        raise ValueError("DSH session status is invalid")
    selections = {
        str(key): item if isinstance(item, str) else None
        for key, item in _dict(data.get("selections")).items()
        if isinstance(key, str) and (item is None or isinstance(item, str))
    }
    return SessionState(
        session_id=_required_string(data.get("sessionId"), "sessionId"),
        external_session_id=_optional_string(data.get("externalSessionId")),
        runtime=_runtime(data),
        status=cast(RuntimeStatus, raw_status),
        selections=selections,
        status_reason=_optional_string(data.get("statusReason")),
        error=_dict(data.get("error"))
        if isinstance(data.get("error"), Mapping)
        else None,
        metadata=_dict(data.get("metadata")),
    )


def timeline_item(
    value: Any, *, default_session_id: str | None = None
) -> RuntimeTimelineItem:
    """Decode canonical platform items; native DSH projection belongs to the plugin."""
    data = _mapping(value, "timeline item")
    if "payload" in data:
        raise ValueError("DSH native payload projection is no longer supported")
    item_type = _required_string(data.get("type"), "timeline type")
    status = _required_string(data.get("status"), "timeline status")
    role = _optional_string(data.get("role"))
    if item_type not in {
        "message",
        "tool",
        "artifact",
        "marker",
        "system",
        "turn.start",
        "turn.end",
    }:
        raise ValueError("DSH timeline type is invalid")
    if status not in {
        "pending",
        "inProgress",
        "running",
        "waiting_approval",
        "done",
        "failed",
        "cancelled",
        "interrupted",
        "hidden",
    }:
        raise ValueError("DSH timeline status is invalid")
    if role not in {None, "user", "assistant", "system", "tool"}:
        raise ValueError("DSH timeline role is invalid")
    content = _mapping(data.get("content"), "timeline content")
    computed_hash = timeline_content_hash(item_type, status, role, content)  # type: ignore[arg-type]
    if data.get("contentHash") != computed_hash:
        raise ValueError("DSH timeline contentHash does not match canonical content")
    return RuntimeTimelineItem(
        id=_required_string(data.get("id"), "timeline id"),
        session_id=default_session_id
        or _required_string(data.get("sessionId"), "sessionId"),
        type=item_type,
        status=status,
        order_seq=_nonnegative_int(data.get("orderSeq"), "orderSeq"),
        content_hash=computed_hash,
        role=role,
        turn_id=_optional_string(data.get("turnId")),
        content=content,
        source=_mapping(data.get("source"), "timeline source"),
        revision=max(1, _nonnegative_int(data.get("revision"), "revision")),
        metadata=_dict(data.get("metadata")),
    )


def notice(value: Any) -> SessionNotice:
    data = _mapping(value, "notice")
    notice_type = data.get("type", "notification")
    if notice_type not in {"notification", "interaction"}:
        raise ValueError("DSH notice type is invalid")
    severity = data.get("severity", "info")
    if severity not in {"info", "success", "warning", "error"}:
        raise ValueError("DSH notice severity is invalid")
    return SessionNotice(
        notice_id=_required_string(data.get("noticeId"), "noticeId"),
        session_id=_required_string(data.get("sessionId"), "sessionId"),
        runtime=_runtime(data),
        type=notice_type,
        title=_required_string(data.get("title"), "notice title"),
        message=_optional_string(data.get("message")),
        severity=severity,
        status=_optional_string(data.get("status")) or "open",
        interaction_type=_optional_string(data.get("interactionType")),
        blocking=_dict(data.get("blocking"))
        if isinstance(data.get("blocking"), Mapping)
        else None,
        response_required=_boolean(data.get("responseRequired"), False),
        actions=tuple(
            _dict(item) for item in _list(data.get("actions", []), "actions")
        ),
        source=_dict(data.get("source")),
        context=_dict(data.get("context")),
        metadata=_dict(data.get("metadata")),
    )


def commands(value: Any) -> tuple[RuntimeCommand, ...]:
    raw_items = value.get("commands") if isinstance(value, Mapping) else value
    output: list[RuntimeCommand] = []
    for raw in _list(raw_items, "commands"):
        item = _mapping(raw, "command")
        output.append(
            RuntimeCommand(
                id=_required_string(item.get("id") or item.get("name"), "command id"),
                title=_required_string(
                    item.get("title") or item.get("name"), "command title"
                ),
                description=_optional_string(item.get("description")),
                aliases=tuple(
                    value for value in item.get("aliases", []) if isinstance(value, str)
                ),
                category=_optional_string(item.get("category")),
                scope="session",
                enabled=_boolean(item.get("enabled"), True),
                disabled_reason=_optional_string(item.get("disabledReason")),
                accepts_args=_boolean(item.get("acceptsArgs"), False),
                args_schema=_dict(item.get("argsSchema"))
                if isinstance(item.get("argsSchema"), Mapping)
                else None,
                metadata=_dict(item.get("metadata")),
            )
        )
    return tuple(output)


def command_result(value: Any, command: str) -> RuntimeCommandResult:
    data = _mapping(value, "command result")
    return RuntimeCommandResult(
        command=_optional_string(data.get("command")) or command,
        ok=_boolean(data.get("ok"), True),
        code=_optional_string(data.get("code")),
        message=_optional_string(data.get("message")),
        result=_dict(data.get("result")),
    )


def _runtime(data: Mapping[str, Any]) -> str:
    runtime = data.get("runtime", "dsh")
    if runtime != "dsh":
        raise ValueError("bridge payload runtime must be dsh")
    return "dsh"


def _mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"DSH {label} must be an object")
    return {str(key): item for key, item in value.items() if isinstance(key, str)}


def _dict(value: Any) -> dict[str, Any]:
    return _mapping(value, "mapping") if isinstance(value, Mapping) else {}


def _list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"DSH {label} must be an array")
    return value


def _required_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"DSH {label} must be a non-empty string")
    return value


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _revision(value: Any) -> int:
    return _nonnegative_int(value, "revision")


def _nonnegative_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"DSH {label} must be a non-negative integer")
    return value


def _boolean(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise ValueError("DSH boolean field is invalid")
    return value
