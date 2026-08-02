from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from connector.launch import LaunchTarget
from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAttachment,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeReasoningItem,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    RuntimeUnsupportedError,
    SessionMeta,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.server.protocol import protocol_selection_id

NotificationHandler = Callable[[dict[str, Any]], Awaitable[None]]
APP_SERVER_STREAM_LIMIT = 64 * 1024 * 1024


class CodexRuntimeClient(Protocol):
    async def start(self, handler: NotificationHandler) -> None: ...
    async def stop(self) -> None: ...
    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]: ...
    async def respond(
        self,
        request_id: str | int,
        result: Mapping[str, Any] | None = None,
    ) -> None: ...


@dataclass(slots=True)
class CodexRuntime(AgentRuntime):
    config: RuntimeConfig
    host: RuntimeHostClient
    client: CodexRuntimeClient | None = None
    runtime_version: str = "native-0"

    def __post_init__(self) -> None:
        self._started = False
        self._model_list_result: dict[str, Any] | None = None
        self._session_states: dict[str, SessionState] = {}
        self._active_turn_ids: dict[str, str] = {}
        self._timeline_order_by_id: dict[str, int] = {}
        self._timeline_raw_by_id: dict[str, dict[str, Any]] = {}
        self._next_timeline_order = 0

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="codex",
            runtime_version=self.runtime_version,
            display_name="Codex",
        )

    async def start(self) -> None:
        if self._started:
            return
        if self.client is not None:
            await self.client.start(self._handle_notification)
            await self._best_effort_bootstrap_reads()
        self._started = True

    async def stop(self) -> None:
        if self.client is not None:
            await self.client.stop()
        self._started = False

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        await self.start()
        catalog = model_catalog_from_codex_items(
            _model_list_items(self._model_list_result),
            revision=self.config.revision,
        )
        if query:
            lowered = query.casefold()
            models = tuple(
                model
                for model in catalog.models
                if lowered in model.id.casefold() or lowered in model.title.casefold()
            )
        else:
            models = catalog.models
        return RuntimeModelCatalog(
            runtime=catalog.runtime,
            revision=catalog.revision,
            models=models[:limit],
        )

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        permissions = permission_catalog_from_codex_items(
            _codex_permission_catalog_items(),
            revision=self.config.revision,
        ).permissions
        if query:
            lowered = query.casefold()
            permissions = tuple(
                item
                for item in permissions
                if lowered in item.id.casefold() or lowered in item.title.casefold()
            )
        return RuntimePermissionCatalog(
            runtime="codex",
            revision=self.config.revision,
            permissions=permissions[:limit],
        )

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        _ = cursor
        _ = force
        if self.client is None:
            return ()
        await self.start()
        result = await self.client.request(
            "thread/list",
            {
                "limit": limit,
                "sortKey": "updated_at",
            },
        )
        sessions: list[SessionMeta] = []
        for thread_ref in _thread_refs_from_list_result(result):
            if _local_thread_state(thread_ref) in {"archived", "deleted", "unresumable"}:
                continue
            thread_id = _thread_id_from_result(thread_ref)
            if thread_id is None:
                continue
            sessions.append(
                SessionMeta(
                    session_id=stable_session_id(self.host.connector_id, thread_id),
                    external_session_id=thread_id,
                    runtime="codex",
                    title=_thread_title(thread_ref),
                    cwd=_thread_cwd(thread_ref),
                    ordering_time=_thread_ordering_time(thread_ref),
                    metadata={
                        "local_state": _local_thread_state(thread_ref),
                        "source": "codex.thread/list",
                    },
                )
            )
        return tuple(sessions[:limit])

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        cached = self._session_states.get(session_id)
        if cached is not None:
            return cached
        if external_session_id is None:
            return None
        return SessionState(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="codex",
            status="idle",
            metadata={"source": "codex.runtime.basic"},
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int = 100,
    ) -> RuntimeTimelineSnapshot:
        if self.client is None or external_session_id is None:
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=external_session_id,
                runtime="codex",
                items=(),
                complete=True,
                metadata={"source": "codex.runtime.basic"},
            )
        await self.start()
        result = await self.client.request(
            "thread/read",
            {
                "threadId": external_session_id,
                "includeTurns": True,
            },
        )
        thread = result.get("thread") if isinstance(result.get("thread"), dict) else result
        items = _timeline_items_from_thread(
            session_id=session_id,
            external_session_id=external_session_id,
            thread=thread if isinstance(thread, dict) else {},
            limit=limit,
        )
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="codex",
            items=items,
            complete=True,
            metadata={"source": "codex.thread/read"},
        )

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        _ensure_text_only_attachments(attachments)
        if self.client is None:
            raise RuntimeUnsupportedError("create_and_start_session")
        await self.start()
        selected_model = await self._model_settings_from_selection(
            (selections or {}).get("model")
        )
        native_permission = await self._permission_settings_from_selection(
            (selections or {}).get("permission")
        )
        result = await self.client.request(
            "thread/start",
            {
                "cwd": cwd,
                "model": selected_model.get("model"),
                "approvalPolicy": native_permission.get("approvalPolicy"),
                "sandbox": native_permission.get("sandbox"),
                "ephemeral": False,
            },
        )
        thread_id = _thread_id_from_result(result)
        if thread_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="codex_thread_start_failed",
                message="Codex thread/start did not return a thread id",
                result={"raw": result},
            )
        await self.host.session_meta_upsert(
            session_id=session_id,
            runtime="codex",
            external_session_id=thread_id,
            title=title,
            cwd=cwd,
            metadata={"source": "codex.thread/start"},
        )
        await self._set_session_state(
            session_id=session_id,
            external_session_id=thread_id,
            status="idle",
            selections=selections,
            metadata={"source": "codex.thread/start"},
        )
        turn_result = await self.start_turn(
            session_id=session_id,
            external_session_id=thread_id,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
        )
        return RuntimeOperationResult(
            ok=turn_result.ok,
            code=turn_result.code,
            message=turn_result.message,
            result={
                "sessionId": session_id,
                "externalSessionId": thread_id,
                "thread": result.get("thread") or result,
                **turn_result.result,
            },
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        _ensure_text_only_attachments(attachments)
        if self.client is None or external_session_id is None:
            raise RuntimeUnsupportedError("start_turn")
        await self.start()
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="waiting",
            metadata={"source": "codex.turn/start.requested"},
        )
        try:
            result = await self.client.request(
                "turn/start",
                {
                    "threadId": external_session_id,
                    "input": [{"type": "text", "text": content, "text_elements": []}],
                    "clientUserMessageId": client_message_id,
                },
            )
        except Exception as exc:
            await self._set_session_state(
                session_id=session_id,
                external_session_id=external_session_id,
                status="error",
                error={
                    "code": getattr(exc, "code", None) or exc.__class__.__name__,
                    "message": str(exc) or exc.__class__.__name__,
                },
                metadata={"source": "codex.turn/start.failed"},
            )
            raise
        turn_id = _turn_id_from_result(result)
        if turn_id is not None:
            self._active_turn_ids[session_id] = turn_id
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="running",
            metadata={
                "source": "codex.turn/start",
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "turnId": turn_id,
                "turn": result.get("turn") or result,
                "externalSessionId": external_session_id,
            },
        )

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        _ensure_text_only_attachments(attachments)
        if self.client is None or external_session_id is None:
            raise RuntimeUnsupportedError("steer_turn")
        turn_id = self._active_turn_ids.get(session_id)
        if turn_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="codex_no_active_turn",
                message="Codex runtime has no active turn to steer",
                result={"externalSessionId": external_session_id},
            )
        await self.start()
        result = await self.client.request(
            "turn/steer",
            {
                "threadId": external_session_id,
                "input": [{"type": "text", "text": content, "text_elements": []}],
                "expectedTurnId": turn_id,
                "clientUserMessageId": client_message_id,
            },
        )
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="running",
            metadata={"source": "codex.turn/steer", "turn_id": turn_id},
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "steered": True,
                "turnId": turn_id,
                "externalSessionId": external_session_id,
                "turn": result.get("turn") or result,
            },
        )

    async def interrupt_turn(
        self,
        session_id: str,
        external_session_id: str | None = None,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        _ = reason
        if self.client is None or external_session_id is None:
            raise RuntimeUnsupportedError("interrupt_turn")
        turn_id = self._active_turn_ids.get(session_id)
        if turn_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="codex_no_active_turn",
                message="Codex runtime has no active turn to interrupt",
                result={"externalSessionId": external_session_id},
            )
        await self.start()
        try:
            result = await self.client.request(
                "turn/interrupt",
                {
                    "threadId": external_session_id,
                    "turnId": turn_id,
                },
            )
        except RuntimeError as exc:
            soft_reason = _soft_interrupt_failure_reason(str(exc))
            if soft_reason is None:
                raise
            self._active_turn_ids.pop(session_id, None)
            await self._set_session_state(
                session_id=session_id,
                external_session_id=external_session_id,
                status="idle",
                metadata={
                    "source": "codex.turn/interrupt.soft-failed",
                    "reason": soft_reason,
                    "turn_id": turn_id,
                },
            )
            return RuntimeOperationResult(
                ok=False,
                code=soft_reason,
                message="Codex turn was already unavailable to interrupt",
                result={"interrupted": False, "turnId": turn_id},
            )
        self._active_turn_ids.pop(session_id, None)
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="idle",
            metadata={"source": "codex.turn/interrupt", "turn_id": turn_id},
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "interrupted": True,
                "turnId": turn_id,
                "externalSessionId": external_session_id,
                "turn": result.get("turn") or result,
            },
        )

    async def list_commands(
        self,
        session_id: str,
        external_session_id: str | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RuntimeCommand, ...]:
        _ = session_id
        commands = (
            RuntimeCommand(
                id="compact",
                title="Compact conversation",
                description="Ask Codex to compact this thread's context.",
                aliases=("summarize",),
                category="context",
                scope="session",
                enabled=external_session_id is not None and self.client is not None,
                disabled_reason=(
                    None
                    if external_session_id is not None and self.client is not None
                    else "Codex compact requires a loaded local thread."
                ),
            ),
        )
        if query:
            lowered = query.casefold()
            commands = tuple(
                command
                for command in commands
                if lowered in command.id.casefold()
                or lowered in command.title.casefold()
                or any(lowered in alias.casefold() for alias in command.aliases)
            )
        return commands[:limit]

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        _ = session_id
        _ = raw
        if command != "compact":
            return RuntimeCommandResult(
                command=command,
                ok=False,
                code="unknown_command",
                message=f"Codex runtime does not support /{command}",
            )
        if args:
            return RuntimeCommandResult(
                command=command,
                ok=False,
                code="arguments_not_supported",
                message="/compact does not accept arguments.",
            )
        if self.client is None or external_session_id is None:
            return RuntimeCommandResult(
                command=command,
                ok=False,
                code="codex_thread_required",
                message="Codex compact requires a loaded local thread.",
            )
        await self.start()
        result = await self.client.request(
            "thread/compact/start",
            {"threadId": external_session_id},
        )
        return RuntimeCommandResult(
            command=command,
            ok=True,
            code="started",
            message="Codex compaction started.",
            result={
                "externalSessionId": external_session_id,
                "thread": result,
            },
        )

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        if self.client is None:
            raise RuntimeUnsupportedError("respond_interaction")
        data = dict(input_data or {})
        request_id = data.get("requestId")
        if not isinstance(request_id, str | int):
            approval_source = data.get("approvalSource")
            if isinstance(approval_source, dict):
                request_id = approval_source.get("requestId")
        if not isinstance(request_id, str | int):
            raise ValueError("requestId is required to respond to a Codex interaction")
        status = data.get("approvalStatus")
        decision = _approval_decision(status if isinstance(status, str) else action_id)
        await self.start()
        await self.client.respond(request_id, {"decision": decision})
        return RuntimeOperationResult(
            ok=True,
            result={
                "resolved": True,
                "noticeId": notice_id,
                "sessionId": session_id,
                "decision": decision,
            },
        )

    async def _best_effort_bootstrap_reads(self) -> None:
        if self.client is None:
            return
        for method in ("model/list", "thread/loaded/list"):
            try:
                result = await self.client.request(method)
            except Exception as exc:  # noqa: BLE001
                logger.debug("codex bootstrap read failed method={} error={}", method, exc)
                continue
            if method == "model/list":
                self._model_list_result = result

    async def _handle_notification(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        thread_id = _thread_id_from_result(params)
        session_id = _session_id_from_notification(params)
        if session_id is None and thread_id is not None:
            session_id = stable_session_id(self.host.connector_id, thread_id)
        if session_id is None or thread_id is None:
            return
        if method == "turn/started":
            turn_id = _turn_id_from_result(params)
            if turn_id is not None:
                self._active_turn_ids[session_id] = turn_id
            await self._set_session_state(
                session_id=session_id,
                external_session_id=thread_id,
                status="running",
                metadata={
                    "source": "codex.turn/started",
                    **({"turn_id": turn_id} if turn_id else {}),
                },
            )
        elif method == "turn/completed":
            self._active_turn_ids.pop(session_id, None)
            turn_items = self._timeline_items_from_turn_notification(
                session_id=session_id,
                external_session_id=thread_id,
                params=params,
                method=method,
            )
            if turn_items:
                await self.host.timeline_sync(
                    session_id=session_id,
                    runtime="codex",
                    external_session_id=thread_id,
                    items=turn_items,
                    complete=False,
                    metadata={"source": "codex.turn/completed"},
                )
            await self._set_session_state(
                session_id=session_id,
                external_session_id=thread_id,
                status="idle",
                metadata={"source": "codex.turn/completed"},
            )
        item = self._timeline_item_from_notification(
            session_id=session_id,
            external_session_id=thread_id,
            method=str(method),
            params=params,
        )
        if item is not None:
            await self.host.timeline_item_upsert(item)

    async def _set_session_state(
        self,
        session_id: str,
        external_session_id: str | None,
        status: str,
        selections: Mapping[str, str | None] | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        previous = self._session_states.get(session_id)
        state = SessionState(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="codex",
            status=status,  # type: ignore[arg-type]
            selections={
                **dict(previous.selections if previous is not None else {}),
                **dict(selections or {}),
            },
            error=error,
            metadata={
                **dict(previous.metadata if previous is not None else {}),
                **dict(metadata or {}),
            },
        )
        self._session_states[session_id] = state
        await self.host.session_state_update(
            session_id=session_id,
            runtime="codex",
            external_session_id=external_session_id,
            status=state.status,
            selections=state.selections,
            error=state.error,
            metadata=state.metadata,
        )

    async def _model_settings_from_selection(self, selection_id: str | None) -> dict[str, str]:
        if selection_id is None:
            return {}
        catalog = await self.list_model_catalog()
        for model in catalog.models:
            if model.selection_id == selection_id:
                return {"model": model.id}
            for reasoning in model.reasoning_items:
                if reasoning.selection_id == selection_id:
                    return {"model": model.id, "effort": reasoning.id}
        return {}

    async def _permission_settings_from_selection(self, selection_id: str | None) -> dict[str, Any]:
        if selection_id is None:
            return {}
        catalog = await self.list_permission_catalog()
        for permission in catalog.permissions:
            if permission.selection_id == selection_id:
                native = permission.metadata.get("nativeSettings")
                return dict(native) if isinstance(native, dict) else {}
        return {}

    def _timeline_item_from_notification(
        self,
        session_id: str,
        external_session_id: str,
        method: str,
        params: Mapping[str, Any],
    ) -> RuntimeTimelineItem | None:
        raw = _raw_item_from_notification(method, params)
        if raw is None:
            return None
        item_id = _timeline_item_id(raw, external_session_id, 0)
        previous = self._timeline_raw_by_id.get(item_id)
        merged = {**copy.deepcopy(previous or {}), **copy.deepcopy(raw)}
        if method == "item/agentMessage/delta":
            merged["type"] = merged.get("type") or "agentMessage"
            merged["status"] = merged.get("status") or "inProgress"
            previous_text = previous.get("text") if previous else ""
            merged["text"] = f"{previous_text if isinstance(previous_text, str) else ''}{_notification_delta(params)}"
        elif method == "item/commandExecution/outputDelta":
            merged["type"] = merged.get("type") or "commandExecution"
            merged["status"] = merged.get("status") or "inProgress"
            previous_output = previous.get("aggregatedOutput") if previous else ""
            merged["aggregatedOutput"] = (
                f"{previous_output if isinstance(previous_output, str) else ''}{_notification_delta(params)}"
            )
        elif method == "item/started":
            merged.setdefault("status", "inProgress")
        elif method == "item/completed":
            merged["status"] = merged.get("status") or "completed"
        merged["id"] = item_id
        if _timeline_item_turn_id(merged) is None:
            turn_id = _turn_id_from_result(dict(params))
            if turn_id is not None:
                merged["turnId"] = turn_id
        self._timeline_raw_by_id[item_id] = merged
        return self._runtime_timeline_item(
            session_id=session_id,
            external_session_id=external_session_id,
            raw=merged,
            event=method,
        )

    def _timeline_items_from_turn_notification(
        self,
        session_id: str,
        external_session_id: str,
        params: Mapping[str, Any],
        method: str,
    ) -> tuple[RuntimeTimelineItem, ...]:
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else params
        if not isinstance(turn, dict):
            return ()
        turn_id = _turn_id_from_result(turn) or _turn_id_from_result(dict(params))
        items: list[RuntimeTimelineItem] = []
        for index, raw_item in enumerate(_raw_timeline_items(turn)):
            raw = copy.deepcopy(raw_item)
            if turn_id is not None and _timeline_item_turn_id(raw) is None:
                raw["turnId"] = turn_id
            item_id = _timeline_item_id(raw, external_session_id, index)
            raw["id"] = item_id
            self._timeline_raw_by_id[item_id] = raw
            items.append(
                self._runtime_timeline_item(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    raw=raw,
                    event=method,
                    fallback_index=index,
                )
            )
        return tuple(items)

    def _runtime_timeline_item(
        self,
        session_id: str,
        external_session_id: str,
        raw: Mapping[str, Any],
        event: str,
        fallback_index: int = 0,
    ) -> RuntimeTimelineItem:
        raw_dict = dict(raw)
        item_id = _timeline_item_id(raw_dict, external_session_id, fallback_index)
        order_seq = self._timeline_order_by_id.get(item_id)
        if order_seq is None:
            order_seq = self._next_timeline_order
            self._next_timeline_order += 1
            self._timeline_order_by_id[item_id] = order_seq
        content = _timeline_item_content(raw_dict)
        item_type = _timeline_item_type(raw_dict)
        status = _timeline_item_status(raw_dict)
        role = _timeline_item_role(raw_dict)
        return RuntimeTimelineItem(
            id=item_id,
            session_id=session_id,
            type=item_type,
            status=status,
            order_seq=order_seq,
            content_hash=_content_hash(
                {
                    "type": item_type,
                    "status": status,
                    "role": role,
                    "content": content,
                }
            ),
            role=role,
            turn_id=_timeline_item_turn_id(raw_dict),
            content=content,
            source={
                "runtime": "codex",
                "event": event,
                "threadId": external_session_id,
                "rawType": raw_dict.get("type"),
                "itemId": raw_dict.get("id") or raw_dict.get("itemId"),
            },
            revision=_timeline_item_revision(raw_dict),
            metadata={"raw": raw_dict},
        )


class CodexAppServerClient:
    def __init__(
        self,
        command: list[str],
        environment: Mapping[str, str] | None = None,
    ) -> None:
        self.command = command
        self.environment = dict(environment) if environment is not None else None
        self.process: asyncio.subprocess.Process | None = None
        self._start_lock = asyncio.Lock()
        self._next_id = 1
        self._pending: dict[int | str, asyncio.Future[dict[str, Any]]] = {}
        self._server_request_ids: set[int | str] = set()
        self._notification_handler: NotificationHandler | None = None
        self._initialized = False

    async def start(self, handler: NotificationHandler) -> None:
        async with self._start_lock:
            if self.process is not None and self._initialized:
                self._notification_handler = handler
                return

            self._notification_handler = handler
            if self.process is None:
                logger.info("starting codex app-server command={}", self.command)
                self.process = await asyncio.create_subprocess_exec(
                    *self.command,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    limit=APP_SERVER_STREAM_LIMIT,
                    env=self.environment,
                )
                self._track_reader(asyncio.create_task(self._read_stdout(self.process)), "stdout")
                self._track_reader(asyncio.create_task(self._read_stderr(self.process)), "stderr")

            await self.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "agents-anywhere-connector",
                        "title": "Agents Anywhere Connector",
                        "version": "0.2.0",
                    },
                    "capabilities": {
                        "experimentalApi": True,
                        "requestAttestation": False,
                    },
                },
            )
            await self.notify("initialized")
            self._initialized = True

    async def stop(self) -> None:
        if self.process is None:
            return
        self.process.terminate()
        try:
            await asyncio.wait_for(self.process.wait(), timeout=5)
        except TimeoutError:
            self.process.kill()
            await self.process.wait()
        finally:
            self.process = None
            self._initialized = False
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(RuntimeError("Codex app-server stopped"))
            self._pending.clear()
            self._server_request_ids.clear()

    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("Codex app-server is not started")

        request_id = self._next_id
        self._next_id += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = future
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": dict(params or {}),
        }
        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()
        return await future

    async def notify(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("Codex app-server is not started")
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "method": method,
            "params": dict(params or {}),
        }
        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()

    async def respond(
        self,
        request_id: str | int,
        result: Mapping[str, Any] | None = None,
    ) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("Codex app-server is not started")
        payload: dict[str, Any] = {
            "jsonrpc": "2.0",
            "id": self._response_id_for(request_id),
            "result": dict(result or {}),
        }
        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()

    async def _read_stdout(self, process: asyncio.subprocess.Process) -> None:
        assert process.stdout
        while line := await process.stdout.readline():
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                logger.warning(
                    "codex app-server emitted non-json stdout: {}",
                    line.decode(errors="replace").strip(),
                )
                continue

            request_id = payload.get("id")
            if request_id in self._pending and ("result" in payload or "error" in payload):
                future = self._pending.pop(request_id)
                self._settle_pending_future(future, payload)
                continue

            if request_id is not None and isinstance(payload.get("method"), str):
                self._server_request_ids.add(request_id)

            if self._notification_handler is not None:
                await self._notification_handler(payload)

    async def _read_stderr(self, process: asyncio.subprocess.Process) -> None:
        assert process.stderr
        while line := await process.stderr.readline():
            logger.trace("codex app-server stderr: {}", line.decode(errors="replace").rstrip())

    def _track_reader(self, task: asyncio.Task[None], name: str) -> None:
        def done(completed: asyncio.Task[None]) -> None:
            try:
                completed.result()
            except asyncio.CancelledError:
                return
            except Exception:  # noqa: BLE001
                logger.exception("codex app-server {} reader stopped unexpectedly", name)

        task.add_done_callback(done)

    def _response_id_for(self, request_id: str | int) -> str | int:
        if request_id in self._server_request_ids:
            self._server_request_ids.remove(request_id)
            return request_id
        if isinstance(request_id, str):
            try:
                numeric_request_id = int(request_id)
            except ValueError:
                numeric_request_id = None
            if numeric_request_id is not None and numeric_request_id in self._server_request_ids:
                self._server_request_ids.remove(numeric_request_id)
                return numeric_request_id
        logger.warning("codex app-server responding to unknown server request id={}", request_id)
        return request_id

    @staticmethod
    def _settle_pending_future(
        future: asyncio.Future[dict[str, Any]],
        payload: dict[str, Any],
    ) -> None:
        if future.done():
            return
        if "error" in payload:
            future.set_exception(RuntimeError(json.dumps(payload["error"], ensure_ascii=False)))
            return
        result = payload.get("result")
        future.set_result(result if isinstance(result, dict) else {})


