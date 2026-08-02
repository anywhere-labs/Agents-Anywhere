from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import secrets
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from connector.attachments import attachment_target
from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAttachment,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    RuntimeUnsupportedError,
    SessionMeta,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.server.protocol import protocol_selection_id
from connector.time import utc_now

SdkLoader = Callable[[], Any]
ClaudeClientFactory = Callable[[Any, Mapping[str, Any]], Any]


@dataclass(slots=True)
class _ClaudeSession:
    session_id: str
    external_session_id: str | None = None
    cwd: str | None = None
    active_task: asyncio.Task[None] | None = None
    active_turn_id: str | None = None
    client: Any | None = None
    selections: dict[str, str | None] = field(default_factory=dict)


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
        permissions = _claude_permissions(self.config.revision).permissions
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
            external_session_id = _string_attr(item, "session_id")
            if external_session_id is None:
                continue
            sessions.append(
                SessionMeta(
                    session_id=stable_session_id(self.host.connector_id, external_session_id),
                    external_session_id=external_session_id,
                    runtime="claude",
                    title=_string_attr(item, "custom_title") or _string_attr(item, "summary"),
                    cwd=_string_attr(item, "cwd"),
                    ordering_time=_timestamp_from_ms(_int_attr(item, "last_modified")),
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
        session_info = _get_session_info(sdk, external_session_id, directory=None)
        messages = _get_session_messages(sdk, external_session_id, directory=_string_attr(session_info, "cwd"))
        items = _timeline_items_from_messages(
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
        await client.query(_prompt_stream(await self._materialize_content(session_id, content, attachments)))
        await self._set_session_state(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            status="running",
            metadata={
                "source": "claude.turn/steer",
                **({"turn_id": session.active_turn_id} if session.active_turn_id else {}),
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
                **({"turn_id": session.active_turn_id} if session.active_turn_id else {}),
            },
        )
        turn_id = session.active_turn_id
        session.active_turn_id = None
        return RuntimeOperationResult(
            ok=interrupted,
            code=None if interrupted else "claude_interrupt_unavailable",
            message=None if interrupted else "Claude SDK client did not expose interrupt",
            result={"interrupted": interrupted, "turnId": turn_id},
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
            await query(_prompt_stream(await self._materialize_content(session.session_id, content, attachments)))
            await self.host.timeline_item_upsert(
                _message_item(
                    session_id=session.session_id,
                    external_session_id=session.external_session_id,
                    turn_id=turn_id,
                    role="user",
                    text=content,
                    source_event="claude.turn/start.user",
                    order_seq=self._order_for(_stable_item_id("claude_user", session.session_id, turn_id, client_message_id, content)),
                    item_id=_stable_item_id("claude_user", session.session_id, turn_id, client_message_id, content),
                    client_message_id=client_message_id,
                )
            )
            async for raw in _receive_response(client):
                for item in _timeline_items_from_live_message(
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
            logger.exception("claude runtime turn failed session_id={}", session.session_id)
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
        options = _sdk_options(sdk, self.config, session)
        if self.client_factory is not None:
            return self.client_factory(sdk, options)
        client_cls = getattr(sdk, "ClaudeSDKClient", None)
        if client_cls is None:
            raise RuntimeUnsupportedError("ClaudeSDKClient")
        try:
            return client_cls(options=options)
        except TypeError:
            return client_cls(options)

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
                downloaded = await self.host.attachment_download(session_id, attachment.file_id)
            except Exception as exc:  # noqa: BLE001
                logger.exception("Claude attachment download failed file_id={}", attachment.file_id)
                blocks.append({"type": "text", "text": f"\n\n[Failed to load attachment {attachment.file_id}: {exc}]"})
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
                            "data": base64.b64encode(downloaded.content).decode("ascii"),
                        },
                    }
                )
            blocks.append({"type": "text", "text": f"\n\nAttached file: {name} at {target}"})
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


def stable_session_id(connector_id: str, external_session_id: str) -> str:
    digest = hashlib.sha256(f"{connector_id}:claude:{external_session_id}".encode("utf-8")).hexdigest()[:24]
    return f"sess_claude_{digest}"


def _claude_permissions(revision: int) -> RuntimePermissionCatalog:
    items = [
        ("default", "Ask permissions", "Prompt before destructive actions. Read-only commands run automatically.", True),
        ("acceptEdits", "Accept edits", "Auto-approve file edits; still ask for shell commands.", False),
        ("plan", "Plan mode", "Read-only planning. No writes, no commands.", False),
        ("auto", "Auto mode", "Run everything; background classifier flags risky actions.", False),
        ("bypassPermissions", "Bypass permissions", "Skip every prompt. Use with care.", False),
    ]
    return RuntimePermissionCatalog(
        runtime="claude",
        revision=revision,
        permissions=tuple(
            RuntimePermissionItem(
                id=item_id,
                title=title,
                description=description,
                selection_id=protocol_selection_id(
                    "claude",
                    "permission",
                    {"permission_mode": item_id},
                ),
                metadata={
                    "default": is_default,
                    "nativeSettings": {"permissionMode": item_id},
                },
            )
            for item_id, title, description, is_default in items
        ),
    )


def _sdk_options(sdk: Any, config: RuntimeConfig, session: _ClaudeSession) -> Any:
    kwargs: dict[str, Any] = {
        "include_partial_messages": True,
    }
    if session.cwd:
        kwargs["cwd"] = session.cwd
    if session.external_session_id:
        kwargs["resume"] = session.external_session_id
    executable_path = config.values.get("executablePath")
    if isinstance(executable_path, str) and executable_path:
        kwargs["cli_path"] = executable_path
    environment = config.values.get("environment")
    if isinstance(environment, Mapping):
        kwargs["env"] = dict(environment)
    permission_selection = session.selections.get("permission")
    permission_mode = _permission_mode_from_selection(permission_selection)
    if permission_mode:
        kwargs["permission_mode"] = permission_mode
    options_cls = getattr(sdk, "ClaudeAgentOptions", None) or getattr(sdk, "ClaudeCodeOptions", None)
    if options_cls is None:
        return kwargs
    return options_cls(**kwargs)


def _permission_mode_from_selection(selection_id: str | None) -> str | None:
    if selection_id is None:
        return None
    for permission in _claude_permissions(1).permissions:
        if permission.selection_id == selection_id:
            native = permission.metadata.get("nativeSettings")
            if isinstance(native, Mapping):
                mode = native.get("permissionMode")
                return mode if isinstance(mode, str) else None
    return None


def _get_session_info(sdk: Any, session_id: str, directory: str | None) -> Any:
    get_session_info = getattr(sdk, "get_session_info", None)
    if not callable(get_session_info):
        return None
    try:
        return get_session_info(session_id, directory=directory)
    except TypeError:
        return get_session_info(session_id)


def _get_session_messages(sdk: Any, session_id: str, directory: str | None) -> list[Any]:
    get_session_messages = getattr(sdk, "get_session_messages", None)
    if not callable(get_session_messages):
        raise RuntimeUnsupportedError("get_session_messages")
    try:
        return list(get_session_messages(session_id, directory=directory))
    except TypeError:
        return list(get_session_messages(session_id))


def _timeline_items_from_messages(
    session_id: str,
    external_session_id: str,
    session_info: Any,
    messages: list[Any],
    limit: int,
) -> tuple[RuntimeTimelineItem, ...]:
    items: list[RuntimeTimelineItem] = []
    for index, message in enumerate(messages[:limit]):
        item = _timeline_item_from_history_message(
            session_id=session_id,
            external_session_id=external_session_id,
            session_info=session_info,
            message=message,
            order_seq=index + 1,
        )
        if item is not None:
            items.append(item)
    return tuple(items)


def _timeline_item_from_history_message(
    session_id: str,
    external_session_id: str,
    session_info: Any,
    message: Any,
    order_seq: int,
) -> RuntimeTimelineItem | None:
    raw = _raw_message(message)
    role = _message_role(raw, message)
    text = _message_text(raw, message)
    if role is None or text is None:
        return None
    message_id = _string_attr(message, "uuid") or _string(raw.get("id")) or _stable_item_id(
        "claude_history",
        external_session_id,
        order_seq,
        role,
        text,
    )
    timestamp = _timestamp_from_ms(_int_attr(session_info, "last_modified")) or utc_now()
    return _message_item(
        session_id=session_id,
        external_session_id=external_session_id,
        turn_id=message_id,
        role=role,
        text=text,
        source_event="claude-agent-sdk.history",
        order_seq=order_seq,
        item_id=_stable_item_id("claude_msg", external_session_id, message_id),
        timestamp=timestamp,
    )


def _timeline_items_from_live_message(
    session_id: str,
    external_session_id: str | None,
    turn_id: str,
    message: Any,
    next_order: Callable[[str], int],
) -> tuple[RuntimeTimelineItem, ...]:
    raw = _raw_message(message)
    session_from_message = _string_attr(message, "session_id") or _string(raw.get("session_id")) or external_session_id
    role = _message_role(raw, message)
    text = _message_text(raw, message)
    if role is None or text is None:
        return ()
    item_id = _stable_item_id(
        "claude_live",
        session_from_message,
        _string_attr(message, "uuid") or _string(raw.get("id")) or text,
        role,
    )
    return (
        _message_item(
            session_id=session_id,
            external_session_id=session_from_message,
            turn_id=turn_id,
            role=role,
            text=text,
            source_event="claude-agent-sdk.live",
            order_seq=next_order(item_id),
            item_id=item_id,
            timestamp=_string_attr(message, "timestamp") or utc_now(),
        ),
    )


def _message_item(
    session_id: str,
    external_session_id: str | None,
    turn_id: str,
    role: str,
    text: str,
    source_event: str,
    order_seq: int,
    item_id: str,
    timestamp: str | None = None,
    client_message_id: str | None = None,
) -> RuntimeTimelineItem:
    content = {"text": text, "format": "markdown"}
    source: dict[str, Any] = {
        "runtime": "claude",
        "sessionId": external_session_id,
        "turnId": turn_id,
        "itemId": item_id,
        "itemType": "message",
        "event": source_event,
    }
    if client_message_id:
        source["clientMessageId"] = client_message_id
    return RuntimeTimelineItem(
        id=item_id,
        session_id=session_id,
        type="message",
        status="done",
        order_seq=order_seq,
        content_hash=_content_hash("message", "done", role, content),
        role=role,
        turn_id=turn_id,
        content=content,
        source=source,
        revision=1,
        metadata={
            **({"createdAt": timestamp} if timestamp else {}),
        },
    )


async def _receive_response(client: Any) -> AsyncIterator[Any]:
    receive = getattr(client, "receive_response", None)
    if not callable(receive):
        return
    result = receive()
    if hasattr(result, "__aiter__"):
        async for item in result:
            yield item
        return
    if hasattr(result, "__await__"):
        result = await result
    if hasattr(result, "__aiter__"):
        async for item in result:
            yield item
        return
    if isinstance(result, list | tuple):
        for item in result:
            yield item
        return
    if result is not None:
        yield result


async def _prompt_stream(content: Any) -> AsyncIterator[dict[str, Any]]:
    yield {
        "type": "user",
        "message": {
            "role": "user",
            "content": content,
        },
    }


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value


def _raw_message(message: Any) -> dict[str, Any]:
    raw = getattr(message, "message", None)
    if isinstance(raw, dict):
        return raw
    if isinstance(message, dict):
        nested = message.get("message")
        return nested if isinstance(nested, dict) else message
    return {}


def _message_role(raw: Mapping[str, Any], message: Any) -> str | None:
    role = _string(raw.get("role")) or _string_attr(message, "type") or _string_attr(message, "role")
    return role if role in {"user", "assistant", "system"} else None


def _message_text(raw: Mapping[str, Any], message: Any) -> str | None:
    result = _string_attr(message, "result")
    if result:
        return result
    content = raw.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, Mapping):
                text = _string(block.get("text"))
                if text:
                    parts.append(text)
        text = "\n".join(parts).strip()
        return text or None
    text = _string(raw.get("text")) or _string_attr(message, "text")
    return text if text else None


def _string_attr(value: Any, attr: str) -> str | None:
    candidate = getattr(value, attr, None)
    return candidate if isinstance(candidate, str) and candidate else None


def _int_attr(value: Any, attr: str) -> int | None:
    candidate = getattr(value, attr, None)
    return candidate if isinstance(candidate, int) else None


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _timestamp_from_ms(value: int | None) -> str | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, tz=UTC).isoformat().replace("+00:00", "Z")


def _stable_item_id(*values: Any) -> str:
    payload = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "claude_" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _content_hash(item_type: str, status: str, role: str | None, content: Any) -> str:
    payload = json.dumps(
        {
            "type": item_type,
            "status": status,
            "role": role,
            "content": content,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()
