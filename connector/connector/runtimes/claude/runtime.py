from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.core.json_kv import JsonKeyValueStore
from connector.runtime_protocol import (
    AgentRuntime,
    PreparedSessionTimelineSync,
    RuntimeAttachment,
    RuntimeCapabilitySet,
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
from connector.runtimes.claude.catalogs.reader import ClaudeCatalogReader
from connector.runtimes.claude.domain.capabilities import (
    ClaudeCapabilityContext,
    claude_runtime_capabilities,
    claude_session_capabilities,
)
from connector.runtimes.claude.domain.pending_messages import (
    ClaudePendingClientMessageRegistry,
)
from connector.runtimes.claude.domain.session import ClaudeSession
from connector.runtimes.claude.history.state import ClaudeHistoryCursorStore
from connector.runtimes.claude.history.syncer import ClaudeHistorySyncer
from connector.runtimes.claude.notifications.notices import ClaudeNoticeRegistry
from connector.runtimes.claude.notifications.projector import (
    ClaudeNotificationProjector,
)
from connector.runtimes.claude.sdk.client import (
    ClaudeClientFactory,
    SdkLoader,
)
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore
from connector.runtimes.claude.sessions.reader import ClaudeSessionReader
from connector.runtimes.claude.sessions.sync_state import ClaudeSessionSyncStateStore
from connector.runtimes.claude.timeline.messages import ClaudeMessageProjector
from connector.runtimes.claude.turns.controller import ClaudeTurnController


@dataclass(slots=True)
class ClaudeRuntime(AgentRuntime):
    config: RuntimeConfig
    host: RuntimeHostClient
    sdk_loader: SdkLoader | None = None
    client_factory: ClaudeClientFactory | None = None
    client_message_kv: JsonKeyValueStore | None = None
    runtime_version: str = "native-0"
    _sessions: dict[str, ClaudeSession] = field(default_factory=dict, init=False)
    _session_states: RuntimeSessionStateCache = field(init=False)
    _session_store: ClaudeSessionStore = field(init=False)
    _session_reader: ClaudeSessionReader = field(init=False)
    _session_sync_states: ClaudeSessionSyncStateStore = field(init=False)
    _pending_messages: ClaudePendingClientMessageRegistry = field(init=False)
    _history_syncer: ClaudeHistorySyncer = field(init=False)
    _catalogs: ClaudeCatalogReader = field(init=False)
    _timeline: ClaudeMessageProjector = field(init=False)
    _notices: ClaudeNoticeRegistry = field(init=False)
    _notifications: ClaudeNotificationProjector = field(init=False)
    _turns: ClaudeTurnController = field(init=False)

    def __post_init__(self) -> None:
        self._session_states = RuntimeSessionStateCache(
            "claude",
            self.host,
            on_state_updated=self.publish_session_capabilities_for_state,
        )
        self._session_store = ClaudeSessionStore(self._sessions)
        self._session_sync_states = ClaudeSessionSyncStateStore(self.host)
        self._pending_messages = ClaudePendingClientMessageRegistry(
            connector_id=self.host.connector_id,
            kv_store=self.client_message_kv,
        )
        self._catalogs = ClaudeCatalogReader(config=self.config)
        self._session_reader = ClaudeSessionReader(
            config=self.config,
            host=self.host,
            session_store=self._session_store,
            sdk_loader=self.sdk_loader,
            sync_states=self._session_sync_states,
            pending_messages=self._pending_messages,
        )
        self._history_syncer = ClaudeHistorySyncer(
            config=self.config,
            host=self.host,
            session_store=self._session_store,
            sdk_loader=self.sdk_loader,
            cursor_store=ClaudeHistoryCursorStore(self.host),
            sync_states=self._session_sync_states,
            pending_messages=self._pending_messages,
        )
        self._timeline = ClaudeMessageProjector()
        self._notices = ClaudeNoticeRegistry()
        self._notifications = ClaudeNotificationProjector(
            host=self.host,
            session_states=self._session_states,
            session_store=self._session_store,
            notices=self._notices,
        )
        self._turns = ClaudeTurnController(
            config=self.config,
            host=self.host,
            session_states=self._session_states,
            session_store=self._session_store,
            session_reader=self._session_reader,
            history_syncer=self._history_syncer,
            catalogs=self._catalogs,
            timeline=self._timeline,
            notices=self._notices,
            notifications=self._notifications,
            pending_messages=self._pending_messages,
            sdk_loader=self.sdk_loader,
            client_factory=self.client_factory,
        )

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="claude",
            runtime_version=self.runtime_version,
            display_name="Claude",
        )

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        await self._turns.stop()

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return claude_runtime_capabilities(
            ClaudeCapabilityContext(
                connector_id=self.host.connector_id,
                revision=self.config.revision,
            )
        )

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

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        state = self._session_states.get(session_id)
        if state is not None:
            return state
        if external_session_id is not None:
            state = self._session_states.get_by_external_session_id(external_session_id)
            if state is not None:
                return state
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
        state = await self.get_session_state(session_id, external_session_id)
        return claude_session_capabilities(
            ClaudeCapabilityContext(
                connector_id=self.host.connector_id,
                revision=self.config.revision,
                session_id=session_id,
                has_active_turn=claude_state_has_active_execution(state),
            )
        )

    async def publish_session_capabilities_for_state(
        self,
        state: SessionState,
    ) -> None:
        """Publish session capabilities after a Claude state transition."""

        await self.host.session_capabilities_update(
            claude_session_capabilities(
                ClaudeCapabilityContext(
                    connector_id=self.host.connector_id,
                    revision=self.config.revision,
                    session_id=state.session_id,
                    has_active_turn=claude_state_has_active_execution(state),
                )
            )
        )

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        return await self._session_reader.list_sessions(
            limit=limit,
            cursor=cursor,
            force=force,
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        return await self._session_reader.get_session_snapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            limit=limit,
        )

    async def sync_session_timeline(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> bool:
        return await self._history_syncer.sync_session_timeline(
            session_id=session_id,
            external_session_id=external_session_id,
        )

    async def prepare_session_timeline_sync(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> PreparedSessionTimelineSync | None:
        return await self._history_syncer.prepare_session_timeline_sync(
            session_id=session_id,
            external_session_id=external_session_id,
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
        return await self._turns.start_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            content=content,
            selections=selections,
            attachments=attachments,
            client_message_id=client_message_id,
            cwd=cwd,
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

    async def interrupt_session(
        self,
        session_id: str,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        return await self._turns.interrupt_session(
            session_id=session_id,
            reason=reason,
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


def claude_state_has_active_execution(state: SessionState | None) -> bool:
    if state is None:
        return False
    return state.status in {
        "waiting",
        "pending",
        "running",
        "stopping",
        "waiting_approval",
        "blocked",
    }
