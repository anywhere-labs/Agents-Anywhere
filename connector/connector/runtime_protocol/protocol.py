from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol.errors import RuntimeUnsupportedError
from connector.runtime_protocol.models import (
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
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionNotice,
    SessionState,
)


class AgentRuntime(ABC):
    """Connector -> Runtime."""

    @property
    @abstractmethod
    def identity(self) -> RuntimeIdentity:
        raise NotImplementedError

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def get_config(self) -> RuntimeConfig:
        raise RuntimeUnsupportedError("get_config")

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return RuntimeCapabilitySet(
            runtime=self.identity.runtime,
            revision=0,
            capabilities=(),
            metadata={"source": "runtime.default-empty-capabilities"},
        )

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        raise RuntimeUnsupportedError("list_model_catalog")

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        raise RuntimeUnsupportedError("list_permission_catalog")

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        raise RuntimeUnsupportedError("list_sessions")

    async def list_complete_session_inventory(
        self,
        page_size: int = 100,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        raise RuntimeUnsupportedError("list_complete_session_inventory")

    def supports_complete_session_inventory(self) -> bool:
        return (
            type(self).list_complete_session_inventory
            is not AgentRuntime.list_complete_session_inventory
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        raise RuntimeUnsupportedError("get_session_snapshot")

    async def sync_session_timeline(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> bool:
        """Let runtimes override background scanner timeline sync.

        Return True when the runtime published or intentionally skipped timeline
        updates. Return False to let the connector publish get_session_snapshot().
        """
        _ = session_id, external_session_id
        return False

    async def prepare_session_timeline_sync(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> PreparedSessionTimelineSync | None:
        _ = session_id, external_session_id
        return None

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        return None

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        return ()

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        return RuntimeCapabilitySet(
            runtime=self.identity.runtime,
            revision=0,
            capabilities=(),
            session_id=session_id,
            metadata={
                "source": "runtime.default-empty-capabilities",
                "external_session_id": external_session_id,
            },
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
        raise RuntimeUnsupportedError("create_and_start_session")

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
        raise RuntimeUnsupportedError("start_turn")

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("steer_turn")

    async def interrupt_session(
        self,
        session_id: str,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("interrupt_session")

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("update_session_selections")

    async def list_commands(
        self,
        session_id: str,
        external_session_id: str | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RuntimeCommand, ...]:
        return ()

    async def list_runtime_commands(
        self,
        limit: int = 100,
    ) -> tuple[RuntimeCommand, ...]:
        return ()

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        raise RuntimeUnsupportedError("execute_command")

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("respond_interaction")
