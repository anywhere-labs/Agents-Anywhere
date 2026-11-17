from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator
from typing import Any

from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.repositories.active_runs_facade import ActiveRunRepositoryMixin
from agent_server.infra.repositories.attachments import AttachmentRepositoryMixin
from agent_server.infra.repositories.channel_reconciliation import (
    ChannelReconciliationRepositoryMixin,
)
from agent_server.infra.repositories.connectors import ConnectorRepositoryMixin
from agent_server.infra.repositories.device_link import DeviceLinkRepositoryMixin
from agent_server.infra.repositories.device_runtimes import DeviceRuntimeRepositoryMixin
from agent_server.infra.repositories.e2ee import E2eeRepositoryMixin
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
from agent_server.infra.repositories.previews import PreviewRepositoryMixin
from agent_server.infra.repositories.token_families import TokenFamilyRepositoryMixin
from agent_server.infra.repositories.usage import UsageRepositoryMixin
from agent_server.infra.repositories.users import UserRepositoryMixin
from agent_server.infra.terminal_roots import TerminalRootStore

_MAX_TRACKED_LOCKS = 4096
_TRACKED_LOCK_IDLE_SECONDS = 900.0


from agent_server.infra.repositories.model_channels import ModelChannelRepositoryMixin
from agent_server.infra.repositories.model_config import ModelConfigRepositoryMixin
from agent_server.infra.repositories.runtime_workflows import (
    RuntimeWorkflowRepositoryMixin,
)
from agent_server.infra.repositories.tokens_links import TokensLinkRepositoryMixin


class Store(
    TokenFamilyRepositoryMixin,
    PreviewRepositoryMixin,
    DeviceLinkRepositoryMixin,
    E2eeRepositoryMixin,
    ChannelReconciliationRepositoryMixin,
    ModelChannelRepositoryMixin,
    ModelConfigRepositoryMixin,
    TokensLinkRepositoryMixin,
    RuntimeWorkflowRepositoryMixin,
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
    UsageRepositoryMixin,
):
    def __init__(
        self,
        *,
        db_url: str | None = None,
        file_storage: FileStorage | None = None,
    ) -> None:
        engine = build_engine(db_url)
        self._engine: AsyncEngine = engine
        self.files: FileStorage = file_storage or build_file_storage(
            default_local_root=_default_files_root(engine)
        )
        self.instance_settings = InstanceSettingsRepository(engine)
        self.active_runs = ActiveRunRepository(engine)
        self.attachments = AttachmentService(self, self.files)
        # Terminal roots are runtime state in Redis (``05-server.md`` §3.1). Until
        # the app binds its coordinator they live in this process.
        self.terminal_roots = TerminalRootStore(RedisCoordinator())

        self._lifecycle_locks: dict[str, asyncio.Lock] = {}
        self._lifecycle_locks_guard = asyncio.Lock()
        self._lifecycle_lock_used: dict[str, float] = {}
        self._connector_lifecycle_factory: Any | None = None

    def bind_terminal_roots(self, terminal_roots: TerminalRootStore) -> None:
        self.terminal_roots = terminal_roots

    def bind_connector_lifecycle(self, factory: Any) -> None:
        self._connector_lifecycle_factory = factory

    @asynccontextmanager
    async def connector_lifecycle(self, connector_id: str) -> AsyncIterator[None]:
        factory = self._connector_lifecycle_factory
        guard = factory(connector_id) if factory else await self._local_lifecycle_lock(connector_id)
        async with guard:
            yield

    @property
    def engine(self) -> AsyncEngine:
        return self._engine

    async def _local_lifecycle_lock(self, connector_id: str) -> asyncio.Lock:
        """Return this connector's in-process lifecycle lock, keeping the registry bounded.

        Used only when no app-scoped lifecycle guard is bound (tests and tools
        that build a bare Store). The registry evicts idle, unlocked entries
        instead of growing without bound.
        """

        async with self._lifecycle_locks_guard:
            lock = self._lifecycle_locks.get(connector_id)
            if lock is None:
                lock = asyncio.Lock()
                self._lifecycle_locks[connector_id] = lock
            self._lifecycle_lock_used[connector_id] = time.monotonic()
            if len(self._lifecycle_locks) > _MAX_TRACKED_LOCKS:
                self._evict_lifecycle_locks_locked()
            return lock

    def _evict_lifecycle_locks_locked(self) -> None:
        cutoff = time.monotonic() - _TRACKED_LOCK_IDLE_SECONDS
        removable = [
            connector_id
            for connector_id, lock in self._lifecycle_locks.items()
            if not lock.locked() and self._lifecycle_lock_used.get(connector_id, 0.0) <= cutoff
        ]
        if not removable:
            removable = [
                connector_id
                for connector_id, lock in self._lifecycle_locks.items()
                if not lock.locked()
            ]
        for connector_id in removable:
            self._lifecycle_locks.pop(connector_id, None)
            self._lifecycle_lock_used.pop(connector_id, None)

    async def close(self) -> None:
        await self._engine.dispose()
