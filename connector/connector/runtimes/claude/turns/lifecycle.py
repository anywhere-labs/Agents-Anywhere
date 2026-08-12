from __future__ import annotations

import asyncio
from dataclasses import dataclass

from connector.logging import logger
from connector.runtime_protocol import RuntimeAttachment, RuntimeConfig
from connector.runtime_protocol.host import RuntimeHostClient
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
from connector.runtimes.claude.sdk.stderr import ClaudeStderrBuffer
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore
from connector.runtimes.claude.timeline.messages import (
    ClaudeMessageProjector,
    message_id,
    message_role,
    message_session_id,
    message_text,
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
        terminal: ClaudeTerminalEvent | None = None
        try:
            sdk = load_sdk(self.sdk_loader)
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
            await self.notifications.timeline_activity.timeline_item_upsert(
                self.timeline.message_item(
                    session=session,
                    turn_id=turn_id,
                    role="user",
                    text=content,
                    event="claude.turn.user",
                    client_message_id=client_message_id,
                    attachments=tuple(
                        attachment.to_mapping()
                        for attachment in materialized_attachments
                    ),
                )
            )
            await query_client(client, effective_content)

            emitted_final_assistant_content = False
            stream_accumulator = ClaudeStreamAccumulator()
            async for message in receive_response_messages(client):
                external_session_id = message_session_id(message)
                if external_session_id is not None:
                    await self._update_external_session_id(session, external_session_id)
                stream_item = stream_accumulator.item_from_stream_event(
                    session=session,
                    turn_id=turn_id,
                    message=message,
                    projector=self.timeline,
                )
                if stream_item is not None:
                    await self.notifications.timeline_activity.timeline_item_upsert(
                        stream_item
                    )
                if is_stream_event(message):
                    continue
                terminal_message = terminal_event_from_message(message)
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
                for item in self.timeline.tool_items_for_message(
                    session=session,
                    turn_id=turn_id,
                    message=message,
                ):
                    await self.notifications.timeline_activity.timeline_item_upsert(
                        item
                    )
                for item in self.timeline.system_items_for_message(
                    session=session,
                    turn_id=turn_id,
                    message=message,
                    event="claude.turn.system",
                ):
                    await self.notifications.timeline_activity.timeline_item_upsert(
                        item
                    )
                role = message_role(message)
                if role not in {"assistant", "system"}:
                    continue
                text = message_text(message)
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
            try:
                await disconnect_client(client)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Claude SDK disconnect failed session_id={}",
                    session.session_id,
                )
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
                    await self.interactions.close_open_approval_notices(
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
            await self.notifications.session_state.session_state_update(
                session,
                "error",
                error={
                    "code": terminal.error_code or "claude_turn_failed",
                    "message": terminal.error_message or "Claude turn failed",
                },
                metadata={
                    "source": "claude.turn.failed",
                    **({"terminalReason": reason} if reason else {}),
                },
            )
            return
        source = "claude.turn.completed"
        if terminal.status == "interrupted":
            source = execution.interrupt_source or "claude.turn.interrupted"
        await self.notifications.session_state.session_state_update(
            session,
            "idle",
            metadata={
                "source": source,
                **({"terminalReason": reason} if reason else {}),
            },
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
        await self.notifications.session_state.session_meta_upsert(
            session,
            source="claude.session.external_id",
        )
