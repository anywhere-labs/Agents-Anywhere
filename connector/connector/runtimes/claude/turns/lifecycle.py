from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeConfig,
    RuntimeTimelineItem,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.domain.pending_messages import (
    ClaudePendingClientMessageRegistry,
    client_message_text_matches,
)
from connector.runtimes.claude.domain.session import ClaudeExecution, ClaudeSession
from connector.runtimes.claude.notifications.projector import (
    ClaudeNotificationProjector,
)
from connector.runtimes.claude.sdk.client import (
    ClaudeClientFactory,
    SdkLoader,
    connect_client,
    load_sdk,
    new_sdk_client,
    query_client,
    receive_response_messages,
)
from connector.runtimes.claude.sdk.connection import ClaudeConnection, ClaudeResponse
from connector.runtimes.claude.sdk.events import (
    ClaudeTerminalEvent,
    failed_terminal_event,
    interrupted_terminal_event,
    terminal_event_from_message,
)
from connector.runtimes.claude.sdk.settings import (
    create_gateway_settings_file,
    remove_gateway_settings_file,
)
from connector.runtimes.claude.sdk.stderr import ClaudeStderrBuffer
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore
from connector.runtimes.claude.sessions.scheduled import ClaudeScheduledSessions
from connector.runtimes.claude.timeline.messages import (
    ClaudeMessageProjector,
    is_synthetic_control_message,
    message_id,
    message_role,
    message_session_id,
    message_text,
    stable_message_item_id,
)
from connector.runtimes.claude.timeline.stream import (
    ClaudeStreamAccumulator,
    is_stream_event,
)
from connector.runtimes.claude.turns.attachments import (
    content_with_attachment_notes,
    materialize_claude_attachments,
)
from connector.runtimes.claude.turns.interactions import ClaudeInteractionController


