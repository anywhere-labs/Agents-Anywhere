from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeConfig,
    RuntimeOperationResult,
    RuntimeSessionStateCache,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.catalogs.reader import ClaudeCatalogReader
from connector.runtimes.claude.domain.pending_messages import (
    ClaudePendingClientMessageRegistry,
)
from connector.runtimes.claude.history.syncer import ClaudeHistorySyncer
from connector.runtimes.claude.notifications.notices import ClaudeNoticeRegistry
from connector.runtimes.claude.notifications.projector import (
    ClaudeNotificationProjector,
)
from connector.runtimes.claude.sdk.client import ClaudeClientFactory, SdkLoader
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore
from connector.runtimes.claude.sessions.reader import ClaudeSessionReader
from connector.runtimes.claude.timeline.messages import ClaudeMessageProjector
from connector.runtimes.claude.turns.actions import ClaudeTurnActionHandler
from connector.runtimes.claude.turns.interactions import ClaudeInteractionController
from connector.runtimes.claude.turns.lifecycle import ClaudeTurnRunner
from connector.runtimes.claude.turns.selections import ClaudeSelectionController
from connector.runtimes.claude.turns.session_start import ClaudeSessionStartHandler


@dataclass(slots=True)
class ClaudeTurnController:
    config: RuntimeConfig
    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    session_store: ClaudeSessionStore
    session_reader: ClaudeSessionReader
    history_syncer: ClaudeHistorySyncer
    catalogs: ClaudeCatalogReader
    timeline: ClaudeMessageProjector
    notices: ClaudeNoticeRegistry
    notifications: ClaudeNotificationProjector
    pending_messages: ClaudePendingClientMessageRegistry
    sdk_loader: SdkLoader | None = None
    client_factory: ClaudeClientFactory | None = None
    interactions: ClaudeInteractionController = field(init=False)
    selections: ClaudeSelectionController = field(init=False)
    runner: ClaudeTurnRunner = field(init=False)
    actions: ClaudeTurnActionHandler = field(init=False)
    session_start: ClaudeSessionStartHandler = field(init=False)

    def __post_init__(self) -> None:
        self.interactions = ClaudeInteractionController(
            session_store=self.session_store,
            notices=self.notices,
            notifications=self.notifications,
            has_active_turn=self.has_active_turn,
        )
        self.selections = ClaudeSelectionController(
            session_states=self.session_states,
            session_store=self.session_store,
            catalogs=self.catalogs,
            notifications=self.notifications,
        )
        self.runner = ClaudeTurnRunner(
            config=self.config,
            host=self.host,
            session_store=self.session_store,
            timeline=self.timeline,
            notifications=self.notifications,
            interactions=self.interactions,
            pending_messages=self.pending_messages,
            sdk_loader=self.sdk_loader,
            client_factory=self.client_factory,
        )
        self.actions = ClaudeTurnActionHandler(
            session_states=self.session_states,
            session_store=self.session_store,
            notifications=self.notifications,
            selections=self.selections,
            interactions=self.interactions,
            runner=self.runner,
        )
        self.session_start = ClaudeSessionStartHandler(
            session_store=self.session_store,
            notifications=self.notifications,
            actions=self.actions,
        )

    async def stop(self) -> None:
        await self.actions.stop()

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
        return await self.session_start.create_and_start_session(
            session_id=session_id,
            content=content,
            title=title,
            cwd=cwd,
            selections=selections,
            attachments=attachments,
            client_message_id=client_message_id,
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        return await self.actions.start_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            content=content,
            selections=selections,
            attachments=attachments,
            client_message_id=client_message_id,
            cwd=cwd,
        )

    async def interrupt_session(
        self,
        session_id: str,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        return await self.actions.interrupt_session(
            session_id=session_id,
            reason=reason,
        )

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        return await self.selections.update_session_selections(
            session_id=session_id,
            external_session_id=external_session_id,
            selections=selections,
        )

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        return await self.interactions.respond_interaction(
            session_id=session_id,
            notice_id=notice_id,
            action_id=action_id,
            input_data=input_data,
        )

    def has_active_turn(self, session_id: str) -> bool:
        return self.actions.has_active_turn(session_id)
