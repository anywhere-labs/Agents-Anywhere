"""Project the host service's stored messages into canonical timeline items.

The item shapes are the ones Agents Anywhere already renders -- content kinds
`markdown`, `tool_call`, `command`, `turn_start` / `turn_end`, `error`, marker
kinds -- because that is what the plugin projector emitted and what the client
draws. Inventing a new `kind` here would render as nothing on the client, so
this module mirrors the existing vocabulary rather than designing a new one.

Turn structure comes from the stored data itself, and the live shapes measured in
`docs/opencode-server-surface.md` §4.1 are not the tidy pairing the schema
suggests: one 649-message session held 46 `user` messages and **101** `idle`
messages (a turn can idle per step), and 7 turns had no `idle` at all. So
`turn.end` is emitted only for an `idle` that finds a turn open, and a turn left
without one is reported as such rather than closed with a made-up outcome.

Tool results are the same story: a stored tool part carries its answer in
`state.content` (a `Tool.Content` array), never in `output`/`result`, so reading
only those keys silently produced title-only tool rows on real sessions.
"""

from __future__ import annotations

import hashlib
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem
from connector.runtime_protocol.timeline import timeline_content_hash

RUNTIME = "opencode"
TOOL_STATUS = {
    "completed": "done",
    "error": "failed",
    "running": "running",
    "streaming": "running",
    "pending": "pending",
    "cancelled": "cancelled",
}
#: `Session.Message.Idle.outcome` is exactly `succeeded|failed|interrupted`.
TURN_END_STATUS = {
    "succeeded": "done",
    "failed": "failed",
    "interrupted": "interrupted",
    "cancelled": "cancelled",
}
SHELL_STATUS = {
    "running": "running",
    "exited": "done",
    "timeout": "failed",
    "killed": "cancelled",
    "completed": "done",
}
SWITCH_TYPES = ("agent-switched", "model-switched", "location-switched")


def timeline_item_id(native_key: str) -> str:
    return f"itm_{hashlib.sha256(native_key.encode('utf-8')).hexdigest()[:24]}"


@dataclass(frozen=True, slots=True)
class Projection:
    """Projected items plus what the projector chose not to draw.

    `skipped` is reported to the Hub in the snapshot metadata so "the client
    shows nothing for X" is a number someone can look at instead of a rumour.
    """

    items: tuple[RuntimeTimelineItem, ...] = ()
    skipped: Counter[str] = field(default_factory=Counter)


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _markdown(text: str) -> dict[str, Any]:
    return {"kind": "markdown", "text": text, "format": "markdown"}


def _tool_content(part: Mapping[str, Any], state: Mapping[str, Any]) -> dict[str, Any]:
    content: dict[str, Any] = {"kind": "tool_call", "title": str(part.get("name") or part.get("id") or "tool")}
    if "input" in state:
        content["input"] = state["input"]
    # `Tool.Content` is `[{type:"text"|"file", …}]`; the array goes over verbatim
    # because that is the value the plugin put in `output` and the client learned
    # to fold.
    if state.get("content") is not None:
        content["output"] = state["content"]
    if state.get("error") is not None:
        content["error"] = state["error"]
    if state.get("metadata") is not None and state.get("status") == "running":
        content["progress"] = state["metadata"]
    return content


def _shell_content(message: Mapping[str, Any]) -> dict[str, Any]:
    command = message.get("command")
    content: dict[str, Any] = {"kind": "command", "title": str(command or "shell")}
    if isinstance(command, str):
        content["command"] = command
    if message.get("output") is not None:
        content["output"] = message["output"]
    exit_code = message.get("exit")
    if isinstance(exit_code, int) and not isinstance(exit_code, bool):
        content["exitCode"] = exit_code
    elif isinstance(exit_code, str) and exit_code.isdigit():
        content["exitCode"] = int(exit_code)
    return content


def _switch_label(message: Mapping[str, Any]) -> str:
    kind = str(message.get("type"))
    current = message.get("model")
    if kind == "model-switched" and isinstance(current, Mapping):
        return f"model → {current.get('providerID')}/{current.get('id')}"
    if isinstance(current, str):
        return f"{kind.replace('-switched', '')} → {current}"
    return str(kind)