@dataclass(slots=True)
class ClaudeTurnRunner:
    config: RuntimeConfig
    host: RuntimeHostClient
    session_store: ClaudeSessionStore
    timeline: ClaudeMessageProjector
    notifications: ClaudeNotificationProjector
    interactions: ClaudeInteractionController
    pending_messages: ClaudePendingClientMessageRegistry
    sdk_loader: SdkLoader | None = None
    client_factory: ClaudeClientFactory | None = None
    connections: dict[str, ClaudeConnection] = field(default_factory=dict, init=False)
    stopping: bool = False
    scheduled_sessions: ClaudeScheduledSessions = field(init=False)

    def __post_init__(self) -> None:
        self.scheduled_sessions = ClaudeScheduledSessions(self.host)

    async def stop(self) -> None:
        self.stopping = True
        for connection in tuple(self.connections.values()):
            await connection.close()

    async def reconnect_sessions(self) -> None:
        """Resume only AA sessions previously observed to have scheduled tasks."""
        if self.stopping:
            return
        for session_id, saved in (await self.scheduled_sessions.read()).items():
            session = self.session_store.ensure(
                session_id=session_id,
                external_session_id=saved["externalSessionId"],
                cwd=saved["cwd"],
            )
            if session.execution is not None or session_id in self.connections:
                continue
            session.selections = dict(saved["selections"])
            try:
                connection = await self.connection_for(
                    session, ClaudeStderrBuffer(session.session_id)
                )
                connection.task_ids.update(saved["taskIds"])
                connection.queried.set()
                await connection.connect()
            except Exception as exc:  # noqa: BLE001
                await self.notifications.session_state.session_state_update(
                    session,
                    "error",
                    error={
                        "code": "claude_schedule_resume_failed",
                        "message": str(exc),
                    },
                    metadata={"source": "claude.scheduled.resume"},
                )

    async def scheduled_activity(
        self, session: ClaudeSession, response: ClaudeResponse
    ) -> None:
        async with session.execution_lock:
            if self.stopping:
                return
            if response.execution is not None:
                return
            session.queued_execution = session.execution
            execution = ClaudeExecution(
                turn_id=f"turn_claude_{secrets.token_urlsafe(12)}"
            )
            session.execution = execution
            response.execution = execution
            try:
                await self.notifications.session_state.session_state_update(
                    session,
                    "running",
                    metadata={"source": "claude.scheduled.running"},
                )
                execution.task = asyncio.create_task(
                    self.drive_turn(
                        session,
                        execution,
                        "",
                        (),
                        None,
                        scheduled=True,
                        response=response,
                    )
                )
            except BaseException:
                session.execution = session.queued_execution
                session.queued_execution = None
                execution.finished.set()
                raise

    async def connection_for(
        self,
        session: ClaudeSession,
        stderr: ClaudeStderrBuffer,
    ) -> ClaudeConnection:
        existing = self.connections.get(session.session_id)
        if existing is not None:
            if not existing.closing and existing.selections == session.selections:
                return existing
            await existing.close()
        sdk = load_sdk(self.sdk_loader)
        settings_path = create_gateway_settings_file(self.config.values)

        async def approval(tool_name, tool_input, context):
            await connection.prepare_approval()
            return await self.interactions.approval_callback(
                sdk,
                session,
                session.active_turn_id,
            )(tool_name, tool_input, context)

        async def tool_result(data, *args):
            result = await connection.tool_result(data, *args)
            native_id = data.get("session_id")
            if session.external_session_id is None and isinstance(native_id, str):
                await self._update_external_session_id(session, native_id)
            await self.scheduled_sessions.save(session, connection.task_ids)
            return result

        def cleanup():
            remove_gateway_settings_file(settings_path)
            if self.connections.get(session.session_id) is connection:
                self.connections.pop(session.session_id)

        try:
            client = new_sdk_client(
                sdk=sdk,
                config_values=self.config.values,
                session=session,
                client_factory=self.client_factory,
                can_use_tool=approval,
                stderr=stderr.record,
                settings_path=settings_path,
                on_tool_result=tool_result,
                before_tool=lambda data: connection.before_tool(data),
            )
        except BaseException:
            remove_gateway_settings_file(settings_path)
            raise
        connection = ClaudeConnection(
            client=client,
            on_activity=lambda response: self.scheduled_activity(session, response),
            cleanup=cleanup,
            selections=dict(session.selections),
            task_ids=set(existing.task_ids) if existing is not None else set(),
        )
        self.connections[session.session_id] = connection
        return connection

    async def refresh_idle_connection(self, session: ClaudeSession) -> None:
        async with session.execution_lock:
            existing = self.connections.get(session.session_id)
            if (
                self.stopping
                or session.execution is not None
                or existing is None
                or existing.selections == session.selections
            ):
                return
            try:
                connection = await self.connection_for(
                    session,
                    ClaudeStderrBuffer(session.session_id),
                )
                connection.queried.set()
                await connection.connect()
                await self.scheduled_sessions.save(session, connection.task_ids)
            except Exception as exc:  # noqa: BLE001
                connection = self.connections.get(session.session_id)
                if connection is not None:
                    await connection.close()
                await self.notifications.session_state.session_state_update(
                    session,
                    "error",
                    error={
                        "code": "claude_connection_refresh_failed",
                        "message": str(exc),
                    },
                    metadata={"source": "claude.connection.refresh"},
                )

    async def drive_turn(
        self,
        session: ClaudeSession,
        execution: ClaudeExecution,
        content: str,
        attachments: tuple[RuntimeAttachment, ...],
        client_message_id: str | None,
        scheduled: bool = False,
        response: ClaudeResponse | None = None,
    ) -> None:
        turn_id = execution.turn_id
        stderr = ClaudeStderrBuffer(session.session_id)
        client = response
        connection = response.connection if response is not None else None
        terminal: ClaudeTerminalEvent | None = None
        reserved_user_item = None
        attachment_mappings: tuple[dict[str, object], ...] = ()
        replayed_user_message: tuple[str, str] | None = None
        response_external_session_confirmed = False
        user_message_published = scheduled
        try:
            if client is None:
                connection = await self.connection_for(session, stderr)
                client = connection.response_for(execution)
            execution.client = client
            await connect_client(client)
            materialized_attachments = await materialize_claude_attachments(
                self.host,
                session.session_id,
                attachments,
            )
            effective_content = content_with_attachment_notes(
                content,
                materialized_attachments,
            )
            if not scheduled:
                await self.notifications.session_state.session_state_update(
                    session,
                    "running",
                    metadata={"source": "claude.turn.running"},
                )
            attachment_mappings = tuple(
                attachment.to_mapping() for attachment in materialized_attachments
            )
            if not scheduled:
                reserved_user_item = self.timeline.message_item(
                    session=session,
                    turn_id=turn_id,
                    role="user",
                    text=content,
                    event="claude.turn.user",
                    client_message_id=client_message_id,
                    attachments=attachment_mappings,
                )
                await query_client(client, effective_content)

            emitted_final_assistant_content = False
            stream_accumulator = ClaudeStreamAccumulator()
            async for message in receive_response_messages(client):
                external_session_id = message_session_id(message)
                if external_session_id is not None:
                    await self._update_external_session_id(session, external_session_id)
                    response_external_session_confirmed = True
                    user_message_published = await self.publish_replayed_user_message(
                        session=session,
                        turn_id=turn_id,
                        content=content,
                        attachments=attachment_mappings,
                        client_message_id=client_message_id,
                        reserved_user_item=reserved_user_item,
                        replayed_user_message=replayed_user_message,
                        already_published=user_message_published,
                    )
                role = message_role(message)
                text = message_text(message)
                native_message_id = message_id(message)
                synthetic_control = is_synthetic_control_message(message)
                if (
                    role == "user"
                    and text
                    and native_message_id
                    and not synthetic_control
                ):
                    replayed_user_message = (native_message_id, text)
                    if response_external_session_confirmed:
                        user_message_published = (
                            await self.publish_replayed_user_message(
                                session=session,
                                turn_id=turn_id,
                                content=content,
                                attachments=attachment_mappings,
                                client_message_id=client_message_id,
                                reserved_user_item=reserved_user_item,
                                replayed_user_message=replayed_user_message,
                                already_published=user_message_published,
                            )
                        )
                stream_item = stream_accumulator.item_from_stream_event(
                    session=session,
                    turn_id=turn_id,
                    message=message,
                    projector=self.timeline,
                )
                terminal_message = terminal_event_from_message(message)
                tool_items = self.timeline.tool_items_for_message(
                    session=session,
                    turn_id=turn_id,
                    message=message,
                )
                system_items = self.timeline.system_items_for_message(
                    session=session,
                    turn_id=turn_id,
                    message=message,
                    event="claude.turn.system",
                )
                has_visible_message = (
                    not synthetic_control
                    and role in {"assistant", "system"}
                    and bool(text)
                )
                if not user_message_published and (
                    stream_item is not None
                    or terminal_message is not None
                    or bool(tool_items)
                    or bool(system_items)
                    or has_visible_message
                ):
                    await self.publish_fallback_user_message(
                        session=session,
                        turn_id=turn_id,
                        content=content,
                        attachments=attachment_mappings,
                        client_message_id=client_message_id,
                        reserved_user_item=reserved_user_item,
                    )
                    user_message_published = True
                if stream_item is not None:
                    await self.notifications.timeline_activity.timeline_item_upsert(
                        stream_item
                    )
                if is_stream_event(message):
                    continue
                if terminal_message is not None:
                    terminal = terminal_message
                    if not emitted_final_assistant_content:
                        text = message_text(message)
                        if text:
                            await self.notifications.timeline_activity.timeline_item_upsert(
                                self.timeline.message_item(
                                    session=session,
                                    turn_id=turn_id,
                                    role="assistant",
                                    text=text,
                                    event="claude.turn.result",
                                    native_item_id=message_id(message),
                                    item_id=stream_accumulator.final_item_id(
                                        session,
                                        turn_id,
                                    ),
                                    revision=stream_accumulator.next_final_revision(),
                                )
                            )
                            emitted_final_assistant_content = True
                            stream_accumulator.reset()
                    break
                for item in tool_items:
                    await self.notifications.timeline_activity.timeline_item_upsert(
                        item
                    )
                for item in system_items:
                    await self.notifications.timeline_activity.timeline_item_upsert(
                        item
                    )
                if synthetic_control:
                    continue
                if role not in {"assistant", "system"}:
                    continue
                if not text:
                    continue
                await self.notifications.timeline_activity.timeline_item_upsert(
                    self.timeline.message_item(
                        session=session,
                        turn_id=turn_id,
                        role=role,
                        text=text,
                        event=f"claude.turn.{role}",
                        native_item_id=message_id(message),
                        item_id=stream_accumulator.final_item_id(session, turn_id)
                        if role == "assistant"
                        else None,
                        revision=stream_accumulator.next_final_revision()
                        if role == "assistant"
                        else 1,
                    )
                )
                if role == "assistant":
                    emitted_final_assistant_content = True
                    stream_accumulator.reset()

            if terminal is None:
                terminal = failed_terminal_event(
                    code="claude_stream_ended_without_result",
                    message="Claude response stream ended without a terminal result",
                    reason="stream_exhausted",
                )
        except asyncio.CancelledError:
            terminal = interrupted_terminal_event(
                execution.interrupt_reason or "cancelled"
            )
        except Exception as exc:  # noqa: BLE001
            terminal = failed_terminal_event(
                code=exc.__class__.__name__,
                message=stderr.failure_message(exc),
            )
        finally:
            if execution.interrupt_source is not None:
                terminal = interrupted_terminal_event(execution.interrupt_reason)
            if reserved_user_item is not None and not user_message_published:
                try:
                    user_message_published = await self.publish_replayed_user_message(
                        session=session,
                        turn_id=turn_id,
                        content=content,
                        attachments=attachment_mappings,
                        client_message_id=client_message_id,
                        reserved_user_item=reserved_user_item,
                        replayed_user_message=replayed_user_message,
                        already_published=False,
                    )
                    if not user_message_published:
                        await self.publish_fallback_user_message(
                            session=session,
                            turn_id=turn_id,
                            content=content,
                            attachments=attachment_mappings,
                            client_message_id=client_message_id,
                            reserved_user_item=reserved_user_item,
                        )
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "Claude user message publish failed session_id={}",
                        session.session_id,
                    )
            reconciled = False
            if connection is not None and client is not None:
                if (
                    scheduled
                    and terminal is not None
                    and terminal.status == "completed"
                ):
                    connection.reconcile_needed = True
                if (
                    connection.reconcile_needed
                    and connection.retained
                    and not connection.reconciling
                    and connection.pending is None
                    and not connection.closing
                    and not self.stopping
                    and terminal is not None
                    and terminal.status == "completed"
                ):
                    try:
                        reconciled = await connection.reconcile_tasks(client)
                    except asyncio.CancelledError:
                        terminal = interrupted_terminal_event(
                            execution.interrupt_reason
                        )
            if connection is not None and (connection.retained or reconciled):
                try:
                    await self.scheduled_sessions.save(session, connection.task_ids)
                except Exception as exc:  # noqa: BLE001
                    terminal = failed_terminal_event(
                        code="claude_schedule_save_failed", message=str(exc)
                    )
            execution.client = None
            if terminal is None:
                terminal = failed_terminal_event(
                    code="claude_turn_missing_terminal_state",
                    message="Claude turn stopped without a terminal state",
                )
            try:
                await self.finish_execution(
                    session=session,
                    execution=execution,
                    terminal=terminal,
                    response=client,
                )
            finally:
                if connection is not None:
                    if terminal.status == "failed":
                        await connection.close()
                    else:
                        if not connection.retained and connection.pending is None:
                            await connection.close()
                        await self.refresh_idle_connection(session)

    async def publish_replayed_user_message(
        self,
        *,
        session: ClaudeSession,
        turn_id: str,
        content: str,
        attachments: tuple[dict[str, object], ...],
        client_message_id: str | None,
        reserved_user_item: RuntimeTimelineItem,
        replayed_user_message: tuple[str, str] | None,
        already_published: bool,
    ) -> bool:
        """Publish the live user item once Claude confirms its native identity."""

        if already_published:
            return True
        if session.external_session_id is None or replayed_user_message is None:
            return False
        native_message_id, text = replayed_user_message
        if not client_message_text_matches(text, content):
            return False
        item_id = stable_message_item_id(session, native_message_id)
        self.timeline.move_reserved_order(reserved_user_item.id, item_id)
        user_item = self.timeline.message_item(
            session=session,
            turn_id=turn_id,
            role="user",
            text=content,
            event="claude.turn.user",
            client_message_id=client_message_id,
            native_item_id=native_message_id,
            item_id=item_id,
            attachments=attachments,
        )
        await self.publish_user_message(
            session=session,
            item=user_item,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
            native_message_id=native_message_id,
        )
        return True

    async def publish_fallback_user_message(
        self,
        *,
        session: ClaudeSession,
        turn_id: str,
        content: str,
        attachments: tuple[dict[str, object], ...],
        client_message_id: str | None,
        reserved_user_item: RuntimeTimelineItem,
    ) -> None:
        """Publish the reserved ID when the SDK omits a replayed user UUID."""

        fallback_user_item = self.timeline.message_item(
            session=session,
            turn_id=turn_id,
            role="user",
            text=content,
            event="claude.turn.user",
            client_message_id=client_message_id,
            item_id=reserved_user_item.id,
            attachments=attachments,
        )
        await self.publish_user_message(
            session=session,
            item=fallback_user_item,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
            native_message_id=None,
        )

    async def publish_user_message(
        self,
        *,
        session: ClaudeSession,
        item: RuntimeTimelineItem,
        content: str,
        attachments: tuple[dict[str, object], ...],
        client_message_id: str | None,
        native_message_id: str | None,
    ) -> None:
        """Publish one user item and retain bounded history reconciliation data."""

        await self.notifications.timeline_activity.timeline_item_upsert(item)
        try:
            self.pending_messages.register_live_message(
                session_id=session.session_id,
                external_session_id=session.external_session_id,
                client_message_id=client_message_id,
                platform_item_id=item.id,
                text=content,
                attachments=attachments,
            )
            if native_message_id is None or session.external_session_id is None:
                return
            self.pending_messages.bind_live_native_message(
                session_id=session.session_id,
                external_session_id=session.external_session_id,
                client_message_id=client_message_id,
                native_message_id=native_message_id,
                text=content,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "Claude user message identity persistence failed session_id={}",
                session.session_id,
            )

    async def finish_execution(
        self,
        session: ClaudeSession,
        execution: ClaudeExecution,
        terminal: ClaudeTerminalEvent,
        response: ClaudeResponse | None = None,
    ) -> bool:
        """Publish one terminal state and release this exact execution."""

        async with execution.finalization_lock:
            if execution.finished.is_set():
                return False
            async with session.execution_lock:
                queued = session.queued_execution is execution
                if session.execution is not execution and not queued:
                    if response is not None:
                        response.release(interrupted=terminal.status == "interrupted")
                    execution.finished.set()
                    return False
                try:
                    if not queued:
                        await self.interactions.close_open_interaction_notices(
                            session,
                            status="closed",
                            reason=terminal.status,
                        )
                    await self.publish_terminal_state(
                        session, execution, terminal, update_state=not queued
                    )
                finally:
                    if response is not None:
                        response.release(interrupted=terminal.status == "interrupted")
                    if queued:
                        session.queued_execution = None
                    else:
                        session.execution = session.queued_execution
                        session.queued_execution = None
                    if not queued and session.execution is not None:
                        await self.notifications.session_state.session_state_update(
                            session,
                            "running",
                            metadata={"source": "claude.turn.running"},
                        )
                    execution.finished.set()
            return True

    async def publish_terminal_state(
        self,
        session: ClaudeSession,
        execution: ClaudeExecution,
        terminal: ClaudeTerminalEvent,
        *,
        update_state: bool = True,
    ) -> None:
        reason = terminal.reason or execution.interrupt_reason
        if terminal.status == "failed":
            metadata = {
                "source": "claude.turn.failed",
                **({"terminalReason": reason} if reason else {}),
            }
            await self.host.session_turn_ended(
                session_id=session.session_id,
                runtime="claude",
                external_session_id=session.external_session_id,
                turn_id=execution.turn_id,
                outcome="failed",
                metadata=metadata,
            )
            if not update_state:
                return
            await self.notifications.session_state.session_state_update(
                session,
                "error",
                error={
                    "code": terminal.error_code or "claude_turn_failed",
                    "message": terminal.error_message or "Claude turn failed",
                },
                metadata=metadata,
            )
            return
        source = "claude.turn.completed"
        if terminal.status == "interrupted":
            source = execution.interrupt_source or "claude.turn.interrupted"
        metadata = {
            "source": source,
            **({"terminalReason": reason} if reason else {}),
        }
        await self.host.session_turn_ended(
            session_id=session.session_id,
            runtime="claude",
            external_session_id=session.external_session_id,
            turn_id=execution.turn_id,
            outcome=terminal.status,
            metadata=metadata,
        )
        if not update_state:
            return
        await self.notifications.session_state.session_state_update(
            session,
            "idle",
            metadata=metadata,
        )

    async def _update_external_session_id(
        self,
        session: ClaudeSession,
        external_session_id: str,
    ) -> None:
        if not self.session_store.update_external_session_id(
            session,
            external_session_id,
        ):
            return
        self.pending_messages.bind_external_session(
            session.session_id,
            external_session_id,
        )
        await self.notifications.session_state.session_meta_upsert(
            session,
            source="claude.session.external_id",
        )
