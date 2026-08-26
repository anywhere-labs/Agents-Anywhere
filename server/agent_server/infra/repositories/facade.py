from __future__ import annotations

from agent_server.infra.repositories.active_runs_facade import ActiveRunRepositoryMixin
from agent_server.infra.repositories.app_releases import AppReleaseRepositoryMixin
from agent_server.infra.repositories.attachments import AttachmentRepositoryMixin
from agent_server.infra.repositories.connectors import ConnectorRepositoryMixin
from agent_server.infra.repositories.device_runtimes import DeviceRuntimeRepositoryMixin
from agent_server.infra.repositories.instance_settings_facade import InstanceSettingsRepositoryMixin
from agent_server.infra.repositories.oauth import OAuthRepositoryMixin
from agent_server.infra.repositories.protocol_catalogs import ProtocolCatalogRepositoryMixin
from agent_server.infra.repositories.sessions import SessionRepositoryMixin
from agent_server.infra.repositories.timeline import TimelineRepositoryMixin
from agent_server.infra.repositories.users import UserRepositoryMixin
from agent_server.infra.repositories.store_support import *


class Store(
    AppReleaseRepositoryMixin,
    DeviceRuntimeRepositoryMixin,
    ProtocolCatalogRepositoryMixin,
    UserRepositoryMixin,
    OAuthRepositoryMixin,
    InstanceSettingsRepositoryMixin,
    ConnectorRepositoryMixin,
    SessionRepositoryMixin,
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


    @property
    def engine(self) -> AsyncEngine:
        return self._engine

    async def close(self) -> None:
        await self._engine.dispose()
