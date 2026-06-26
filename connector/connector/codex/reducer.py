from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from connector.time import utc_now


CODEX_APPROVAL_METHODS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
}

OUTPUT_PREVIEW_CHARS = 4000


@dataclass(slots=True)
class ReductionResult:
    session_update: dict[str, Any] | None = None
    timeline_items: list[dict[str, Any]] = field(default_factory=list)
    approvals: list[dict[str, Any]] = field(default_factory=list)


class TimelineReducer:
    def __init__(self) -> None:
        self._session_by_thread: dict[str, str] = {}
        self._thread_by_session: dict[str, str] = {}
        self._items: dict[str, dict[str, Any]] = {}
        self._order_by_item: dict[str, int] = {}
        self._tool_kind_by_call: dict[str, str] = {}
        self._client_message_by_turn: dict[tuple[str, str | None, str], dict[str, Any]] = {}
        self._pending_client_messages: dict[tuple[str, str | None], list[dict[str, Any]]] = {}
        self._reasoning_index_by_turn: dict[tuple[str, str], int] = {}
        self._next_order = 1

    def bind_session(self, session_id: str, thread_id: str) -> None:
        self._session_by_thread[thread_id] = session_id
        self._thread_by_session[session_id] = thread_id

    def thread_for_session(self, session_id: str) -> str | None:
        return self._thread_by_session.get(session_id)

    def session_for_thread(self, thread_id: str) -> str | None:
        return self._session_by_thread.get(thread_id)

    def _session_update(
        self,
        *,
        session_id: str,
        thread_id: str | None,
        status: str | None = None,
        **values: Any,
    ) -> dict[str, Any]:
        update = {
            "sessionId": session_id,
            "runtime": "codex",
            "sourceObservedAt": utc_now(),
            **values,
        }
        if status is not None:
            update["status"] = status
        if thread_id:
            update["externalSessionId"] = thread_id
        return update

    def register_client_message(
        self,
        *,
        session_id: str,
        thread_id: str | None,
        client_message_id: str,
        text: str | None = None,
        turn_id: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> None:
        message = {"clientMessageId": client_message_id, "text": text, "attachments": attachments or []}
        if turn_id:
            self._client_message_by_turn[(session_id, thread_id, turn_id)] = message
            pending_key = (session_id, thread_id)
            pending = self._pending_client_messages.get(pending_key)
            if pending is not None:
                self._pending_client_messages[pending_key] = [
                    item for item in pending if item.get("clientMessageId") != client_message_id
                ]
            return
        self._pending_client_messages.setdefault((session_id, thread_id), []).append(
            message
        )

    def reduce_thread_snapshot(
        self,
        session_id: str,
        thread: dict[str, Any],
        *,
        fallback_thread_id: str | None = None,
    ) -> ReductionResult:
        thread_id = fallback_thread_id or _thread_id(thread)
        if thread_id:
            self.bind_session(session_id, thread_id)

        items: list[dict[str, Any]] = []
        for turn in _list_value(thread.get("turns")):
            turn_id = _string_value(turn.get("id")) or _string_value(turn.get("turnId"))
            status = _turn_status(turn)
            is_complete = status in {"completed", "failed", "cancelled", "interrupted"}
            turn_items = [
                item for item in _list_value(turn.get("items"))
                if not _is_bootstrap_user_message(item) and not _is_external_import_marker(item)
            ]
            message_counts = _message_type_counts(turn_items)
            message_indices: dict[str, int] = {}
            _reasoning_index_by_turn: dict[str | None, int] = {}
            if turn_id:
                items.append(
                    self._upsert_turn_start(
                        session_id,
                        thread_id,
                        turn_id,
                        turn,
                        status=_turn_result_to_status(_turn_result(turn)) if is_complete else "running",
                        event="turn/completed" if is_complete else "turn/started",
                    )
                )
            for index, item in enumerate(turn_items):
                item = dict(item)
                item.setdefault("_snapshotIndex", index)
                codex_type = _string_value(item.get("type"))
                if codex_type == "reasoning":
                    idx = _reasoning_index_by_turn.get(turn_id, 0)
                    item["_reasoningTurnIndex"] = idx
                    _reasoning_index_by_turn[turn_id] = idx + 1
                if codex_type in {"userMessage", "agentMessage"}:
                    message_index = message_indices.get(codex_type, 0)
                    message_indices[codex_type] = message_index + 1
                    if message_counts.get(codex_type, 0) > 1:
                        item["_messageKey"] = f"message-{codex_type}-{message_index}"
                reduced = self._upsert_completed_item(session_id, thread_id, turn_id, item)
                if reduced is not None:
                    items.append(reduced)
            if turn_id and is_complete:
                items.append(self._upsert_turn_end(session_id, thread_id, turn_id, turn))

        session_update = {
            "sessionId": session_id,
            "runtime": "codex",
            "status": _session_status_from_thread(thread),
            "externalSessionId": thread_id,
            "title": _string_value(thread.get("name")) or _string_value(thread.get("title")),
            "cwd": _string_value(thread.get("cwd")),
            "lastSyncedAt": utc_now(),
            "sourceObservedAt": utc_now(),
        }
        return ReductionResult(session_update=session_update, timeline_items=items)

    def reduce_history_items(
        self,
        session_id: str,
        thread_id: str,
        items: list[dict[str, Any]],
    ) -> ReductionResult:
        self.bind_session(session_id, thread_id)
        records: list[tuple[str | None, dict[str, Any]]] = []
        completed_turns: dict[str, str] = {}
        message_counts: dict[str, int] = {}
        for item_record in items:
            raw_item = item_record.get("item") if isinstance(item_record.get("item"), dict) else item_record
            if not isinstance(raw_item, dict):
                continue
            if _is_bootstrap_user_message(raw_item) or _is_external_import_marker(raw_item):
                continue
            turn_id = _string_value(item_record.get("turnId")) or _string_value(item_record.get("turn_id"))
            item = dict(raw_item)
            codex_type = _string_value(item.get("type"))
            if codex_type in {"userMessage", "agentMessage"}:
                message_counts[f"{turn_id}:{codex_type}"] = message_counts.get(f"{turn_id}:{codex_type}", 0) + 1
            if codex_type == "turnEnd" and turn_id is not None:
                completed_turns[turn_id] = _turn_result_to_status(_turn_result(item))
            records.append((turn_id, item))

        reduced_items: list[dict[str, Any]] = []
        message_indices: dict[str, int] = {}
        for turn_id, item in records:
            codex_type = _string_value(item.get("type"))
            if codex_type in {"userMessage", "agentMessage"} and _string_value(item.get("_derivedKey")) is None:
                message_index = message_indices.get(f"{turn_id}:{codex_type}", 0)
                message_indices[f"{turn_id}:{codex_type}"] = message_index + 1
                if message_counts.get(f"{turn_id}:{codex_type}", 0) > 1:
                    item["_messageKey"] = f"message-{codex_type}-{message_index}"
            if codex_type == "turnStart" and turn_id in completed_turns:
                item["_historyTurnStartStatus"] = completed_turns[turn_id]
            reduced = self._upsert_completed_item(
                session_id,
                thread_id,
                turn_id,
                item,
                event="history/response_item",
            )
            if reduced is not None:
                reduced_items.append(reduced)
        return ReductionResult(timeline_items=reduced_items)

    def reduce_notification(self, message: dict[str, Any]) -> ReductionResult:
        method = _string_value(message.get("method"))
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        thread_id = _extract_thread_id(params)
        turn_id = _extract_turn_id(params)
        session_id = _string_value(params.get("platformSessionId"))
        if session_id is None and thread_id is not None:
            session_id = self._session_by_thread.get(thread_id)
        if session_id is None:
            return ReductionResult()
        if thread_id:
            self.bind_session(session_id, thread_id)

        if method == "thread/name/updated":
            return ReductionResult(
                session_update=self._session_update(
                    session_id=session_id,
                    thread_id=thread_id,
                    title=_string_value(params.get("threadName")),
                ),
            )

        if method == "turn/started":
            return ReductionResult(
                session_update=self._session_update(
                    session_id=session_id,
                    thread_id=thread_id,
                    status="running",
                ),
                timeline_items=[self._upsert_turn_start(session_id, thread_id, turn_id, params.get("turn") or params)],
            )

        if method == "turn/completed":
            turn = params.get("turn") if isinstance(params.get("turn"), dict) else params
            return ReductionResult(
                session_update=self._session_update(
                    session_id=session_id,
                    thread_id=thread_id,
                    status=_session_status_from_turn(turn),
                ),
                timeline_items=self._complete_turn(session_id, thread_id, turn_id, turn),
            )

        if method == "turn/diff/updated":
            item = self._upsert_item(
                session_id=session_id,
                turn_id=turn_id,
                item_id=None,
                derived_key="turn-diff",
                item_type="artifact",
                status="running",
                role=None,
                content={
                    "kind": "diff",
                    "unifiedDiff": _string_value(params.get("diff")) or _string_value(params.get("patch")) or "",
                },
                source_session_id=thread_id,
                source_item_type=None,
                event=method,
            )
            return ReductionResult(timeline_items=[item])

        if method == "turn/plan/updated":
            plan = params.get("plan") if isinstance(params.get("plan"), dict) else params
            item = self._upsert_item(
                session_id=session_id,
                turn_id=turn_id,
                item_id=None,
                derived_key="turn-plan",
                item_type="system",
                status="running",
                role="system",
                content=_plan_content(plan),
                source_session_id=thread_id,
                source_item_type=None,
                event=method,
            )
            return ReductionResult(timeline_items=[item])

        if method in CODEX_APPROVAL_METHODS:
            approval = self._approval_from_request(method, message, params, session_id, thread_id, turn_id)
            timeline_item = self._approval_target_item(method, params, approval)
            return ReductionResult(
                session_update=self._session_update(
                    session_id=session_id,
                    thread_id=thread_id,
                    status="waiting_approval",
                ),
                timeline_items=[timeline_item] if timeline_item else [],
                approvals=[approval],
            )

        if method == "item/agentMessage/delta":
            item_id = _string_value(params.get("itemId")) or _nested_string(params, "item", "id")
            item = self._append_text_item(
                session_id=session_id,
                thread_id=thread_id,
                turn_id=turn_id,
                item_id=item_id,
                delta=_string_value(params.get("delta")) or _string_value(params.get("text")) or "",
            )
            return ReductionResult(timeline_items=[item])

        if method == "item/commandExecution/outputDelta":
            item_id = _string_value(params.get("itemId")) or _nested_string(params, "item", "id")
            item = self._append_command_output(
                session_id=session_id,
                thread_id=thread_id,
                turn_id=turn_id,
                item_id=item_id,
                delta=_string_value(params.get("delta")) or _string_value(params.get("text")) or "",
            )
            return ReductionResult(timeline_items=[item])

        if method == "item/fileChange/patchUpdated":
            item_id = _string_value(params.get("itemId")) or _nested_string(params, "item", "id")
            item = self._upsert_item(
                session_id=session_id,
                turn_id=turn_id,
                item_id=item_id,
                derived_key=None,
                item_type="tool",
                status="running",
                role="tool",
                content={
                    "kind": "file_change",
                    "changes": [
                        {
                            "path": _string_value(params.get("path")) or "",
                            "action": _string_value(params.get("action")) or "unknown",
                            "diff": _string_value(params.get("patch")) or _string_value(params.get("diff")),
                        }
                    ],
                },
                source_session_id=thread_id,
                source_item_type="fileChange",
                event=method,
            )
            return ReductionResult(timeline_items=[item])

        if method == "item/completed":
            item = params.get("item") if isinstance(params.get("item"), dict) else params
            item = dict(item)
            item["_eventItemId"] = _string_value(params.get("itemId"))
            timeline_item = self._upsert_completed_item(session_id, thread_id, turn_id, item, event=method)
            return ReductionResult(timeline_items=[timeline_item] if timeline_item else [])

        if method == "error":
            item = self._upsert_item(
                session_id=session_id,
                turn_id=turn_id,
                item_id=None,
                derived_key=f"error-{_short_hash(message)}",
                item_type="system",
                status="failed",
                role="system",
                content={
                    "kind": "error",
                    "code": _string_value(params.get("code")) or "codex_error",
                    "message": _string_value(params.get("message")) or json.dumps(params, ensure_ascii=False),
                    "details": params,
                    "recoverable": True,
                },
                source_session_id=thread_id,
                source_item_type=None,
                event=method,
            )
            return ReductionResult(
                session_update=self._session_update(
                    session_id=session_id,
                    thread_id=thread_id,
                    status="error",
                ),
                timeline_items=[item],
            )

        return ReductionResult()

    def _upsert_completed_item(
        self,
        session_id: str,
        thread_id: str | None,
        turn_id: str | None,
        item: dict[str, Any],
        *,
        event: str | None = None,
    ) -> dict[str, Any] | None:
        codex_type = _string_value(item.get("type")) or "unknown"
        item_id = _string_value(item.get("id")) or _string_value(item.get("itemId")) or _string_value(item.get("call_id")) or _short_hash(item)
        derived_key = _stable_item_key(item)
        source_item_id = _string_value(item.get("_eventItemId")) or item_id
        status = _timeline_status(item.get("status")) or "done"
        role: str | None = None
        timeline_type = "system"
        content: dict[str, Any]
        source_extra: dict[str, Any] | None = None

        if codex_type == "userMessage":
            timeline_type = "message"
            role = "user"
            content = {"text": _message_text(item), "format": "markdown"}
            client_message = self._client_message_for_user_message(
                session_id, thread_id, turn_id, content["text"]
            )
            client_message_id = client_message.get("clientMessageId") if client_message else None
            if client_message_id:
                source_extra = {"clientMessageId": client_message_id}
            attachments = client_message.get("attachments") if client_message else None
            if isinstance(attachments, list) and attachments:
                content["attachments"] = attachments
        elif codex_type == "agentMessage":
            timeline_type = "message"
            role = "assistant"
            content = {"text": _message_text(item), "format": "markdown"}
        elif codex_type == "reasoning":
            if derived_key is None and turn_id is not None:
                key = (session_id, turn_id)
                idx = self._reasoning_index_by_turn.get(key, 0)
                self._reasoning_index_by_turn[key] = idx + 1
                derived_key = f"reasoning-{idx}"
            role = "system"
            content = _reasoning_content(item)
        elif codex_type == "plan":
            role = "system"
            content = _plan_content(item)
        elif codex_type == "turnStart":
            return self._upsert_turn_start(
                session_id,
                thread_id,
                turn_id,
                item,
                status=_timeline_status(item.get("_historyTurnStartStatus")) or "running",
                event=event or "history/turn_started",
            )
        elif codex_type == "turnEnd":
            return self._upsert_turn_end(session_id, thread_id, turn_id, item)
        elif codex_type == "commandExecution":
            timeline_type = "tool"
            role = "tool"
            content = _command_content(item)
        elif codex_type == "function_call":
            timeline_type = "tool"
            role = "tool"
            content = _function_call_content(item)
            self._tool_kind_by_call[source_item_id] = str(content.get("kind") or "command")
        elif codex_type == "fileChange":
            timeline_type = "tool"
            role = "tool"
            content = _file_change_content(item)
        elif codex_type == "custom_tool_call":
            timeline_type = "tool"
            role = "tool"
            content = _custom_tool_call_content(item)
            self._tool_kind_by_call[source_item_id] = str(content.get("kind") or "tool")
        elif codex_type in {"function_call_output", "custom_tool_call_output"}:
            timeline_type = "tool"
            role = "tool"
            content = self._tool_output_content(session_id, thread_id, turn_id, source_item_id, item)
        elif codex_type == "mcpToolCall":
            timeline_type = "tool"
            role = "tool"
            content = {
                "kind": "mcp",
                "server": _string_value(item.get("server")) or "",
                "tool": _string_value(item.get("tool")) or _string_value(item.get("name")) or "",
                "arguments": item.get("arguments"),
                "result": item.get("result"),
                "error": item.get("error"),
            }
        elif codex_type == "webSearch":
            timeline_type = "tool"
            role = "tool"
            content = {"kind": "web_search", "query": _string_value(item.get("query")), "action": item.get("action")}
        elif codex_type == "imageView":
            timeline_type = "artifact"
            content = {
                "kind": "image",
                "path": _string_value(item.get("path")) or "",
                "url": _string_value(item.get("url")),
                "mediaType": _string_value(item.get("mediaType")),
            }
        else:
            role = "system"
            content = {"kind": "status", "code": f"codex.{codex_type}", "message": codex_type, "details": item}

        return self._upsert_item(
            session_id=session_id,
            turn_id=turn_id,
            item_id=None if derived_key else source_item_id,
            derived_key=derived_key,
            item_type=timeline_type,
            status=status,
            role=role,
            content=content,
            source_session_id=thread_id,
            source_item_type=codex_type,
            source_item_id=source_item_id,
            event=event,
            source_extra=source_extra,
        )

    def _client_message_for_user_message(
        self,
        session_id: str,
        thread_id: str | None,
        turn_id: str | None,
        text: str,
    ) -> dict[str, Any] | None:
        if turn_id is not None:
            mapped = self._client_message_by_turn.get((session_id, thread_id, turn_id))
            if mapped:
                return mapped
        pending_key = (session_id, thread_id)
        pending = self._pending_client_messages.get(pending_key)
        if not pending:
            return None
        for index, candidate in enumerate(pending):
            expected = candidate.get("text")
            if expected is None or _client_message_text_matches(text, expected):
                client_message_id = candidate.get("clientMessageId")
                del pending[index]
                if turn_id is not None and client_message_id:
                    self._client_message_by_turn[(session_id, thread_id, turn_id)] = candidate
                return candidate
        return None

    def _upsert_turn_start(
        self,
        session_id: str,
        thread_id: str | None,
        turn_id: str | None,
        turn: dict[str, Any],
        *,
        status: str = "running",
        event: str = "turn/started",
    ) -> dict[str, Any]:
        return self._upsert_item(
            session_id=session_id,
            turn_id=turn_id,
            item_id=None,
            derived_key="turn-start",
            item_type="turn.start",
            status=status,
            role=None,
            content={
                "title": _string_value(turn.get("title")),
                "inputSummary": _turn_input_summary(turn),
            },
            source_session_id=thread_id,
            source_item_type=None,
            event=event,
        )

    def _complete_turn(
        self,
        session_id: str,
        thread_id: str | None,
        turn_id: str | None,
        turn: dict[str, Any],
    ) -> list[dict[str, Any]]:
        result = _turn_result(turn)
        start = self._upsert_turn_start(
            session_id=session_id,
            thread_id=thread_id,
            turn_id=turn_id,
            turn=turn,
            status=_turn_result_to_status(result),
            event="turn/completed",
        )
        end = self._upsert_turn_end(session_id, thread_id, turn_id, turn)
        return [start, end]

    def _upsert_turn_end(
        self,
        session_id: str,
        thread_id: str | None,
        turn_id: str | None,
        turn: dict[str, Any],
    ) -> dict[str, Any]:
        result = _turn_result(turn)
        return self._upsert_item(
            session_id=session_id,
            turn_id=turn_id,
            item_id=None,
            derived_key="turn-end",
            item_type="turn.end",
            status=_turn_result_to_status(result),
            role=None,
            content={
                "result": result,
                "error": _error_content(turn.get("error")),
                "usage": turn.get("usage"),
            },
            source_session_id=thread_id,
            source_item_type=None,
            event="turn/completed",
            completed_at=_turn_completed_at(turn),
        )

    def _append_text_item(
        self,
        *,
        session_id: str,
        thread_id: str | None,
        turn_id: str | None,
        item_id: str | None,
        delta: str,
    ) -> dict[str, Any]:
        timeline_id = _timeline_id(session_id, thread_id, turn_id, item_id, None)
        existing = self._items.get(timeline_id)
        text = ""
        if existing:
            text = str(existing.get("content", {}).get("text") or "")
        return self._upsert_item(
            session_id=session_id,
            turn_id=turn_id,
            item_id=item_id,
            derived_key=None,
            item_type="message",
            status="running",
            role="assistant",
            content={"text": text + delta, "format": "markdown"},
            source_session_id=thread_id,
            source_item_type="agentMessage",
            source_item_id=item_id,
            event="item/agentMessage/delta",
        )

    def _append_command_output(
        self,
        *,
        session_id: str,
        thread_id: str | None,
        turn_id: str | None,
        item_id: str | None,
        delta: str,
    ) -> dict[str, Any]:
        timeline_id = _timeline_id(session_id, thread_id, turn_id, item_id, None)
        existing = self._items.get(timeline_id)
        content = dict(existing.get("content", {})) if existing else {"kind": "command", "command": ""}
        output = str(content.get("outputText") or "") + delta
        output_preview = _preview_text(output)
        content["outputText"] = output_preview
        content["outputPreview"] = output_preview
        content["outputTruncated"] = len(output) > OUTPUT_PREVIEW_CHARS
        content["outputLength"] = len(output)
        return self._upsert_item(
            session_id=session_id,
            turn_id=turn_id,
            item_id=item_id,
            derived_key=None,
            item_type="tool",
            status="running",
            role="tool",
            content=content,
            source_session_id=thread_id,
            source_item_type="commandExecution",
            event="item/commandExecution/outputDelta",
        )

    def _tool_output_content(
        self,
        session_id: str,
        thread_id: str | None,
        turn_id: str | None,
        item_id: str,
        item: dict[str, Any],
    ) -> dict[str, Any]:
        timeline_id = _timeline_id(session_id, thread_id, turn_id, item_id, None)
        existing = self._items.get(timeline_id)
        content = dict(existing.get("content", {})) if existing else {"kind": self._tool_kind_by_call.get(item_id, "tool")}
        content["result"] = _tool_output_value(item)
        output = _tool_output_text(item)
        output_preview = _preview_text(output)
        content["outputText"] = output_preview
        content["outputPreview"] = output_preview
        content["outputTruncated"] = len(output) > OUTPUT_PREVIEW_CHARS
        content["outputLength"] = len(output)
        return content

    def _approval_from_request(
        self,
        method: str,
        message: dict[str, Any],
        params: dict[str, Any],
        session_id: str,
        thread_id: str | None,
        turn_id: str | None,
    ) -> dict[str, Any]:
        item_id = _string_value(params.get("itemId")) or _nested_string(params, "item", "id")
        approval_id = f"appr_{_short_hash([session_id, thread_id, turn_id, item_id, method, message.get('id')])}"
        if "commandExecution" in method:
            kind = "command"
            title = "Codex wants to run a command"
        elif "fileChange" in method:
            kind = "file_change"
            title = "Codex wants to change files"
        elif "permissions" in method:
            kind = "permission"
            title = "Codex requests permission"
        else:
            kind = "unknown"
            title = "Codex requests approval"

        return {
            "id": approval_id,
            "sessionId": session_id,
            "turnId": turn_id,
            "status": "pending",
            "kind": kind,
            "targetItemId": _timeline_id(session_id, thread_id, turn_id, item_id, None) if item_id else None,
            "title": title,
            "description": _approval_description(params),
            "payload": params,
            "choices": ["approve", "approve_for_session", "reject", "cancel"],
            "source": {
                "runtime": "codex",
                "requestId": message.get("id"),
                "sessionId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "method": method,
            },
        }

    def _approval_target_item(
        self,
        method: str,
        params: dict[str, Any],
        approval: dict[str, Any],
    ) -> dict[str, Any] | None:
        target_item_id = approval.get("targetItemId")
        if not isinstance(target_item_id, str):
            return None
        existing = self._items.get(target_item_id)
        content = dict(existing.get("content", {})) if existing else {}
        if not content:
            if approval["kind"] == "command":
                content = {
                    "kind": "command",
                    "command": params.get("command") or params.get("cmd") or "",
                    "cwd": _string_value(params.get("cwd")),
                }
            else:
                content = {
                    "kind": "file_change" if approval["kind"] == "file_change" else "unknown",
                    "changes": [],
                }
        content["approval"] = {"id": approval["id"], "status": "pending"}
        item_id = _string_value(params.get("itemId")) or _nested_string(params, "item", "id")
        return self._upsert_item(
            session_id=approval["sessionId"],
            turn_id=approval.get("turnId"),
            item_id=item_id,
            derived_key=None,
            item_type="tool",
            status="waiting_approval",
            role="tool",
            content=content,
            source_session_id=approval["source"].get("sessionId"),
            source_item_type="commandExecution" if "commandExecution" in method else "fileChange",
            event=method,
        )

    def _upsert_item(
        self,
        *,
        session_id: str,
        turn_id: str | None,
        item_id: str | None,
        derived_key: str | None,
        item_type: str,
        status: str,
        role: str | None,
        content: dict[str, Any],
        source_session_id: str | None,
        source_item_type: str | None,
        event: str | None,
        source_item_id: str | None = None,
        completed_at: str | None = None,
        source_extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        timeline_id = _timeline_id(session_id, source_session_id, turn_id, item_id, derived_key)
        order_seq = self._order_by_item.setdefault(timeline_id, self._allocate_order_seq())
        existing = self._items.get(timeline_id)
        revision = int(existing.get("revision", 0)) + 1 if existing else 1
        now = utc_now()
        source = {
            "runtime": "codex",
            "sessionId": source_session_id,
            "turnId": turn_id,
            "itemId": source_item_id or item_id,
            "itemType": source_item_type,
            "event": event,
            "derivedKey": derived_key,
        }
        if source_extra:
            source.update(source_extra)
        source = {key: value for key, value in source.items() if value is not None}
        content_hash = _content_hash(item_type, status, role, content, source)
        if existing and existing.get("contentHash") == content_hash:
            return existing
        snapshot = {
            "id": timeline_id,
            "sessionId": session_id,
            "turnId": turn_id,
            "type": item_type,
            "status": status,
            "role": role,
            "content": content,
            "source": source,
            "orderSeq": order_seq,
            "revision": revision,
            "contentHash": content_hash,
            "createdAt": existing.get("createdAt") if existing else now,
            "updatedAt": now,
            "completedAt": completed_at,
        }
        if role is None:
            snapshot.pop("role")
        if turn_id is None:
            snapshot.pop("turnId")
        if completed_at is None:
            snapshot.pop("completedAt")
        self._items[timeline_id] = snapshot
        return snapshot

    def _allocate_order_seq(self) -> int:
        value = self._next_order
        self._next_order += 1
        return value


def _timeline_id(
    session_id: str,
    source_session_id: str | None,
    turn_id: str | None,
    item_id: str | None,
    derived_key: str | None,
) -> str:
    identity = [session_id, "codex", source_session_id, turn_id, item_id or derived_key]
    return f"tl_{_short_hash(identity)}"


def _content_hash(*values: Any) -> str:
    return f"sha256:{_short_hash(values, length=64)}"


def _client_message_text_matches(actual: str, expected: str) -> bool:
    if actual == expected:
        return True
    return actual.startswith(expected) and actual[len(expected) :].startswith("\n\n[")


def _short_hash(value: Any, *, length: int = 20) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:length]


def _extract_thread_id(params: dict[str, Any]) -> str | None:
    return _string_value(params.get("threadId")) or _nested_string(params, "thread", "id")


def _extract_turn_id(params: dict[str, Any]) -> str | None:
    return _string_value(params.get("turnId")) or _nested_string(params, "turn", "id")


def _thread_id(thread: dict[str, Any]) -> str | None:
    return _string_value(thread.get("id")) or _string_value(thread.get("threadId")) or _nested_string(thread, "thread", "id")


def _string_value(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _nested_string(data: dict[str, Any], key: str, nested_key: str) -> str | None:
    nested = data.get(key)
    if not isinstance(nested, dict):
        return None
    return _string_value(nested.get(nested_key))


def _list_value(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _message_type_counts(items: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        codex_type = _string_value(item.get("type"))
        if codex_type in {"userMessage", "agentMessage"}:
            counts[codex_type] = counts.get(codex_type, 0) + 1
    return counts


def _message_text(item: dict[str, Any]) -> str:
    if isinstance(item.get("text"), str):
        return item["text"]
    parts = item.get("parts")
    if isinstance(parts, list):
        return "".join(str(part.get("text") or "") for part in parts if isinstance(part, dict))
    content = item.get("content")
    if isinstance(content, list):
        return "".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
    return ""


def _is_bootstrap_user_message(item: dict[str, Any]) -> bool:
    if _string_value(item.get("type")) != "userMessage":
        return False
    text = _message_text(item).lstrip()
    return (
        text.startswith("# AGENTS.md instructions for ")
        and "<INSTRUCTIONS>" in text
        and "<environment_context>" in text
    )


def _is_external_import_marker(item: dict[str, Any]) -> bool:
    if _string_value(item.get("type")) not in {"userMessage", "agentMessage"}:
        return False
    return _message_text(item).strip() == "<EXTERNAL SESSION IMPORTED>"


def _stable_item_key(item: dict[str, Any]) -> str | None:
    derived_key = _string_value(item.get("_derivedKey"))
    if derived_key:
        return derived_key
    message_key = _string_value(item.get("_messageKey"))
    if message_key:
        return message_key
    codex_type = _string_value(item.get("type")) or "unknown"
    if codex_type in {"userMessage", "agentMessage"}:
        item_id = _string_value(item.get("id")) or _string_value(item.get("_eventItemId"))
        if item_id and not item_id.startswith("item-"):
            return None
        return _message_item_key(codex_type)
    if codex_type == "reasoning":
        idx = item.get("_reasoningTurnIndex")
        if isinstance(idx, int):
            return f"reasoning-{idx}"
        return None
    item_id = _string_value(item.get("id"))
    if not item_id or not item_id.startswith("item-"):
        return None
    index = item.get("_snapshotIndex")
    if isinstance(index, int):
        return f"snapshot-{codex_type}-{index}"
    return f"snapshot-{codex_type}-{item_id}"


def _message_item_key(codex_type: str) -> str:
    return f"message-{codex_type}"


def _reasoning_content(item: dict[str, Any]) -> dict[str, Any]:
    summaries = item.get("summaries")
    if not isinstance(summaries, list):
        summaries = item.get("summary")
    if isinstance(summaries, list):
        normalized = [
            {"index": index, "text": str(summary.get("text") or "") if isinstance(summary, dict) else str(summary)}
            for index, summary in enumerate(summaries)
        ]
    else:
        normalized = []
    return {"kind": "reasoning", "summaries": normalized, "rawText": _string_value(item.get("text"))}


def _plan_content(plan: dict[str, Any]) -> dict[str, Any]:
    steps = plan.get("steps")
    normalized_steps = []
    if isinstance(steps, list):
        for step in steps:
            if isinstance(step, dict):
                normalized_steps.append(
                    {
                        "text": str(step.get("text") or step.get("description") or ""),
                        "status": _plan_step_status(step.get("status")),
                    }
                )
            else:
                normalized_steps.append({"text": str(step), "status": "pending"})
    return {
        "kind": "plan",
        "explanation": _string_value(plan.get("explanation")),
        "steps": normalized_steps,
        "text": _string_value(plan.get("text")),
    }


def _plan_step_status(value: Any) -> str:
    if value in {"pending", "running", "done"}:
        return str(value)
    if value == "completed":
        return "done"
    if value == "in_progress":
        return "running"
    return "pending"


def _command_content(item: dict[str, Any]) -> dict[str, Any]:
    output = (
        _string_value(item.get("outputText"))
        or _string_value(item.get("output"))
        or _string_value(item.get("aggregatedOutput"))
        or ""
    )
    output_preview = _preview_text(output)
    return {
        "kind": "command",
        "command": item.get("command") or item.get("cmd") or "",
        "cwd": _string_value(item.get("cwd")),
        "outputText": output_preview,
        "outputPreview": output_preview,
        "outputTruncated": len(output) > OUTPUT_PREVIEW_CHARS,
        "outputLength": len(output),
        "exitCode": item.get("exitCode"),
        "durationMs": item.get("durationMs"),
        "processId": item.get("processId"),
        "actions": item.get("commandActions"),
    }


def _function_call_content(item: dict[str, Any]) -> dict[str, Any]:
    name = _string_value(item.get("name")) or "function"
    arguments = _parse_jsonish(item.get("arguments"))
    if name == "exec_command":
        command = arguments.get("cmd") if isinstance(arguments, dict) else None
        return {
            "kind": "command",
            "command": command or "",
            "cwd": arguments.get("workdir") if isinstance(arguments, dict) else None,
            "arguments": arguments,
            "function": name,
        }
    if name in {"web", "web.run"} or name.startswith("web."):
        return {"kind": "web_search", "query": _query_from_arguments(arguments), "action": arguments, "function": name}
    return {"kind": "mcp", "server": "function", "tool": name, "arguments": arguments, "result": None, "error": None}


def _custom_tool_call_content(item: dict[str, Any]) -> dict[str, Any]:
    name = _string_value(item.get("name")) or "custom_tool"
    call_input = item.get("input")
    if name == "apply_patch":
        return {"kind": "file_change", "tool": name, "changes": _changes_from_patch(_string_value(call_input) or "")}
    return {"kind": "mcp", "server": "custom", "tool": name, "arguments": call_input, "result": None, "error": None}


def _tool_output_value(item: dict[str, Any]) -> Any:
    output = item.get("output")
    if isinstance(output, str):
        parsed = _parse_jsonish(output)
        return parsed
    return output


def _tool_output_text(item: dict[str, Any]) -> str:
    output = _tool_output_value(item)
    if isinstance(output, dict):
        for key in ("output", "text", "message"):
            if isinstance(output.get(key), str):
                return output[key]
        return json.dumps(output, ensure_ascii=False, indent=2)
    if output is None:
        return ""
    return str(output)


def _preview_text(value: str) -> str:
    return value[-OUTPUT_PREVIEW_CHARS:]


def _file_change_content(item: dict[str, Any]) -> dict[str, Any]:
    changes = item.get("changes")
    if not isinstance(changes, list):
        changes = [
            {
                "path": _string_value(item.get("path")) or "",
                "action": _string_value(item.get("action")) or "unknown",
                "diff": _string_value(item.get("diff")) or _string_value(item.get("patch")),
            }
        ]
    return {"kind": "file_change", "changes": changes}


def _parse_jsonish(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def _query_from_arguments(arguments: Any) -> str | None:
    if isinstance(arguments, dict):
        query = arguments.get("query") or arguments.get("q")
        if isinstance(query, str):
            return query
        search_query = arguments.get("search_query")
        if isinstance(search_query, list) and search_query and isinstance(search_query[0], dict):
            q = search_query[0].get("q")
            return q if isinstance(q, str) else None
    return None


def _changes_from_patch(patch: str) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    diff_lines: list[str] = []
    for line in patch.splitlines():
        if line.startswith("*** Add File: ") or line.startswith("*** Update File: ") or line.startswith("*** Delete File: "):
            if current is not None:
                current["diff"] = "\n".join(diff_lines)
                changes.append(current)
            action, path = _patch_header(line)
            current = {"path": path, "action": action}
            diff_lines = []
        elif current is not None:
            diff_lines.append(line)
    if current is not None:
        current["diff"] = "\n".join(diff_lines)
        changes.append(current)
    return changes or [{"path": "", "action": "patch", "diff": patch}]


def _patch_header(line: str) -> tuple[str, str]:
    if line.startswith("*** Add File: "):
        return "add", line.removeprefix("*** Add File: ").strip()
    if line.startswith("*** Delete File: "):
        return "delete", line.removeprefix("*** Delete File: ").strip()
    return "update", line.removeprefix("*** Update File: ").strip()


def _timeline_status(value: Any) -> str | None:
    if value in {"pending", "running", "waiting_approval", "done", "failed", "cancelled", "interrupted"}:
        return str(value)
    if value in {"completed", "succeeded"}:
        return "done"
    if value in {"inProgress", "in_progress"}:
        return "running"
    return None


def _turn_status(turn: dict[str, Any]) -> str:
    status = turn.get("status")
    if isinstance(status, dict):
        return str(status.get("type") or "")
    return str(status or "")


def _turn_result(turn: dict[str, Any]) -> str:
    status = _turn_status(turn)
    if status in {"completed", "failed", "interrupted", "cancelled"}:
        return status
    return "completed"


def _turn_completed_at(turn: dict[str, Any]) -> str | None:
    for key in (
        "completedAt",
        "completed_at",
        "endedAt",
        "ended_at",
        "finishedAt",
        "finished_at",
        "updatedAt",
        "updated_at",
    ):
        value = turn.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _turn_result_to_status(result: str) -> str:
    if result == "completed":
        return "done"
    if result in {"failed", "interrupted", "cancelled"}:
        return result
    return "done"


def _session_status_from_turn(turn: dict[str, Any]) -> str:
    result = _turn_result(turn)
    if result == "completed":
        return "idle"
    if result in {"interrupted", "cancelled"}:
        return "idle"
    return "error"


def _session_status_from_thread(thread: dict[str, Any]) -> str:
    status = thread.get("status")
    status_type = status.get("type") if isinstance(status, dict) else status
    if status_type in {"running", "inProgress"}:
        return "running"
    if status_type == "waiting_approval":
        return "waiting_approval"
    if status_type == "error":
        return "error"
    return "idle"


def _turn_input_summary(turn: dict[str, Any]) -> str | None:
    input_value = turn.get("input")
    if isinstance(input_value, str):
        return input_value[:200]
    if isinstance(input_value, list):
        text = "".join(str(item.get("text") or "") for item in input_value if isinstance(item, dict))
        return text[:200] if text else None
    return None


def _error_content(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return {
            "code": _string_value(value.get("code")),
            "message": _string_value(value.get("message")) or json.dumps(value, ensure_ascii=False),
            "details": value,
        }
    return {"message": str(value)}


def _approval_description(params: dict[str, Any]) -> str | None:
    parts = [
        _string_value(params.get("command")),
        _string_value(params.get("reason")),
        _string_value(params.get("cwd")),
        _string_value(params.get("grantRoot")),
    ]
    return "\n".join(part for part in parts if part) or None
