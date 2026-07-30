from __future__ import annotations

from typing import Any, Protocol

from agent_server.core.models import (
    Approval,
    ApprovalIn,
    ConnectorView,
    Notice,
    NoticeIn,
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


class NoticeRepository(Protocol):
    async def get_notice(self, notice_id: str) -> Notice: ...

    async def upsert_notice(self, notice: NoticeIn) -> Notice: ...

    async def update_notice_status(
        self,
        notice_id: str,
        status: str,
        *,
        expected_status: str | None = None,
        context_patch: dict[str, Any] | None = None,
    ) -> Notice: ...

    async def list_open_blocking_notices(self, session_id: str) -> list[Notice]: ...


class SessionStateRepository(SessionLookupRepository, NoticeRepository, Protocol):
    async def get_active_run(self, session_id: str) -> dict[str, Any] | None: ...

    async def get_open_turn_id(self, session_id: str) -> str | None: ...

    async def set_session_status(
        self,
        session_id: str,
        status: SessionStatus,
        *,
        expected_status: SessionStatus | None = None,
    ) -> SessionView: ...


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

    async def list_pending_approvals(self, session_id: str) -> list[Approval]: ...

    async def resolve_approval(self, approval_id: str, status: str) -> Approval: ...


class ApprovalRepository(
    SessionLookupRepository,
    TimelineEffectRepository,
    Protocol,
):
    async def get_approval(self, approval_id: str) -> Approval: ...


class InteractionRepository(SessionStateRepository, Protocol):
    pass


class InteractionProjectionRepository(SessionStateRepository, Protocol):
    async def upsert_approval(self, approval: ApprovalIn) -> Approval: ...


class ConnectorIngestRepository(DashboardEventRepository, Protocol):
    async def record_connector_activity(self, connector_id: str) -> None: ...

    async def get_protocol_capabilities(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]: ...

    async def get_session_seq(self, session_id: str) -> int: ...

    async def list_sessions_for_connector(
        self,
        connector_id: str,
    ) -> list[SessionView]: ...

    async def list_pending_approvals(self, session_id: str) -> list[Approval]: ...

    async def list_open_notices(self, session_id: str) -> list[Notice]: ...


class ConnectorNotificationRepository(
    SessionStateRepository,
    TimelineEffectRepository,
    Protocol,
):
    async def clear_active_run(self, session_id: str) -> None: ...

    async def get_session_runtime(self, session_id: str) -> str | None: ...

    async def record_connector_activity(self, connector_id: str) -> None: ...

    async def replace_timeline(
        self,
        *,
        session_id: str,
        items: list[TimelineItemIn],
        source_observed_at: str | None = None,
    ) -> list[TimelineItem]: ...

    async def replace_timeline_snapshot(
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

    async def update_active_run_turn_id(
        self, session_id: str, turn_id: str
    ) -> None: ...

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

    async def update_protocol_catalog(
        self,
        connector_id: str,
        *,
        runtime: str,
        catalog_type: str,
        revision: int,
        catalog: dict[str, Any],
    ) -> None: ...

    async def update_session_snapshot(self, **values: Any) -> SessionView: ...

    async def upsert_approval(self, approval: ApprovalIn) -> Approval: ...

    async def upsert_connector_session(self, **values: Any) -> SessionView: ...


class DeviceRuntimeRepository(
    DashboardEventRepository,
    SessionStateRepository,
    Protocol,
):
    async def clear_active_run(self, session_id: str) -> None: ...

    async def clear_device_runtime_config(
        self, connector_id: str, runtime_id: str
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

    async def list_pending_approvals(self, session_id: str) -> list[Approval]: ...

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

    async def resolve_approval(self, approval_id: str, status: str) -> Approval: ...

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
    DashboardEventRepository,
    SessionStateRepository,
    TimelineEffectRepository,
    Protocol,
):
    async def clear_active_run(self, session_id: str) -> None: ...

    async def create_session(self, **values: Any) -> SessionView: ...

    async def get_protocol_catalog(
        self,
        connector_id: str,
        *,
        runtime: str,
        catalog_type: str,
        user_id: str | None = None,
    ) -> dict[str, Any] | None: ...

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

    async def list_connectors(
        self, *, user_id: str | None = None
    ) -> list[ConnectorView]: ...


TerminalRepository = SessionLookupRepository
WorkspaceRepository = SessionLookupRepository
