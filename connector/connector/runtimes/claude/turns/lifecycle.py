from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import RuntimeAttachment, RuntimeConfig
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.domain.session import ClaudeSession
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
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore
from connector.runtimes.claude.sessions.reader import ClaudeSessionReader
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
    session_reader: ClaudeSessionReader
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
            async for message in receive_response_messages(client):
                external_session_id = message_session_id(message)
                if external_session_id is not None:
                    await self._update_external_session_id(session, external_session_id)
                if is_result_message(message):
                    if message_is_error(message):
                        result_error = {
                            "code": "claude_result_error",
                            "message": message_error_text(message)
                            or "Claude turn completed with an error",
                        }
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
                    )
                )

            if result_error is not None:
                await self.notifications.session_state.session_state_update(
                    session,
                    "blocked",
                    error=result_error,
                    metadata={"source": "claude.turn.failed", "turnId": turn_id},
                )
            else:
                await self._sync_completed_turn_history(session)
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
            await self.notifications.session_state.session_state_update(
                session,
                "idle",
                metadata={"source": "claude.turn.cancelled", "turnId": turn_id},
            )
        except Exception as exc:  # noqa: BLE001
            await self.notifications.session_state.session_state_update(
                session,
                "blocked",
                error={
                    "code": exc.__class__.__name__,
                    "message": str(exc) or exc.__class__.__name__,
                },
                metadata={"source": "claude.turn.failed", "turnId": turn_id},
            )
        finally:
            await disconnect_client(session.client)
            session.client = None
            if session.active_turn_id == turn_id:
                session.active_turn_id = None

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

    async def _sync_completed_turn_history(self, session: ClaudeSession) -> None:
        if session.external_session_id is None:
            return
        snapshot = await self.session_reader.get_session_snapshot(
            session.session_id,
            session.external_session_id,
        )
        if not snapshot.complete and not snapshot.items:
            return
        await self.notifications.timeline_activity.timeline_sync(
            snapshot,
            source="claude.turn.history_sync",
        )
