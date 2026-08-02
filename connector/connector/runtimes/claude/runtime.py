from __future__ import annotations

import asyncio
import base64
import secrets
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAttachment,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeTimelineSnapshot,
    RuntimeUnsupportedError,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.attachments import attachment_target
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude import (
    approvals,
    timeline,
    utils,
)
from connector.runtimes.claude import (
    options as claude_options,
)
from connector.runtimes.claude import permissions as permission_catalogs

SdkLoader = Callable[[], Any]
ClaudeClientFactory = Callable[[Any, Mapping[str, Any]], Any]


@dataclass(slots=True)
class _PendingClaudeApproval:
    approval_id: str
    future: asyncio.Future[str]
    input_data: dict[str, Any]
    notice: SessionNotice


@dataclass(slots=True)
class _ClaudeSession:
    session_id: str
    external_session_id: str | None = None
    cwd: str | None = None
    active_task: asyncio.Task[None] | None = None
    active_turn_id: str | None = None
    client: Any | None = None
    selections: dict[str, str | None] = field(default_factory=dict)
    pending_approvals: dict[str, _PendingClaudeApproval] = field(default_factory=dict)


@dataclass(slots=True)
class ClaudeRuntime(AgentRuntime):
    config: RuntimeConfig
    host: RuntimeHostClient
    sdk_loader: SdkLoader
    client_factory: ClaudeClientFactory | None = None
    runtime_version: str = "native-0"

    def __post_init__(self) -> None:
        self._started = False
        self._sdk: Any | None = None
        self._sessions: dict[str, _ClaudeSession] = {}
        self._session_states: dict[str, SessionState] = {}
        self._timeline_order_by_id: dict[str, int] = {}
        self._next_timeline_order = 1

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="claude",
            runtime_version=self.runtime_version,
            display_name="Claude",
        )

    async def start(self) -> None:
        if self._started:
            return
        self._sdk = self.sdk_loader()
        self._started = True

    async def stop(self) -> None:
        tasks = [
            session.active_task
            for session in self._sessions.values()
            if session.active_task is not None and not session.active_task.done()
        ]
        for session in self._sessions.values():
            self._resolve_pending_approvals(session, "reject")
            client = session.client
            if client is not None:
                interrupt = getattr(client, "interrupt", None)
                if callable(interrupt):
                    await _maybe_await(interrupt())
                disconnect = getattr(client, "disconnect", None)
                if callable(disconnect):
                    await _maybe_await(disconnect())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._sessions.clear()
        self._started = False

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        _ = query
        return RuntimeModelCatalog(
            runtime="claude",
            revision=self.config.revision,
            models=()[:limit],
        )

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        permissions = permission_catalogs.claude_permissions(
            self.config.revision
        ).permissions
        if query:
            lowered = query.casefold()
            permissions = tuple(
                item
                for item in permissions
                if lowered in item.id.casefold() or lowered in item.title.casefold()
            )
        return RuntimePermissionCatalog(
            runtime="claude",
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
        await self.start()
        sdk = self._require_sdk()
        list_sessions = getattr(sdk, "list_sessions", None)
        if not callable(list_sessions):
            raise RuntimeUnsupportedError("list_sessions")
        sessions: list[SessionMeta] = []
        for item in list(list_sessions(limit=limit)):
            external_session_id = utils.string_attr(item, "session_id")
            if external_session_id is None:
                continue
            sessions.append(
                SessionMeta(
                    session_id=utils.stable_session_id(
                        self.host.connector_id, external_session_id
                    ),
                    external_session_id=external_session_id,
                    runtime="claude",
                    title=utils.string_attr(item, "custom_title")
                    or utils.string_attr(item, "summary"),
                    cwd=utils.string_attr(item, "cwd"),
                    ordering_time=utils.timestamp_from_ms(
                        utils.int_attr(item, "last_modified")
                    ),
                    metadata={
                        "local_state": "active",
                        "source": "claude-agent-sdk.list_sessions",
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
        return SessionState(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="claude",
            status="idle",
            metadata={"source": "claude.runtime.basic"},
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int = 100,
    ) -> RuntimeTimelineSnapshot:
        if external_session_id is None:
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=None,
                runtime="claude",
                items=(),
                complete=True,
                metadata={"source": "claude.runtime.basic"},
            )
        await self.start()
        sdk = self._require_sdk()
        session_info = timeline.get_session_info(
            sdk, external_session_id, directory=None
        )
        messages = timeline.get_session_messages(
            sdk, external_session_id, directory=utils.string_attr(session_info, "cwd")
        )
        items = timeline.timeline_items_from_messages(
            session_id=session_id,
            external_session_id=external_session_id,
            session_info=session_info,
            messages=messages,
            limit=limit,
        )
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="claude",
            items=items,
            complete=True,
            metadata={"source": "claude-agent-sdk.history"},
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
        session = self._session_for(session_id, None, cwd)
        session.selections.update(dict(selections or {}))
        await self.host.session_meta_upsert(
            session_id=session_id,
            runtime="claude",
            external_session_id=None,
            title=title,
            cwd=cwd,
            metadata={"source": "claude.runtime.create"},
        )
        await self._set_session_state(
            session_id=session_id,
            external_session_id=None,
            status="idle",
            selections=selections,
            metadata={"source": "claude.runtime.create"},
        )
        turn_result = await self.start_turn(
            session_id=session_id,
            external_session_id=None,
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
                "externalSessionId": session.external_session_id,
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
        await self.start()
        session = self._session_for(session_id, external_session_id, None)
        if session.active_task is not None and not session.active_task.done():
            return RuntimeOperationResult(
                ok=False,
                code="claude_turn_already_running",
                message="Claude runtime already has an active turn for this session",
            )
        turn_id = f"turn_claude_{secrets.token_urlsafe(12)}"
        session.active_turn_id = turn_id
        await self._set_session_state(
            session_id=session_id,
            external_session_id=session.external_session_id,
            status="waiting",
            metadata={"source": "claude.turn/start.requested", "turn_id": turn_id},
        )
        session.active_task = asyncio.create_task(
            self._drive_turn(
                session=session,
                content=content,
                attachments=attachments,
                client_message_id=client_message_id,
            )
        )
        return RuntimeOperationResult(ok=True, result={"turnId": turn_id})

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        _ = external_session_id
        session = self._sessions.get(session_id)
        if session is None or session.active_task is None or session.active_task.done():
            return RuntimeOperationResult(
                ok=False,
                code="claude_no_active_turn",
                message="Claude runtime has no active turn to steer",
            )
        client = session.client
        if client is None or not callable(getattr(client, "query", None)):
            return RuntimeOperationResult(
                ok=False,
                code="claude_steer_unavailable",
                message="Claude SDK client is not ready to receive steering input",
            )
        await client.query(
            timeline.prompt_stream(
                await self._materialize_content(session_id, content, attachments)
            )
        )
        await self._set_session_state(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            status="running",
            metadata={
                "source": "claude.turn/steer",
                **(
                    {"turn_id": session.active_turn_id}
                    if session.active_turn_id
                    else {}
                ),
                **({"clientMessageId": client_message_id} if client_message_id else {}),
            },
        )
        return RuntimeOperationResult(
            ok=True,
            result={"steered": True, "turnId": session.active_turn_id},
        )

    async def interrupt_turn(
        self,
        session_id: str,
        external_session_id: str | None = None,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        _ = external_session_id
        session = self._sessions.get(session_id)
        if session is None or session.active_turn_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="claude_no_active_turn",
                message="Claude runtime has no active turn to interrupt",
            )
        interrupted = False
        self._resolve_pending_approvals(session, "reject")
        client = session.client
        if client is not None:
            interrupt = getattr(client, "interrupt", None)
            if callable(interrupt):
                await _maybe_await(interrupt())
                interrupted = True
        if session.active_task is not None and not session.active_task.done():
            session.active_task.cancel()
            interrupted = True
        await self._set_session_state(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            status="idle",
            metadata={
                "source": "claude.turn/interrupt",
                **({"reason": reason} if reason else {}),
                **(
                    {"turn_id": session.active_turn_id}
                    if session.active_turn_id
                    else {}
                ),
            },
        )
        turn_id = session.active_turn_id
        session.active_turn_id = None
        return RuntimeOperationResult(
            ok=interrupted,
            code=None if interrupted else "claude_interrupt_unavailable",
            message=None
            if interrupted
            else "Claude SDK client did not expose interrupt",
            result={"interrupted": interrupted, "turnId": turn_id},
        )

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        _ = input_data
        session = self._sessions.get(session_id)
        if session is None:
            return RuntimeOperationResult(
                ok=False,
                code="claude_session_not_found",
                message="Claude session is not active",
            )
        pending = session.pending_approvals.get(notice_id)
        if pending is None:
            return RuntimeOperationResult(
                ok=False,
                code="claude_interaction_not_pending",
                message="Claude interaction is not pending",
            )
        normalized_action = approvals.normalize_approval_action(action_id)
        if normalized_action is None:
            return RuntimeOperationResult(
                ok=False,
                code="claude_interaction_action_unsupported",
                message=f"Claude interaction action is not supported: {action_id}",
            )
        if not pending.future.done():
            pending.future.set_result(normalized_action)
        await self._set_session_state(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            status="running",
            metadata={
                "source": "claude.approval/responded",
                "approval_id": pending.approval_id,
                "action": normalized_action,
            },
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "noticeId": notice_id,
                "action": normalized_action,
            },
        )

    def _require_sdk(self) -> Any:
        if self._sdk is None:
            self._sdk = self.sdk_loader()
        return self._sdk

    def _session_for(
        self,
        session_id: str,
        external_session_id: str | None,
        cwd: str | None,
    ) -> _ClaudeSession:
        session = self._sessions.get(session_id)
        if session is None:
            session = _ClaudeSession(
                session_id=session_id,
                external_session_id=external_session_id,
                cwd=cwd,
            )
            self._sessions[session_id] = session
        if external_session_id:
            session.external_session_id = external_session_id
        if cwd:
            session.cwd = cwd
        return session

    async def _drive_turn(
        self,
        session: _ClaudeSession,
        content: str,
        attachments: tuple[RuntimeAttachment, ...],
        client_message_id: str | None,
    ) -> None:
        turn_id = session.active_turn_id or f"turn_claude_{secrets.token_urlsafe(12)}"
        try:
            sdk = self._require_sdk()
            client = self._new_client(sdk, session)
            session.client = client
            connect = getattr(client, "connect", None)
            if callable(connect):
                await _maybe_await(connect())
            await self._set_session_state(
                session_id=session.session_id,
                external_session_id=session.external_session_id,
                status="running",
                metadata={"source": "claude.turn/running", "turn_id": turn_id},
            )
            query = getattr(client, "query", None)
            if not callable(query):
                raise RuntimeUnsupportedError("ClaudeSDKClient.query")
            await query(
                timeline.prompt_stream(
                    await self._materialize_content(
                        session.session_id, content, attachments
                    )
                )
            )
            await self.host.timeline_item_upsert(
                timeline.message_item(
                    session_id=session.session_id,
                    external_session_id=session.external_session_id,
                    turn_id=turn_id,
                    role="user",
                    text=content,
                    source_event="claude.turn/start.user",
                    order_seq=self._order_for(
                        utils.stable_item_id(
                            "claude_user",
                            session.session_id,
                            turn_id,
                            client_message_id,
                            content,
                        )
                    ),
                    item_id=utils.stable_item_id(
                        "claude_user",
                        session.session_id,
                        turn_id,
                        client_message_id,
                        content,
                    ),
                    client_message_id=client_message_id,
                )
            )
            async for raw in timeline.receive_response(client):
                for item in timeline.timeline_items_from_live_message(
                    session_id=session.session_id,
                    external_session_id=session.external_session_id,
                    turn_id=turn_id,
                    message=raw,
                    next_order=self._order_for,
                ):
                    await self.host.timeline_item_upsert(item)
                    source_session_id = item.source.get("sessionId")
                    if isinstance(source_session_id, str) and source_session_id:
                        session.external_session_id = source_session_id
            await self._set_session_state(
                session_id=session.session_id,
                external_session_id=session.external_session_id,
                status="idle",
                metadata={"source": "claude.turn/completed", "turn_id": turn_id},
            )
        except asyncio.CancelledError:
            await self._set_session_state(
                session_id=session.session_id,
                external_session_id=session.external_session_id,
                status="idle",
                metadata={"source": "claude.turn/cancelled", "turn_id": turn_id},
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "claude runtime turn failed session_id={}", session.session_id
            )
            await self._set_session_state(
                session_id=session.session_id,
                external_session_id=session.external_session_id,
                status="error",
                error={
                    "code": getattr(exc, "code", None) or exc.__class__.__name__,
                    "message": str(exc) or exc.__class__.__name__,
                },
                metadata={"source": "claude.turn/failed", "turn_id": turn_id},
            )
        finally:
            session.active_turn_id = None
            disconnect = getattr(session.client, "disconnect", None)
            if callable(disconnect):
                try:
                    await _maybe_await(disconnect())
                except Exception:  # noqa: BLE001
                    logger.exception("disconnecting Claude SDK client failed")

    def _new_client(self, sdk: Any, session: _ClaudeSession) -> Any:
        options = claude_options.sdk_options(
            sdk=sdk,
            config_values=self.config.values,
            cwd=session.cwd,
            external_session_id=session.external_session_id,
            permission_selection=session.selections.get("permission"),
            can_use_tool=self._can_use_tool,
        )
        if self.client_factory is not None:
            return self.client_factory(sdk, options)
        client_cls = getattr(sdk, "ClaudeSDKClient", None)
        if client_cls is None:
            raise RuntimeUnsupportedError("ClaudeSDKClient")
        try:
            return client_cls(options=options)
        except TypeError:
            return client_cls(options)

    async def _can_use_tool(
        self, tool_name: str, input_data: dict[str, Any], context: Any = None
    ) -> Any:
        sdk = self._require_sdk()
        context_session_id = utils.string(
            utils.extract_attr(context, "session_id", "sessionId")
        )
        session = self._session_from_context(context_session_id)
        if session is None:
            return approvals.permission_deny(sdk, "Session is not registered")
        approval_id = approvals.approval_id(
            session.session_id, session.active_turn_id, tool_name, input_data
        )
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()
        notice = approvals.approval_notice(
            approval_id=approval_id,
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            active_turn_id=session.active_turn_id,
            tool_name=tool_name,
            input_data=input_data,
            status="open",
        )
        session.pending_approvals[approval_id] = _PendingClaudeApproval(
            approval_id=approval_id,
            future=future,
            input_data=dict(input_data),
            notice=notice,
        )
        await self._set_session_state(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            status="blocked",
            metadata={
                "source": "claude.approval/requested",
                "approval_id": approval_id,
                **(
                    {"turn_id": session.active_turn_id}
                    if session.active_turn_id
                    else {}
                ),
            },
        )
        await self.host.notice_upsert(notice)
        action = await future
        session.pending_approvals.pop(approval_id, None)
        if action in {"approve", "approve_for_session"}:
            return approvals.permission_allow(sdk, input_data)
        return approvals.permission_deny(sdk, "User denied or interrupted this action")

    def _session_from_context(
        self, external_session_id: str | None
    ) -> _ClaudeSession | None:
        if external_session_id:
            for session in self._sessions.values():
                if session.external_session_id == external_session_id:
                    return session
        for session in self._sessions.values():
            if session.active_turn_id:
                return session
        return None

    def _resolve_pending_approvals(self, session: _ClaudeSession, action: str) -> None:
        for pending in list(session.pending_approvals.values()):
            if not pending.future.done():
                pending.future.set_result(action)

    async def _materialize_content(
        self,
        session_id: str,
        content: str,
        attachments: tuple[RuntimeAttachment, ...],
    ) -> Any:
        if not attachments:
            return content
        blocks: list[dict[str, Any]] = [{"type": "text", "text": content}]
        for attachment in attachments:
            try:
                downloaded = await self.host.attachment_download(
                    session_id, attachment.file_id
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "Claude attachment download failed file_id={}", attachment.file_id
                )
                blocks.append(
                    {
                        "type": "text",
                        "text": f"\n\n[Failed to load attachment {attachment.file_id}: {exc}]",
                    }
                )
                continue
            name = downloaded.name or attachment.name or attachment.file_id
            target = attachment_target(session_id, attachment.file_id, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(downloaded.content)
            if downloaded.media_type.startswith("image/"):
                blocks.append(
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": downloaded.media_type,
                            "data": base64.b64encode(downloaded.content).decode(
                                "ascii"
                            ),
                        },
                    }
                )
            blocks.append(
                {"type": "text", "text": f"\n\nAttached file: {name} at {target}"}
            )
        return blocks

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
            runtime="claude",
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
            runtime="claude",
            external_session_id=external_session_id,
            status=state.status,
            selections=state.selections,
            error=state.error,
            metadata=state.metadata,
        )

    def _order_for(self, item_id: str) -> int:
        order = self._timeline_order_by_id.get(item_id)
        if order is None:
            order = self._next_timeline_order
            self._next_timeline_order += 1
            self._timeline_order_by_id[item_id] = order
        return order


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value
