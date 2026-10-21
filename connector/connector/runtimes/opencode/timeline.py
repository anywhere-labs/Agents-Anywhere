"""Map opencode session messages (info + parts) to platform timeline items.

OpenCode stores a session as an ordered list of messages; each message has
``info`` (role, ids, tokens, timing) and ``parts`` (text / reasoning / tool /
step-start / step-finish). The platform timeline is a flat, ordered list of
typed items, so we expand parts in message order and drop internal
``step-start``/``step-finish`` markers.
"""

from __future__ import annotations

from typing import Any

from connector.runtime_protocol.size_budget import MAX_TIMELINE_TEXT_BYTES
from connector.runtime_protocol.timeline import (
    MarkdownMessageContent,
    MessageTimelineItem,
    PlatformTimelineItem,
    ReasoningSystemContent,
    SystemTimelineItem,
    TextMessageContent,
    TimelineSource,
    ToolCallContent,
    ToolTimelineItem,
)
from connector.runtimes.opencode.attachments import (
    decode_filename,
    path_from_file_url,
    staged_file_id,
)

# opencode stores attachments as inline data URLs, so a video arrives as
# megabytes of base64. Keep the inline URL only while it still fits the frame
# budget alongside the rest of the item.
MAX_INLINE_ATTACHMENT_BYTES = MAX_TIMELINE_TEXT_BYTES

RUNTIME = "opencode"

_TOOL_STATUS_MAP = {
    "completed": "done",
    "running": "running",
    "error": "failed",
}


def _source(
    external_session_id: str | None,
    native_item_id: str,
    turn_id: str | None = None,
    client_message_id: str | None = None,
) -> TimelineSource:
    return TimelineSource(
        runtime=RUNTIME,
        external_session_id=external_session_id,
        native_item_id=native_item_id,
        turn_id=turn_id,
        client_message_id=client_message_id,
    )


def _tool_status(state: dict[str, Any] | None) -> str:
    status = (state or {}).get("status")
    return _TOOL_STATUS_MAP.get(status, "pending")


