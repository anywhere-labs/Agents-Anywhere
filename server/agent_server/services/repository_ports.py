from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from typing import Any, Protocol

from agent_server.core.catalogs import CatalogType, CatalogUpdateOutcome
from agent_server.core.device_runtime import RuntimeTypeDescriptor
from agent_server.core.models import (
    ConnectorSessionResolution,
    ConnectorView,
    ProjectView,
    SessionRuntimeState,
    SessionStatus,
    SessionView,
    TimelineItem,
    TimelineItemIn,
)
from agent_server.core.timeline import (
    TimelineBatchWriteResult,
    TimelineItemWriteResult,
)


class InstanceSettingsRepository(Protocol):
    async def get_setting(self, key: str, default: str | None = None) -> str | None: ...

    async def set_setting(self, key: str, value: str) -> None: ...


class SessionLookupRepository(Protocol):
    async def get_session(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> SessionView: ...


class DashboardEventRepository(SessionLookupRepository, Protocol):
    async def get_connector(self, connector_id: str) -> ConnectorView: ...

    async def get_session_user_id(self, session_id: str) -> str: ...


class ConnectorDeletionRepository(DashboardEventRepository, Protocol):
    def connector_lifecycle(self, connector_id: str) -> AbstractAsyncContextManager[None]: ...

    async def begin_connector_deletion(self, connector_id: str, *, user_id: str) -> list[str]: ...

    async def pending_connector_deletions(self) -> list[tuple[str, str]]: ...

    async def delete_connector(self, connector_id: str, *, user_id: str) -> list[str]: ...


class ProjectLookupRepository(Protocol):
    async def get_project(
        self,
        project_id: str,
        *,
        user_id: str,
    ) -> ProjectView: ...


class ProjectRepository(ProjectLookupRepository, Protocol):
    async def list_projects(self, *, user_id: str) -> list[ProjectView]: ...

    async def create_project(self, **values: Any) -> ProjectView: ...

    async def update_project(self, project_id: str, **values: Any) -> ProjectView: ...

    async def delete_project(self, project_id: str, *, user_id: str) -> int: ...

    async def list_project_sessions_page(
        self,
        project_id: str,
        **values: Any,
    ) -> tuple[list[SessionView], bool, str | None]: ...

    async def archive_project_sessions(
        self,
        project_id: str,
        archived: bool,
        **values: Any,
    ) -> list[SessionView]: ...


class CatalogRepository(Protocol):
    async def get_protocol_catalog(
        self,
        connector_id: str,
        *,
        runtime_id: str,
        catalog_type: CatalogType,
        user_id: str | None = None,
    ) -> dict[str, Any] | None: ...

    async def update_protocol_catalog(
        self,
        connector_id: str,
        *,
        runtime: str,
        runtime_id: str | None = None,
        catalog_type: CatalogType,
        revision: int,
        catalog: dict[str, Any],
    ) -> CatalogUpdateOutcome: ...


class SessionStateRepository(SessionLookupRepository, Protocol):
    async def get_active_run(self, session_id: str) -> dict[str, Any] | None: ...

    async def start_active_run(self, **values: Any) -> None: ...

    async def set_session_status(
        self,
        session_id: str,
        status: SessionStatus,
        *,
        expected_status: SessionStatus | None = None,
        mark_read_on_change: bool = False,
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
        runtime_id: str | None = None,
        external_session_id: str | None = None,
        status: str | None = None,
        selections: dict[str, str | None] | None = None,
        status_reason: str | None = None,
        error: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SessionRuntimeState: ...


class TimelineReader(Protocol):
    async def read(self, session_id: str) -> list[TimelineItem]: ...


class TimelineBufferReader(Protocol):
    async def read(self, session_id: str) -> list[TimelineItem]: ...

    async def read_one(
        self,
        session_id: str,
        item_id: str,
    ) -> TimelineItem | None: ...


class TimelineBufferRepository(DashboardEventRepository, Protocol):
    timeline: TimelineBufferReader

    async def get_session_seq(self, session_id: str) -> int: ...

    async def get_max_timeline_order_seq(self, session_id: str) -> int: ...

    async def reserve_timeline_sequence(
        self,
        *,
        session_id: str,
        mark_read_on_change: bool = False,
    ) -> int: ...

    async def lease_session_revision_range(
        self,
        *,
        session_id: str,
        count: int,
    ) -> tuple[int, int]: ...

    async def persist_buffered_timeline_items(
        self,
        *,
        session_id: str,
        items: list[TimelineItem],
        source_observed_at: str | None = None,
        mark_read_on_change: bool = False,
    ) -> TimelineBatchWriteResult: ...


class TimelineEffectRepository(Protocol):
    timeline: TimelineReader

    async def upsert_timeline_item(
        self,
        *,
        session_id: str,
        item: TimelineItemIn,
        source_observed_at: str | None = None,
        mark_read_on_change: bool = False,
    ) -> TimelineItemWriteResult: ...

class InteractionResolutionRepository(
    SessionLookupRepository,
    TimelineEffectRepository,
    Protocol,
):
    pass


class ConnectorIngestRepository(DashboardEventRepository, Protocol):
    async def get_unconfigured_runtime_ids(self, connector_id: str) -> set[str]: ...

    def session_revision_fence(
        self,
        session_id: str,
    ) -> AbstractAsyncContextManager[None]: ...

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
        mark_read_on_change: bool = False,
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
    async def refresh_unchanged_session_source(
        self, session_id: str, *, connector_id: str, runtime: str, runtime_id: str,
        availability: str, reason: str | None, observed_at: str | None,
        observation_origin: str,
    ) -> bool: ...

    async def clear_active_run(self, session_id: str) -> None: ...

    async def resolve_connector_session_binding(
        self,
        *,
        connector_id: str,
        session_id: str,
        external_session_id: str | None = None,
        runtime: str | None = None,
        runtime_id: str | None = None,
        source_runtime: str | None = None,
        source_runtime_id: str | None = None,
    ) -> ConnectorSessionResolution: ...

    async def begin_session_inventory(
        self,
        connector_id: str,
        runtime: str,
        runtime_id: str,
        scan_token: str,
    ) -> None: ...

    async def complete_session_inventory(
        self,
        connector_id: str,
        runtime: str,
        runtime_id: str,
        scan_token: str,
        entries: list[dict[str, Any]],
        *,
        complete: bool,
    ) -> list[str]: ...

    async def update_session_source_state(
        self,
        session_id: str,
        *,
        availability: str,
        reason: str | None,
        observed_at: str | None,
        observation_origin: str,
    ) -> SessionView: ...

    async def get_session_runtime(self, session_id: str) -> str | None: ...

    async def record_connector_activity(self, connector_id: str) -> None: ...

    async def get_protocol_capabilities(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]: ...

    async def replace_timeline_snapshot(
        self,
        *,
        session_id: str,
        items: list[TimelineItemIn],
        source_observed_at: str | None = None,
        mark_read_on_change: bool = False,
    ) -> TimelineBatchWriteResult: ...

    async def sync_timeline_items(
        self,
        *,
        session_id: str,
        items: list[TimelineItemIn],
        source_observed_at: str | None = None,
        mark_read_on_change: bool = False,
    ) -> TimelineBatchWriteResult: ...

    async def resolve_connector_session_id(
        self,
        *,
        connector_id: str,
        session_id: str,
        external_session_id: str | None = None,
        runtime: str | None = None,
        runtime_id: str | None = None,
    ) -> str: ...

    async def set_session_archived(
        self,
        session_id: str,
        archived: bool,
        *,
        user_id: str | None = None,
    ) -> SessionView: ...

    async def record_session_turn_end(
        self,
        *,
        session_id: str,
        source_observed_at: str | None = None,
        mark_read_on_change: bool = False,
    ) -> SessionView: ...

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
    def connector_lifecycle(self, connector_id: str) -> AbstractAsyncContextManager[None]: ...

    async def get_unconfigured_runtime_ids(self, connector_id: str) -> set[str]: ...

    async def runtime_session_ids(self, connector_id: str, runtime_id: str) -> list[str]: ...

    async def delete_runtime_session_files(self, session_ids: list[str]) -> None: ...

    def session_revision_fence(
        self,
        session_id: str,
    ) -> AbstractAsyncContextManager[None]: ...

    async def clear_active_run(self, session_id: str) -> None: ...

    async def clear_device_runtime_config(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        cleanup_files: bool = True,
    ) -> list[str]: ...

    async def create_device_runtime(
        self,
        connector_id: str,
        *,
        runtime_type: str,
        name: str,
        config: dict[str, Any],
        active: bool,
    ) -> dict[str, Any]: ...

    async def get_connector_runtime_type(
        self,
        connector_id: str,
        runtime_type: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]: ...

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

    async def list_user_device_runtimes(
        self,
        *,
        user_id: str,
    ) -> list[dict[str, Any]]: ...

    async def list_connector_runtime_types(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> list[dict[str, Any]]: ...

    async def list_running_sessions_for_connector_agent(
        self,
        *,
        connector_id: str,
        runtime_id: str,
        user_id: str | None = None,
    ) -> list[SessionView]: ...

    async def replace_connector_runtime_types(
        self,
        connector_id: str,
        runtime_types: list[RuntimeTypeDescriptor],
    ) -> list[dict[str, Any]]: ...

    async def rename_device_runtime(
        self,
        connector_id: str,
        runtime_id: str,
        name: str,
    ) -> dict[str, Any]: ...

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
    ProjectLookupRepository,
    Protocol,
):
    async def get_protocol_capabilities(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]: ...

    async def get_device_runtime(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]: ...

    async def clear_active_run(self, session_id: str) -> None: ...

    async def create_session(self, **values: Any) -> SessionView: ...

    async def save_user_uploaded_file(
        self,
        *,
        session_id: str,
        user_id: str,
        name: str,
        data: bytes,
        media_type: str | None = None,
    ) -> dict[str, Any]: ...

    async def read_uploaded_file(
        self,
        *,
        session_id: str,
        file_id: str,
        user_id: str,
    ) -> dict[str, Any]: ...

    async def resolve_connector_session_id(
        self,
        *,
        connector_id: str,
        session_id: str,
        external_session_id: str | None = None,
        runtime: str | None = None,
        runtime_id: str | None = None,
    ) -> str: ...

    async def start_active_run(self, **values: Any) -> None: ...

    async def update_session_snapshot(self, **values: Any) -> SessionView: ...

    async def update_session_source_state(
        self,
        session_id: str,
        *,
        availability: str,
        reason: str | None,
        observed_at: str | None,
        observation_origin: str,
    ) -> SessionView: ...

    async def upsert_connector_session(self, **values: Any) -> SessionView: ...


class OAuthRepository(Protocol):
    async def user_exists(self, user_id: str) -> bool: ...


class AdminDashboardRepository(Protocol):
    engine: Any

    async def list_connectors(self, *, user_id: str | None = None) -> list[ConnectorView]: ...


class ConnectorTerminalRepository(Protocol):
    async def get_connector_terminal_root(
        self,
        *,
        connector_id: str,
        terminal_id: str,
    ) -> dict[str, str] | None: ...


TerminalRepository = SessionLookupRepository
WorkspaceRepository = SessionLookupRepository
