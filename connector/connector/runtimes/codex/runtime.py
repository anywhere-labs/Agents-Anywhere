from __future__ import annotations

import copy
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAttachment,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    RuntimeUnsupportedError,
    SessionMeta,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex import sessions as codex_sessions
from connector.runtimes.codex import timeline as codex_timeline
from connector.runtimes.codex.approvals import (
    approval_decision,
    approval_notice_from_request,
    is_approval_request,
)
from connector.runtimes.codex.catalogs import (
    codex_permission_catalog_items,
    model_catalog_from_codex_items,
    permission_catalog_from_codex_items,
)
from connector.runtimes.codex.client import CodexRuntimeClient


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
            codex_sessions.model_list_items(self._model_list_result),
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
            codex_permission_catalog_items(),
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
        for thread_ref in codex_sessions.thread_refs_from_list_result(result):
            if codex_sessions.local_thread_state(thread_ref) in {
                "archived",
                "deleted",
                "unresumable",
            }:
                continue
            thread_id = codex_sessions.thread_id_from_result(thread_ref)
            if thread_id is None:
                continue
            sessions.append(
                SessionMeta(
                    session_id=codex_sessions.stable_session_id(
                        self.host.connector_id, thread_id
                    ),
                    external_session_id=thread_id,
                    runtime="codex",
                    title=codex_sessions.thread_title(thread_ref),
                    cwd=codex_sessions.thread_cwd(thread_ref),
                    ordering_time=codex_sessions.thread_ordering_time(thread_ref),
                    metadata={
                        "local_state": codex_sessions.local_thread_state(thread_ref),
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
        thread = (
            result.get("thread") if isinstance(result.get("thread"), dict) else result
        )
        items = codex_timeline.timeline_items_from_thread(
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
        thread_id = codex_sessions.thread_id_from_result(result)
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
        turn_id = codex_sessions.turn_id_from_result(result)
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
        decision = approval_decision(status if isinstance(status, str) else action_id)
        await self.start()
        await self.client.respond(request_id, {"decision": decision})
        cached_state = self._session_states.get(session_id)
        if cached_state is not None:
            await self._set_session_state(
                session_id=session_id,
                external_session_id=cached_state.external_session_id,
                status="running",
                metadata={
                    "source": "codex.approval/responded",
                    "notice_id": notice_id,
                    "decision": decision,
                },
            )
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
                logger.debug(
                    "codex bootstrap read failed method={} error={}", method, exc
                )
                continue
            if method == "model/list":
                self._model_list_result = result

    async def _handle_notification(self, message: dict[str, Any]) -> None:
        method = message.get("method")
        params = (
            message.get("params") if isinstance(message.get("params"), dict) else {}
        )
        thread_id = codex_sessions.thread_id_from_result(params)
        session_id = codex_sessions.session_id_from_notification(params)
        if session_id is None and thread_id is not None:
            session_id = codex_sessions.stable_session_id(
                self.host.connector_id, thread_id
            )
        if session_id is None or thread_id is None:
            return
        if is_approval_request(method):
            turn_id = codex_sessions.turn_id_from_result(
                params
            ) or self._active_turn_ids.get(session_id)
            if turn_id is not None:
                self._active_turn_ids[session_id] = turn_id
            notice = approval_notice_from_request(
                session_id=session_id,
                thread_id=thread_id,
                method=str(method),
                params=params,
                request_id=message.get("id"),
                turn_id=turn_id,
            )
            await self.host.notice_upsert(notice)
            await self._set_session_state(
                session_id=session_id,
                external_session_id=thread_id,
                status="blocked",
                metadata={
                    "source": str(method),
                    "notice_id": notice.notice_id,
                    **({"turn_id": turn_id} if turn_id else {}),
                },
            )
            return
        if method == "turn/started":
            turn_id = codex_sessions.turn_id_from_result(params)
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

    async def _model_settings_from_selection(
        self, selection_id: str | None
    ) -> dict[str, str]:
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

    async def _permission_settings_from_selection(
        self, selection_id: str | None
    ) -> dict[str, Any]:
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
        raw = codex_timeline.raw_item_from_notification(method, params)
        if raw is None:
            return None
        item_id = codex_timeline.timeline_item_id(raw, external_session_id, 0)
        previous = self._timeline_raw_by_id.get(item_id)
        merged = {**copy.deepcopy(previous or {}), **copy.deepcopy(raw)}
        if method == "item/agentMessage/delta":
            merged["type"] = merged.get("type") or "agentMessage"
            merged["status"] = merged.get("status") or "inProgress"
            previous_text = previous.get("text") if previous else ""
            merged["text"] = (
                f"{previous_text if isinstance(previous_text, str) else ''}{codex_timeline.notification_delta(params)}"
            )
        elif method == "item/commandExecution/outputDelta":
            merged["type"] = merged.get("type") or "commandExecution"
            merged["status"] = merged.get("status") or "inProgress"
            previous_output = previous.get("aggregatedOutput") if previous else ""
            merged["aggregatedOutput"] = (
                f"{previous_output if isinstance(previous_output, str) else ''}{codex_timeline.notification_delta(params)}"
            )
        elif method == "item/started":
            merged.setdefault("status", "inProgress")
        elif method == "item/completed":
            merged["status"] = merged.get("status") or "completed"
        merged["id"] = item_id
        if codex_timeline.timeline_item_turn_id(merged) is None:
            turn_id = codex_sessions.turn_id_from_result(dict(params))
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
        turn_id = codex_sessions.turn_id_from_result(
            turn
        ) or codex_sessions.turn_id_from_result(dict(params))
        items: list[RuntimeTimelineItem] = []
        for index, raw_item in enumerate(codex_timeline.raw_timeline_items(turn)):
            raw = copy.deepcopy(raw_item)
            if (
                turn_id is not None
                and codex_timeline.timeline_item_turn_id(raw) is None
            ):
                raw["turnId"] = turn_id
            item_id = codex_timeline.timeline_item_id(raw, external_session_id, index)
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
        item_id = codex_timeline.timeline_item_id(
            raw_dict, external_session_id, fallback_index
        )
        order_seq = self._timeline_order_by_id.get(item_id)
        if order_seq is None:
            order_seq = self._next_timeline_order
            self._next_timeline_order += 1
            self._timeline_order_by_id[item_id] = order_seq
        content = codex_timeline.timeline_item_content(raw_dict)
        item_type = codex_timeline.timeline_item_type(raw_dict)
        status = codex_timeline.timeline_item_status(raw_dict)
        role = codex_timeline.timeline_item_role(raw_dict)
        return RuntimeTimelineItem(
            id=item_id,
            session_id=session_id,
            type=item_type,
            status=status,
            order_seq=order_seq,
            content_hash=codex_timeline.content_hash(
                {
                    "type": item_type,
                    "status": status,
                    "role": role,
                    "content": content,
                }
            ),
            role=role,
            turn_id=codex_timeline.timeline_item_turn_id(raw_dict),
            content=content,
            source={
                "runtime": "codex",
                "event": event,
                "threadId": external_session_id,
                "rawType": raw_dict.get("type"),
                "itemId": raw_dict.get("id") or raw_dict.get("itemId"),
            },
            revision=codex_timeline.timeline_item_revision(raw_dict),
            metadata={"raw": raw_dict},
        )


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