class EmptyCodexClient:
    async def start(self, handler: NotificationHandler) -> None:
        _ = handler

    async def stop(self) -> None:
        pass

    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        _ = method
        _ = params
        return {}

    async def respond(
        self,
        request_id: str | int,
        result: Mapping[str, Any] | None = None,
    ) -> None:
        _ = request_id
        _ = result


def app_server_client_from_config(config: RuntimeConfig) -> CodexAppServerClient:
    executable = config.values.get("executablePath")
    if not isinstance(executable, str) or not executable:
        raise RuntimeError("Codex app-server runtime requires executablePath")
    target = LaunchTarget(
        source="configured",
        path=executable,
        launcher=str(config.metadata.get("launchTarget", {}).get("launcher") or "direct"),  # type: ignore[arg-type]
    )
    environment = _runtime_environment(config.values.get("environment"))
    return CodexAppServerClient(
        command=target.command(["app-server", "--listen", "stdio://"]),
        environment=environment,
    )


def model_catalog_from_codex_items(
    items: list[dict[str, Any]],
    revision: int,
) -> RuntimeModelCatalog:
    models = tuple(
        model
        for model in (_model_item(item) for item in items)
        if model is not None
    )
    return RuntimeModelCatalog(runtime="codex", revision=revision, models=models)


