from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger

from connector.attachments import attachment_target
from connector.adapter import NotificationSink
from connector.claude.history_adapter import ClaudeHistoryAdapter
from connector.claude.normalized import NormalizedClaudeEvent
from connector.claude.normalizers import ClaudeLiveNormalizer
from connector.claude.timeline_reducer import ClaudeTimelineReducer, is_task_event_tool_name
from connector.launch import LaunchTarget, launch_target
from connector.time import utc_now


AttachmentDownloader = Callable[[str, str], Awaitable[tuple[bytes, str, str]]]
"""(session_id, file_id) -> (data, original_name, media_type)"""

_MAX_STDERR_LINES = 80
_MAX_STDERR_CHARS = 8000
_SECRET_RE = re.compile(
    r"(?i)(api[_-]?key|auth[_-]?token|authorization|bearer|token|password|secret)([=:\s]+)([^\s,;]+)"
)


class ClaudeSdkAdapterError(RuntimeError):
    pass


@dataclass(slots=True)
class _PendingSdkApproval:
    approval_id: str
    future: asyncio.Future[str]
    input_data: dict[str, Any]


@dataclass(slots=True)
class _SdkSessionRuntime:
    session_id: str
    connector_id: str | None = None
    cwd: str | None = None
    external_session_id: str | None = None
    client: Any | None = None
    active_task: asyncio.Task[None] | None = None
    active_turn_id: str | None = None
    next_order_seq: int = 1
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    pending_approvals: dict[str, _PendingSdkApproval] = field(default_factory=dict)
    interrupted: bool = False
    stderr_lines: list[str] = field(default_factory=list)
    current_client_message_id: str | None = None
    current_content: str | None = None
    current_attachments: list[dict[str, Any]] | None = None
    emitted_user_message: bool = False
    partial_message_id: str | None = None
    partial_message_uuid: str | None = None
    partial_text_blocks: dict[int, str] = field(default_factory=dict)
    live_stream_items: dict[str, dict[str, Any]] = field(default_factory=dict)
    live_tool_items: dict[str, dict[str, Any]] = field(default_factory=dict)
    ignored_task_tool_use_ids: set[str] = field(default_factory=set)


