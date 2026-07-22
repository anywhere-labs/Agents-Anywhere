from __future__ import annotations

from agent_server.infra.repositories.active_runs_facade import ActiveRunRepositoryMixin
from agent_server.infra.repositories.approvals import ApprovalRepositoryMixin
from agent_server.infra.repositories.attachments import AttachmentRepositoryMixin
from agent_server.infra.repositories.connectors import ConnectorRepositoryMixin
from agent_server.infra.repositories.device_runtimes import DeviceRuntimeRepositoryMixin
from agent_server.infra.repositories.instance_settings_facade import InstanceSettingsRepositoryMixin
from agent_server.infra.repositories.notices import NoticeRepositoryMixin
from agent_server.infra.repositories.oauth import OAuthRepositoryMixin
from agent_server.infra.repositories.protocol_catalogs import ProtocolCatalogRepositoryMixin
from agent_server.infra.repositories.sessions import SessionRepositoryMixin
from agent_server.infra.repositories.timeline import TimelineRepositoryMixin
from agent_server.infra.repositories.users import UserRepositoryMixin
from agent_server.infra.repositories.store_support import *


class Store(
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
    ApprovalRepositoryMixin,
    NoticeRepositoryMixin,
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
        # Create tables synchronously up front so callers can start using the
        # store immediately (tests construct Store outside of an event loop and
        # do not always trigger the FastAPI lifespan). render_as_string keeps
        # the URL password intact — str(engine.url) would mask it.
        url_str = engine.url.render_as_string(hide_password=False)
        init_db_sync(url_str)

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


    async def init_schema(self) -> None:
        await init_db(self._engine)


    async def close(self) -> None:
        await self._engine.dispose()