def permission_catalog_from_codex_items(
    items: list[dict[str, Any]],
    revision: int,
) -> RuntimePermissionCatalog:
    permissions = tuple(
        permission
        for permission in (_permission_item(item) for item in items)
        if permission is not None
    )
    return RuntimePermissionCatalog(runtime="codex", revision=revision, permissions=permissions)


def stable_session_id(connector_id: str, thread_id: str) -> str:
    digest = hashlib.sha256(f"{connector_id}:codex:{thread_id}".encode()).hexdigest()[:24]
    return f"sess_codex_{digest}"


def _model_item(item: dict[str, Any]) -> RuntimeModelItem | None:
    model_id = _first_string(item, "id", "model", "modelId", "model_id", "name")
    if model_id is None:
        return None
    reasoning_items = _reasoning_items(
        model_id,
        _first_list(
            item,
            "reasoningItems",
            "reasoning_items",
            "reasoningEfforts",
            "reasoning_efforts",
            "supportedReasoningEfforts",
            "supported_reasoning_efforts",
            "efforts",
        ),
    )
    return RuntimeModelItem(
        id=model_id,
        title=_first_string(item, "displayName", "display_name", "label", "name") or model_id,
        selection_id=None
        if reasoning_items
        else protocol_selection_id("codex", "model", {"model_id": model_id, "reasoning_id": None}),
        description=_first_string(item, "description"),
        reasoning_items=reasoning_items,
        metadata={"source": "codex.model/list", "raw": item},
    )