@dataclass(slots=True)
class ClaudeSdkAdapter:
    """Claude Chat Mode adapter backed by the Python Claude Agent SDK."""

    notification_sink: NotificationSink = None
    sdk_module: Any | None = None
    history_adapter: ClaudeHistoryAdapter = field(default_factory=ClaudeHistoryAdapter)
    attachment_downloader: AttachmentDownloader | None = None
    claude_target: LaunchTarget | None = None
    _sessions: dict[str, _SdkSessionRuntime] = field(default_factory=dict, init=False)

    @property
    def claude_bin(self) -> str | None:
        return self.claude_target.path if self.claude_target is not None else None

    @claude_bin.setter
    def claude_bin(self, value: str | None) -> None:
        self.claude_target = launch_target("cli", value) if value else None

    def forget_sync_state(self) -> None:
        self.history_adapter.forget_sync_state()

    def forget_persisted_sync_state(self, connector_id: str) -> None:
        self.history_adapter.forget_persisted_sync_state(connector_id)

    def apply_history_sync_state(self, state: list[dict[str, Any]]) -> None:
        self.history_adapter.apply_history_sync_state(state)

    async def create_session(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = (
            _optional_string(params.get("sessionId"))
            or f"sess_claude_chat_{secrets.token_urlsafe(10)}"
        )
        runtime = self._runtime_for(session_id, params)
        return {
            "sessionId": session_id,
            "externalSessionId": runtime.external_session_id,
            "backendNotifications": [],
        }

    async def sync_session(self, params: dict[str, Any]) -> dict[str, Any]:
        self._prepare_history_adapter()
        return await self.history_adapter.sync_session(params)

    async def sync_existing_sessions(
        self,
        connector_id: str,
        *,
        limit: int = 100,
        force: bool = False,
        notification_sink: Callable[[list[dict[str, Any]]], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        self._prepare_history_adapter()
        skip_external_session_ids = {
            runtime.external_session_id
            for runtime in self._sessions.values()
            if runtime.active_turn_id is not None and runtime.external_session_id is not None
        }
        return await self.history_adapter.sync_existing_sessions(
            connector_id,
            limit=limit,
            force=force,
            skip_external_session_ids=skip_external_session_ids,
            notification_sink=notification_sink,
        )

    async def start_turn(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = _required(params, "sessionId")
        content = _required(params, "content")
        runtime = self._runtime_for(session_id, params)
        connector_id = _optional_string(params.get("connectorId"))
        if connector_id is not None:
            runtime.connector_id = connector_id
        if runtime.lock.locked():
            raise ClaudeSdkAdapterError("Claude SDK turn already running for this session")
        await runtime.lock.acquire()
        runtime.interrupted = False
        turn_id = _optional_string(params.get("turnId")) or _turn_id(session_id, content)
        runtime.active_turn_id = turn_id
        runtime.current_client_message_id = _optional_string(params.get("clientMessageId"))
        runtime.current_content = content
        runtime.current_attachments = _attachments_metadata(params)
        runtime.emitted_user_message = False
        runtime.partial_message_id = None
        runtime.partial_message_uuid = None
        runtime.partial_text_blocks.clear()
        runtime.live_stream_items.clear()
        runtime.live_tool_items.clear()
        runtime.ignored_task_tool_use_ids.clear()
        runtime.active_task = asyncio.create_task(
            self._drive_turn(runtime=runtime, params=params, content=content, turn_id=turn_id)
        )
        self._prepare_history_adapter()
        runtime.active_task.add_done_callback(
            lambda _task: runtime.lock.release() if runtime.lock.locked() else None
        )
        return {"turnId": turn_id}

    async def interrupt_turn(self, params: dict[str, Any]) -> dict[str, Any]:
        runtime = self._sessions.get(_required(params, "sessionId"))
        if runtime is None:
            return {"interrupted": False, "reason": "session not registered"}
        runtime.interrupted = True
        for pending in list(runtime.pending_approvals.values()):
            if not pending.future.done():
                pending.future.set_result("cancelled")
        client = runtime.client
        if client is not None:
            interrupt = getattr(client, "interrupt", None)
            if callable(interrupt):
                await interrupt()
                return {"interrupted": True}
        return {"interrupted": False, "reason": "no active Claude SDK client"}

    async def resolve_approval(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = _required(params, "sessionId")
        approval_id = _required(params, "approvalId")
        status = _required(params, "status")
        runtime = self._sessions.get(session_id)
        if runtime is None:
            return {"resolved": False, "reason": "session not registered"}
        pending = runtime.pending_approvals.get(approval_id)
        if pending is None:
            return {"resolved": False, "reason": "approval not pending"}
        if not pending.future.done():
            pending.future.set_result(status)
        return {"resolved": True}

    def _runtime_for(self, session_id: str, params: dict[str, Any]) -> _SdkSessionRuntime:
        runtime = self._sessions.get(session_id)
        if runtime is None:
            runtime = _SdkSessionRuntime(
                session_id=session_id,
                cwd=_optional_string(params.get("cwd")),
                external_session_id=_optional_string(params.get("externalSessionId")),
            )
            self._sessions[session_id] = runtime
        if params.get("cwd"):
            runtime.cwd = _optional_string(params.get("cwd"))
        if params.get("externalSessionId"):
            runtime.external_session_id = _optional_string(params.get("externalSessionId"))
        return runtime

    async def _drive_turn(
        self,
        *,
        runtime: _SdkSessionRuntime,
        params: dict[str, Any],
        content: str,
        turn_id: str,
    ) -> None:
        stream_finished = False
        try:
            runtime.stderr_lines.clear()
            await self._emit_item(runtime.session_id, _turn_start_item(runtime, turn_id))
            client = self._client(runtime, params)
            runtime.client = client
            await _maybe_await(getattr(client, "connect", None))
            runtime_content = await self._materialize_runtime_content(
                content=content,
                attachments=params.get("attachments"),
                cwd=runtime.cwd,
                session_id=runtime.session_id,
            )
            await client.query(_prompt_stream(runtime_content))
            await self._receive_response(runtime, client, turn_id)
            stream_finished = True
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            stderr = _stderr_excerpt(runtime.stderr_lines)
            logger.exception(
                "claude sdk turn failed session_id={} turn_id={} cwd={} external_session_id={} "
                "model={} effort={} permission_mode={} cli_path={} stderr={}",
                runtime.session_id,
                turn_id,
                runtime.cwd,
                runtime.external_session_id,
                _optional_string(params.get("model")),
                _optional_string(params.get("effort")),
                _optional_string(params.get("permissionMode")),
                self.claude_bin,
                stderr or "<empty>",
            )
            stop_reason = _failure_message(exc, stderr)
            await self._finalize_live_stream_items(runtime, turn_id, status="failed")
            await self._emit_item(
                runtime.session_id,
                _turn_end_item(
                    runtime,
                    turn_id,
                    status="failed",
                    result="failed",
                    stop_reason=stop_reason,
                ),
            )
            if self.notification_sink is not None:
                await self.notification_sink(
                    "runtime.error",
                    {
                        "sessionId": runtime.session_id,
                        "runtime": "claude",
                        "message": stop_reason,
                        "stderr": stderr,
                    },
                )
        finally:
            if stream_finished:
                await self._mark_history_consumed(runtime)
            if runtime.active_turn_id == turn_id:
                runtime.active_turn_id = None
                runtime.active_task = None
                runtime.current_client_message_id = None
                runtime.current_content = None
                runtime.current_attachments = None
                runtime.emitted_user_message = False
            runtime.pending_approvals.clear()
            self._prepare_history_adapter()
            await self._emit_session_update(runtime, status="idle")

    async def _receive_response(self, runtime: _SdkSessionRuntime, client: Any, turn_id: str) -> None:
        receive_response = getattr(client, "receive_response", None)
        if not callable(receive_response):
            raise ClaudeSdkAdapterError("ClaudeSDKClient does not expose receive_response()")
        saw_result = False
        emitted_live_content = False
        buffered_messages: list[Any] = []
        async for message in receive_response():
            if _is_stream_event(message):
                session_id = _optional_string(_extract_attr(message, "session_id", "sessionId"))
                if session_id:
                    runtime.external_session_id = session_id
                    self._prepare_history_adapter()
                    await self._emit_session_update(runtime, status="running")
                if runtime.external_session_id is None:
                    buffered_messages.append(message)
                    continue
                await self._emit_pending_user_message(runtime, turn_id)
                emitted_live_content = await self._emit_stream_event(runtime, turn_id, message) or emitted_live_content
                continue
            if _is_result_message(message):
                saw_result = True
                session_id = _extract_attr(message, "session_id", "sessionId")
                if isinstance(session_id, str) and session_id:
                    runtime.external_session_id = session_id
                    self._prepare_history_adapter()
                    await self._emit_session_update(runtime, status="running")
                await self._emit_pending_user_message(runtime, turn_id)
                for buffered in buffered_messages:
                    if _is_stream_event(buffered):
                        emitted_live_content = await self._emit_stream_event(runtime, turn_id, buffered) or emitted_live_content
                    else:
                        emitted_live_content = await self._emit_sdk_message(runtime, turn_id, buffered) or emitted_live_content
                if not emitted_live_content:
                    emitted_live_content = await self._emit_result_message(runtime, turn_id, message) or emitted_live_content
                subtype = _optional_string(_extract_attr(message, "subtype"))
                status = "interrupted" if runtime.interrupted else ("failed" if subtype in {"error", "failed"} else "done")
                result = "interrupted" if runtime.interrupted else ("failed" if status == "failed" else "completed")
                await self._finalize_live_stream_items(runtime, turn_id, status=status)
                await self._emit_item(
                    runtime.session_id,
                    _turn_end_item(
                        runtime,
                        turn_id,
                        status=status,
                        result=result,
                        stop_reason=subtype or result,
                    ),
                )
                break
            if runtime.external_session_id is None:
                buffered_messages.append(message)
                continue
            await self._emit_pending_user_message(runtime, turn_id)
            emitted_live_content = await self._emit_sdk_message(runtime, turn_id, message) or emitted_live_content
        if not saw_result:
            status = "interrupted" if runtime.interrupted else "done"
            await self._emit_pending_user_message(runtime, turn_id)
            for buffered in buffered_messages:
                if _is_stream_event(buffered):
                    await self._emit_stream_event(runtime, turn_id, buffered)
                else:
                    await self._emit_sdk_message(runtime, turn_id, buffered)
            await self._finalize_live_stream_items(runtime, turn_id, status=status)
            await self._emit_item(
                runtime.session_id,
                _turn_end_item(
                    runtime,
                    turn_id,
                    status=status,
                    result="interrupted" if runtime.interrupted else "completed",
                    stop_reason="interrupted" if runtime.interrupted else "completed",
                ),
            )

    async def _emit_sdk_message(self, runtime: _SdkSessionRuntime, turn_id: str, message: Any) -> bool:
        role = _message_role(message)
        raw = _sdk_message_to_raw(
            message,
            runtime.external_session_id,
        )
        if raw is not None:
            return await self._emit_normalized(
                runtime.session_id,
                turn_id,
                raw,
                streaming=role == "assistant",
            )
        return False

    async def _emit_stream_event(self, runtime: _SdkSessionRuntime, turn_id: str, message: Any) -> bool:
        raw = _stream_event_to_raw(runtime, turn_id, message)
        if raw is not None:
            return await self._emit_normalized(runtime.session_id, turn_id, raw, streaming=True)
        return False

    async def _emit_result_message(self, runtime: _SdkSessionRuntime, turn_id: str, message: Any) -> bool:
        raw = _result_message_to_raw(message, runtime.external_session_id)
        if raw is not None:
            return await self._emit_normalized(runtime.session_id, turn_id, raw)
        return False

    async def _emit_normalized(
        self,
        session_id: str,
        turn_id: str,
        raw: dict[str, Any],
        *,
        streaming: bool = False,
    ) -> bool:
        reducer = ClaudeTimelineReducer()
        events = ClaudeLiveNormalizer().normalize([raw])
        runtime = self._sessions.get(session_id)
        if runtime is not None:
            events = _filter_live_task_events(runtime, events)
        emitted = False
        for item in reducer.reduce(session_id=session_id, turn_id=turn_id, events=events):
            dumped = dict(item)
            if runtime is not None:
                if streaming and _is_streaming_assistant_message(dumped):
                    prepared = _prepare_live_stream_item(runtime, dumped)
                    if prepared is None:
                        continue
                    dumped = prepared
                elif _is_streaming_assistant_message(dumped):
                    prepared = _prepare_live_stream_final_item(runtime, dumped)
                    if prepared is not None:
                        dumped = prepared
                    else:
                        dumped["orderSeq"] = _next_order(runtime)
                elif _is_tool_item(dumped):
                    prepared = _prepare_live_tool_item(runtime, dumped)
                    if prepared is None:
                        continue
                    dumped = prepared
                else:
                    dumped["orderSeq"] = _next_order(runtime)
            await self._emit_item(session_id, dumped)
            emitted = True
        return emitted

    async def _finalize_live_stream_items(
        self,
        runtime: _SdkSessionRuntime,
        turn_id: str,
        *,
        status: str,
    ) -> None:
        if not runtime.live_stream_items:
            return
        completed_at = utc_now()
        for item_id, item in list(runtime.live_stream_items.items()):
            if item.get("turnId") != turn_id:
                continue
            if item.get("status") == status and item.get("completedAt"):
                continue
            finalized = dict(item)
            finalized["status"] = status
            finalized["revision"] = int(finalized.get("revision") or 1) + 1
            finalized["updatedAt"] = completed_at
            finalized["completedAt"] = completed_at
            runtime.live_stream_items[item_id] = finalized
            await self._emit_item(runtime.session_id, finalized)

    async def _emit_pending_user_message(self, runtime: _SdkSessionRuntime, turn_id: str) -> None:
        if runtime.emitted_user_message:
            return
        if not runtime.external_session_id or runtime.current_content is None:
            return
        events = [
            NormalizedClaudeEvent(
                claudeSessionId=runtime.external_session_id,
                sourceEventId=f"{turn_id}:user",
                messageId=f"{turn_id}:user",
                role="user",
                blockIndex=0,
                blockType="text",
                text=runtime.current_content,
                timestamp=utc_now(),
                clientMessageId=runtime.current_client_message_id,
                attachments=runtime.current_attachments,
            )
        ]
        for item in ClaudeTimelineReducer().reduce(
            session_id=runtime.session_id,
            turn_id=turn_id,
            events=events,
        ):
            item["orderSeq"] = _next_order(runtime)
            await self._emit_item(runtime.session_id, item)
        runtime.emitted_user_message = True

    async def _emit_item(self, session_id: str, item: dict[str, Any]) -> None:
        if self.notification_sink is None:
            return
        await self.notification_sink("timeline.itemUpsert", {"sessionId": session_id, "item": item})

    async def _emit_session_update(self, runtime: _SdkSessionRuntime, *, status: str) -> None:
        if self.notification_sink is None:
            return
        await self.notification_sink(
            "session.updated",
            {
                "sessionId": runtime.session_id,
                "runtime": "claude",
                "externalSessionId": runtime.external_session_id,
                "status": status,
                "cwd": runtime.cwd,
                "lastSyncedAt": utc_now(),
            },
        )

    async def _mark_history_consumed(self, runtime: _SdkSessionRuntime) -> None:
        try:
            self._prepare_history_adapter()
            await self.history_adapter.mark_session_consumed(
                connector_id=runtime.connector_id,
                external_session_id=runtime.external_session_id,
                cwd=runtime.cwd,
            )
        except Exception:
            logger.exception(
                "claude sdk history consumed marker failed session_id={} external_session_id={}",
                runtime.session_id,
                runtime.external_session_id,
            )

    async def _sync_current_history_snapshot(self, runtime: _SdkSessionRuntime) -> None:
        if runtime.external_session_id is None:
            return
        try:
            self._prepare_history_adapter()
            result = await self.history_adapter.sync_session(
                {
                    "sessionId": runtime.session_id,
                    "externalSessionId": runtime.external_session_id,
                    "cwd": runtime.cwd,
                    "pendingClientMessages": _pending_client_messages(runtime),
                }
            )
        except Exception:
            logger.exception(
                "claude sdk history snapshot failed session_id={} external_session_id={}",
                runtime.session_id,
                runtime.external_session_id,
            )
            return
        notifications = result.get("backendNotifications") if isinstance(result, dict) else None
        if self.notification_sink is None or not isinstance(notifications, list):
            return
        for notification in notifications:
            if not isinstance(notification, dict):
                continue
            method = notification.get("method")
            params = notification.get("params")
            if isinstance(method, str) and isinstance(params, dict):
                await self.notification_sink(method, params)

    def _prepare_history_adapter(self) -> None:
        self.history_adapter.sdk_module = self.sdk_module

    def _client(self, runtime: _SdkSessionRuntime, params: dict[str, Any]) -> Any:
        sdk = self._load_sdk()
        options = sdk.ClaudeAgentOptions(**self._options_kwargs(sdk, runtime, params))
        client_cls = sdk.ClaudeSDKClient
        try:
            return client_cls(options=options)
        except TypeError:
            return client_cls(options)

    def _options_kwargs(self, sdk: Any, runtime: _SdkSessionRuntime, params: dict[str, Any]) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "include_partial_messages": True,
            "can_use_tool": self._can_use_tool,
            "stderr": lambda line: _record_stderr(runtime, line),
        }
        if runtime.cwd:
            kwargs["cwd"] = runtime.cwd
        if runtime.external_session_id:
            kwargs["resume"] = runtime.external_session_id
        if self.claude_target is not None:
            kwargs["cli_path"] = self.claude_target.path
        for param_key, option_key in (
            ("permissionMode", "permission_mode"),
            ("model", "model"),
            ("effort", "effort"),
        ):
            value = _optional_string(params.get(param_key))
            if value:
                kwargs[option_key] = value
        hook_matcher = _optional_attr(sdk, "HookMatcher", "types.HookMatcher")
        if hook_matcher is not None:
            async def _keep_permission_stream_open(_input_data: Any, _tool_use_id: Any = None, _context: Any = None) -> dict[str, bool]:
                return {"continue_": True}

            kwargs["hooks"] = {"PreToolUse": [hook_matcher(matcher=None, hooks=[_keep_permission_stream_open])]}
        return kwargs

    async def _can_use_tool(self, tool_name: str, input_data: dict[str, Any], context: Any = None) -> Any:
        sdk = self._load_sdk()
        context_session_id = _optional_string(_extract_attr(context, "session_id", "sessionId"))
        runtime = self._runtime_from_context(context_session_id)
        if runtime is None:
            return _permission_deny(sdk, "Session is not registered")
        approval_id = _approval_id(runtime.session_id, runtime.active_turn_id, tool_name, input_data)
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()
        runtime.pending_approvals[approval_id] = _PendingSdkApproval(approval_id, future, input_data)
        if self.notification_sink is not None:
            await self.notification_sink(
                "approval.requested",
                _approval_payload(
                    approval_id=approval_id,
                    runtime=runtime,
                    tool_name=tool_name,
                    input_data=input_data,
                ),
            )
        status = await future
        runtime.pending_approvals.pop(approval_id, None)
        if status in {"approved", "approved_for_session"} and not runtime.interrupted:
            return _permission_allow(sdk, input_data)
        return _permission_deny(sdk, "User denied or interrupted this action")

    def _runtime_from_context(self, context_session_id: str | None) -> _SdkSessionRuntime | None:
        if context_session_id:
            for runtime in self._sessions.values():
                if runtime.external_session_id == context_session_id:
                    return runtime
        for runtime in self._sessions.values():
            if runtime.active_turn_id:
                return runtime
        return None

    def _load_sdk(self) -> Any:
        if self.sdk_module is not None:
            return self.sdk_module
        try:
            import claude_agent_sdk  # type: ignore[import-not-found]
        except ModuleNotFoundError as exc:
            raise ClaudeSdkAdapterError("claude-agent-sdk is not installed") from exc
        return claude_agent_sdk

    async def _materialize_runtime_content(
        self,
        *,
        content: str,
        attachments: Any,
        cwd: str | None,
        session_id: str,
    ) -> Any:
        if not isinstance(attachments, list) or not attachments:
            return content
        blocks: list[dict[str, Any]] = [{"type": "text", "text": content}]
        downloadable = False
        for attachment in attachments:
            if not isinstance(attachment, dict):
                continue
            path_hint = _optional_string(attachment.get("pathHint") or attachment.get("path"))
            if path_hint:
                blocks.append({"type": "text", "text": f"\n\nAttached file: {path_hint}"})
                continue
            if _attachment_file_id(attachment) is not None:
                downloadable = True

        if not downloadable:
            return blocks
        if self.attachment_downloader is None:
            logger.warning("dropping {} Claude attachments - no downloader is wired", len(attachments))
            blocks.append(
                {
                    "type": "text",
                    "text": "\n\n[Attachments could not be loaded: connector downloader unavailable]",
                }
            )
            return blocks

        for attachment in attachments:
            if not isinstance(attachment, dict):
                continue
            if _optional_string(attachment.get("pathHint") or attachment.get("path")):
                continue
            file_id = _attachment_file_id(attachment)
            if file_id is None:
                continue
            try:
                data, original_name, media_type = await self.attachment_downloader(
                    session_id, file_id
                )
            except Exception as exc:
                logger.exception("Claude attachment download failed file_id={}", file_id)
                blocks.append({"type": "text", "text": f"\n\n[Failed to load attachment {file_id}: {exc}]"})
                continue
            original_name = original_name or _attachment_name_from(attachment) or file_id
            media_type = media_type or _optional_string(attachment.get("mediaType")) or "application/octet-stream"
            target = attachment_target(session_id, file_id, original_name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            try:
                target.chmod(0o600)
            except OSError:
                pass
            if media_type.startswith("image/"):
                blocks.append(
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": base64.b64encode(data).decode("ascii"),
                        },
                    }
                )
                blocks.append({"type": "text", "text": f"\n\nAttached image: {original_name} at {target}"})
            else:
                blocks.append(
                    {
                        "type": "text",
                        "text": (
                            f"\n\n[Attached file: {original_name} ({media_type},"
                            f" {len(data)} bytes) at {target}]"
                        ),
                    }
                )
        return blocks


async def _prompt_stream(content: Any):
    yield {
        "type": "user",
        "message": {
            "role": "user",
            "content": content,
        },
    }


def _attachments_metadata(params: dict[str, Any]) -> list[dict[str, Any]] | None:
    attachments = params.get("attachments")
    if not isinstance(attachments, list) or not attachments:
        return None
    metadata: list[dict[str, Any]] = []
    for attachment in attachments:
        if not isinstance(attachment, dict):
            continue
        item: dict[str, Any] = {}
        for source_key, target_key in (
            ("fileId", "fileId"),
            ("id", "fileId"),
            ("name", "name"),
            ("mediaType", "mediaType"),
            ("size", "size"),
            ("sha256", "sha256"),
        ):
            value = attachment.get(source_key)
            if value is not None and target_key not in item:
                item[target_key] = value
        if item:
            metadata.append(item)
    return metadata or None


def _pending_client_messages(runtime: _SdkSessionRuntime) -> list[dict[str, Any]]:
    if not runtime.current_client_message_id:
        return []
    message: dict[str, Any] = {"clientMessageId": runtime.current_client_message_id}
    if runtime.current_content is not None:
        message["text"] = runtime.current_content
    if runtime.current_attachments:
        message["attachments"] = runtime.current_attachments
    return [message]


def _record_stderr(runtime: _SdkSessionRuntime, line: str) -> None:
    cleaned = _redact(line.strip())
    if not cleaned:
        return
    runtime.stderr_lines.append(cleaned)
    if len(runtime.stderr_lines) > _MAX_STDERR_LINES:
        del runtime.stderr_lines[: len(runtime.stderr_lines) - _MAX_STDERR_LINES]
    logger.warning("claude sdk stderr session_id={} line={}", runtime.session_id, cleaned)


def _filter_live_task_events(
    runtime: _SdkSessionRuntime,
    events: list[Any],
) -> list[Any]:
    out: list[Any] = []
    for event in events:
        tool_use_id = _optional_string(getattr(event, "toolUseId", None))
        if tool_use_id and getattr(event, "toolResult", None) is None and is_task_event_tool_name(getattr(event, "toolName", None)):
            runtime.ignored_task_tool_use_ids.add(tool_use_id)
            continue
        if tool_use_id and getattr(event, "toolResult", None) is not None and tool_use_id in runtime.ignored_task_tool_use_ids:
            continue
        out.append(event)
    return out


def _stderr_excerpt(lines: list[str]) -> str | None:
    if not lines:
        return None
    text = "\n".join(lines[-_MAX_STDERR_LINES:])
    if len(text) > _MAX_STDERR_CHARS:
        return "..." + text[-_MAX_STDERR_CHARS:]
    return text


def _failure_message(exc: Exception, stderr: str | None) -> str:
    message = str(exc)
    if stderr:
        return f"{message}\n\nClaude stderr:\n{stderr}"
    return message


def _redact(value: str) -> str:
    return _SECRET_RE.sub(lambda match: f"{match.group(1)}{match.group(2)}***", value)


async def _maybe_await(method: Any) -> None:
    if not callable(method):
        return
    result = method()
    if hasattr(result, "__await__"):
        await result


def _sdk_message_to_raw(
    message: Any,
    fallback_session_id: str | None,
) -> dict[str, Any] | None:
    content = _extract_attr(message, "content")
    role = _message_role(message)
    if content is None and role is None:
        return None
    blocks = _blocks_to_dicts(content)
    session_id = (
        _optional_string(_extract_attr(message, "session_id", "sessionId"))
        or fallback_session_id
        or "unknown"
    )
    message_id = _optional_string(_extract_attr(message, "message_id", "messageId"))
    textless_blocks = _without_text_blocks(blocks)
    if _has_text_blocks(blocks) and message_id is None:
        if textless_blocks:
            blocks = textless_blocks
        else:
            logger.warning(
                "dropping Claude SDK text message without message_id role={} session_id={}",
                role,
                session_id,
            )
            return None
    if not blocks:
        logger.warning(
            "dropping Claude SDK message with no reducible blocks role={} session_id={}",
            role,
            session_id,
        )
        return None
    source_event_id = _optional_string(_extract_attr(message, "uuid")) or message_id or "unknown"
    return {
        "uuid": source_event_id,
        "session_id": session_id,
        "timestamp": _optional_string(_extract_attr(message, "timestamp")) or utc_now(),
        "message": {
            "id": message_id,
            "role": role,
            "content": blocks,
        },
    }


def _result_message_to_raw(message: Any, fallback_session_id: str | None) -> dict[str, Any] | None:
    text = _optional_string(_extract_attr(message, "result"))
    if not text:
        return None
    message_id = _optional_string(_extract_attr(message, "uuid"))
    if message_id is None:
        logger.warning(
            "dropping Claude result text without uuid session_id={}",
            _optional_string(_extract_attr(message, "session_id", "sessionId")) or fallback_session_id,
        )
        return None
    session_id = (
        _optional_string(_extract_attr(message, "session_id", "sessionId"))
        or fallback_session_id
        or "unknown"
    )
    return {
        "uuid": message_id,
        "session_id": session_id,
        "timestamp": utc_now(),
        "message": {
            "id": message_id,
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
    }


def _stream_event_to_raw(runtime: _SdkSessionRuntime, turn_id: str, message: Any) -> dict[str, Any] | None:
    event = _extract_attr(message, "event")
    if not isinstance(event, dict):
        return None
    event_type = _optional_string(event.get("type"))
    if event_type == "message_start":
        payload = event.get("message")
        runtime.partial_text_blocks.clear()
        if isinstance(payload, dict):
            runtime.partial_message_id = _optional_string(payload.get("id"))
        else:
            runtime.partial_message_id = None
        runtime.partial_message_uuid = _optional_string(_extract_attr(message, "uuid"))
        return None
    if event_type == "content_block_start":
        index = _int(event.get("index"))
        block = event.get("content_block")
        text = _text_from_stream_block(block)
        if index is not None and text is not None:
            runtime.partial_text_blocks[index] = text
            return _partial_message_raw(runtime, turn_id, message)
        return None
    if event_type == "content_block_delta":
        index = _int(event.get("index"))
        delta = event.get("delta")
        text = _text_from_stream_block(delta)
        if index is not None and text:
            runtime.partial_text_blocks[index] = f"{runtime.partial_text_blocks.get(index, '')}{text}"
            return _partial_message_raw(runtime, turn_id, message)
    if event_type == "message_delta":
        return _partial_message_raw(runtime, turn_id, message)
    return None


def _partial_message_raw(runtime: _SdkSessionRuntime, turn_id: str, message: Any) -> dict[str, Any] | None:
    text = "".join(runtime.partial_text_blocks[index] for index in sorted(runtime.partial_text_blocks))
    if not text:
        return None
    message_id = runtime.partial_message_id
    if message_id is None:
        logger.warning("dropping Claude stream text without message_start id turn_id={}", turn_id)
        return None
    return {
        "uuid": runtime.partial_message_uuid or message_id,
        "session_id": _optional_string(_extract_attr(message, "session_id", "sessionId")) or runtime.external_session_id or "unknown",
        "timestamp": utc_now(),
        "message": {
            "id": message_id,
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
        },
    }


def _text_from_stream_block(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    block_type = _optional_string(value.get("type"))
    if block_type in {"text", "text_delta"}:
        return _optional_string(value.get("text"))
    if block_type == "input_json_delta":
        return None
    return _optional_string(value.get("text"))


def _is_streaming_assistant_message(item: dict[str, Any]) -> bool:
    return (
        item.get("type") == "message"
        and item.get("role") == "assistant"
        and isinstance(item.get("id"), str)
    )


def _is_tool_item(item: dict[str, Any]) -> bool:
    return item.get("type") == "tool" and isinstance(item.get("id"), str)


def _prepare_live_stream_item(
    runtime: _SdkSessionRuntime,
    item: dict[str, Any],
) -> dict[str, Any] | None:
    item_id = _optional_string(item.get("id"))
    if item_id is None:
        return item
    existing = runtime.live_stream_items.get(item_id)
    content = item.get("content") if isinstance(item.get("content"), dict) else {}
    content_hash = _hash_content(content)
    now = utc_now()
    if existing is not None and existing.get("contentHash") == content_hash:
        return None
    if existing is None:
        prepared = dict(item)
        prepared["orderSeq"] = _next_order(runtime)
        prepared["revision"] = 1
        prepared["status"] = "running"
        prepared["contentHash"] = content_hash
        prepared["createdAt"] = item.get("createdAt") or now
        prepared["updatedAt"] = item.get("updatedAt") or now
        prepared.pop("completedAt", None)
    else:
        prepared = dict(item)
        prepared["orderSeq"] = existing.get("orderSeq")
        prepared["revision"] = int(existing.get("revision") or 1) + 1
        prepared["status"] = "running"
        prepared["contentHash"] = content_hash
        prepared["createdAt"] = existing.get("createdAt") or item.get("createdAt") or now
        prepared["updatedAt"] = item.get("updatedAt") or now
        prepared.pop("completedAt", None)
    runtime.live_stream_items[item_id] = prepared
    return prepared


def _prepare_live_stream_final_item(
    runtime: _SdkSessionRuntime,
    item: dict[str, Any],
) -> dict[str, Any] | None:
    item_id = _optional_string(item.get("id"))
    if item_id is None:
        return None
    existing = runtime.live_stream_items.get(item_id)
    if existing is None:
        return None
    content = item.get("content") if isinstance(item.get("content"), dict) else {}
    content_hash = _hash_content(content)
    finalized = dict(item)
    finalized["orderSeq"] = existing.get("orderSeq")
    finalized["revision"] = int(existing.get("revision") or 1) + (
        0 if existing.get("contentHash") == content_hash and existing.get("status") == "done" else 1
    )
    finalized["status"] = "done"
    finalized["contentHash"] = content_hash
    finalized["createdAt"] = existing.get("createdAt") or item.get("createdAt") or utc_now()
    finalized["updatedAt"] = item.get("updatedAt") or utc_now()
    finalized["completedAt"] = finalized["updatedAt"]
    runtime.live_stream_items[item_id] = finalized
    return finalized


def _prepare_live_tool_item(
    runtime: _SdkSessionRuntime,
    item: dict[str, Any],
) -> dict[str, Any] | None:
    item_id = _optional_string(item.get("id"))
    if item_id is None:
        return item
    existing = runtime.live_tool_items.get(item_id)
    incoming_content = item.get("content") if isinstance(item.get("content"), dict) else {}
    now = utc_now()
    if existing is None:
        prepared = dict(item)
        prepared["orderSeq"] = _next_order(runtime)
        prepared["revision"] = int(prepared.get("revision") or 1)
        prepared["contentHash"] = _hash_content(prepared.get("content") if isinstance(prepared.get("content"), dict) else {})
        prepared["createdAt"] = item.get("createdAt") or now
        prepared["updatedAt"] = item.get("updatedAt") or now
        if prepared.get("status") not in {"done", "failed", "interrupted", "cancelled"}:
            prepared.pop("completedAt", None)
        runtime.live_tool_items[item_id] = prepared
        return prepared

    merged_content = dict(existing.get("content") if isinstance(existing.get("content"), dict) else {})
    merged_content.update(incoming_content)
    content_hash = _hash_content(merged_content)
    incoming_status = _optional_string(item.get("status")) or _optional_string(existing.get("status")) or "running"
    if existing.get("contentHash") == content_hash and existing.get("status") == incoming_status:
        return None
    prepared = dict(existing)
    prepared["content"] = merged_content
    prepared["status"] = incoming_status
    prepared["role"] = item.get("role") or existing.get("role")
    prepared["revision"] = int(existing.get("revision") or 1) + 1
    prepared["contentHash"] = content_hash
    prepared["updatedAt"] = item.get("updatedAt") or now
    if incoming_status in {"done", "failed", "interrupted", "cancelled"}:
        prepared["completedAt"] = item.get("completedAt") or prepared["updatedAt"]
    else:
        prepared.pop("completedAt", None)
    runtime.live_tool_items[item_id] = prepared
    return prepared


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) else None


def _blocks_to_dicts(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if not isinstance(content, (list, tuple)):
        return []
    blocks: list[dict[str, Any]] = []
    for block in content:
        block_type = _optional_string(_extract_attr(block, "type"))
        if block_type is None:
            block_type = _block_type_from_class(block)
        if block_type == "text":
            text = _optional_string(_extract_attr(block, "text"))
            if text is None or not text.strip():
                continue
            blocks.append({"type": "text", "text": text})
        elif block_type == "tool_use":
            blocks.append(
                {
                    "type": "tool_use",
                    "id": _optional_string(_extract_attr(block, "id")) or _stable_message_id(block),
                    "name": _optional_string(_extract_attr(block, "name")) or "unknown",
                    "input": _extract_attr(block, "input") or {},
                }
            )
        elif block_type == "tool_result":
            blocks.append(
                {
                    "type": "tool_result",
                    "tool_use_id": _optional_string(_extract_attr(block, "tool_use_id", "toolUseId")) or "",
                    "content": _extract_attr(block, "content"),
                    "is_error": _extract_attr(block, "is_error", "isError"),
                }
            )
    return blocks


def _has_text_blocks(blocks: list[dict[str, Any]]) -> bool:
    return any(block.get("type") == "text" and isinstance(block.get("text"), str) for block in blocks)


def _without_text_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [block for block in blocks if block.get("type") != "text"]


def _role_from_class(value: Any) -> str | None:
    name = value.__class__.__name__.lower()
    if "assistant" in name:
        return "assistant"
    if "user" in name:
        return "user"
    if "system" in name:
        return "system"
    return None


def _message_role(message: Any) -> str | None:
    return _optional_string(_extract_attr(message, "role")) or _role_from_class(message)


def _block_type_from_class(value: Any) -> str:
    name = value.__class__.__name__.lower()
    if "tooluse" in name or "tool_use" in name:
        return "tool_use"
    if "toolresult" in name or "tool_result" in name:
        return "tool_result"
    return "text"


def _is_result_message(message: Any) -> bool:
    name = message.__class__.__name__.lower()
    return "result" in name


def _is_stream_event(message: Any) -> bool:
    return message.__class__.__name__.lower() == "streamevent"


def _permission_allow(sdk: Any, input_data: dict[str, Any]) -> Any:
    cls = _optional_attr(sdk, "PermissionResultAllow", "types.PermissionResultAllow")
    if cls is not None:
        return cls(updated_input=input_data)
    return {"behavior": "allow", "updatedInput": input_data}


def _permission_deny(sdk: Any, message: str) -> Any:
    cls = _optional_attr(sdk, "PermissionResultDeny", "types.PermissionResultDeny")
    if cls is not None:
        return cls(message=message)
    return {"behavior": "deny", "message": message}


def _optional_attr(root: Any, *paths: str) -> Any:
    for path in paths:
        current = root
        for part in path.split("."):
            current = getattr(current, part, None)
            if current is None:
                break
        if current is not None:
            return current
    return None


def _extract_attr(value: Any, *names: str) -> Any:
    for name in names:
        if isinstance(value, dict) and name in value:
            return value[name]
        if hasattr(value, name):
            return getattr(value, name)
    return None


def _turn_start_item(runtime: _SdkSessionRuntime, turn_id: str) -> dict[str, Any]:
    return _timeline_item(
        id=f"{turn_id}:turn-start",
        session_id=runtime.session_id,
        turn_id=turn_id,
        item_type="turn.start",
        status="running",
        role=None,
        content={},
        external_session_id=runtime.external_session_id,
        source_item_type="turn.start",
        derived_key="turn-start",
        order_seq=_next_order(runtime),
    )


def _turn_end_item(
    runtime: _SdkSessionRuntime,
    turn_id: str,
    *,
    status: str,
    result: str,
    stop_reason: str,
) -> dict[str, Any]:
    return _timeline_item(
        id=f"{turn_id}:turn-end",
        session_id=runtime.session_id,
        turn_id=turn_id,
        item_type="turn.end",
        status=status,
        role=None,
        content={"stopReason": stop_reason, "result": result},
        external_session_id=runtime.external_session_id,
        source_item_type="turn.end",
        derived_key="turn-end",
        order_seq=_next_order(runtime),
    )


def _timeline_item(
    *,
    id: str,
    session_id: str,
    turn_id: str,
    item_type: str,
    status: str,
    role: str | None,
    content: dict[str, Any],
    external_session_id: str | None,
    source_item_type: str,
    derived_key: str | None = None,
    source_extra: dict[str, Any] | None = None,
    order_seq: int,
) -> dict[str, Any]:
    now = utc_now()
    source: dict[str, Any] = {
        "runtime": "claude",
        "sessionId": external_session_id,
        "turnId": turn_id,
        "itemId": id,
        "itemType": source_item_type,
        "event": source_item_type,
    }
    if derived_key:
        source["derivedKey"] = derived_key
    if source_extra:
        source.update(source_extra)
    return {
        "id": id,
        "sessionId": session_id,
        "turnId": turn_id,
        "type": item_type,
        "status": status,
        "role": role,
        "content": content,
        "source": source,
        "orderSeq": order_seq,
        "revision": 1,
        "contentHash": _hash_content(content),
        "createdAt": now,
        "updatedAt": now,
        "completedAt": now if status in {"done", "failed", "interrupted", "cancelled"} else None,
    }


def _next_order(runtime: _SdkSessionRuntime) -> int:
    order_seq = runtime.next_order_seq
    runtime.next_order_seq += 1
    return order_seq


def _approval_payload(
    *,
    approval_id: str,
    runtime: _SdkSessionRuntime,
    tool_name: str,
    input_data: dict[str, Any],
) -> dict[str, Any]:
    kind = _approval_kind(tool_name)
    return {
        "id": approval_id,
        "sessionId": runtime.session_id,
        "turnId": runtime.active_turn_id,
        "status": "pending",
        "kind": kind,
        "title": f"Claude requests {tool_name}",
        "description": _approval_description(tool_name, input_data),
        "payload": {"toolName": tool_name, "input": input_data},
        "choices": ["approve", "reject"],
        "source": {
            "runtime": "claude",
            "requestId": approval_id,
            "sessionId": runtime.external_session_id,
            "turnId": runtime.active_turn_id,
            "method": "can_use_tool",
        },
    }


def _approval_kind(tool_name: str) -> str:
    if tool_name == "Bash":
        return "command"
    if tool_name in {"Edit", "Write", "NotebookEdit"}:
        return "file_change"
    return "tool_call"


def _approval_description(tool_name: str, input_data: dict[str, Any]) -> str:
    if tool_name == "Bash":
        return _optional_string(input_data.get("command")) or "Run command"
    if tool_name in {"Edit", "Write", "NotebookEdit"}:
        return _optional_string(input_data.get("file_path")) or "Modify file"
    return json.dumps(input_data, ensure_ascii=False, sort_keys=True)


def _approval_id(session_id: str, turn_id: str | None, tool_name: str, input_data: dict[str, Any]) -> str:
    return "appr_" + _short_hash([session_id, turn_id, tool_name, input_data])


def _turn_id(session_id: str, content: str) -> str:
    return "turn_claude_" + _short_hash([session_id, content, secrets.token_urlsafe(8)])


def _stable_message_id(value: Any) -> str:
    return "msg_" + _short_hash(repr(value))


def _hash_content(content: Any) -> str:
    return "sha256:" + hashlib.sha256(
        json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _short_hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:24]


def _required(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} is required")
    return value


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _attachment_file_id(att: Any) -> str | None:
    if isinstance(att, dict):
        candidate = att.get("fileId")
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _attachment_name_from(att: Any) -> str | None:
    if isinstance(att, dict):
        candidate = att.get("name")
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


__all__ = ["ClaudeSdkAdapter", "ClaudeSdkAdapterError"]
