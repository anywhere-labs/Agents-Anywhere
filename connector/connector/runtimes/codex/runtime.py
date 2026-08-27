from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from connector.core.json_kv import JsonKeyValueStore
from connector.runtime_protocol import (
    AgentRuntime,
    PreparedSessionTimelineSync,
    RuntimeAttachment,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeSessionStateCache,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.catalogs.reader import CodexCatalogReader
from connector.runtimes.codex.domain.capabilities import (
    codex_capability_context,
    codex_runtime_capabilities,
    codex_session_capabilities,
)
from connector.runtimes.codex.domain.commands import list_codex_commands
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.lifecycle.runtime_lifecycle import CodexRuntimeLifecycle
from connector.runtimes.codex.notifications import CodexNotificationProjector
from connector.runtimes.codex.sdk.runtime_client import (
    CodexModelListResult,
    CodexRuntimeClient,
)
from connector.runtimes.codex.sessions.reader import CodexSessionReader
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator
from connector.runtimes.codex.turns.controller import CodexTurnController


@dataclass(slots=True)
class CodexRuntime(AgentRuntime):
    config: RuntimeConfig
    host: RuntimeHostClient
    client: CodexRuntimeClient | None = None
    client_message_kv: JsonKeyValueStore | None = None
    runtime_version: str = "native-0"

    def __post_init__(self) -> None:
        self._active_turn_ids: dict[str, str] = {}
        self._session_states = RuntimeSessionStateCache(
            "codex",
            self.host,
            on_state_updated=self.publish_session_capabilities_for_state,
        )
        self._notices = CodexNoticeRegistry()
        self._pending_messages = PendingClientMessageRegistry(
            connector_id=self.host.connector_id,
            kv_store=self.client_message_kv,
        )
        self._timeline = CodexTimelineAccumulator(
            pending_messages=self._pending_messages,
        )
        self._notifications = CodexNotificationProjector(
            host=self.host,
            session_states=self._session_states,
            active_turn_ids=self._active_turn_ids,
            timeline=self._timeline,
            notices=self._notices,
        )
        self._lifecycle = CodexRuntimeLifecycle(
            client=self.client,
            notifications=self._notifications,
        )
        self._catalogs = CodexCatalogReader(
            config=self.config,
            ensure_started=self.start,
            get_model_list_result=self._get_model_list_result,
        )
        self._session_reader = CodexSessionReader(
            host=self.host,
            client=self.client,
            session_states=self._session_states,
            ensure_started=self.start,
            list_model_catalog=self._catalogs.list_model_catalog,
            list_permission_catalog=self._catalogs.list_permission_catalog,
            pending_messages=self._pending_messages,
            timeline=self._timeline,
        )
        self._turns = CodexTurnController(
            host=self.host,
            client=self.client,
            session_states=self._session_states,
            active_turn_ids=self._active_turn_ids,
            notices=self._notices,
            ensure_started=self.start,
            list_model_catalog=self._catalogs.list_model_catalog,
            list_permission_catalog=self._catalogs.list_permission_catalog,
            pending_messages=self._pending_messages,
            timeline=self._timeline,
        )

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="codex",
            runtime_version=self.runtime_version,
            display_name="Codex",
        )

    async def start(self) -> None:
        await self._lifecycle.start()

    async def stop(self) -> None:
        await self._lifecycle.stop()

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        context = codex_capability_context(
            connector_id=self.host.connector_id,
            revision=self.config.revision,
            client_available=self.client is not None,
        )
        return codex_runtime_capabilities(context)

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        return await self._catalogs.list_model_catalog(query=query, limit=limit)

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        return await self._catalogs.list_permission_catalog(query=query, limit=limit)

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        return await self._session_reader.list_sessions(limit, cursor, force)

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        return await self._session_reader.get_session_state(
            session_id,
            external_session_id,
        )

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        _ = external_session_id
        return self._notices.current_for_session(session_id)

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        state = await self.get_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
        )
        context = codex_capability_context(
            connector_id=self.host.connector_id,
            revision=self.config.revision,
            client_available=self.client is not None,
            session_id=session_id,
            external_session_id=external_session_id,
            state=state,
            has_active_turn=session_id in self._active_turn_ids,
        )
        return codex_session_capabilities(context)

    async def publish_runtime_capabilities(self) -> None:
        """Publish current runtime-scoped capabilities.

        Side effects:
        - sends a runtime capability update through the host client
        """

        await self.host.runtime_capabilities_update(
            await self.get_runtime_capabilities()
        )

    async def publish_session_capabilities_for_state(
        self,
        state: SessionState,
    ) -> None:
        """Publish session-scoped capabilities after a state transition.

        Side effects:
        - sends a session capability update through the host client
        """

        context = codex_capability_context(
            connector_id=self.host.connector_id,
            revision=self.config.revision,
            client_available=self.client is not None,
            session_id=state.session_id,
            external_session_id=state.external_session_id,
            state=state,
            has_active_turn=state.session_id in self._active_turn_ids,
        )
        await self.host.session_capabilities_update(
            codex_session_capabilities(context)
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        return await self._session_reader.get_session_snapshot(
            session_id,
            external_session_id,
            limit,
        )

    async def prepare_session_timeline_sync(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> PreparedSessionTimelineSync | None:
        return await self._session_reader.prepare_session_timeline_sync(
            session_id,
            external_session_id,
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
        runtime_options: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        _ = runtime_options
        return await self._turns.create_and_start_session(
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
        _ = cwd
        return await self._turns.start_turn(
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
        return await self._turns.steer_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
        )

    async def interrupt_session(
        self,
        session_id: str,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        return await self._turns.interrupt_session(
            session_id=session_id,
            reason=reason,
        )

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        return await self._turns.update_session_selections(
            session_id=session_id,
            external_session_id=external_session_id,
            selections=selections,
        )

    async def list_commands(
        self,
        session_id: str,
        external_session_id: str | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RuntimeCommand, ...]:
        _ = session_id
        return list_codex_commands(
            external_session_id=external_session_id,
            client_available=self.client is not None,
            query=query,
            limit=limit,
        )

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        return await self._turns.execute_command(
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
        return await self._turns.respond_interaction(
            session_id=session_id,
            notice_id=notice_id,
            action_id=action_id,
            input_data=input_data,
        )

    async def _handle_notification(self, message: Any) -> None:
        await self._lifecycle.handle_notification(message)

    def _get_model_list_result(self) -> CodexModelListResult | None:
        return self._lifecycle.model_list_result
