from __future__ import annotations

import asyncio
from dataclasses import dataclass

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
    disconnect_client,
    load_sdk,
    new_sdk_client,
    query_client,
    receive_response_messages,
)
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

    async def drive_turn(
        self,
        session: ClaudeSession,
        execution: ClaudeExecution,
        content: str,
        attachments: tuple[RuntimeAttachment, ...],
        client_message_id: str | None,
    ) -> None:
        turn_id = execution.turn_id
        stderr = ClaudeStderrBuffer(session.session_id)
        client: object | None = None
        settings_path: str | None = None
        terminal: ClaudeTerminalEvent | None = None
        reserved_user_item = None
        attachment_mappings: tuple[dict[str, object], ...] = ()
        replayed_user_message: tuple[str, str] | None = None
        response_external_session_confirmed = False
        user_message_published = False
        try:
            sdk = load_sdk(self.sdk_loader)
            settings_path = create_gateway_settings_file(self.config.values)
            client = new_sdk_client(
                sdk=sdk,
                config_values=self.config.values,
                session=session,
                client_factory=self.client_factory,
                can_use_tool=self.interactions.approval_callback(
                    sdk,
                    session,
                    turn_id,
                ),
                stderr=stderr.record,
                settings_path=settings_path,
            )
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
            await self.notifications.session_state.session_state_update(
                session,
                "running",
                metadata={"source": "claude.turn.running"},
            )
            attachment_mappings = tuple(
                attachment.to_mapping() for attachment in materialized_attachments
            )
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
            assert reserved_user_item is not None
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
            try:
                await disconnect_client(client)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Claude SDK disconnect failed session_id={}",
                    session.session_id,
                )
            remove_gateway_settings_file(settings_path)
            execution.client = None
            if terminal is None:
                terminal = failed_terminal_event(
                    code="claude_turn_missing_terminal_state",
                    message="Claude turn stopped without a terminal state",
                )
            await self.finish_execution(
                session=session,
                execution=execution,
                terminal=terminal,
            )

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
    ) -> bool:
        """Publish one terminal state and release this exact execution."""

        async with execution.finalization_lock:
            if execution.finished.is_set():
                return False
            async with session.execution_lock:
                if session.execution is not execution:
                    execution.finished.set()
                    return False
                try:
                    await self.interactions.close_open_interaction_notices(
                        session,
                        status="closed",
                        reason=terminal.status,
                    )
                    await self.publish_terminal_state(session, execution, terminal)
                finally:
                    session.execution = None
                    execution.finished.set()
            return True

    async def publish_terminal_state(
        self,
        session: ClaudeSession,
        execution: ClaudeExecution,
        terminal: ClaudeTerminalEvent,
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