def _user_attachments(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Map user ``file`` parts to the platform's attachment content entries.

    The platform fileId recovery priority:

    1. **Filename-encoded** (preferred): ``attachments.to_part`` embeds the
       platform fileId as ``<fileId>__<realName>`` in the ``filename`` field,
       because opencode inlines ``file://`` URLs into ``data:`` URLs when
       storing the message (which would otherwise lose the file id).
       ``decode_filename`` splits the encoded pair back.
    2. **Staged path**: when the URL is still a ``file://`` path under the
       connector's session attachment directory, recover the fileId from the
       parent directory name. This branch only fires for snapshots taken
       before opencode has inlined the URL.
    3. **Synthetic fallback**: ``opencode-<partId>`` — no platform match, so
       the client cannot merge its optimistic preview. Surfaced as a last
       resort so the chip still renders.

    A ``data:`` URL means the file came from the opencode web UI's own
    uploader; it is surfaced as an inline ``openUrl`` instead.
    """

    entries: list[dict[str, Any]] = []
    for part in parts:
        if part.get("type") != "file":
            continue
        url = str(part.get("url") or "")
        raw_filename = str(part.get("filename") or "file")
        encoded_file_id, real_name = decode_filename(raw_filename)
        staged_file_id_value = staged_file_id(url)
        file_id = encoded_file_id or staged_file_id_value
        entry: dict[str, Any] = {"name": real_name}
        media_type = part.get("mime")
        if isinstance(media_type, str) and media_type:
            entry["mediaType"] = media_type
        if file_id:
            entry["fileId"] = file_id
        if url.startswith("data:"):
            # opencode stores attachments as inline data URLs, so a video lands
            # here as several megabytes of base64. One such entry pushes the
            # whole itemUpsert past the frame budget. Drop the inline URL and
            # keep the chip: the client resolves the bytes through its own
            # attachment channel, which is how every other runtime delivers
            # them. Inventing extra keys here would violate the content
            # contract, so the entry simply looks like a non-inline one.
            if len(url.encode("utf-8")) <= MAX_INLINE_ATTACHMENT_BYTES:
                entry["openUrl"] = url
        else:
            staged = path_from_file_url(url)
            if staged is not None:
                try:
                    entry["size"] = staged.stat().st_size
                except OSError:
                    pass
        if "fileId" not in entry:
            # Unknown origin (e.g. a raw path from another client): keep a
            # stable synthetic id so the client still renders the chip.
            entry["fileId"] = f"opencode-{part.get('id') or len(entries)}"
        entries.append(entry)
    return entries


def map_user_message_item(
    external_session_id: str | None,
    message_id: str,
    parts: list[dict[str, Any]],
    *,
    client_message_id: str | None = None,
) -> MessageTimelineItem | None:
    """Map one opencode *user* message to a platform item.

    Shared by the snapshot mapper and the live stream so both produce the same
    item id (the opencode message id) and the same content — otherwise the live
    item and the turn-end snapshot would show the prompt twice, and the live one
    would not merge with the client's optimistic echo (which only merges when
    ``source.clientMessageId`` matches).
    """

    text = "\n".join(
        str(part.get("text") or "")
        for part in parts
        if part.get("type") == "text" and not part.get("synthetic")
    ).strip()
    attachments = _user_attachments(parts)
    if not text and not attachments:
        return None
    return MessageTimelineItem(
        id=message_id,
        type="message",
        status="done",
        role="user",
        turn_id=message_id,
        content=TextMessageContent(
            text=text,
            metadata={"attachments": attachments} if attachments else {},
        ),
        source=_source(
            external_session_id,
            message_id,
            message_id,
            client_message_id=client_message_id,
        ),
    )


def map_messages_to_timeline(
    external_session_id: str | None,
    messages: list[dict[str, Any]],
    client_message_ids: dict[str, str] | None = None,
) -> tuple[PlatformTimelineItem, ...]:
    """Expand opencode messages into an ordered tuple of platform items.

    ``client_message_ids`` maps native user-message ids to the platform
    ``clientMessageId`` of the web message that produced them, so clients can
    merge the optimistic echo instead of showing the message twice.
    """

    items: list[PlatformTimelineItem] = []

    for message in messages:
        info = message.get("info") or {}
        parts = message.get("parts") or []
        role = info.get("role")
        message_id = str(info.get("id") or "")
        if not message_id:
            continue

        # Turn id: an assistant message points back to the user message via
        # parentID; a user message is itself the turn anchor.
        turn_id = info.get("parentID") if role == "assistant" else message_id
        turn_id = str(turn_id) if turn_id else None

        if role == "user":
            item = map_user_message_item(
                external_session_id,
                message_id,
                parts,
                client_message_id=(client_message_ids or {}).get(message_id),
            )
            if item is not None:
                items.append(item)
            continue

        if role != "assistant":
            continue

        for part in parts:
            part_type = part.get("type")
            part_id = str(part.get("id") or f"{message_id}:{part_type}:{len(items)}")

            if part_type == "text":
                text = str(part.get("text") or "").strip()
                if not text:
                    continue
                items.append(
                    MessageTimelineItem(
                        id=part_id,
                        type="message",
                        status="done",
                        role="assistant",
                        turn_id=turn_id,
                        content=MarkdownMessageContent(text=text),
                        source=_source(external_session_id, part_id, turn_id),
                    )
                )

            elif part_type == "reasoning":
                text = str(part.get("text") or "").strip()
                if not text:
                    continue
                items.append(
                    SystemTimelineItem(
                        id=part_id,
                        type="system",
                        status="done",
                        role="system",
                        turn_id=turn_id,
                        content=ReasoningSystemContent(text=text),
                        source=_source(external_session_id, part_id, turn_id),
                    )
                )

            elif part_type == "tool":
                state = part.get("state") or {}
                tool_name = str(part.get("tool") or "tool")
                items.append(
                    ToolTimelineItem(
                        id=part_id,
                        type="tool",
                        status=_tool_status(state),
                        role="tool",
                        turn_id=turn_id,
                        content=ToolCallContent(
                            title=tool_name,
                            input=state.get("input"),
                            output=state.get("output"),
                        ),
                        source=_source(external_session_id, part_id, turn_id),
                        metadata={"tool": tool_name, "callID": part.get("callID")},
                    )
                )

            # step-start / step-finish and other internal parts are dropped.

    return tuple(items)


def map_streaming_part(
    external_session_id: str | None,
    part: dict[str, Any],
    *,
    text: str,
    turn_id: str | None,
    revision: int = 1,
    streaming: bool = True,
) -> PlatformTimelineItem | None:
    """Map one in-flight opencode part to a platform timeline item.

    Used for live updates while a turn runs: opencode emits
    ``message.part.delta`` (an append-only ``delta`` string) and
    ``message.part.updated`` (the whole part, sent again when it changes or
    completes). The item id is the opencode part id — the same id
    ``map_messages_to_timeline`` uses for that part — so the streamed item and
    the end-of-turn snapshot replace each other instead of duplicating.

    ``text`` is the accumulated content (``part["text"]`` for an updated part,
    the running accumulation for a delta). ``streaming`` only affects the
    status: live items are ``running``, the terminal update is ``done``.
    """

    part_id = str(part.get("id") or "")
    if not part_id:
        return None
    part_type = part.get("type")
    content = text.strip()
    if part_type == "text":
        if not content:
            return None
        return MessageTimelineItem(
            id=part_id,
            type="message",
            status="running" if streaming else "done",
            role="assistant",
            turn_id=turn_id,
            revision=revision,
            content=MarkdownMessageContent(text=content),
            source=_source(external_session_id, part_id, turn_id),
        )
    if part_type == "reasoning":
        if not content:
            return None
        return SystemTimelineItem(
            id=part_id,
            type="system",
            status="running" if streaming else "done",
            role="system",
            turn_id=turn_id,
            revision=revision,
            content=ReasoningSystemContent(text=content),
            source=_source(external_session_id, part_id, turn_id),
        )
    if part_type == "tool":
        state = part.get("state") or {}
        tool_name = str(part.get("tool") or "tool")
        return ToolTimelineItem(
            id=part_id,
            type="tool",
            # A running tool keeps ``running`` regardless of ``streaming``: the
            # status comes from opencode's own tool state.
            status=_tool_status(state),
            role="tool",
            turn_id=turn_id,
            revision=revision,
            content=ToolCallContent(
                title=tool_name,
                input=state.get("input"),
                output=state.get("output"),
            ),
            source=_source(external_session_id, part_id, turn_id),
            metadata={"tool": tool_name, "callID": part.get("callID")},
        )
    return None


def derive_session_status(messages: list[dict[str, Any]]) -> str:
    """Derive a runtime status from the tail of the message list.

    - last assistant message has no ``completed`` time  -> running
    - last message is a user message (turn started)     -> running
    - otherwise                                          -> idle
    """

    if not messages:
        return "idle"
    last = messages[-1]
    info = last.get("info") or {}
    role = info.get("role")
    if role == "assistant":
        completed = (info.get("time") or {}).get("completed")
        return "idle" if completed else "running"
    if role == "user":
        return "running"
    return "idle"