def _build(
    *,
    native_key: str,
    session_id: str,
    item_type: str,
    status: str,
    role: str | None,
    order_seq: int,
    content: dict[str, Any],
    source_event: str,
    turn_id: str | None,
    native_item_id: str | None,
    metadata: dict[str, Any],
) -> RuntimeTimelineItem:
    return RuntimeTimelineItem(
        id=timeline_item_id(native_key),
        session_id=session_id,
        type=item_type,  # type: ignore[arg-type]
        status=status,  # type: ignore[arg-type]
        order_seq=order_seq,
        content_hash=timeline_content_hash(item_type, status, role, content),  # type: ignore[arg-type]
        role=role,  # type: ignore[arg-type]
        turn_id=turn_id,
        content=content,
        source={"runtime": RUNTIME, "event": source_event, **({"itemId": native_item_id} if native_item_id else {})},
        revision=1,
        metadata=metadata,
    )


def project_messages(rows: Sequence[Any], *, session_id: str) -> Projection:
    """Project chronologically ordered `/api/session/{id}/message` rows into items.

    Callers must pass oldest-first: the service's own default is newest-first, and
    `client.list_messages()` is what turns that around.
    """
    items: list[RuntimeTimelineItem] = []
    skipped: Counter[str] = Counter()
    turn_id: str | None = None

    def emit(**kwargs: Any) -> RuntimeTimelineItem:
        item = _build(session_id=session_id, order_seq=len(items) + 1, **kwargs)
        items.append(item)
        return item

    for message in rows:
        if not isinstance(message, Mapping):
            continue
        kind = message.get("type")
        native_id = message.get("id")
        if not isinstance(native_id, str):
            skipped["anonymous"] += 1
            continue

        if kind == "user":
            marker = emit(
                native_key=f"turn:start:{native_id}",
                item_type="turn.start",
                status="done",
                role="user",
                content={"kind": "turn_start"},
                source_event="message.user",
                turn_id=None,
                native_item_id=native_id,
                metadata={},
            )
            turn_id = marker.id
            emit(
                native_key=f"user:{native_id}",
                item_type="message",
                status="done",
                role="user",
                content=_markdown(_text(message.get("text"))),
                source_event="message.user",
                turn_id=turn_id,
                native_item_id=native_id,
                metadata=_user_metadata(message),
            )

        elif kind == "assistant":
            turn_fault = message.get("error")
            parts = message.get("content")
            parts = parts if isinstance(parts, Sequence) and not isinstance(parts, (str, bytes)) else []
            extra = _assistant_metadata(message)
            for ordinal, part in enumerate(parts):
                if not isinstance(part, Mapping):
                    continue
                part_type = part.get("type")
                if part_type in ("text", "reasoning"):
                    reasoning = part_type == "reasoning"
                    emit(
                        native_key=f"{part_type}:{native_id}:{ordinal}",
                        # Codex carries thinking as a `system` item with content
                        # kind `reasoning`, and the Hub's timeline row has no
                        # metadata column (measured against a live server), so a
                        # flag in metadata alone would make thinking
                        # indistinguishable from prose on the client.
                        item_type="system" if reasoning else "message",
                        status="done",
                        role="assistant",
                        content=(
                            {"kind": "reasoning", "text": _text(part.get("text"))}
                            if reasoning
                            else _markdown(_text(part.get("text")))
                        ),
                        source_event="message.assistant",
                        turn_id=turn_id,
                        native_item_id=native_id,
                        metadata={
                            "ordinal": ordinal,
                            **({"reasoning": True} if reasoning else {}),
                            **extra,
                        },
                    )
                elif part_type == "tool":
                    tool_id = part.get("id")
                    state = part.get("state")
                    state = state if isinstance(state, Mapping) else {}
                    raw_status = state.get("status")
                    emit(
                        native_key=f"tool:{native_id}:{ordinal}",
                        # A stored snapshot means the call already finished, so an
                        # unrecognised status is reported as done with the native
                        # value kept in metadata rather than guessed at.
                        item_type="tool",
                        status=TOOL_STATUS.get(raw_status if isinstance(raw_status, str) else "", "done"),
                        role="tool",
                        content=_tool_content(part, state),
                        source_event="message.assistant",
                        turn_id=turn_id,
                        native_item_id=tool_id if isinstance(tool_id, str) else native_id,
                        metadata={
                            **({"nativeToolId": tool_id} if isinstance(tool_id, str) else {}),
                            "messageId": native_id,
                            **({"executed": part["executed"]} if isinstance(part.get("executed"), bool) else {}),
                            **({} if isinstance(raw_status, str) and raw_status in TOOL_STATUS else {"nativeStatus": raw_status}),
                            **extra,
                        },
                    )
            if isinstance(turn_fault, Mapping) and not parts:
                # `finish: "error"` with no parts is an invisible failure unless
                # it is drawn; 8 of 418 assistant messages in the live sample.
                emit(
                    native_key=f"fault:{native_id}",
                    item_type="system",
                    status="failed",
                    role=None,
                    content={
                        "kind": "error",
                        "text": _text(turn_fault.get("message")) or _text(turn_fault.get("type")),
                        "severity": "error",
                    },
                    source_event="message.assistant",
                    turn_id=turn_id,
                    native_item_id=native_id,
                    metadata={"nativeType": _text(turn_fault.get("type")), **extra},
                )

        elif kind in ("synthetic", "system"):
            text = _text(message.get("text"))
            metadata = _subagent_metadata(message)
            if isinstance(message.get("description"), str):
                metadata["description"] = message["description"]
            emit(
                native_key=f"{kind}:{native_id}",
                item_type="message",
                status="done",
                role="system",
                content=_markdown(text),
                source_event=f"message.{kind}",
                turn_id=turn_id,
                native_item_id=native_id,
                metadata={"nativeType": kind, **metadata},
            )

        elif kind == "skill":
            emit(
                native_key=f"skill:{native_id}",
                item_type="tool",
                status="done",
                role="tool",
                content={
                    "kind": "tool_call",
                    "title": f"skill {_text(message.get('name')) or _text(message.get('skill'))}",
                    "input": {"skill": _text(message.get("skill"))},
                    "output": _text(message.get("text")),
                },
                source_event="message.skill",
                turn_id=turn_id,
                native_item_id=native_id,
                metadata={"nativeToolId": _text(message.get("skill")), "skill": True},
            )

        elif kind == "shell":
            status = message.get("status")
            emit(
                native_key=f"shell:{native_id}",
                item_type="tool",
                status=SHELL_STATUS.get(status if isinstance(status, str) else "", "done"),
                role="tool",
                content=_shell_content(message),
                source_event="message.shell",
                turn_id=turn_id,
                native_item_id=native_id,
                metadata={"nativeToolId": _text(message.get("shellID")), "shell": True},
            )

        elif kind == "compaction":
            emit(
                native_key=f"compact:{native_id}",
                item_type="marker",
                status="done",
                role=None,
                content={
                    "kind": "compact",
                    "label": f"Conversation compacted ({_text(message.get('reason')) or 'auto'})",
                    "text": _text(message.get("summary")),
                },
                source_event="message.compaction",
                turn_id=turn_id,
                native_item_id=native_id,
                metadata={"nativeStatus": _text(message.get("status"))},
            )

        elif kind in SWITCH_TYPES:
            emit(
                native_key=f"switch:{native_id}",
                item_type="marker",
                status="done",
                role=None,
                content={"kind": "system", "label": _switch_label(message)},
                source_event=f"message.{kind}",
                turn_id=turn_id,
                native_item_id=native_id,
                metadata={"nativeType": kind},
            )

        elif kind == "idle":
            if turn_id is None:
                # An idle with no open turn is a step boundary, not a turn end.
                skipped["idle_without_turn"] += 1
                continue
            outcome = message.get("outcome")
            emit(
                native_key=f"turn:end:{native_id}",
                item_type="turn.end",
                status=TURN_END_STATUS.get(outcome if isinstance(outcome, str) else "", "done"),
                role=None,
                content={"kind": "turn_end"},
                source_event="message.idle",
                turn_id=turn_id,
                native_item_id=native_id,
                metadata={"outcome": outcome} if isinstance(outcome, str) and outcome else {},
            )
            turn_id = None

        else:
            skipped[str(kind)] += 1

    return Projection(items=tuple(items), skipped=skipped)


def _user_metadata(message: Mapping[str, Any]) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    inner = message.get("metadata")
    if isinstance(inner, Mapping):
        for key in ("agent", "model"):
            if inner.get(key) is not None:
                metadata[key] = inner[key]
    return metadata


def _assistant_metadata(message: Mapping[str, Any]) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    for key in ("agent", "model", "finish"):
        if message.get(key) is not None:
            metadata[key] = message[key]
    return metadata


def _subagent_metadata(message: Mapping[str, Any]) -> dict[str, Any]:
    """Keep subagent provenance: this is how a child run shows up in the parent."""
    inner = message.get("metadata")
    if not isinstance(inner, Mapping) or inner.get("source") != "subagent":
        return {}
    metadata = {key: inner[key] for key in ("source", "childID", "agent", "state") if inner.get(key) is not None}
    return metadata