def _reasoning_items(
    model_id: str,
    raw_items: list[Any],
) -> tuple[RuntimeReasoningItem, ...]:
    result: list[RuntimeReasoningItem] = []
    for raw in raw_items:
        item = raw if isinstance(raw, dict) else {"id": raw}
        reasoning_id = _first_string(
            item,
            "id",
            "reasoningEffort",
            "reasoning_effort",
            "effort",
            "reasoning",
            "value",
            "name",
        )
        if reasoning_id is None:
            continue
        result.append(
            RuntimeReasoningItem(
                id=reasoning_id,
                title=_first_string(item, "displayName", "display_name", "label", "name")
                or _reasoning_label(reasoning_id),
                selection_id=protocol_selection_id(
                    "codex",
                    "model",
                    {"model_id": model_id, "reasoning_id": reasoning_id},
                ),
                description=_first_string(item, "description"),
                metadata={"source": "codex.model/list", "raw": item},
            )
        )
    return tuple(result)


def _permission_item(item: dict[str, Any]) -> RuntimePermissionItem | None:
    permission_id = _first_string(item, "id")
    title = _first_string(item, "label", "displayName", "display_name", "name")
    if permission_id is None or title is None:
        return None
    identity = item.get("identity") if isinstance(item.get("identity"), dict) else {"permission_id": permission_id}
    metadata = {"source": "codex.static-permissions"}
    if isinstance(item.get("runtimeSettings"), dict):
        metadata["runtimeSettings"] = item["runtimeSettings"]
    if isinstance(item.get("nativeSettings"), dict):
        metadata["nativeSettings"] = item["nativeSettings"]
    return RuntimePermissionItem(
        id=permission_id,
        title=title,
        selection_id=protocol_selection_id("codex", "permission", identity),
        description=_first_string(item, "description"),
        metadata=metadata,
    )


