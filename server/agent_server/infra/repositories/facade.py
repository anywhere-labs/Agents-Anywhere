from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from typing import Any

from agent_server.infra.repositories.active_runs_facade import ActiveRunRepositoryMixin
from agent_server.infra.repositories.attachments import AttachmentRepositoryMixin
from agent_server.infra.repositories.connectors import ConnectorRepositoryMixin
from agent_server.infra.repositories.device_runtimes import DeviceRuntimeRepositoryMixin
from agent_server.infra.repositories.instance_settings_facade import (
    InstanceSettingsRepositoryMixin,
)
from agent_server.infra.repositories.oauth import OAuthRepositoryMixin
from agent_server.infra.repositories.projects import ProjectRepositoryMixin
from agent_server.infra.repositories.protocol_catalogs import (
    ProtocolCatalogRepositoryMixin,
)
from agent_server.infra.repositories.sessions import SessionRepositoryMixin
from agent_server.infra.repositories.shares import SessionShareRepositoryMixin
from agent_server.infra.repositories.store_support import *
from agent_server.infra.repositories.timeline import TimelineRepositoryMixin
from agent_server.infra.repositories.users import UserRepositoryMixin

_MAX_TRACKED_LOCKS = 4096
_TRACKED_LOCK_IDLE_SECONDS = 900.0


class Store(
    DeviceRuntimeRepositoryMixin,
    ProtocolCatalogRepositoryMixin,
    UserRepositoryMixin,
    OAuthRepositoryMixin,
    InstanceSettingsRepositoryMixin,
    ConnectorRepositoryMixin,
    ProjectRepositoryMixin,
    SessionRepositoryMixin,
    SessionShareRepositoryMixin,
    AttachmentRepositoryMixin,
    ActiveRunRepositoryMixin,
    TimelineRepositoryMixin,
):
    def __init__(
        self,
        path: str | Path | None = None,
        *,
        db_url: str | None = None,
        backend: str | None = None,
        file_storage: FileStorage | None = None,
    ) -> None:
        resolved_backend, engine = build_engine(backend=backend, url=db_url, sqlite_path=path)
        self.backend: str = resolved_backend
        self._engine: AsyncEngine = engine
        self.timeline: SqlTimelineStore = SqlTimelineStore(engine, backend=resolved_backend)
        self.files: FileStorage = file_storage or build_file_storage(
            default_local_root=_default_files_root(engine, path)
        )
        self.instance_settings = InstanceSettingsRepository(engine)
        self.active_runs = ActiveRunRepository(engine)
        self.attachments = AttachmentService(self, self.files)

        self._timeline_locks: dict[str, asyncio.Lock] = {}
        self._timeline_locks_guard = asyncio.Lock()
        self._timeline_lock_used: dict[str, float] = {}
        self._session_revision_fence_factory: Any | None = None
        self._session_revision_publisher: Any | None = None
        self._session_revision_range_sealer: Any | None = None
        self._connector_lifecycle_factory: Any | None = None

    def bind_connector_lifecycle(self, factory: Any) -> None:
        self._connector_lifecycle_factory = factory

    @asynccontextmanager
    async def connector_lifecycle(self, connector_id: str) -> AsyncIterator[None]:
        factory = self._connector_lifecycle_factory
        guard = factory(connector_id) if factory else await self.timeline_lock(f"connector:{connector_id}")
        async with guard:
            yield

    def bind_session_revision_fence(self, factory: Any) -> None:
        """Bind the app-scoped coordinator used by revision-producing writes."""

        self._session_revision_fence_factory = factory

    def bind_session_revision_publisher(self, publisher: Any) -> None:
        """Bind the ordered publisher paired with the revision fence."""

        self._session_revision_publisher = publisher

    def bind_session_revision_range_sealer(self, sealer: Any) -> None:
        """Bind the Redis allocator hook that retires an active revision lease."""

        self._session_revision_range_sealer = sealer

    async def seal_session_revision_range(
        self,
        session_id: str,
        allocated_high: int,
    ) -> None:
        sealer = self._session_revision_range_sealer
        if sealer is not None:
            await sealer(session_id, allocated_high)

    async def publish_session_revision_result(
        self,
        session_id: str,
        *,
        operation: str,
        result: Any,
    ) -> None:
        publisher = self._session_revision_publisher
        if publisher is not None:
            await publisher(session_id, operation=operation, result=result)

    @asynccontextmanager
    async def session_revision_fence(self, session_id: str) -> AsyncIterator[None]:
        factory = self._session_revision_fence_factory
        if factory is None:
            yield
            return
        async with factory(session_id):
            yield

    @property
    def engine(self) -> AsyncEngine:
        return self._engine

    async def timeline_lock(self, session_id: str) -> asyncio.Lock:
        """Return this session's SQLite writer lock, keeping the registry bounded.

        Only the SQLite backend uses these locks, but a long-lived dev or test
        process still touches many sessions, so the registry evicts idle,
        unlocked entries instead of growing without bound.
        """

        async with self._timeline_locks_guard:
            lock = self._timeline_locks.get(session_id)
            if lock is None:
                lock = asyncio.Lock()
                self._timeline_locks[session_id] = lock
            self._timeline_lock_used[session_id] = time.monotonic()
            if len(self._timeline_locks) > _MAX_TRACKED_LOCKS:
                self._evict_timeline_locks_locked()
            return lock

    def _evict_timeline_locks_locked(self) -> None:
        cutoff = time.monotonic() - _TRACKED_LOCK_IDLE_SECONDS
        removable = [
            session_id
            for session_id, lock in self._timeline_locks.items()
            if not lock.locked() and self._timeline_lock_used.get(session_id, 0.0) <= cutoff
        ]
        if not removable:
            removable = [
                session_id
                for session_id, lock in self._timeline_locks.items()
                if not lock.locked()
            ]
        for session_id in removable:
            self._timeline_locks.pop(session_id, None)
            self._timeline_lock_used.pop(session_id, None)

    async def close(self) -> None:
        await self._engine.dispose()
