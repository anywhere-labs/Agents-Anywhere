from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import RuntimeAttachment, RuntimeConfig
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.domain.session import ClaudeSession
from connector.runtimes.claude.history.syncer import ClaudeHistorySyncer
from connector.runtimes.claude.notifications.projector import ClaudeNotificationProjector
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
from connector.runtimes.claude.sdk.stderr import ClaudeStderrBuffer
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore
from connector.runtimes.claude.timeline.messages import (
    ClaudeMessageProjector,
    is_result_message,
    message_error_text,
    message_id,
    message_is_error,
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
    history_syncer: ClaudeHistorySyncer
    timeline: ClaudeMessageProjector
    notifications: ClaudeNotificationProjector
    interactions: ClaudeInteractionController
    sdk_loader: SdkLoader | None = None
    client_factory: ClaudeClientFactory | None = None

    async def drive_turn(
        self,
        session: ClaudeSession,
        turn_id: str,
        content: str,
        attachments: tuple[RuntimeAttachment, ...],
        client_message_id: str | None,
    ) -> None:
        stderr = ClaudeStderrBuffer(session.session_id)
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
            session.client = client
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
                metadata={"source": "claude.turn.running", "turnId": turn_id},
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

            result_error: Mapping[str, Any] | None = None
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
                if is_result_message(message):
                    if message_is_error(message):
                        result_error = {
                            "code": "claude_result_error",
                            "message": message_error_text(message)
                            or "Claude turn completed with an error",
                        }
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
                    continue
                for item in self.timeline.tool_items_for_message(
                    session=session,
                    turn_id=turn_id,
                    message=message,
                ):
                    await self.notifications.timeline_activity.timeline_item_upsert(
                        item
                    )
                if message_role(message) != "assistant":
                    continue
                text = message_text(message)
                if not text:
                    continue
                await self.notifications.timeline_activity.timeline_item_upsert(
                    self.timeline.message_item(
                        session=session,
                        turn_id=turn_id,
                        role="assistant",
                        text=text,
                        event="claude.turn.assistant",
                        native_item_id=message_id(message),
                        item_id=stream_accumulator.final_item_id(session, turn_id),
                        revision=stream_accumulator.next_final_revision(),
                    )
                )
                emitted_final_assistant_content = True
                stream_accumulator.reset()

            if result_error is not None:
                self._release_active_turn(session, turn_id)
                await self.notifications.session_state.session_state_update(
                    session,
                    "blocked",
                    error=result_error,
                    metadata={"source": "claude.turn.failed", "turnId": turn_id},
                )
            else:
                consumed = await self.history_syncer.mark_session_consumed(session)
                if consumed:
                    self._release_active_turn(session, turn_id)
                await self.notifications.session_state.session_state_update(
                    session,
                    "idle",
                    metadata={"source": "claude.turn.completed", "turnId": turn_id},
                )
        except asyncio.CancelledError:
            await self.interactions.close_open_approval_notices(
                session,
                status="closed",
                reason="cancelled",
            )
            self._release_active_turn(session, turn_id)
            await self.notifications.session_state.session_state_update(
                session,
                "idle",
                metadata={"source": "claude.turn.cancelled", "turnId": turn_id},
            )
        except Exception as exc:  # noqa: BLE001
            self._release_active_turn(session, turn_id)
            await self.notifications.session_state.session_state_update(
                session,
                "blocked",
                error={
                    "code": exc.__class__.__name__,
                    "message": stderr.failure_message(exc),
                },
                metadata={"source": "claude.turn.failed", "turnId": turn_id},
            )
        finally:
            await disconnect_client(session.client)
            session.client = None

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

    def _release_active_turn(self, session: ClaudeSession, turn_id: str) -> None:
        session.clear_active_turn(turn_id)