def _model_list_items(result: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(result, dict):
        return []
    for key in ("models", "items", "data"):
        value = result.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    nested = result.get("modelCatalog") or result.get("catalog")
    if isinstance(nested, dict):
        return _model_list_items(nested)
    return []


def _thread_refs_from_list_result(result: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("threads", "data", "items"):
        value = result.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    nested = result.get("thread")
    if isinstance(nested, dict):
        return [nested]
    if _thread_id_from_result(result):
        return [result]
    return []


def _timeline_items_from_thread(
    session_id: str,
    external_session_id: str,
    thread: dict[str, Any],
    limit: int,
) -> tuple[RuntimeTimelineItem, ...]:
    raw_items = _raw_timeline_items(thread)
    items: list[RuntimeTimelineItem] = []
    for index, raw in enumerate(raw_items[:limit]):
        item_id = _timeline_item_id(raw, external_session_id, index)
        content = _timeline_item_content(raw)
        source = {
            "runtime": "codex",
            "event": "thread/read",
            "threadId": external_session_id,
            "rawType": raw.get("type"),
        }
        items.append(
            RuntimeTimelineItem(
                id=item_id,
                session_id=session_id,
                type=_timeline_item_type(raw),
                status=_timeline_item_status(raw),
                order_seq=index,
                content_hash=_content_hash(
                    {
                        "type": _timeline_item_type(raw),
                        "status": _timeline_item_status(raw),
                        "role": _timeline_item_role(raw),
                        "content": content,
                    }
                ),
                role=_timeline_item_role(raw),
                turn_id=_timeline_item_turn_id(raw),
                content=content,
                source=source,
                revision=_timeline_item_revision(raw),
                metadata={"raw": raw},
            )
        )
    return tuple(items)


def _raw_timeline_items(thread: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("items", "timeline", "timelineItems", "timeline_items"):
        value = thread.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    turns = thread.get("turns")
    if isinstance(turns, list):
        result: list[dict[str, Any]] = []
        for turn in turns:
            if not isinstance(turn, dict):
                continue
            for key in ("items", "timeline", "timelineItems", "messages"):
                value = turn.get(key)
                if isinstance(value, list):
                    result.extend(item for item in value if isinstance(item, dict))
        return result
    messages = thread.get("messages")
    if isinstance(messages, list):
        return [item for item in messages if isinstance(item, dict)]
    return []


def _timeline_item_id(raw: dict[str, Any], external_session_id: str, index: int) -> str:
    for key in ("id", "itemId", "item_id"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return f"codex_{external_session_id}_{index}_{_content_hash(raw)[:16]}"


def _timeline_item_type(raw: dict[str, Any]) -> str:
    value = raw.get("type") or raw.get("kind")
    if not isinstance(value, str) or not value:
        return "message"
    if value in {"agentMessage", "userMessage", "steeringUserMessage"}:
        return "message"
    if value == "commandExecution":
        return "command"
    if value == "fileChange":
        return "file_change"
    return value


def _timeline_item_status(raw: dict[str, Any]) -> str:
    value = raw.get("status")
    if not isinstance(value, str) or not value:
        return "done"
    if value in {"inProgress", "in_progress"}:
        return "running"
    if value == "completed":
        return "done"
    return value


def _timeline_item_role(raw: dict[str, Any]) -> str | None:
    value = raw.get("role")
    if isinstance(value, str) and value:
        return value
    item_type = raw.get("type")
    if item_type in {"userMessage", "steeringUserMessage"}:
        return "user"
    if item_type == "agentMessage":
        return "assistant"
    return None


def _timeline_item_turn_id(raw: dict[str, Any]) -> str | None:
    for key in ("turnId", "turn_id"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _turn_id_from_result(value: dict[str, Any]) -> str | None:
    turn = value.get("turn") if isinstance(value.get("turn"), dict) else value
    if not isinstance(turn, dict):
        return None
    for key in ("id", "turn_id", "turnId"):
        value = turn.get(key)
        if isinstance(value, str) and value:
            return value
    nested = turn.get("turn")
    if isinstance(nested, dict) and isinstance(nested.get("id"), str):
        return nested["id"]
    return None


def _session_id_from_notification(params: Mapping[str, Any]) -> str | None:
    for key in ("platformSessionId", "sessionId", "session_id"):
        value = params.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _ensure_text_only_attachments(attachments: tuple[RuntimeAttachment, ...]) -> None:
    if attachments:
        raise RuntimeUnsupportedError("codex.attachments")


def _soft_interrupt_failure_reason(error_text: str) -> str | None:
    message = error_text
    try:
        parsed = json.loads(error_text)
        if isinstance(parsed, dict):
            raw = parsed.get("message")
            if isinstance(raw, str):
                message = raw
    except json.JSONDecodeError:
        pass
    normalized = message.lower()
    if "thread not found" in normalized:
        return "thread_not_found"
    if "turn not found" in normalized:
        return "turn_not_found"
    return None


def _timeline_item_revision(raw: dict[str, Any]) -> int:
    value = raw.get("revision")
    return value if isinstance(value, int) and value > 0 else 1


def _timeline_item_content(raw: dict[str, Any]) -> Mapping[str, Any]:
    content = raw.get("content")
    if isinstance(content, dict):
        return content
    text = raw.get("text")
    if isinstance(text, str):
        return {"text": text, "format": "markdown"}
    if isinstance(content, str):
        return {"text": content, "format": "markdown"}
    aggregated_output = raw.get("aggregatedOutput")
    if isinstance(aggregated_output, str):
        return {
            "command": raw.get("command") or raw.get("cmd") or "",
            "output": aggregated_output,
            "format": "text",
        }
    if raw.get("type") == "commandExecution":
        return {
            "command": raw.get("command") or raw.get("cmd") or "",
            "output": raw.get("output") or raw.get("outputText") or "",
            "format": "text",
        }
    return {}


def _thread_id_from_result(value: dict[str, Any]) -> str | None:
    thread = value.get("thread") if isinstance(value.get("thread"), dict) else value
    if not isinstance(thread, dict):
        return None
    for key in ("id", "thread_id", "threadId"):
        value = thread.get(key)
        if isinstance(value, str) and value:
            return value
    nested = thread.get("thread")
    if isinstance(nested, dict) and isinstance(nested.get("id"), str):
        return nested["id"]
    return None


def _raw_item_from_notification(
    method: str,
    params: Mapping[str, Any],
) -> dict[str, Any] | None:
    if method not in {
        "item/started",
        "item/completed",
        "item/agentMessage/delta",
        "item/commandExecution/outputDelta",
    }:
        return None
    item = params.get("item")
    raw: dict[str, Any] = copy.deepcopy(item) if isinstance(item, dict) else {}
    item_id = _first_string_from_mapping(params, "itemId", "item_id")
    if item_id is not None:
        raw["id"] = item_id
    if not isinstance(raw.get("id"), str) or not raw["id"]:
        return None
    if not isinstance(raw.get("type"), str) or not raw["type"]:
        if method == "item/agentMessage/delta":
            raw["type"] = "agentMessage"
        elif method == "item/commandExecution/outputDelta":
            raw["type"] = "commandExecution"
    turn_id = _turn_id_from_result(dict(params))
    if turn_id is not None and _timeline_item_turn_id(raw) is None:
        raw["turnId"] = turn_id
    return raw


def _notification_delta(params: Mapping[str, Any]) -> str:
    for key in ("delta", "text", "outputDelta", "output_delta"):
        value = params.get(key)
        if isinstance(value, str):
            return value
    return ""


def _first_string_from_mapping(mapping: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _local_thread_state(thread_ref: dict[str, Any]) -> str:
    for key in ("localState", "local_state", "lifecycleState", "lifecycle_state"):
        value = thread_ref.get(key)
        if isinstance(value, str):
            normalized = value.lower()
            if normalized in {"active", "archived", "deleted", "unresumable", "unknown"}:
                return normalized
    status = thread_ref.get("status")
    if isinstance(status, dict):
        status = status.get("type") or status.get("state")
    if isinstance(status, str):
        normalized_status = status.lower()
        if normalized_status in {"archived", "deleted", "unresumable"}:
            return normalized_status
    for key in ("archived", "isArchived", "is_archived"):
        if thread_ref.get(key) is True:
            return "archived"
    for key in ("deleted", "isDeleted", "is_deleted"):
        if thread_ref.get(key) is True:
            return "deleted"
    if thread_ref.get("resumeSupported") is False or thread_ref.get("resumable") is False:
        return "unresumable"
    return "active"


def _thread_title(thread_ref: dict[str, Any]) -> str | None:
    return _first_string(thread_ref, "name", "title", "summary")


def _thread_cwd(thread_ref: dict[str, Any]) -> str | None:
    value = thread_ref.get("cwd") or thread_ref.get("workingDirectory") or thread_ref.get("working_directory")
    return value if isinstance(value, str) and value else None


def _thread_ordering_time(thread_ref: dict[str, Any]) -> str | None:
    value = (
        thread_ref.get("updatedAt")
        or thread_ref.get("updated_at")
        or thread_ref.get("createdAt")
        or thread_ref.get("created_at")
    )
    return str(value) if value is not None else None


def _runtime_environment(raw: Any) -> dict[str, str]:
    environment = dict(os.environ)
    if isinstance(raw, dict):
        for key, value in raw.items():
            if value is None:
                environment.pop(str(key), None)
            elif isinstance(value, str):
                environment[str(key)] = value
    return environment


def _codex_permission_catalog_items() -> list[dict[str, Any]]:
    return [
        {
            "id": "untrusted_workspace_write",
            "label": "Ask for untrusted commands",
            "description": "Run trusted commands automatically in workspace-write sandbox; ask before untrusted commands.",
            "identity": {
                "approval_policy": "untrusted",
                "sandbox": "workspace-write",
            },
            "runtimeSettings": {"permissionMode": "untrusted_workspace_write"},
            "nativeSettings": {
                "approvalPolicy": "untrusted",
                "sandbox": "workspace-write",
                "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            },
        },
        {
            "id": "on_request_workspace_write",
            "label": "Ask when requested",
            "description": "Use workspace-write sandbox and let the model decide when to ask for approval.",
            "identity": {
                "approval_policy": "on-request",
                "sandbox": "workspace-write",
            },
            "runtimeSettings": {"permissionMode": "on_request_workspace_write"},
            "nativeSettings": {
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write",
                "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            },
        },
        {
            "id": "on_request_read_only",
            "label": "Read only",
            "description": "Run commands in read-only sandbox; ask before work that needs writes.",
            "identity": {
                "approval_policy": "on-request",
                "sandbox": "read-only",
            },
            "runtimeSettings": {"permissionMode": "on_request_read_only"},
            "nativeSettings": {
                "approvalPolicy": "on-request",
                "sandbox": "read-only",
                "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
            },
        },
        {
            "id": "never_workspace_write",
            "label": "Never ask, workspace write",
            "description": "Do not prompt for approvals; failures are returned to the model. Commands stay sandboxed to workspace writes.",
            "identity": {
                "approval_policy": "never",
                "sandbox": "workspace-write",
            },
            "runtimeSettings": {"permissionMode": "never_workspace_write"},
            "nativeSettings": {
                "approvalPolicy": "never",
                "sandbox": "workspace-write",
                "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": False},
            },
        },
        {
            "id": "never_danger_full_access",
            "label": "Full access ⚠️",
            "description": "Never ask and run without sandboxing. Use only in externally sandboxed environments.",
            "identity": {
                "approval_policy": "never",
                "sandbox": "danger-full-access",
            },
            "runtimeSettings": {"permissionMode": "never_danger_full_access"},
            "nativeSettings": {
                "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                "sandboxPolicy": {"type": "dangerFullAccess"},
            },
        },
    ]


def _first_string(item: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _first_list(item: dict[str, Any], *keys: str) -> list[Any]:
    for key in keys:
        value = item.get(key)
        if isinstance(value, list):
            return value
    return []


def _reasoning_label(reasoning_id: str) -> str:
    return {
        "low": "Low",
        "medium": "Medium",
        "high": "High",
        "xhigh": "Extra high",
        "max": "Max",
        "ultra": "Ultra",
    }.get(reasoning_id, reasoning_id)


def _approval_decision(status_or_action: str) -> str:
    if status_or_action in {"approved_for_session", "approve_for_session"}:
        return "acceptForSession"
    if status_or_action in {"approved", "approve"}:
        return "accept"
    if status_or_action in {"cancelled", "cancel"}:
        return "cancel"
    return "decline"


def _content_hash(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(encoded.encode()).hexdigest()
