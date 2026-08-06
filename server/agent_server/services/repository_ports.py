from __future__ import annotations

from typing import Any, Protocol

from agent_server.core.catalogs import CatalogType, CatalogUpdateOutcome
from agent_server.core.models import (
    ConnectorView,
    SessionRuntimeState,
    SessionStatus,
    SessionView,
    TimelineItem,
    TimelineItemIn,
)


class SessionLookupRepository(Protocol):
    async def get_session(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> SessionView: ...


class DashboardEventRepository(SessionLookupRepository, Protocol):
    async def get_connector(self, connector_id: str) -> ConnectorView: ...


class CatalogRepository(Protocol):
    async def get_protocol_catalog(
        self,
        connector_id: str,
        *,
        runtime: str,
        catalog_type: CatalogType,
        user_id: str | None = None,
    ) -> dict[str, Any] | None: ...

    async def update_protocol_catalog(
        self,
        connector_id: str,
        *,
        runtime: str,
        catalog_type: CatalogType,
        revision: int,
        catalog: dict[str, Any],
    ) -> CatalogUpdateOutcome: ...


class SessionStateRepository(SessionLookupRepository, Protocol):
    async def get_active_run(self, session_id: str) -> dict[str, Any] | None: ...

    async def has_active_timeline_item(self, session_id: str) -> bool: ...

    async def get_open_turn_id(self, session_id: str) -> str | None: ...

    async def set_session_status(
        self,
        session_id: str,
        status: SessionStatus,
        *,
        expected_status: SessionStatus | None = None,
    ) -> SessionView: ...

    async def get_session_runtime_state(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> SessionRuntimeState: ...

    async def upsert_session_runtime_state(
        self,
        *,
        session_id: str,
        runtime: str,
        external_session_id: str | None = None,
        status: str | None = None,
        selections: dict[str, str | None] | None = None,
        status_reason: str | None = None,
        error: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SessionRuntimeState: ...


class TimelineReader(Protocol):
    async def read(self, session_id: str) -> list[TimelineItem]: ...


class TimelineEffectRepository(Protocol):
    timeline: TimelineReader

    async def upsert_timeline_item(
        self,
        *,
        session_id: str,
        item: TimelineItemIn,
        source_observed_at: str | None = None,
    ) -> TimelineItem: ...

class InteractionResolutionRepository(
    SessionLookupRepository,
    TimelineEffectRepository,
    Protocol,
):
    pass


class ConnectorIngestRepository(DashboardEventRepository, Protocol):
    async def record_connector_activity(self, connector_id: str) -> None: ...

    async def get_protocol_capabilities(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]: ...

    async def get_session_seq(self, session_id: str) -> int: ...

    async def set_session_status(
        self,
        session_id: str,
        status: SessionStatus,
        *,
        expected_status: SessionStatus | None = None,
    ) -> SessionView: ...

    async def list_sessions_for_connector(
        self,
        connector_id: str,
    ) -> list[SessionView]: ...

class ConnectorNotificationRepository(
    CatalogRepository,
    SessionStateRepository,
    TimelineEffectRepository,
    Protocol,
):
    async def clear_active_run(self, session_id: str) -> None: ...

    async def get_session_runtime(self, session_id: str) -> str | None: ...

    async def record_connector_activity(self, connector_id: str) -> None: ...

    async def get_protocol_capabilities(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]: ...

    async def replace_timeline(
        self,
        *,
        session_id: str,
        items: list[TimelineItemIn],
        source_observed_at: str | None = None,
    ) -> tuple[list[TimelineItem], bool]: ...

    async def replace_timeline_snapshot(
        self,
        *,
        session_id: str,
        items: list[TimelineItemIn],
        source_observed_at: str | None = None,
    ) -> list[TimelineItem]: ...

    async def sync_timeline_items(
        self,
        *,
        session_id: str,
        items: list[TimelineItemIn],
        source_observed_at: str | None = None,
    ) -> list[TimelineItem]: ...

    async def resolve_connector_session_id(
        self,
        *,
        connector_id: str,
        session_id: str,
        external_session_id: str | None = None,
    ) -> str: ...

    async def set_session_archived(
        self,
        session_id: str,
        archived: bool,
        *,
        user_id: str | None = None,
    ) -> SessionView: ...

    async def update_active_run_turn_id(self, session_id: str, turn_id: str) -> None: ...

    async def update_connector_preferences(
        self,
        connector_id: str,
        preferences: dict[str, Any],
    ) -> dict[str, Any]: ...

    async def update_protocol_capabilities(
        self,
        connector_id: str,
        capability_set: dict[str, Any],
    ) -> bool: ...

    async def update_session_snapshot(self, **values: Any) -> SessionView: ...

    async def upsert_connector_session(self, **values: Any) -> SessionView: ...


class DeviceRuntimeRepository(
    DashboardEventRepository,
    SessionStateRepository,
    Protocol,
):
    async def clear_active_run(self, session_id: str) -> None: ...

    async def clear_device_runtime_config(self, connector_id: str, runtime_id: str) -> dict[str, Any]: ...

    async def get_device_runtime(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]: ...

    async def get_session_seq(self, session_id: str) -> int: ...

    async def list_device_runtimes(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> list[dict[str, Any]]: ...

    async def list_running_sessions_for_connector_agent(
        self,
        *,
        connector_id: str,
        runtime: str,
        user_id: str | None = None,
    ) -> list[SessionView]: ...

    async def replace_device_runtime_inventory(
        self,
        connector_id: str,
        runtimes: list[Any],
    ) -> list[dict[str, Any]]: ...

    async def set_device_runtime_active(
        self,
        connector_id: str,
        runtime_id: str,
        active: bool,
    ) -> dict[str, Any]: ...

    async def set_device_runtime_config(
        self,
        connector_id: str,
        runtime_id: str,
        config: dict[str, Any],
    ) -> dict[str, Any]: ...

    async def set_device_runtime_status(
        self,
        connector_id: str,
        runtime_id: str,
        status: str,
        error: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...


class SessionRunRepository(
    CatalogRepository,
    DashboardEventRepository,
    SessionStateRepository,
    TimelineEffectRepository,
    Protocol,
):
    async def clear_active_run(self, session_id: str) -> None: ...

    async def create_session(self, **values: Any) -> SessionView: ...

    async def read_uploaded_file(
        self,
        *,
        session_id: str,
        file_id: str,
    ) -> dict[str, Any]: ...

    async def resolve_connector_session_id(
        self,
        *,
        connector_id: str,
        session_id: str,
        external_session_id: str | None = None,
    ) -> str: ...

    async def start_active_run(self, **values: Any) -> None: ...

    async def update_session_snapshot(self, **values: Any) -> SessionView: ...

    async def upsert_connector_session(self, **values: Any) -> SessionView: ...


class OAuthRepository(Protocol):
    async def user_exists(self, user_id: str) -> bool: ...


class AdminDashboardRepository(Protocol):
    engine: Any

    async def list_connectors(self, *, user_id: str | None = None) -> list[ConnectorView]: ...


TerminalRepository = SessionLookupRepository
WorkspaceRepository = SessionLookupRepository
