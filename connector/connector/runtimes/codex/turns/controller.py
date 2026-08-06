from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeCommandResult,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeSessionStateCache,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.sdk.runtime_client import CodexRuntimeClient
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator
from connector.runtimes.codex.turns.actions import CodexTurnActions
from connector.runtimes.codex.turns.commands import CodexCommandController
from connector.runtimes.codex.turns.interactions import CodexInteractionController
from connector.runtimes.codex.turns.selections import CodexSelectionController
from connector.runtimes.codex.turns.session_start import CodexSessionStartController

EnsureStarted = Callable[[], Awaitable[None]]
ListModelCatalog = Callable[[str | None, int], Awaitable[RuntimeModelCatalog]]
ListPermissionCatalog = Callable[[str | None, int], Awaitable[RuntimePermissionCatalog]]


@dataclass(slots=True)
class CodexTurnController:
    host: RuntimeHostClient
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    notices: CodexNoticeRegistry
    ensure_started: EnsureStarted
    list_model_catalog: ListModelCatalog
    list_permission_catalog: ListPermissionCatalog
    pending_messages: PendingClientMessageRegistry
    timeline: CodexTimelineAccumulator
    actions: CodexTurnActions = field(init=False)
    commands: CodexCommandController = field(init=False)
    interactions: CodexInteractionController = field(init=False)
    selections: CodexSelectionController = field(init=False)
    session_starter: CodexSessionStartController = field(init=False)

    def __post_init__(self) -> None:
        self.actions = CodexTurnActions(
            host=self.host,
            client=self.client,
            session_states=self.session_states,
            active_turn_ids=self.active_turn_ids,
            notices=self.notices,
            ensure_started=self.ensure_started,
            pending_messages=self.pending_messages,
            list_model_catalog=self.list_model_catalog,
            list_permission_catalog=self.list_permission_catalog,
        )
        self.commands = CodexCommandController(
            host=self.host,
            client=self.client,
            session_states=self.session_states,
            ensure_started=self.ensure_started,
        )
        self.interactions = CodexInteractionController(
            host=self.host,
            client=self.client,
            session_states=self.session_states,
            active_turn_ids=self.active_turn_ids,
            notices=self.notices,
            ensure_started=self.ensure_started,
        )
        self.selections = CodexSelectionController(
            client=self.client,
            session_states=self.session_states,
            ensure_started=self.ensure_started,
            list_model_catalog=self.list_model_catalog,
            list_permission_catalog=self.list_permission_catalog,
        )
        self.session_starter = CodexSessionStartController(
            host=self.host,
            client=self.client,
            session_states=self.session_states,
            ensure_started=self.ensure_started,
            list_model_catalog=self.list_model_catalog,
            list_permission_catalog=self.list_permission_catalog,
            turn_actions=self.actions,
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
        return await self.session_starter.create_and_start_session(
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
    ) -> RuntimeOperationResult:
        return await self.actions.start_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            content=content,
            selections=selections,
            attachments=attachments,
            client_message_id=client_message_id,
        )

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        return await self.actions.steer_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
        )

    async def interrupt_turn(
        self,
        session_id: str,
        external_session_id: str | None = None,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        return await self.actions.interrupt_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            reason=reason,
        )

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        return await self.commands.execute_command(
            session_id=session_id,
            command=command,
            external_session_id=external_session_id,
            raw=raw,
            args=args,
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
