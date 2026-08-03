from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any

from connector.runtime_protocol import TimelineSource
from connector.runtimes.codex.domain.sessions import (
    first_string_from_mapping,
)
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.timeline.content import (
    codex_timeline_content_from_mapping,
)
from connector.runtimes.codex.timeline.events import raw_item_from_notification
from connector.runtimes.codex.timeline.identity import (
    client_message_id_from_raw,
    derived_key,
    native_item_id,
    timeline_item_id,
)
from connector.runtimes.codex.timeline.items import (
    CodexTimelineItem,
    codex_timeline_item_class,
    timeline_item_status_from_string,
    timeline_item_type_from_string,
    timeline_role_from_string,
)
from connector.runtimes.codex.timeline.raw_content import (
    text_from_value,
    timeline_item_content,
)
from connector.runtimes.codex.timeline.raw_item import (
    timeline_item_revision,
    timeline_item_role,
    timeline_item_status,
    timeline_item_turn_id,
    timeline_item_type,
    timeline_raw_status,
    timeline_raw_type,
)


@dataclass(frozen=True, slots=True)
class CodexTimelineProjection:
    native_id: str | None
    raw_type: str
    status: str | None = None
    role: str | None = None
    turn_id: str | None = None
    text: str | None = None
    input_value: Any = None
    message: str | None = None
    name: str | None = None
    arguments: Any = None
    command: str | None = None
    aggregated_output: str | None = None
    output: Any = None
    exit_code: int | None = None
    path: str | None = None
    action: str | None = None
    patch: str | None = None
    changes: Any = None
    client_message_id: str | None = None
    revision: int = 1

    def with_client_message_id(self, client_message_id: str) -> CodexTimelineProjection:
        return replace(self, client_message_id=client_message_id)

    def with_text(self, text: str) -> CodexTimelineProjection:
        return replace(self, text=text)

    def with_aggregated_output(self, output: str) -> CodexTimelineProjection:
        return replace(self, aggregated_output=output)

    def with_patch(self, patch: str) -> CodexTimelineProjection:
        return replace(self, patch=patch)

    def with_status(self, status: str) -> CodexTimelineProjection:
        return replace(self, status=status)

    def to_codex_timeline_item(
        self,
        external_session_id: str,
        fallback_index: int,
        event: str,
    ) -> CodexTimelineItem:
        raw = self.to_legacy_raw()
        item_type = timeline_item_type(raw)
        status = timeline_item_status(raw)
        role = timeline_item_role(raw)
        native_type = timeline_raw_type(raw)
        client_message_id = client_message_id_from_raw(raw)
        item_class = codex_timeline_item_class(native_type)
        platform_item_type = timeline_item_type_from_string(item_type)
        return item_class(
            id=timeline_item_id(raw, external_session_id, fallback_index),
            type=platform_item_type,
            status=timeline_item_status_from_string(status),
            role=timeline_role_from_string(role),
            turn_id=timeline_item_turn_id(raw),
            content=codex_timeline_content_from_mapping(
                native_item_type=native_type,
                platform_item_type=platform_item_type,
                content=timeline_item_content(raw),
            ),
            source=TimelineSource(runtime="codex"),
            revision=timeline_item_revision(raw),
            native_item_type=native_type,
            native_item_id=native_item_id(raw),
            external_session_id=external_session_id,
            event=event,
            derived_key=derived_key(raw, fallback_index),
            client_message_id=client_message_id,
            metadata={"raw": raw},
        )

    def to_legacy_raw(self) -> dict[str, Any]:
        raw: dict[str, Any] = {
            "type": self.raw_type,
            **({"id": self.native_id} if self.native_id else {}),
            **({"status": self.status} if self.status else {}),
            **({"role": self.role} if self.role else {}),
            **({"turnId": self.turn_id} if self.turn_id else {}),
            **({"text": self.text} if self.text is not None else {}),
            **({"input": self.input_value} if self.input_value is not None else {}),
            **({"message": self.message} if self.message else {}),
            **({"name": self.name} if self.name else {}),
            **({"arguments": self.arguments} if self.arguments is not None else {}),
            **({"command": self.command} if self.command is not None else {}),
            **(
                {"aggregatedOutput": self.aggregated_output}
                if self.aggregated_output is not None
                else {}
            ),
            **({"output": self.output} if self.output is not None else {}),
            **({"exitCode": self.exit_code} if self.exit_code is not None else {}),
            **({"path": self.path} if self.path else {}),
            **({"action": self.action} if self.action else {}),
            **({"patch": self.patch} if self.patch is not None else {}),
            **({"changes": self.changes} if self.changes is not None else {}),
            **(
                {"_clientMessageId": self.client_message_id}
                if self.client_message_id
                else {}
            ),
            **({"revision": self.revision} if self.revision > 1 else {}),
        }
        return raw


def timeline_projection_from_event(
    event: CodexSdkEvent,
) -> CodexTimelineProjection | None:
    raw = raw_item_from_notification(event.event_type, event.params)
    if raw is None:
        return None
    return timeline_projection_from_raw(raw)


def timeline_projection_from_raw(raw: Mapping[str, Any]) -> CodexTimelineProjection:
    raw_dict = dict(raw)
    return CodexTimelineProjection(
        native_id=native_item_id(raw_dict),
        raw_type=timeline_raw_type(raw_dict),
        status=timeline_raw_status(raw_dict),
        role=timeline_item_role(raw_dict),
        turn_id=timeline_item_turn_id(raw_dict),
        text=text_from_value(raw_dict),
        input_value=raw_dict.get("input"),
        message=first_string_from_mapping(raw_dict, "message"),
        name=first_string_from_mapping(raw_dict, "name", "function", "tool"),
        arguments=raw_dict.get("arguments") or raw_dict.get("input"),
        command=first_string_from_mapping(raw_dict, "command", "cmd"),
        aggregated_output=first_string_from_mapping(raw_dict, "aggregatedOutput"),
        output=raw_dict.get("output") or raw_dict.get("outputText"),
        exit_code=(
            raw_dict.get("exitCode")
            if isinstance(raw_dict.get("exitCode"), int)
            else None
        ),
        path=first_string_from_mapping(raw_dict, "path", "file", "filePath"),
        action=first_string_from_mapping(raw_dict, "action", "operation"),
        patch=first_string_from_mapping(raw_dict, "patch", "diff"),
        changes=raw_dict.get("changes"),
        client_message_id=client_message_id_from_raw(raw_dict),
        revision=timeline_item_revision(raw_dict),
    )


def timeline_item_from_projection(
    projection: CodexTimelineProjection,
    external_session_id: str,
    fallback_index: int,
    event: str,
) -> CodexTimelineItem:
    return projection.to_codex_timeline_item(
        external_session_id=external_session_id,
        fallback_index=fallback_index,
        event=event,
    )
